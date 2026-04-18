import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CampusSessionHeaders } from "../shared/campus-session-auth.js";
import type { AnyAgentTool } from "./tools/common.js";

export type BundleMcpToolRuntime = {
  tools: AnyAgentTool[];
  dispose: () => Promise<void>;
};

export type McpServerCatalog = {
  serverName: string;
  launchSummary: string;
  toolCount: number;
};

export type McpCatalogTool = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  fallbackDescription: string;
};

export type McpToolCatalog = {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
};

export type SessionMcpRuntime = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  configFingerprint: string;
  campusSessionHeadersFingerprint: string;
  createdAt: number;
  lastUsedAt: number;
  getCatalog: () => Promise<McpToolCatalog>;
  markUsed: () => void;
  callTool: (serverName: string, toolName: string, input: unknown) => Promise<CallToolResult>;
  dispose: () => Promise<void>;
};

export type SessionMcpRuntimeManager = {
  getOrCreate: (params: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
    campusSessionHeaders?: CampusSessionHeaders;
  }) => Promise<SessionMcpRuntime>;
  bindSessionKey: (sessionKey: string, sessionId: string) => void;
  resolveSessionId: (sessionKey: string) => string | undefined;
  disposeSession: (sessionId: string) => Promise<void>;
  disposeAll: () => Promise<void>;
  listSessionIds: () => string[];
};
