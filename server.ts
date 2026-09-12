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
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });

function isRetryable(status: number, message: string): boolean {
  if (status === 0) return true; // network-level failure (connection refused, DNS, etc.)
  if (status === 408 || status === 429 || status >= 500) return true;
  return /quota|overload|rate[\s_-]?limit|timeout|busy|unavailable|server|capacity|throttl|too many/i.test(
    message
  );
}

// Read a gateway SSE stream. Reasoning deltas are pushed to the client live,
// while content and tool calls are accumulated into a complete assistant message.
async function readStream(res: any, onReasoning?: (text: string) => void): Promise<any> {
  const reader = res.body?.getReader?.();
  const decoder = new TextDecoder();
  let buffer = "";
  let contentAcc = "";
  let reasoningAcc = "";
  const toolMap = new Map<number, any>();
  let sawChunk = false;

  const build = (): any => {
    const message: any = { content: contentAcc || null };
    if (reasoningAcc) message.reasoning = reasoningAcc;
    if (toolMap.size > 0) message.tool_calls = [...toolMap.values()];
    return message;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return build();
      let ch: any = null;
      try {
        ch = JSON.parse(payload);
      } catch {
        continue;
      }
      if (ch?.error) {
        throw new Error(`OmniRoute stream error: ${String(ch?.error?.message || ch?.error).slice(0, 300)}`);
      }
      const delta = ch?.choices?.[0]?.delta;
      if (!delta) continue;
      sawChunk = true;
      if (typeof delta.reasoning === "string") {
        reasoningAcc += delta.reasoning;
        onReasoning?.(reasoningAcc);
      }
      if (typeof delta.content === "string" && delta.content) contentAcc += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const callIndex = tc.index ?? 0;
          let cur = toolMap.get(callIndex);
          if (!cur) {
            cur = { id: tc.id || `call_${callIndex}`, type: "function", function: { name: "", arguments: "" } };
            toolMap.set(callIndex, cur);
          }
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  // Fallback: gateway responded with plain JSON instead of SSE
  if (!sawChunk && buffer.trim()) {
    try {
      const full = JSON.parse(buffer);
      const msg = full?.choices?.[0]?.message;
      if (msg) {
        return {
          content: msg.content ?? null,
          reasoning: msg.reasoning || msg.reasoning_details?.[0]?.text || "",
          tool_calls: msg.tool_calls || undefined,
        };
      }
    } catch {
      /* not JSON — ignore */
    }
  }
  return build();
}

// OpenAI-compatible chat completion against the OmniRoute gateway.
// Uses SSE streaming so reasoning deltas stream to the client live.
async function chatCompletion(
  messages: any[],
  openaiTools: any[],
  hooks?: { onRetry?: (info: any) => void; onReasoning?: (text: string) => void },
  signal?: AbortSignal
) {
  let lastError: any = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const body: any = {
      model: OMNIROUTE_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 800,
      stream: true,
    };
    if (openaiTools.length > 0) {
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
        signal,
      });

      if (!res.ok) {
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

        if (
          /invalid_api_key|apikey|api.?key|unauthorized|forbidden|model.?not.?found|no such model|invalid model|not a model/i.test(
            code + " " + upstream
          )
        ) {
          console.error(`OmniRoute permanent error (code=${code || res.status}) — aborting`);
          break;
        }
        if (!isRetryable(res.status, upstream)) break;
      } else {
        return await readStream(res, hooks?.onReasoning);
      }
    } catch (e: any) {
      lastError = e;
      if (e?.name === "AbortError") break;
      if (!isRetryable(0, e?.message || "")) break;
    }

    if (attempt < RETRY_DELAYS_MS.length) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      console.log(
        `OmniRoute gateway retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${Math.round(
          delayMs / 1000
        )}s — ${lastError?.message ?? "transient failure"}`
      );
      hooks?.onRetry?.({
        attempt: attempt + 1,
        total: RETRY_DELAYS_MS.length,
        delayMs,
        error: lastError?.message ?? "transient failure",
      });
      await sleep(delayMs, signal);
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

