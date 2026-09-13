/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { 
  Menu, 
  LayoutGrid, 
  PenSquare, 
  X, 
  Plus, 
  Minus, 
  Square, 
  ArrowUp, 
  GitBranch, 
  Folder,
  StopCircle,
  ChevronUp,
  ChevronDown,
  Terminal,
  PenLine,
  BookOpen,
  FilePlus2,
  ListFilter,
  Search,
  Globe,
  ListChecks,
  HelpCircle,
  Sparkles,
  Bot,
  PanelRightClose,
  Cpu
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Message, Session, Project } from "./types";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type ToolRun = {
  id: string;
  name: string;
  status: "running" | "done" | "error" | "stopped";
  ms?: number;
  preview?: string;
};

type TodoItem = {
  id?: string;
  content: string;
  status: string;
  priority?: string | null;
};

const TOOL_ICONS: Record<string, any> = {
  bash: Terminal,
  edit: PenLine,
  read: BookOpen,
  write: FilePlus2,
  glob: ListFilter,
  grep: Search,
  webfetch: Globe,
  todowrite: ListChecks,
  question: HelpCircle,
  skill: Sparkles,
  task: Bot
};

const TOOL_COLORS: Record<string, string> = {
  bash: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  edit: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  read: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  write: "text-violet-400 bg-violet-500/10 border-violet-500/20",
  glob: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
  grep: "text-teal-400 bg-teal-500/10 border-teal-500/20",
  webfetch: "text-indigo-400 bg-indigo-500/10 border-indigo-500/20",
  todowrite: "text-rose-400 bg-rose-500/10 border-rose-500/20",
  question: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  skill: "text-fuchsia-400 bg-fuchsia-500/10 border-fuchsia-500/20",
  task: "text-green-400 bg-green-500/10 border-green-500/20"
};

const ACTIVE_LABEL: Record<string, string> = {
  bash: "exec…",
  read: "Reading…",
  write: "Writing…",
  edit: "Editing…",
  glob: "Searching…",
  grep: "Grepping…",
  webfetch: "Fetching…",
  todowrite: "Syncing todos…",
  question: "Asking you…",
  skill: "Loading…",
  task: "Delegating…"
};

function toolDoneText(name: string): string {
  switch (name) {
    case "bash": return "Ran";
    case "read": return "Read";
    case "write": return "Written";
    case "edit": return "Edited";
    case "glob": return "Found";
    case "grep": return "Matches";
    case "webfetch": return "Fetched";
    case "todowrite": return "Todo updated";
    case "question": return "Answered";
    case "skill": return "Skill ready";
    case "task": return "Report ready";
    default: return "Done";
  }
}

function toolFailedText(name: string): string {
  switch (name) {
    case "bash": return "Command failed";
    case "read": return "Read failed";
    case "write": return "Write failed";
    case "edit": return "Edit failed";
    case "glob": return "Search failed";
    case "grep": return "Grep failed";
    case "webfetch": return "Fetch failed";
    case "todowrite": return "Todo sync failed";
    case "question": return "Ask cancelled";
    case "skill": return "Load failed";
    case "task": return "Delegation failed";
    default: return "Failed";
  }
}

