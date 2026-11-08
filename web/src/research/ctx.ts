import { createContext, useContext } from "react";
import { Thread } from "../api";

export type Camera = { kind: "all" | "chain" | "nodes"; q?: string; ids?: string[]; key: number };
export type Send = (text: string, kind?: "chat" | "action", focus?: string[]) => Promise<void>;
export type ThreadCtx = {
  t: Thread;
  send: Send;
  reload: () => void;
  focus: string | null;
  setFocus: (id: string | null) => void;
  onOpenVisual: (visualId: string, viewId: string) => void;
  onTrace: (rid: string) => void;
  openNotebook: (viewId: string) => void;
  activeQ: string | null;
  setActiveQ: (id: string | null) => void;
  readOnly?: boolean; // replaying: look, don't touch
  highlight?: { id: string; tone: string; key: number } | null; // replay: the node this step changed (flashes)
  // a framing request: the whole workspace, one question with its tables, or a set of nodes (a table and its
  // inputs). key: a new request each time
  camera?: Camera | null;
};

export const Ctx = createContext<ThreadCtx | null>(null);
export function useThread(): ThreadCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("no thread context");
  return c;
}