// Detect text-formatted tool calls (opencode <tool_call> XML) when no native tool_calls exist.
function isTextToolCallContent(content: string): boolean {
  if (!content) return false;
  return (
    /<tool_call>/i.test(content) ||
    /<parameter\s+name=[^>]+>/i.test(content) ||
    /<parameter=\w+>/i.test(content) ||
    /<bash>|<glob>|<grep[^>]*>|<read\b[^>]*>|<write\b[^>]*>|<edit\b[^>]*>|<task\b[^>]*>|<webfetch\b[^>]*>/i.test(content)
  );
}

// parseTextToolCalls interprets the opencode XML tool-call forms and returns
// [{ name, args }] compatible with the native functionCall path.
function parseTextToolCalls(content: string): { name: string; args: any }[] {
  const calls: { name: string; args: any }[] = [];
  if (!content) return calls;

  const toolBlocks = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/gi) || [];
  if (toolBlocks.length > 0) {
    for (const block of toolBlocks) {
      const fnMatch = block.match(/<function=([A-Za-z0-9_]+)\b/);
      const name = fnMatch ? fnMatch[1] : null;
      if (!name) continue;
      const args: any = {};
      const openRe = /<parameter\s*\b([^>]*)>/gi;
      let om: RegExpExecArray | null;
      while ((om = openRe.exec(block))) {
        const attrs = om[1];
        let keyMatch =
          attrs.match(/(?:required|name)\s*=\s*["']?([\w .-]+)["']?/i) ||
          attrs.match(/=\s*"?([\w .-]+)"?/i);
        if (!keyMatch) continue;
        const key = keyMatch[1].trim();
        const closeIdx = block.indexOf("</parameter>", om.index);
        if (closeIdx === -1) continue;
        const value = block.slice(om.index + om[0].length, closeIdx).trim();
        args[key] = value;
        om.lastIndex = closeIdx + "</parameter>".length;
      }
      calls.push({ name, args });
    }
    return calls;
  }

  // Self-closing shorthand: <read filePath="/abs/path" />, <edit filePath=".." oldString=".." />
  const selfClosing = /<([A-Za-z][A-Za-z0-9_]*)((?:\s+[\w-]+="[^"]*")*)\s*\/>/gi;
  let sc: RegExpExecArray | null;
  while ((sc = selfClosing.exec(content))) {
    const name = sc[1];
    const args: any = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(sc[2]))) args[am[1]] = am[2];
    if (Object.keys(args).length > 0) calls.push({ name, args });
  }

  // Paired shorthand: <bash>cmd</bash>, <edit filePath="x" oldString="a">b</edit>
  const shorthand = /<([A-Za-z][A-Za-z0-9_]*)((?:\s+[\w-]+="[^"]*")*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = shorthand.exec(content))) {
    const name = m[1];
    const attrs = m[2] || "";
    const body = (m[3] || "").trim();
    if (!attrs && !body) continue;
    const args: any = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrs))) args[am[1]] = am[2];
    if (body) {
      if (name === "bash" || name === "grep") args.command = args.command ?? body;
      else if (name === "glob") args.pattern = args.pattern ?? body;
      else if (name === "read") args.filePath = args.filePath ?? body;
      else if (name === "webfetch") args.url = args.url ?? body;
      else args.content = args.content ?? body;
    }
    calls.push({ name, args });
  }
  return calls;
}

