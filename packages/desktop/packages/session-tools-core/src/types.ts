/**
 * Session Tools Core - Types
 *
 * Shared type definitions for session-scoped tools used by both
 * in-process and subprocess implementations.
 */

// ============================================================
// Credential Input Modes
// ============================================================

/**
 * Credential input modes for different authentication types
 */
export type CredentialInputMode = 'bearer' | 'basic' | 'header' | 'query' | 'multi-header';

// ============================================================
// Service Types (simplified for portability)
// ============================================================

/**
 * Google service types for OAuth
 */
export type GoogleService = 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets' | 'youtube' | 'searchconsole';

/**
 * Slack service types for OAuth
 */
export type SlackService = 'messaging' | 'channels' | 'users' | 'files' | 'full';

/**
 * Microsoft service types for OAuth
 * Note: 'microsoft-calendar' is used to distinguish from Google calendar
 */
export type MicrosoftService = 'outlook' | 'microsoft-calendar' | 'onedrive' | 'teams' | 'sharepoint';

// ============================================================
// Auth Request Types
// ============================================================

/**
 * Auth request type discriminator
 */
export type AuthRequestType =
  | 'credential'
  | 'oauth'
  | 'oauth-google'
  | 'oauth-slack'
  | 'oauth-microsoft';

/**
 * Base auth request fields shared by all auth types
 */
export interface BaseAuthRequest {
  requestId: string;
  sessionId: string;
  sourceSlug: string;
  sourceName: string;
}

/**
 * Credential auth request - prompts for API key, bearer token, etc.
 */
export interface CredentialAuthRequest extends BaseAuthRequest {
  type: 'credential';
  mode: CredentialInputMode;
  labels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  description?: string;
  hint?: string;
  headerName?: string;
  /** Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"]) */
  headerNames?: string[];
  /** Source URL/domain for password manager credential matching (1Password, etc.) */
  sourceUrl?: string;
  /** For basic auth: whether password is required. Default true for backward compatibility. */
  passwordRequired?: boolean;
}

/**
 * MCP OAuth auth request - standard OAuth 2.0 + PKCE
 */
export interface McpOAuthAuthRequest extends BaseAuthRequest {
  type: 'oauth';
}

/**
 * Google OAuth auth request - Google-specific OAuth
 */
export interface GoogleOAuthAuthRequest extends BaseAuthRequest {
  type: 'oauth-google';
  service?: GoogleService;
}

/**
 * Slack OAuth auth request - Slack-specific OAuth
 */
export interface SlackOAuthAuthRequest extends BaseAuthRequest {
  type: 'oauth-slack';
  service?: SlackService;
}

/**
 * Microsoft OAuth auth request - Microsoft-specific OAuth
 */
export interface MicrosoftOAuthAuthRequest extends BaseAuthRequest {
  type: 'oauth-microsoft';
  service?: MicrosoftService;
}

/**
 * Union of all auth request types
 */
export type AuthRequest =
  | CredentialAuthRequest
  | McpOAuthAuthRequest
  | GoogleOAuthAuthRequest
  | SlackOAuthAuthRequest
  | MicrosoftOAuthAuthRequest;

/**
 * Auth result - sent back to agent after auth completes
 */
export interface AuthResult {
  requestId: string;
  sourceSlug: string;
  success: boolean;
  cancelled?: boolean;
  error?: string;
  // Additional info for successful auth
  email?: string;      // For Google/Microsoft OAuth
  workspace?: string;  // For Slack OAuth
}

// ============================================================
// Developer Feedback
// ============================================================

/**
 * Freeform feedback from the agent to the development team.
 * Persisted as individual JSON files for later review/batch-send.
 */
export interface DeveloperFeedback {
  id: string;
  timestamp: string;
  sessionId: string;
  message: string;
}

// ============================================================
// Callback Message (IPC)
// ============================================================

/**
 * Callback message for IPC with main process.
 * Used by subprocess runtimes to communicate via stderr.
 */
export interface CallbackMessage {
  __callback__: string;
  [key: string]: unknown;
}

// ============================================================
// Tool Result Types
// ============================================================

/**
 * Text content block for tool responses
 */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Standard tool result type compatible with both SDK and MCP patterns
 */
export interface ToolResult {
  content: TextContent[];
  /**
   * Optional structured payload for MCP clients.
   * Keep this as an object (not null) for compatibility with strict tool_result parsers.
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ============================================================
// Validation Result Types
// ============================================================

/**
 * Individual validation issue
 */
export interface ValidationIssue {
  path: string;
  message: string;
  suggestion?: string;
}

/**
 * Result of validation operations
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// ============================================================
// Source Config Types (simplified for core package)
// ============================================================

/**
 * Source type discriminator
 */
export type SourceType = 'mcp' | 'api' | 'local';

/**
 * MCP transport type
 */
export type McpTransport = 'http' | 'sse' | 'stdio';

/**
 * MCP auth type
 */
export type McpAuthType = 'oauth' | 'bearer' | 'none';

/**
 * API auth type
 */
export type HttpAuthType = 'bearer' | 'header' | 'query' | 'basic' | 'oauth' | 'none';

/**
 * MCP source configuration block
 */
export interface McpSourceConfig {
  transport?: McpTransport;
  url?: string;
  authType?: McpAuthType;
  clientId?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Header names for credential-store auth (e.g., ["X-API-Key"]) */
  headerNames?: string[];
}

/**
 * API source configuration block
 */
export interface ApiSourceConfig {
  baseUrl: string;
  authType: HttpAuthType;
  headerName?: string;
  /** Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"]) */
  headerNames?: string[];
  queryParam?: string;
  authScheme?: string;
  testEndpoint?: {
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  // Google OAuth
  googleService?: GoogleService;
  googleScopes?: string[];
  googleOAuthClientId?: string;
  googleOAuthClientSecret?: string;
  // Slack OAuth
  slackService?: SlackService;
  // Microsoft OAuth
  microsoftService?: MicrosoftService;
  // Generic OAuth config (when authType is 'oauth' and provider is not google/slack/microsoft)
  oauth?: {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    audience?: string;
    extraParams?: Record<string, string>;
  };
}

/**
 * Local source configuration block
 */
export interface LocalSourceConfig {
  path: string;
  format?: string;
}

/**
 * Connection status for sources
 */
export type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'unknown';

/**
 * Full source configuration (simplified version for core package)
 */
export interface SourceConfig {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  provider: string;
  type: SourceType;
  mcp?: McpSourceConfig;
  api?: ApiSourceConfig;
  local?: LocalSourceConfig;
  isAuthenticated?: boolean;
  lastTestedAt?: string; // ISO date string
  createdAt?: number;
  updatedAt?: number;
  // Display fields
  tagline?: string;
  icon?: string; // URL, emoji, or omitted for local file
  // Connection tracking
  connectionStatus?: ConnectionStatus;
  connectionError?: string;
}
