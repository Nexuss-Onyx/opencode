export interface Message {
  role: "user" | "model" | "system";
  parts: Array<{ text?: string, functionCall?: any, functionResponse?: any }>;
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  projectId?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
}
