import { createContext, useContext } from "react";
import { Thread } from "../api";

export type Send = (text: string, kind?: "chat" | "action", focus?: string[]) => Promise<void>;
export type ThreadCtx = {
  t: Thread;
  send: Send;
  reload: () => void;
  focus: string | null;
  setFocus: (id: string | null) => void;
  onOpenVisual: (visualId: string, viewId: string) => void;
  onTrace: (rid: string) => void;
};

export const Ctx = createContext<ThreadCtx | null>(null);
export function useThread(): ThreadCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("no thread context");
  return c;
}
