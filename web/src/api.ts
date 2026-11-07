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

export type View = { id: string; name: string; kind: string; [k: string]: any };
export type Graph = { views: View[]; edges: { from: string; to: string; pending?: boolean }[] };
