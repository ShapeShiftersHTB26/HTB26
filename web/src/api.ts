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
