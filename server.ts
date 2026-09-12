import "dotenv/config";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { glob as globModule } from "glob";
import * as cheerio from "cheerio";

const execAsync = promisify(exec);

// OmniRoute gateway configuration
const OMNIROUTE_API_BASE = normalizeBase(
  process.env.OMNIROUTE_API_BASE || "https://omniouter-vercel.vercel.app"
);
const OMNIROUTE_API_KEY = process.env.OMNIROUTE_AI_API_KEY || "";
const OMNIROUTE_MODEL = process.env.OMNIROUTE_MODEL || "auto";

function normalizeBase(base: string): string {
  let url = base.trim().replace(/\/+$/, "");
  if (!/\/api\/v1$/i.test(url)) url += "/api/v1";
  return url;
}

// Retry schedule for transient gateway failures (5xx / 429 / quota / overload)
const RETRY_DELAYS_MS = [
  1000, 3000, 6000, 12000, 20000, 40000, 60000, 120000, 300000, 600000,
  900000, 1800000, 3600000,
];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number, message: string): boolean {
  if (status === 0) return true; // network-level failure (connection refused, DNS, etc.)
  if (status === 408 || status === 429 || status >= 500) return true;
  return /quota|overload|rate[\s_-]?limit|timeout|busy|unavailable|server|capacity|throttl|too many/i.test(
    message
  );
}

// OpenAI-compatible chat completion against the OmniRoute gateway
async function chatCompletion(messages: any[], openaiTools: any[], onRetry?: (info: any) => void) {
  let toolsEnabled = openaiTools.length > 0;

  let lastError: any = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const body: any = {
      model: OMNIROUTE_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 800,
    };
    if (toolsEnabled) {
      body.tools = openaiTools;
    }

    try {
      const res = await fetch(`${OMNIROUTE_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OMNIROUTE_API_KEY}`,
          "x-api-key": OMNIROUTE_API_KEY,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data: any = await res.json();
        return data.choices?.[0]?.message ?? null;
      }
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      const code = String(json?.error?.code || json?.code || "").toLowerCase();
      const upstream = String(json?.error?.message || json?.message || text);
      const msg = `OmniRoute API error ${res.status}: ${upstream.slice(0, 500)}`;
      lastError = new Error(msg);

      // Only auth/unknown-model errors are truly permanent — abort immediately.
      if (
        /invalid_api_key|apikey|api.?key|unauthorized|forbidden|model.?not.?found|no such model|invalid model|not a model/i.test(
          code + " " + upstream
        )
      ) {
        console.error(`OmniRoute permanent error (code=${code || res.status}) — aborting`);
        break;
      }

      // A provider-specific payload rejection: retryable because auto re-routes.
      // After a couple of failed attempts, drop tools and try again plain.
      if (
        toolsEnabled &&
        attempt >= 1 &&
        /payload|rejected the request|tools?|bad_request/i.test(code + " " + upstream)
      ) {
        toolsEnabled = false;
        console.error(`OmniRoute payload rejected — retrying without tools`);
        if (onRetry) {
          onRetry({
            attempt: attempt + 1,
            total: RETRY_DELAYS_MS.length,
            delayMs: RETRY_DELAYS_MS[attempt] ?? 1000,
            error: "provider rejected payload, retrying without tools",
          });
        }
        await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
        continue;
      }

      if (!isRetryable(res.status, upstream)) break;
    } catch (e: any) {
      lastError = e;
      if (!isRetryable(0, e?.message || "")) break;
    }

    if (attempt < RETRY_DELAYS_MS.length) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      console.log(
        `OmniRoute gateway retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${Math.round(
          delayMs / 1000
        )}s — ${lastError?.message ?? "transient failure"}`
      );
      if (onRetry) {
        onRetry({
          attempt: attempt + 1,
          total: RETRY_DELAYS_MS.length,
          delayMs,
          error: lastError?.message ?? "transient failure",
        });
      }
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error("OmniRoute request failed after all retries");
}

// Convert the client's Gemini-style history (role + parts) into OpenAI messages
function toOpenAIMessages(messages: any[]): any[] {
  const out: any[] = [];
  let pendingIds: string[] = [];
  let seq = 0;
  for (const m of messages) {
    const parts = m.parts || [];
    if (m.role === "user") {
      const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join("\n");
      const responses = parts.filter((p: any) => p.functionResponse);
      if (responses.length > 0) {
        responses.forEach((p: any, i: number) => {
          const id = pendingIds[i] || `call_${seq++}`;
          const result = p.functionResponse?.response?.result;
          const content =
            typeof result === "string"
              ? result
              : JSON.stringify(p.functionResponse?.response ?? result ?? "");
          out.push({ role: "tool", tool_call_id: id, content });
        });
        pendingIds = [];
      } else if (text) {
        out.push({ role: "user", content: text });
      }
    } else if (m.role === "model") {
      const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join("\n");
      const calls = parts.filter((p: any) => p.functionCall);
      if (calls.length > 0) {
        const tool_calls = calls.map((p: any) => {
          const id = `call_${seq++}`;
          pendingIds.push(id);
          const args = p.functionCall?.args;
          return {
            id,
            type: "function",
            function: {
              name: p.functionCall?.name,
              arguments:
                typeof args === "string" ? args : JSON.stringify(args ?? {}),
            },
          };
        });
        const assistantMsg: any = { role: "assistant", tool_calls };
        if (text) assistantMsg.content = text;
        out.push(assistantMsg);
      } else {
        const assistantMsg: any = { role: "assistant" };
        if (text) assistantMsg.content = text;
        out.push(assistantMsg);
      }
    } else if (m.role === "system") {
      const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join("\n");
      out.push({ role: "system", content: text });
    }
  }
  return out;
}

