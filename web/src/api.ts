export async function op<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/op/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${name} failed: ${res.status}`);
  }
  return res.json();
}

/** Events streamed by POST /api/chat (api/app/chat.py). */
export type ChatEvent =
  | { type: "session"; session_id: string }
  | { type: "text"; text: string }
  | { type: "tool"; label: string }
  | { type: "tool_error"; text: string }
  | { type: "note"; text: string }
  | { type: "done"; session_id: string; is_error: boolean; turns: number; cost_usd?: number; errors?: string[] | null }
  | { type: "error"; message: string };

/** Send one chat message to the app agent and call onEvent for each streamed event (SSE over a POST). */
export async function chat(
  body: { message: string; session_id?: string | null; view_id?: string | null; intent_id?: string | null },
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `chat failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

export type Kind = "schema" | "transform" | "visual";
export type Counts = Record<Kind, number>;

export type View = {
  id: string;
  name: string;
  kind: "source" | "derived";
  question?: string;
  auto_accept?: boolean;
  head: Record<Kind, string | null>;
  pending: Counts;
  latest_instance?: { id: string; row_count: number; created_at?: string; model?: string; hash?: string } | null;
  instance_count?: number;
  visuals?: { id: string; status: string; uses: string[]; title?: string; intent_id?: string }[];
};
export type Graph = {
  views: View[];
  edges: { from: string; to: string; pending?: boolean; kind?: string }[];
  intents?: Intent[];
};
export type Intent = {
  id: string;
  text: string;
  title?: string;
  mode: "auto" | "guided";
  status: "open" | "answered";
  anchors: string[];
  parent_id?: string;
  members: string[];
  inputs: string[];
  visuals: string[];
  steps: number;
  result_id?: string;
  result_kind?: "view" | "visual";
  result_current?: string;
  result_view_id?: string;
  summary?: string;
  created_at?: string;
  agent_status?: "idle" | "queued" | "working" | "error";
};

export type Proposal = {
  id: string;
  view_id: string;
  parent_id?: string;
  author: "agent" | "user";
  status: "pending" | "approved" | "discarded";
  counter?: number;
  decided_by?: string;
  rationale?: string;
  created_at: string;
  [k: string]: any;
};
export type Comment = { id: string; target_id: string; text: string; author: string; created_at: string };

export type ViewDetail = {
  view: Omit<View, "head" | "pending" | "latest_instance">;
  proposals: Record<Kind, Proposal[]>;
  head: Record<Kind, string | null>;
  visual_heads: string[];
  comments: Record<string, Comment[]>;
  upstream: string[];
  downstream: string[];
  instances: Instance[];
  latest_instance: Instance | null;
};
export type Instance = {
  id: string;
  view_id: string;
  created_at: string;
  row_count: number;
  invalid_count: number;
  hash?: string;
  formula_hash?: string;
  data_root?: string;
  batches?: string;
};

export type Column = { name: string; type?: string; role?: string; unit?: string; description?: string };
export function columns(schema: any): Column[] {
  return Object.entries(schema?.properties || {}).map(([name, s]: [string, any]) => ({
    name,
    type: s.type,
    role: s["x-role"],
    unit: s["x-unit"],
    description: s.description,
  }));
}

// ---------------------------------------------------------------- research threads (chat)
export type Dataset = {
  id: string;
  title: string;
  publisher: string;
  licence: string;
  url: string;
  description: string;
  coverage: string;
  updated: string;
  size: string;
  available: boolean;
  files: string[];
  loaded_as: { view_id: string; name: string; filter?: string }[];
};
export type ThreadItem =
  | {
      type: "message";
      at: string;
      id: string;
      role: "user" | "agent";
      text: string;
      kind: "chat" | "action" | "datasets" | "source" | "market";
      market_id?: number;
      datasets?: string[];
      suggestions?: string[];
      view_id?: string;
      hash?: string;
      focus?: string[];
    }
  | { type: "proposal"; at: string; kind: Kind; view_name: string; is_head: boolean; proposal: Proposal }
  | {
      type: "result";
      at: string;
      intent_id: string;
      text: string;
      summary?: string;
      result_kind?: "view" | "visual";
      result_current?: string;
      view_id: string;
      view_name: string;
      instance: { id: string; hash?: string; row_count?: number } | null;
    };
export type Thread = {
  intent: {
    id: string;
    text: string;
    title?: string;
    status: string;
    mode: string;
    auto?: boolean;
    agent_status: "idle" | "queued" | "working" | "error";
    agent_error?: string;
    agent_activity?: string;
    created_at: string;
  };
  intents: { id: string; text: string; status: string }[];
  items: ThreadItem[];
  comments: Record<string, Comment[]>;
  datasets: Record<string, Dataset>;
  names: Record<string, string>;
  view_kinds: Record<string, string>;
  stage: "ask" | "shape" | "data" | "answer" | "answered";
  canvas: {
    nodes: import("./research/nodes").CanvasView[];
    edges: { from: string; to: string; pending: boolean; kind?: string }[];
    notes: import("./research/nodes").Note[];
    open_datasets: string[];
    focus: string[] | null;
    questions: import("./research/nodes").Question[];
  };
};