function ToolRow({ run }: { run: ToolRun }) {
  const Icon = TOOL_ICONS[run.name] || Cpu;
  const colorCls = TOOL_COLORS[run.name] || "text-gray-400 bg-gray-500/10 border-gray-500/20";
  const st =
    run.status === "done"
      ? { val: toolDoneText(run.name), cls: "text-emerald-400" }
      : run.status === "error"
        ? { val: toolFailedText(run.name), cls: "text-red-400" }
        : run.status === "stopped"
          ? { val: "Interrupted", cls: "text-gray-500" }
          : { val: ACTIVE_LABEL[run.name] || `${run.name}…`, cls: "text-gray-400" };
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-[#222] bg-[#141414]">
      <span className={cn("w-7 h-7 rounded-md border grid place-items-center shrink-0", colorCls)}>
        <Icon size={14} />
      </span>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-[12px] font-medium text-gray-300">{run.name}</span>
        <span className={cn("text-[11px] font-mono", st.cls)}>
          {st.val}
          {run.ms != null && run.status !== "running" ? ` · ${run.ms}ms` : ""}
        </span>
      </div>
      {run.preview && (
        <span className="text-[10px] text-gray-600 truncate max-w-[110px] font-mono" title={run.preview}>
          {run.preview}
        </span>
      )}
    </div>
  );
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>(() => {
    const saved = localStorage.getItem("opencode_projects");
    if (saved) {
      let savedProjects: Project[] = JSON.parse(saved);
      // One-time migration: default project -> dedicated workspace folder,
      // old ./projects/* -> ./workspace/*
      savedProjects = savedProjects.map((p) => {
        if (p.id === 'default') return { ...p, path: './workspace/_default' };
        if (p.path && /^(\.\/)?projects\//.test(p.path)) {
          return { ...p, path: `./workspace/${p.path.replace(/^(\.\/)?projects\//, '')}` };
        }
        return p;
      });
      return savedProjects;
    }
    return [{ id: 'default', name: 'Default', path: './workspace/_default' }];
  });
  const [activeProjectId, setActiveProjectId] = useState(() => {
    return localStorage.getItem("opencode_active_project") || projects[0]?.id || 'default';
  });
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);
  const [isGridMenuOpen, setIsGridMenuOpen] = useState(false);

  const [sessions, setSessions] = useState<Session[]>(() => {
    const saved = localStorage.getItem("opencode_sessions");
    if (saved) return JSON.parse(saved);
    return [{ id: uuidv4(), title: "New session", messages: [], projectId: 'default' }];
  });
  
  const activeProject = projects.find(p => p.id === activeProjectId) || projects[0];
  const projectSessions = sessions.filter(s => (s.projectId || 'default') === activeProjectId);

  const [activeSessionId, setActiveSessionId] = useState(projectSessions[0]?.id);
  const [inputValue, setInputValue] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; total: number; delayMs: number; error: string } | null>(null);
  const [reasoningText, setReasoningText] = useState<string>("");
  const [workingExpanded, setWorkingExpanded] = useState(true);
  const [benchOpen, setBenchOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem("opencode_bench_open");
    return saved ? saved === "true" : false;
  });
  const [pillLabel, setPillLabel] = useState<string>("Working…");
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const [toolFeed, setToolFeed] = useState<ToolRun[]>([]);
  const [chunks, setChunks] = useState<{ text: string; ts: number }[]>([]);
  const isThinkingRef = useRef(isThinking);
  const pendingSessionRef = useRef<{ session: Session; cwd: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastReasoningLenRef = useRef(0);
  const chunkLogRef = useRef<{ text: string; ts: number }[]>([]);
  const lastChunkAtRef = useRef(0);
  const momentumRef = useRef({ v: 0 });
  const thinkingScrollRef = useRef<HTMLDivElement>(null);
  
  // Custom dialog state for iframe safety
  const [newProjectModalOpen, setNewProjectModalOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [deleteProjectModalOpen, setDeleteProjectModalOpen] = useState<Project | null>(null);

  const activeSession = sessions.find(s => s.id === activeSessionId) || projectSessions[0] || sessions[0];
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem("opencode_projects", JSON.stringify(projects));
  }, [projects]);

  useEffect(() => {
    localStorage.setItem("opencode_active_project", activeProjectId);
  }, [activeProjectId]);

  useEffect(() => {
    localStorage.setItem("opencode_sessions", JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem("opencode_bench_open", String(benchOpen));
  }, [benchOpen]);

  useEffect(() => {
    setTodoItems([]);
  }, [activeSessionId]);

  useEffect(() => {
    if (!projectSessions.find(s => s.id === activeSessionId)) {
      if (projectSessions.length > 0) {
        setActiveSessionId(projectSessions[0].id);
      } else {
        const newSession = { id: uuidv4(), title: "New session", messages: [], projectId: activeProjectId };
        setSessions(prev => [...prev, newSession]);
        setActiveSessionId(newSession.id);
      }
    }
  }, [activeProjectId, projectSessions, activeSessionId]);

  useEffect(() => {
    isThinkingRef.current = isThinking;
    if (!isThinking && !pendingSessionRef.current) setIsReconnecting(false);
  }, [isThinking]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    }
  }, [activeSessionId]);

  useEffect(() => {
    const msgs = activeSession?.messages;
    if (!msgs?.length) return;
    const last = msgs[msgs.length - 1];
    if (last?.role !== "model" || !last.parts?.some((p: any) => p.text)) return;
    if (last.parts?.some((p: any) => p.functionCall)) return;
    const el = messagesContainerRef.current;
    if (el) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
  }, [activeSession?.messages]);

  useEffect(() => {
    const goOnline = () => {
      setIsOffline(false);
      const pending = pendingSessionRef.current;
      if (pending) {
        pendingSessionRef.current = null;
        setIsReconnecting(false);
        setIsThinking(true);
        processChat(pending.session, pending.cwd).catch((e) => console.error(e));
      } else {
        setIsReconnecting(false);
      }
    };
    const goOffline = () => {
      setIsOffline(true);
      if (isThinkingRef.current) setIsReconnecting(true);
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const cutoff = now - 1000;
      const log = chunkLogRef.current;
      let rate = 0;
      for (const c of log) if (c.ts >= cutoff) rate++;
      while (log.length && log[0].ts < now - 2000) log.shift();
      const target = rate > 0 ? Math.min(160, 28 + 22 * rate) : 0;
      momentumRef.current.v += (target - momentumRef.current.v) * 0.35;
      if (benchOpen && momentumRef.current.v > 1 && thinkingScrollRef.current) {
        thinkingScrollRef.current.scrollTop += momentumRef.current.v * 0.09;
      }
    }, 90);
    return () => clearInterval(id);
  }, [benchOpen]);

  useEffect(() => {
    if (benchOpen && thinkingScrollRef.current) {
      requestAnimationFrame(() => {
        const el = thinkingScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [benchOpen]);

  useEffect(() => {
    if (!isThinking) {
      setPillLabel("Working…");
      return;
    }
    const tick = () => {
      const running = toolFeed.find(t => t.status === "running");
      if (running) {
        setPillLabel(ACTIVE_LABEL[running.name] || `${running.name}…`);
        return;
      }
      const idle = Date.now() - lastChunkAtRef.current;
      if (lastChunkAtRef.current && idle < 3000) {
        const log = chunkLogRef.current;
        let tail = "";
        for (let i = log.length - 1; i >= 0; i--) {
          const t = log[i].text.trim();
          if (t) { tail = t; break; }
        }
        const flat = tail.replace(/\s+/g, " ");
        setPillLabel(flat.length > 70 ? "…" + flat.slice(-70) : flat);
      } else {
        setPillLabel("Working…");
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [isThinking, toolFeed]);

  const handleNewSession = () => {
    const newSession = { id: uuidv4(), title: "New session", messages: [], projectId: activeProjectId };
    setSessions([...sessions, newSession]);
    setActiveSessionId(newSession.id);
  };

  const handleCreateProjectClick = () => {
    setNewProjectName("");
    setNewProjectModalOpen(true);
    setIsProjectDropdownOpen(false);
  };

  const submitCreateProject = async () => {
    if (!newProjectName.trim()) return;
    const safeName = newProjectName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const newPath = `./workspace/${safeName}`;
    
    await fetch("/api/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: newPath })
    });

    const newProj = { id: uuidv4(), name: newProjectName.trim(), path: newPath };
    setProjects(prev => [...prev, newProj]);
    setActiveProjectId(newProj.id);
    setNewProjectModalOpen(false);
  };

  const handleDeleteProjectClick = (proj: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    if (proj.id === 'default') return; // Cannot delete default
    setDeleteProjectModalOpen(proj);
    setIsProjectDropdownOpen(false);
  };

  const submitDeleteProject = async () => {
    const proj = deleteProjectModalOpen;
    if (!proj) return;

    await fetch("/api/rmdir", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: proj.path })
    });

    const newProjects = projects.filter(p => p.id !== proj.id);
    setProjects(newProjects);
    if (activeProjectId === proj.id) {
      setActiveProjectId(newProjects[0].id);
    }
    setDeleteProjectModalOpen(null);
  };

  const handleCloseSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSessions = sessions.filter(s => s.id !== id);
    const remainingProjectSessions = newSessions.filter(s => (s.projectId || 'default') === activeProjectId);
    
    if (remainingProjectSessions.length === 0) {
      const newSession = { id: uuidv4(), title: "New session", messages: [], projectId: activeProjectId };
      setSessions([...newSessions, newSession]);
      setActiveSessionId(newSession.id);
    } else {
      setSessions(newSessions);
      if (activeSessionId === id) {
        setActiveSessionId(remainingProjectSessions[remainingProjectSessions.length - 1].id);
      }
    }
  };

  const handleSelectProjectFromGrid = (projectId: string) => {
    setActiveProjectId(projectId);
    // Explicitly create a new session (tab) when selected from this menu
    const newSession = { id: uuidv4(), title: "New session", messages: [], projectId };
    setSessions(prev => [...prev, newSession]);
    setActiveSessionId(newSession.id);
    setIsGridMenuOpen(false);
  };

  const handleSend = async () => {
    if (!inputValue.trim() || isThinking) return;

    const newUserMsg: Message = { role: "user", parts: [{ text: inputValue }] };
    
    // Update session
    let currentSession = { ...activeSession };
    if (currentSession.messages.length === 0) {
      // First message, rename session
      const date = new Date().toISOString().split('T')[0];
      currentSession.title = `New session - ${date}`;
    }
    
    currentSession.messages = [...currentSession.messages, newUserMsg];
    
    setSessions(prev => prev.map(s => s.id === currentSession.id ? currentSession : s));
    setInputValue("");
    setIsThinking(true);

    const scroller = messagesContainerRef.current;
    if (scroller) {
      requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }));
    }

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setIsOffline(true);
      setIsReconnecting(true);
      pendingSessionRef.current = { session: currentSession, cwd: activeProject.path };
      return;
    }

    try {
      abortRef.current = new AbortController();
      await processChat(currentSession, activeProject.path);
    } catch (e) {
      console.error(e);
    } finally {
      setIsThinking(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    pendingSessionRef.current = null;
    setIsThinking(false);
    setIsReconnecting(false);
    setRetryInfo(null);
    setReasoningText("");
    setToolFeed(prev => prev.map(t => t.status === "running" ? { ...t, status: "stopped" } : t));
  };

  const processChat = async (session: Session, cwdOverride?: string) => {
    const cwd = cwdOverride || activeProject.path;
    let currentMessages = [...session.messages];
    let keepGoing = true;
    let emptyRounds = 0;
    setRetryInfo(null);
    setReasoningText("");
    setToolFeed([]);
    setChunks([]);
    lastReasoningLenRef.current = 0;
    lastChunkAtRef.current = 0;
    momentumRef.current.v = 0;
    chunkLogRef.current = [];
    console.log("[chat] round start", { cwd, messages: currentMessages.length });

    while (keepGoing) {
      // One "round" = fetch + read the NDJSON stream. Transient network errors
      // (e.g. keep-alive socket reuse races) are retried a couple times before
      // we give up and queue for reconnect.
      let data: any = null;
      let attempt = 0;
      for (; attempt < 3; attempt++) {
        if (attempt > 0) {
          console.warn(`[chat] retrying round (${attempt}/2) after transient failure`);
          await new Promise(r => setTimeout(r, 500 * attempt));
        }
        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: currentMessages, cwd }),
            signal: abortRef.current?.signal
          });
          console.log("[chat] POST /api/chat ->", res.status, res.statusText);

          if (!res.ok) {
            let errMsg = "";
            try {
              const errData = await res.json();
              errMsg = errData.error || "Unknown error";
            } catch {
              errMsg = `HTTP ${res.status}`;
            }
            console.error("[chat] non-OK response", res.status, errMsg);
            currentMessages.push({ role: "model", parts: [{ text: `Error: ${errMsg}` }] });
            setSessions(prev => prev.map(s => s.id === session.id ? { ...s, messages: currentMessages } : s));
            keepGoing = false;
            break;
          }

          // NDJSON event stream: read retry/reasoning progress, then the final payload
          const reader = res.body?.getReader();
          if (!reader) throw new Error("No response body reader");
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line) continue;
              let evt: any;
              try { evt = JSON.parse(line); } catch { continue; }
              if (evt.type === "retry") {
                setRetryInfo({ attempt: evt.attempt, total: evt.total, delayMs: evt.delayMs, error: evt.error });
              } else if (evt.type === "reasoning") {
                const full = String(evt.text ?? "");
                const prevLen = lastReasoningLenRef.current;
                const delta = full.length > prevLen ? full.slice(prevLen) : full;
                lastReasoningLenRef.current = full.length;
                setReasoningText(full);
                if (delta.trim()) {
                  const ts = Date.now();
                  chunkLogRef.current.push({ text: delta, ts });
                  lastChunkAtRef.current = ts;
                  setChunks(prev => prev.length > 300 ? [...prev.slice(prev.length - 300), { text: delta, ts }] : [...prev, { text: delta, ts }]);
                }
              } else if (evt.type === "tool") {
                setToolFeed(prev => {
                  if (evt.status === "running") {
                    if (prev.some(t => t.id === evt.id)) {
                      return prev.map(t => t.id === evt.id ? { ...t, status: "running" } : t);
                    }
                    return [...prev, { id: evt.id, name: String(evt.name ?? "tool"), status: "running" }];
                  }
                  return prev.map(t => t.id === evt.id
                    ? { ...t, status: evt.status, ms: evt.ms, preview: evt.preview }
                    : t);
                });
              } else if (evt.type === "todo") {
                if (Array.isArray(evt.items)) setTodoItems(evt.items);
              } else if (evt.type === "function_calls" || evt.type === "text") {
                data = evt;
              } else if (evt.type === "error") {
                currentMessages.push({ role: "model", parts: [{ text: `Error: ${evt.error}` }] });
                setSessions(prev => prev.map(s => s.id === session.id ? { ...s, messages: currentMessages } : s));
                keepGoing = false;
              }
            }
          }
          console.log("[chat] stream ended, terminal event:", data ? data.type : "NONE (no terminal event!)");
          break; // round finished (with or without data)
        } catch (e: any) {
          if (e?.name === "AbortError") {
            console.log("[chat] aborted by Stop");
            keepGoing = false;
            return;
          }
          console.error(`[chat] round failure (${attempt + 1}/3)`, e);
          if (attempt >= 2) {
            // Network dropped mid-request — queue for reconnect, show immediate feedback
            setIsOffline(true);
            setIsReconnecting(true);
            pendingSessionRef.current = { session: { ...session, messages: currentMessages }, cwd };
            return;
          }
        }
      }

      if (keepGoing && data && data.type === "function_calls") {
        console.log("[chat] function_calls received, continuing loop");
        currentMessages.push(data.message);
        currentMessages.push(data.functionResponses);
        // update UI with new messages
        setSessions(prev => prev.map(s => s.id === session.id ? { ...s, messages: currentMessages } : s));
      } else if (keepGoing && data) {
        console.log("[chat] text received, finishing turn");
        currentMessages.push(data.message);
        setSessions(prev => prev.map(s => s.id === session.id ? { ...s, messages: currentMessages } : s));
        keepGoing = false;
      } else if (keepGoing) {
        emptyRounds++;
        console.error(`[chat] empty round ${emptyRounds}/2 (server ended stream without a terminal event)`);
        if (emptyRounds >= 2) {
          currentMessages.push({ role: "model", parts: [{ text: "Error: the server ended the request without a response. Try again." }] });
          setSessions(prev => prev.map(s => s.id === session.id ? { ...s, messages: currentMessages } : s));
          keepGoing = false;
        }
      }
    }
  };

  return (
    <div className="flex h-screen w-full bg-[#0d0d0d] text-gray-300 font-sans selection:bg-gray-700">
      <div className="relative flex-1 min-w-0 flex flex-col">
      {/* Title bar */}
      <div className="flex items-center justify-between h-12 px-3 border-b border-[#222]">
        <div className="flex items-center gap-3">
          <button className="p-1.5 hover:bg-[#222] rounded text-gray-400">
            <Menu size={18} />
          </button>
          
          <div className="relative flex items-center">
            <button 
              className="p-1.5 hover:bg-[#222] rounded text-gray-400"
              onClick={() => setIsGridMenuOpen(!isGridMenuOpen)}
            >
              <LayoutGrid size={18} />
            </button>
            {isGridMenuOpen && (
              <>
                <div 
                  className="fixed inset-0 z-40" 
                  onClick={() => setIsGridMenuOpen(false)}
                />
                <div className="absolute top-full left-0 mt-2 w-56 bg-[#1a1a1a] border border-[#333] rounded-md shadow-xl overflow-hidden z-50 flex flex-col">
                  <div className="px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wider border-b border-[#333]">
                    Projects
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {projects.map(p => (
                      <div 
                        key={p.id}
                        onClick={() => handleSelectProjectFromGrid(p.id)}
                        className={cn(
                          "px-3 py-2 text-[13px] flex items-center gap-2 hover:bg-[#2a2a2a] cursor-pointer",
                          p.id === activeProjectId ? "text-gray-100 bg-[#222]" : "text-gray-400"
                        )}
                      >
                        <Folder size={14} />
                        <span className="truncate flex-1">{p.name}</span>
                      </div>
                    ))}
                  </div>
                  <div 
                    className="px-3 py-2 border-t border-[#333] hover:bg-[#2a2a2a] cursor-pointer flex items-center gap-2 text-gray-300 text-[13px]"
                    onClick={handleCreateProjectClick}
                  >
                    <Plus size={14} />
                    <span>New Project</span>
                  </div>
                </div>
              </>
            )}
          </div>
          
          <div className="flex items-center ml-2 h-full gap-1 overflow-x-auto max-w-[60vw] hide-scrollbar">
            {projectSessions.map(s => (
              <div 
                key={s.id}
                onClick={() => setActiveSessionId(s.id)}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-t-md cursor-pointer text-sm max-w-[200px] border-t border-l border-r border-transparent",
                  s.id === activeSessionId ? "bg-[#222] text-gray-100 border-[#333]" : "hover:bg-[#1a1a1a] text-gray-500"
                )}
              >
                <PenSquare size={14} className="shrink-0" />
                <span className="truncate flex-1">{s.title}</span>
                <button 
                  onClick={(e) => handleCloseSession(s.id, e)}
                  className="p-0.5 hover:bg-[#444] rounded shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ opacity: s.id === activeSessionId ? 1 : undefined }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button onClick={handleNewSession} className="p-1.5 hover:bg-[#222] rounded text-gray-400 ml-1">
              <Plus size={16} />
            </button>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium tracking-wide">OpenCode</span>
          <div className="flex items-center gap-1 ml-4 text-gray-500">
            <button className="p-1.5 hover:bg-[#222] rounded"><Minus size={16} /></button>
            <button className="p-1.5 hover:bg-[#222] rounded"><Square size={14} /></button>
            <button className="p-1.5 hover:bg-red-900/50 hover:text-red-400 rounded"><X size={16} /></button>
          </div>
        </div>
      </div>

      {/* Offline / reconnecting banner */}
      {isOffline && (
        <div className="fixed top-14 left-1/2 -translate-x-1/2 z-[90] flex items-center gap-3 rounded-xl border border-amber-900/40 bg-[#1c160c]/95 px-4 py-2.5 shadow-2xl shadow-black/60 backdrop-blur">
          <div className="relative flex items-center justify-center w-4 h-4">
            <span
              className="thinking-spinner"
              style={{ borderColor: "rgba(245,158,11,0.25)", borderTopColor: "#f59e0b" }}
            />
          </div>
          <div className="flex items-center gap-[3px]">
            <span className="thinking-dot" style={{ background: "#f59e0b" }} />
            <span className="thinking-dot" style={{ background: "#f59e0b", animationDelay: "0.15s" }} />
            <span className="thinking-dot" style={{ background: "#f59e0b", animationDelay: "0.3s" }} />
          </div>
          {isReconnecting ? (
            <span className="text-[13px] font-medium text-amber-300">
              Connection lost — turn on your internet. Reconnecting…
            </span>
          ) : (
            <span className="text-[13px] font-medium text-amber-300">
              You're offline — reconnecting…
            </span>
          )}
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col relative overflow-hidden">
        {activeSession.messages.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <h1 className="text-[12vw] font-black text-[#151515] tracking-tighter uppercase select-none">
              opencode
            </h1>
          </div>
        ) : (
          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-4 md:px-24 py-8 pb-64" style={{ scrollPaddingBottom: "16rem" }}>
            <div className="max-w-3xl mx-auto flex flex-col gap-6">
              {activeSession.messages.map((msg, i) => {
                if (!msg) return null;
                return (
                <div key={i} className={cn("flex flex-col gap-1", msg.role === "user" ? "items-end" : "items-start")}>
                  {msg.role === "model" && msg.parts.some(p => p.functionCall) && (
                    <button
                      onClick={() => setBenchOpen(true)}
                      title="Open Tool Bench"
                      className="text-[12px] text-gray-400 hover:text-gray-200 flex items-center gap-2 bg-[#161616] hover:bg-[#1c1c1c] px-3 py-1.5 rounded-md border border-[#2a2a2a] transition-colors select-none cursor-pointer max-w-[90%]"
                    >
                      <Cpu size={12} className="shrink-0 text-gray-500" />
                      <span className="shrink-0">Used tools:</span>
                      <span className="truncate text-gray-500">
                        {msg.parts.filter(p => p.functionCall).map(p => (p as any).functionCall?.name).join(" · ")}
                      </span>
                      <span className="shrink-0 text-gray-600">view ⟩</span>
                    </button>
                  )}
                  {msg.parts.map((p, j) => {
                    if (p.text) {
                      return (
                        <div 
                          key={j} 
                          className={cn(
                            "px-4 py-2.5 rounded-2xl max-w-[85%] break-words",
                            msg.role === "user" 
                              ? "bg-[#2a2a2a] text-gray-100 rounded-tr-sm" 
                              : "bg-transparent text-gray-300"
                          )}
                        >
                          <pre className="whitespace-pre-wrap font-sans text-[15px] leading-relaxed">{p.text}</pre>
                        </div>
                      )
                    }
                    return null;
                  })}
                </div>
              )})}
            </div>
          </div>
        )}

        {/* Input Area */}
        <div className={cn(
          "absolute left-1/2 -translate-x-1/2 w-full max-w-3xl px-4 transition-all duration-300",
          activeSession.messages.length === 0 ? "top-1/2 -translate-y-1/2 mt-16" : "bottom-6"
        )}>
          {isThinking && (
            <div className="mb-3 rounded-xl border border-[#222] bg-[#151515]/95 shadow-2xl shadow-black/40 overflow-hidden backdrop-blur">
              <button
                onClick={() => setWorkingExpanded(!workingExpanded)}
                className="w-full flex items-center gap-2.5 px-4 py-2.5 hover:bg-[#1c1c1c] transition-colors cursor-pointer select-none text-left"
                title={workingExpanded ? "Collapse" : "Expand"}
              >
                <span className="flex items-center gap-[3px] shrink-0">
                  <span className="thinking-dot" />
                  <span className="thinking-dot" style={{ animationDelay: "0.15s" }} />
                  <span className="thinking-dot" style={{ animationDelay: "0.3s" }} />
                </span>
                <span className="thinking-label text-[13px] font-medium tracking-wide text-gray-400 shrink-0">Working</span>
                {retryInfo && (
                  <span className="text-[12px] text-amber-300/90 truncate">
                    Retrying {retryInfo.attempt}/{retryInfo.total} in {Math.round(retryInfo.delayMs / 1000)}s — {retryInfo.error}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1 text-gray-500 shrink-0">
                  {workingExpanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                </span>
              </button>
              {workingExpanded && (
                <div className="border-t border-[#222] px-4 py-3">
                  {retryInfo ? (
                    <span className="text-[12px] text-amber-300/90 italic block">
                      Waiting for the gateway — {retryInfo.error}
                    </span>
                  ) : reasoningText ? (
                    <div className="max-h-64 overflow-y-auto text-[12px] leading-relaxed text-gray-400 whitespace-pre-wrap pr-2">
                      {reasoningText}
                    </div>
                  ) : (
                    <span className="text-[12px] text-gray-500 italic block">Running your request…</span>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="bg-[#181818] border border-[#2a2a2a] rounded-xl flex flex-col overflow-hidden shadow-2xl focus-within:border-[#444] transition-colors">
            <textarea
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask anything, / for commands, @ for context..."
              className="w-full bg-transparent p-4 min-h-[60px] max-h-[300px] resize-none outline-none text-[15px] placeholder:text-gray-600"
              rows={1}
            />
            <div className="flex items-center justify-between px-3 pb-3">
              <button className="text-gray-500 hover:text-gray-300 transition-colors p-1">
                <Plus size={20} />
              </button>
              <button 
                onClick={isThinking ? handleStop : handleSend}
                disabled={!isThinking && !inputValue.trim()}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  isThinking
                    ? "bg-red-900/40 hover:bg-red-900/70 text-red-300"
                    : "bg-[#2a2a2a] hover:bg-[#3a3a3a] disabled:opacity-50 disabled:hover:bg-[#2a2a2a] text-gray-300"
                )}
                title={isThinking ? "Stop" : "Send"}
              >
                {isThinking ? <StopCircle size={18} /> : <ArrowUp size={18} />}
              </button>
            </div>
          </div>
          
          {/* Footer info */}
          <div className="flex justify-center items-center gap-4 mt-4 text-[11px] text-gray-500 font-medium relative">
            <div 
              className="flex items-center gap-1.5 cursor-pointer hover:text-gray-300 relative"
              onClick={() => setIsProjectDropdownOpen(!isProjectDropdownOpen)}
            >
              <Folder size={12} />
              <span>{activeProject.name}</span>
              
              {isProjectDropdownOpen && (
                <>
                  <div 
                    className="fixed inset-0 z-40" 
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsProjectDropdownOpen(false);
                    }}
                  />
                  <div 
                    className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-[#1a1a1a] border border-[#333] rounded-md shadow-xl overflow-hidden z-50 flex flex-col"
                    onClick={e => e.stopPropagation()}
                  >
                  <div className="max-h-48 overflow-y-auto">
                    {projects.map(p => (
                      <div 
                        key={p.id}
                        onClick={() => {
                          setActiveProjectId(p.id);
                          setIsProjectDropdownOpen(false);
                        }}
                        className={cn(
                          "px-3 py-2 text-[12px] flex items-center justify-between hover:bg-[#2a2a2a] cursor-pointer",
                          p.id === activeProjectId ? "text-gray-100 bg-[#222]" : "text-gray-400"
                        )}
                      >
                        <span className="truncate flex-1 text-left">{p.name}</span>
                        {p.id !== 'default' && (
                          <button 
                            className="p-1 hover:bg-[#444] rounded text-gray-500 hover:text-red-400 ml-2 shrink-0"
                            onClick={(e) => handleDeleteProjectClick(p, e)}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div 
                    className="px-3 py-2 text-[12px] border-t border-[#333] hover:bg-[#2a2a2a] cursor-pointer flex items-center gap-2 text-gray-300"
                    onClick={handleCreateProjectClick}
                  >
                    <Plus size={12} />
                    <span>New Project</span>
                  </div>
                </div>
                </>
              )}
            </div>
            <span className="text-gray-700">/</span>
            <div className="flex items-center gap-1.5 cursor-pointer hover:text-gray-300">
              <GitBranch size={12} />
              <span>No Git</span>
            </div>
          </div>
        </div>
      </div>

      </div>

      {benchOpen && (
        <aside className="w-[380px] shrink-0 border-l border-[#222] bg-[#101010] flex flex-col min-h-0">
          <div className="flex items-center justify-between h-12 px-4 border-b border-[#222] shrink-0">
            <div className="flex items-center gap-2">
              <Cpu size={15} className="text-gray-400" />
              <span className="text-[13px] font-medium tracking-wide text-gray-300">Tool Bench</span>
            </div>
            <button
              onClick={() => setBenchOpen(false)}
              title="Close bench"
              className="p-1.5 hover:bg-[#222] rounded text-gray-500 hover:text-gray-300"
            >
              <PanelRightClose size={16} />
            </button>
          </div>

          <div className="flex flex-col border-b border-[#222] shrink-0">
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <span className="text-[11px] font-medium uppercase tracking-widest text-gray-600">Thinking</span>
              <span className="text-[11px] text-gray-600">
                {chunks.length} chunk{chunks.length === 1 ? "" : "s"}
              </span>
            </div>
            <div
              ref={thinkingScrollRef}
              className="bench-scroll max-h-[220px] min-h-[60px] overflow-y-auto px-4 pb-3 text-[12px] leading-relaxed text-gray-400 whitespace-pre-wrap font-mono"
            >
              {chunks.length === 0 ? (
                <span className="text-gray-600 italic">Idle — new thoughts stream here automatically.</span>
              ) : (
                chunks.map((c, i) => <div key={i}>{c.text}</div>)
              )}
            </div>
          </div>

          <div className="flex flex-col border-b border-[#222] shrink-0">
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <span className="text-[11px] font-medium uppercase tracking-widest text-gray-600">Todo</span>
              <span className="text-[11px] text-gray-600">
                {todoItems.filter(t => t.status !== "completed").length}/{todoItems.length}
              </span>
            </div>
            <div className="bench-scroll max-h-[200px] overflow-y-auto px-4 pb-3">
              {todoItems.length === 0 ? (
                <span className="text-[12px] text-gray-600 italic">No todos yet.</span>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {todoItems.map((t, i) => (
                    <li key={t.id ?? i} className="flex items-center gap-2.5 text-[13px]">
                      <span className={cn(
                        "w-2 h-2 rounded-full shrink-0",
                        t.status === "completed" ? "bg-emerald-500"
                          : t.status === "in_progress" ? "bg-amber-400"
                            : "bg-[#3a3a3a]"
                      )} />
                      <span className={cn(
                        "flex-1 leading-snug",
                        t.status === "completed" ? "text-gray-500 line-through" : "text-gray-300"
                      )}>
                        {t.content}
                      </span>
                      {t.priority && (
                        <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-[#2a2a2a] px-1.5 py-0.5 rounded shrink-0">
                          {String(t.priority)}
                        </span>
                      )}
                      <span className="text-[10px] uppercase tracking-wide text-gray-600 shrink-0">
                        {String(t.status).replace("_", " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
              <span className="text-[11px] font-medium uppercase tracking-widest text-gray-600">Tools</span>
              <span className="text-[11px] text-gray-600">
                {toolFeed.length} run{toolFeed.length === 1 ? "" : "s"}
              </span>
            </div>
            {toolFeed.length === 0 ? (
              <div className="px-4 pb-3 text-[12px] text-gray-600 italic">Idle — tool activity appears here in real time.</div>
            ) : (
              <div className="bench-scroll flex flex-col gap-1 px-3 pb-4 overflow-y-auto flex-1">
                {toolFeed.map(t => <ToolRow key={t.id} run={t} />)}
              </div>
            )}
          </div>
        </aside>
      )}

      {/* Custom Dialog Modals */}
      {newProjectModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1a1a1a] border border-[#333] p-5 rounded-lg shadow-2xl w-[320px]">
            <h3 className="text-gray-200 font-semibold mb-4">Create New Project</h3>
            <input 
              autoFocus
              type="text" 
              placeholder="Project Name" 
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitCreateProject();
              }}
              className="w-full bg-[#111] border border-[#333] rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-[#555] mb-4"
            />
            <div className="flex justify-end gap-2">
              <button 
                onClick={() => setNewProjectModalOpen(false)}
                className="px-4 py-2 rounded text-sm text-gray-400 hover:text-gray-200 hover:bg-[#2a2a2a] transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={submitCreateProject}
                disabled={!newProjectName.trim()}
                className="px-4 py-2 bg-gray-200 text-[#111] rounded text-sm font-medium hover:bg-white disabled:opacity-50 transition-colors"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteProjectModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1a1a1a] border border-[#333] p-5 rounded-lg shadow-2xl w-[320px]">
            <h3 className="text-gray-200 font-semibold mb-2">Delete Project</h3>
            <p className="text-sm text-gray-400 mb-6 leading-relaxed">
              Are you sure you want to delete <span className="text-gray-200 font-medium">{deleteProjectModalOpen.name}</span>? This action cannot be undone and will delete all files inside the project.
            </p>
            <div className="flex justify-end gap-2">
              <button 
                onClick={() => setDeleteProjectModalOpen(null)}
                className="px-4 py-2 rounded text-sm text-gray-400 hover:text-gray-200 hover:bg-[#2a2a2a] transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={submitDeleteProject}
                className="px-4 py-2 bg-red-900/40 text-red-400 border border-red-900/50 rounded text-sm font-medium hover:bg-red-900/60 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

