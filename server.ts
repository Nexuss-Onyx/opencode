import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { glob as globModule } from "glob";
import * as cheerio from "cheerio";
import fetch from "node-fetch";

const execAsync = promisify(exec);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
app.use(express.json());

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

// Tool definitions for Gemini
const tools = [
  {
    name: "bash",
    description: "Executes a given bash command in a persistent shell session.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING },
        timeout: { type: Type.INTEGER, description: "Timeout in milliseconds" },
        workdir: { type: Type.STRING, description: "Working directory" }
      },
      required: ["command"],
    }
  },
  {
    name: "edit",
    description: "Performs exact string replacements in files.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: { type: Type.STRING },
        oldString: { type: Type.STRING },
        newString: { type: Type.STRING },
        replaceAll: { type: Type.BOOLEAN }
      },
      required: ["filePath", "oldString", "newString"],
    }
  },
  {
    name: "glob",
    description: "Fast file pattern matching tool.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: { type: Type.STRING },
        path: { type: Type.STRING }
      },
      required: ["pattern"],
    }
  },
  {
    name: "grep",
    description: "Fast content search tool.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: { type: Type.STRING },
        path: { type: Type.STRING },
        include: { type: Type.STRING }
      },
      required: ["pattern"],
    }
  },
  {
    name: "read",
    description: "Read a file or directory from the local filesystem.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: { type: Type.STRING },
        offset: { type: Type.INTEGER },
        limit: { type: Type.INTEGER }
      },
      required: ["filePath"],
    }
  },
  {
    name: "write",
    description: "Writes a file to the local filesystem.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: { type: Type.STRING },
        content: { type: Type.STRING }
      },
      required: ["filePath", "content"],
    }
  },
  {
    name: "question",
    description: "Use this tool when you need to ask the user questions during execution.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        questions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING },
              header: { type: Type.STRING },
              options: { type: Type.ARRAY, items: { type: Type.STRING } },
              multiple: { type: Type.BOOLEAN }
            }
          }
        }
      },
      required: ["questions"],
    }
  },
  {
    name: "skill",
    description: "Load a specialized skill when the task at hand matches one of the skills listed in the system prompt.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING }
      },
      required: ["name"],
    }
  },
  {
    name: "task",
    description: "Launch a new agent to handle complex, multistep tasks autonomously.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING },
        prompt: { type: Type.STRING },
        subagent_type: { type: Type.STRING },
        task_id: { type: Type.STRING },
        command: { type: Type.STRING }
      },
      required: ["description", "prompt", "subagent_type"],
    }
  },
  {
    name: "todowrite",
    description: "Create and maintain a structured task list for the current coding session.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        todos: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              content: { type: Type.STRING },
              status: { type: Type.STRING },
              priority: { type: Type.STRING }
            }
          }
        }
      },
      required: ["todos"],
    }
  },
  {
    name: "webfetch",
    description: "Fetches content from a specified URL.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING },
        format: { type: Type.STRING },
        timeout: { type: Type.INTEGER }
      },
      required: ["url"],
    }
  }
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

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: formattedMessages,
      config: {
        systemInstruction: systemInstruction,
        tools: [{ functionDeclarations: tools }],
      },
    });
    
    // We handle function calls on the server
    const responseMessage: any = {
      role: "model",
      parts: response.candidates?.[0]?.content?.parts || [{ text: response.text }]
    };

    if (response.functionCalls?.length) {
      // Execute functions
      const functionResponses = [];
      for (const fc of response.functionCalls) {
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
      res.json({
        type: "function_calls",
        message: responseMessage,
        functionResponses: { role: "user", parts: functionResponses }
      });
      return;
    }

    res.json({ type: "text", message: responseMessage });
  } catch (error: any) {
    console.error("API error", error);
    res.status(500).json({ error: error.message });
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