// Convert an OpenAI assistant message back into the client's parts format
function toClientMessage(gptMessage: any) {
  const parts: any[] = [];
  if (gptMessage?.content) parts.push({ text: gptMessage.content });
  for (const tc of gptMessage?.tool_calls || []) {
    let args: any = {};
    try {
      args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      args = {};
    }
    parts.push({ functionCall: { name: tc.function?.name, args } });
  }
  return { role: "model", parts };
}

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = 3000;

// Helper to execute bash command
async function runBash(command: string, timeoutMs: number = 120000, workdir: string = process.cwd()) {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs, cwd: workdir });
    return `Stdout:\n${stdout}\nStderr:\n${stderr}`;
  } catch (error: any) {
    return `Error executing command: ${error.message}\nStdout:\n${error.stdout}\nStderr:\n${error.stderr}`;
  }
}

// Tool definitions (OpenAI function-call schema for OmniRoute)
function fn(name: string, description: string, parameters: any) {
  return { type: "function", function: { name, description, parameters } };
}

const tools = [
  fn("bash", "Executes a given bash command in a persistent shell session.", {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "integer", description: "Timeout in milliseconds" },
      workdir: { type: "string", description: "Working directory" }
    },
    required: ["command"],
  }),
  fn("edit", "Performs exact string replacements in files.", {
    type: "object",
    properties: {
      filePath: { type: "string" },
      oldString: { type: "string" },
      newString: { type: "string" },
      replaceAll: { type: "boolean" }
    },
    required: ["filePath", "oldString", "newString"],
  }),
  fn("glob", "Fast file pattern matching tool.", {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" }
    },
    required: ["pattern"],
  }),
  fn("grep", "Fast content search tool.", {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      include: { type: "string" }
    },
    required: ["pattern"],
  }),
  fn("read", "Read a file or directory from the local filesystem.", {
    type: "object",
    properties: {
      filePath: { type: "string" },
      offset: { type: "integer" },
      limit: { type: "integer" }
    },
    required: ["filePath"],
  }),
  fn("write", "Writes a file to the local filesystem.", {
    type: "object",
    properties: {
      filePath: { type: "string" },
      content: { type: "string" }
    },
    required: ["filePath", "content"],
  }),
  fn("question", "Use this tool when you need to ask the user questions during execution.", {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            multiple: { type: "boolean" }
          }
        }
      }
    },
    required: ["questions"],
  }),
  fn("skill", "Load a specialized skill when the task at hand matches one of the skills listed in the system prompt.", {
    type: "object",
    properties: {
      name: { type: "string" }
    },
    required: ["name"],
  }),
  fn("task", "Launch a new agent to handle complex, multistep tasks autonomously.", {
    type: "object",
    properties: {
      description: { type: "string" },
      prompt: { type: "string" },
      subagent_type: { type: "string" },
      task_id: { type: "string" },
      command: { type: "string" }
    },
    required: ["description", "prompt", "subagent_type"],
  }),
  fn("todowrite", "Create and maintain a structured task list for the current coding session.", {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string" },
            priority: { type: "string" }
          }
        }
      }
    },
    required: ["todos"],
  }),
  fn("webfetch", "Fetches content from a specified URL.", {
    type: "object",
    properties: {
      url: { type: "string" },
      format: { type: "string" },
      timeout: { type: "integer" }
    },
    required: ["url"],
  })
];

let systemInstruction = "";

