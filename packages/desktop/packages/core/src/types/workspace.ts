/**
 * Workspace and authentication types
 */

/**
 * How MCP server should be authenticated (workspace-level)
 * Note: Different from SourceMcpAuthType which uses 'oauth' | 'bearer' | 'none' for individual sources
 */
export type McpAuthType = 'workspace_oauth' | 'workspace_bearer' | 'public';

export type WorkspaceKind = 'project' | 'conversation';

/**
 * Configuration for a remote Qwen Code Server.
 * When set on a workspace, handler calls are proxied over WebSocket.
 */
export interface RemoteServerConfig {
  url: string;              // ws://host:port or wss://host:port
  token: string;            // Auth token for the remote server
  remoteWorkspaceId: string; // ID of the workspace on the remote server
}

/**
 * Client-facing workspace DTO — safe to send over RPC to remote clients.
 * Does not expose server-internal filesystem paths.
 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;              // Server-computed from rootPath basename
  kind?: WorkspaceKind;       // Defaults to 'project' when omitted
  isProtected?: boolean;      // System-managed entries cannot be renamed/removed
  lastAccessedAt?: number;
  pinned?: boolean;
  iconUrl?: string;
  mcpUrl?: string;
  mcpAuthType?: McpAuthType;
  remoteServer?: RemoteServerConfig;
}

/**
 * Full workspace with server-internal details.
 * Used by server code and local Electron renderer (LOCAL_ONLY channels).
 */
export interface Workspace extends WorkspaceInfo {
  rootPath: string;        // Absolute path to local workspace folder (metadata, config). Auto-created for remote workspaces.
  createdAt: number;
}

/**
 * Authentication type for the built-in AI backend.
 * Qwen Code auth is handled by the local Qwen CLI, so the app stores no LLM
 * credential here.
 */
export type AuthType = 'none';

/**
 * OAuth credentials from a fresh authentication flow.
 * Used for temporary state in UI components before saving to credential store.
 */
export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  tokenType: string;
}

// Config stored in JSON file (credentials stored in encrypted file, not here)
export interface StoredConfig {
  authType?: AuthType;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;  // Currently active session (primary scope)
  model?: string;
}
