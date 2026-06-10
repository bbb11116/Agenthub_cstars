import type { AgentHubApi } from "../shared/types";

declare global {
  interface Window {
    agenthub?: AgentHubApi;
  }
}

export {};