app.post("/api/mkdir", async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    await fs.mkdir(dirPath, { recursive: true });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/rmdir", async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    await fs.rm(dirPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { messages, cwd } = req.body;
  const projectCwd = cwd || process.cwd();
  if (!systemInstruction) {
    try {
      systemInstruction = await fs.readFile(path.join(process.cwd(), "src/opencode.md"), "utf8");
    } catch (e) {
      console.error("Could not read opencode.md", e);
    }
  }

  try {
    const formattedMessages = messages.map((m: any) => ({
      role: m.role,
      parts: m.parts || [{ text: m.content }]
    }));

    res.setHeader("Content-Type", "application/x-ndjson");
    res.flushHeaders();
    const emit = (obj: any) => {
      try {
        res.write(JSON.stringify(obj) + "\n");
      } catch {
        /* client closed */
      }
    };

    const openaiMessages: any[] = [];
    if (systemInstruction) {
      openaiMessages.push({ role: "system", content: systemInstruction });
    }
    openaiMessages.push(...toOpenAIMessages(formattedMessages));

    const gptMessage = await chatCompletion(openaiMessages, tools, (info) =>
      emit({ type: "retry", ...info })
    );

    if (!gptMessage) {
      throw new Error("OmniRoute returned an empty response");
    }

    const reasoningText = String(
      gptMessage.reasoning ||
        gptMessage.reasoning_details?.[0]?.text ||
        (Array.isArray(gptMessage.reasoning_details) &&
          gptMessage.reasoning_details
            .map((r: any) => r.text || "")
            .filter(Boolean)
            .join("\n")) ||
        ""
    );
    if (reasoningText) {
      emit({ type: "reasoning", text: reasoningText });
    }

    const responseMessage = toClientMessage(gptMessage);

    // We handle function calls on the server
    const functionCallParts = responseMessage.parts.filter((p: any) => p.functionCall);

    if (functionCallParts.length > 0) {
      // Execute functions
      const functionResponses = [];
      for (const fp of functionCallParts) {
        const fc = fp.functionCall;
        let result = "";
        try {
          const args = fc.args as any;
          if (fc.name === "bash") {
            result = await runBash(args.command, args.timeout, args.workdir || projectCwd);
          } else if (fc.name === "read") {
            const targetPath = path.resolve(projectCwd, args.filePath);
            const content = await fs.readFile(targetPath, "utf8");
            const lines = content.split('\n');
            const offset = args.offset ? args.offset - 1 : 0;
            const limit = args.limit || 2000;
            const slice = lines.slice(offset, offset + limit);
            result = slice.map((line, i) => `${offset + i + 1}: ${line}`).join('\n');
          } else if (fc.name === "write") {
            const targetPath = path.resolve(projectCwd, args.filePath);
            await fs.writeFile(targetPath, args.content, "utf8");
            result = `File written to ${targetPath}`;
          } else if (fc.name === "edit") {
            const targetPath = path.resolve(projectCwd, args.filePath);
            const content = await fs.readFile(targetPath, "utf8");
            if (content.includes(args.oldString)) {
              let newContent = content;
              if (args.replaceAll) {
                newContent = content.split(args.oldString).join(args.newString);
              } else {
                newContent = content.replace(args.oldString, args.newString);
              }
              await fs.writeFile(targetPath, newContent, "utf8");
              result = "Edit successful";
            } else {
              result = "oldString not found in content";
            }
          } else if (fc.name === "glob") {
            const matches = await globModule(args.pattern, { cwd: args.path || projectCwd });
            result = matches.join('\n') || "No matches found";
          } else if (fc.name === "grep") {
             // simplified grep
             const searchCwd = args.path || projectCwd;
             const cmd = `grep -nE "${args.pattern}" -r ${searchCwd}`;
             result = await runBash(cmd);
          } else if (fc.name === "question") {
             result = "User questions are not supported in UI mode yet. Defaulting to empty answers.";
          } else if (fc.name === "skill") {
             result = `Simulated loading skill: ${args.name}`;
          } else if (fc.name === "task") {
             result = `Simulated launching subagent: ${args.subagent_type} (task_id: ${args.task_id || "new"})`;
          } else if (fc.name === "todowrite") {
             result = "Todo list updated in background.";
          } else if (fc.name === "webfetch") {
             try {
                let urlStr = args.url;
                if (urlStr.startsWith("http://")) urlStr = urlStr.replace("http://", "https://");
                if (!urlStr.startsWith("https://")) urlStr = "https://" + urlStr;

                const fetchRes = await fetch(urlStr);
                const html = await fetchRes.text();

                if (args.format === "html") {
                  result = html.substring(0, 50000); // limit size
                } else {
                  // default markdown/text fallback
                  const $ = cheerio.load(html);
                  $('script, style, nav, footer').remove();
                  result = $.text().replace(/\s+/g, ' ').trim().substring(0, 50000);
                }
             } catch (e: any) {
                result = `Error fetching URL: ${e.message}`;
             }
          } else {
            result = `Tool ${fc.name} not implemented locally yet`;
          }
        } catch (e: any) {
          result = `Error: ${e.message}`;
        }
        functionResponses.push({
          functionResponse: {
            name: fc.name,
            response: { result }
          }
        });
      }

      // Return both the model's function calls and the results back to the client
      // so the client can append them to the chat history and make another request.
      emit({
        type: "function_calls",
        message: responseMessage,
        functionResponses: { role: "user", parts: functionResponses }
      });
      res.end();
      return;
    }

    emit({ type: "text", message: responseMessage });
    res.end();
  } catch (error: any) {
    console.error("API error", error);
    if (res.headersSent) {
      try {
        res.end(JSON.stringify({ type: "error", error: error.message }) + "\n");
      } catch {
        res.end();
      }
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();