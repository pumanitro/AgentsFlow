export interface CodexEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  status?: string;
}

export interface CodexQuestion {
  id: string;
  header?: string;
  question: string;
  isSecret?: boolean;
  options?: { label: string; description?: string }[] | null;
}

export interface CodexRequest {
  id: string | number;
  method: string;
  title: string;
  detail: string;
  questions?: CodexQuestion[];
  schema?: Record<string, unknown>;
  url?: string;
}

export interface CodexSnapshot {
  conversationId: string;
  threadId: string;
  state: string;
  entries: CodexEntry[];
  requests: CodexRequest[];
  hasOlder: boolean;
  error?: string;
}

export interface CodexReply {
  accept: boolean;
  answers?: Record<string, string>;
  content?: Record<string, unknown>;
}