// Convert an OpenAI assistant message back into the client's parts format
function toClientMessage(gptMessage: any) {
  const parts: any[] = [];
  const content = gptMessage?.content || "";
  const calls = gptMessage?.tool_calls || [];
  const textCalls = calls.length === 0 ? parseTextToolCalls(content) : [];

  if (textCalls.length > 0) {
    for (const tc of textCalls) {
      parts.push({ functionCall: { name: tc.name, args: tc.args } });
    }
    const cleanBlocks = content
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
      .replace(/<function=[A-Za-z0-9_]+>[\s\S]*?<\/function>/gi, "")
      .replace(/<parameter(?:\s+required=|name=|=)(["']?)[\w .-]+\1>[\s\S]*?<\/parameter>/gi, "")
      .replace(/<([A-Za-z][A-Za-z0-9_]*)((?:\s+[\w-]+="[^"]*")*)\s*\/>/gi, "")
      .replace(/<([A-Za-z][A-Za-z0-9_]*)((?:\s+[\w-]+="[^"]*")*)>[\s\S]*?<\/\1>/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleanBlocks) parts.unshift({ text: cleanBlocks });
    return { role: "model", parts };
  }

  if (content) parts.push({ text: content });
  for (const tc of calls) {
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

// Workspace root — every project (including the Default one) lives under here.
// Override with OMNIROUTE_WORKSPACE_DIR if you want e.g. /workspace.
const WORKSPACE_ROOT = path.resolve(
  process.env.OMNIROUTE_WORKSPACE_DIR || path.join(process.cwd(), "workspace")
);
const DEFAULT_WORKSPACE = path.join(WORKSPACE_ROOT, "_default");

const MAX_TOOL_RESULT_CHARS = 30000;
const MAX_PAYLOAD_BYTES = 30000;

// Truncate long tool/results output so histories stay within provider context.
function truncate(s: string, max: number = MAX_TOOL_RESULT_CHARS): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated ${s.length - max} chars]`;
}

// Path containment guard — every file tool must stay inside the project workspace.
// Returns the resolved absolute path when inside, otherwise null.
function resolveInside(base: string, target: string): string | null {
  const baseAbs = path.resolve(base);
  const abs = path.resolve(baseAbs, target || ".");
  const rel = path.relative(baseAbs, abs);
  if (rel === "" || (!rel.startsWith("..") && rel !== ".." && !path.isAbsolute(rel))) {
    return abs;
  }
  return null;
}

// Blocks commands that clearly escape the workspace (touch /, sudo, rm -rf /, cd /).
const BASH_ESCAPE_RE =
  /(^|[\s;|&])cd\s+\/\s*([;|&]|$)|(\s|^)sudo\s|rm\s+-rf?\s+(\/\s*([;|&]|$)|\/)/i;

// Helper to execute bash command (restricted to the workspace via cwd + guard)
async function runBash(command: string, timeoutMs: number = 120000, workdir: string = process.cwd()) {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs, cwd: workdir });
    return `Stdout:\n${truncate(stdout)}\nStderr:\n${truncate(stderr)}`;
  } catch (error: any) {
    return `Error executing command: ${error.message}\nStdout:\n${truncate(error.stdout || "")}\nStderr:\n${truncate(error.stderr || "")}`;
  }
}

// Trim the oldest messages so the total payload stays within a provider-friendly
// byte budget. The system message (index 0) is always preserved, and assistant
// tool_calls + their follow-up tool messages are removed as whole units.
function trimMessagesToFit(msgs: any[], maxBytes: number = MAX_PAYLOAD_BYTES): any[] {
  let total = JSON.stringify(msgs).length;
  if (total <= maxBytes) return msgs;
  const kept = [...msgs];
  let i = 1; // keep index 0 (system)
  while (i < kept.length && total > maxBytes) {
    const m = kept[i];
    let cut = 1;
    if (m.role === "assistant" && m.tool_calls) {
      while (i + cut < kept.length && kept[i + cut].role === "tool") cut++;
    }
    if (i + cut >= kept.length && kept.length <= 2) break; // never empty a session
    kept.splice(i, cut);
    total = JSON.stringify(kept).length;
  }
  return kept;
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
    const abs = resolveInside(WORKSPACE_ROOT, path.resolve(process.cwd(), dirPath || ""));
    if (!abs) {
      res.status(400).json({ error: `Path "${dirPath}" is outside the workspace` });
      return;
    }
    await fs.mkdir(abs, { recursive: true });
    res.json({ success: true, path: abs });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/rmdir", async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    const abs = resolveInside(WORKSPACE_ROOT, path.resolve(process.cwd(), dirPath || ""));
    if (!abs) {
      res.status(400).json({ error: `Path "${dirPath}" is outside the workspace` });
      return;
    }
    await fs.rm(abs, { recursive: true, force: true });
    res.json({ success: true, path: abs });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { messages, cwd } = req.body;
  // Always resolve the project cwd inside the workspace root; client paths are
  // relative to the app root (./workspace/<name>). Anything outside falls back
  // to the default workspace folder.
  const projectCwd =
    resolveInside(WORKSPACE_ROOT, path.resolve(process.cwd(), cwd || "")) || DEFAULT_WORKSPACE;
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

    // Abort the gateway request if the client disconnects (e.g. user hits Stop)
    const abortController = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) abortController.abort();
    });

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

    const trimmedMessages = trimMessagesToFit(openaiMessages);
    if (trimmedMessages.length !== openaiMessages.length) {
      console.error(
        `Trimmed history from ${openaiMessages.length} to ${trimmedMessages.length} messages (${JSON.stringify(openaiMessages).length} -> ${JSON.stringify(trimmedMessages).length} bytes)`
      );
    }

    const gptMessage = await chatCompletion(
      trimmedMessages,
      tools,
      {
        onRetry: (info) => emit({ type: "retry", ...info }),
        onReasoning: (text) => emit({ type: "reasoning", text }),
      },
      abortController.signal
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
            if (BASH_ESCAPE_RE.test(args.command || "")) {
              result = "Error: command blocked — bash cannot touch paths outside the workspace (no cd /, sudo, or rm -rf /)";
            } else {
              const wd = resolveInside(projectCwd, args.workdir || ".");
              if (!wd) {
                result = `Error: workdir "${args.workdir}" is outside the workspace`;
              } else {
                result = await runBash(args.command, args.timeout, wd);
              }
            }
          } else if (fc.name === "read") {
            const targetPath = resolveInside(projectCwd, args.filePath);
            if (!targetPath) {
              result = `Error: path "${args.filePath}" is outside the workspace`;
            } else {
              const content = await fs.readFile(targetPath, "utf8");
              const lines = content.split('\n');
              const offset = args.offset ? args.offset - 1 : 0;
              const limit = args.limit || 2000;
              const slice = lines.slice(offset, offset + limit);
              result = slice.map((line, i) => `${offset + i + 1}: ${line}`).join('\n');
            }
          } else if (fc.name === "write") {
            const targetPath = resolveInside(projectCwd, args.filePath);
            if (!targetPath) {
              result = `Error: path "${args.filePath}" is outside the workspace`;
            } else {
              await fs.writeFile(targetPath, args.content, "utf8");
              result = `File written to ${targetPath} (workspace-restricted)`;
            }
          } else if (fc.name === "edit") {
            const targetPath = resolveInside(projectCwd, args.filePath);
            if (!targetPath) {
              result = `Error: path "${args.filePath}" is outside the workspace`;
            } else {
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
            }
          } else if (fc.name === "glob") {
            const searchCwd = resolveInside(projectCwd, args.path || ".");
            if (!searchCwd) {
              result = `Error: path "${args.path}" is outside the workspace`;
            } else {
              const matches = await globModule(args.pattern, { cwd: searchCwd });
              result = matches.join('\n') || "No matches found";
            }
          } else if (fc.name === "grep") {
             const searchCwd = resolveInside(projectCwd, args.path || ".");
             if (!searchCwd) {
               result = `Error: path "${args.path}" is outside the workspace`;
             } else {
               const cmd = `grep -nE "${args.pattern}" -r "${searchCwd}"`;
               result = await runBash(cmd);
             }
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
                  result = html.substring(0, MAX_TOOL_RESULT_CHARS);
                } else {
                  // default markdown/text fallback
                  const $ = cheerio.load(html);
                  $('script, style, nav, footer').remove();
                  result = $.text().replace(/\s+/g, ' ').trim().substring(0, MAX_TOOL_RESULT_CHARS);
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
  // Create the workspace directories so tools never operate outside them.
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(DEFAULT_WORKSPACE, { recursive: true });
  console.error(`Workspace dir ready at ${WORKSPACE_ROOT}`);

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