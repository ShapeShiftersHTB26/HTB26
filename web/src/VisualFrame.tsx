import { useEffect, useMemo, useRef } from "react";

export type ViewData = { view_id: string; schema: any; rows: Record<string, any>[]; mode: "preview" | "instance" };

// Renders agent-written HTML in a sandboxed iframe (scripts allowed, no same-origin),
// with window.BACKTRACE + backtraceSelect injected ahead of the agent's code.
export default function VisualFrame(props: {
  html: string;
  schema: any;
  rows: Record<string, any>[];
  mode: "preview" | "instance";
  view: { id: string; name: string };
  views?: Record<string, ViewData>;
  onSelect?: (rid: string) => void;
  height?: number;
}) {
  const ref = useRef<HTMLIFrameElement>(null);

  const srcdoc = useMemo(() => {
    const payload = JSON.stringify({ schema: props.schema, rows: props.rows, mode: props.mode, view: props.view, views: props.views || {} }).replace(
      /<\//g,
      "<\\/",
    );
    const inject =
      `<script>window.BACKTRACE=${payload};` +
      `window.backtraceSelect=function(rid){if(rid)parent.postMessage({type:"select",rid:rid},"*")};</script>`;
    const html = props.html || "";
    const m = html.match(/<head[^>]*>/i);
    return m ? html.replace(m[0], m[0] + inject) : inject + html;
  }, [props.html, props.schema, props.rows, props.mode, props.view.id, props.view.name, props.views]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && e.data?.type === "select" && e.data.rid) props.onSelect?.(e.data.rid);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [props.onSelect]);

  return (
    <iframe
      ref={ref}
      className="visual-frame"
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      style={{ height: props.height ?? 360 }}
      title={`visual of ${props.view.name}`}
    />
  );
}
