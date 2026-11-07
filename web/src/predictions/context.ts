import { createContext, useContext } from "react";
import type { PublicConfig } from "./api";
import type { Addrs } from "./solana";

export interface AppConfig {
  cfg: PublicConfig;
  addrs: Addrs;
}

export const ConfigCtx = createContext<AppConfig | null>(null);

export function useAppConfig(): AppConfig {
  const c = useContext(ConfigCtx);
  if (!c) throw new Error("useAppConfig outside the Predictions tab");
  return c;
}
