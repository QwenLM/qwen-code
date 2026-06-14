/**
 * Session Tools Core - Context Interface
 *
 * Defines the abstract context interface that session tool runtimes provide.
 *
 * This enables writing tool handlers once and running them in every environment.
 */

import type {
  AuthRequest,
  ToolResult,
  SourceConfig,
  GoogleService,
  SlackService,
  MicrosoftService,
  McpSourceConfig,
} from './types.ts';

// ============================================================
// Source Credential Types
// ============================================================

/**
 * Loaded source with context for credential operations.
 * Note: guide field omitted as credential manager doesn't use it.
 */
export interface LoadedSource {
  config: SourceConfig;
  folderPath: string;
  workspaceRootPath: string;
  workspaceId: string;
}

// ============================================================
// Callback Interface
// ============================================================

/**
 * Callbacks for session tool operations.
 * Different runtimes can implement this with direct function calls or callback messages.
 */
export interface SessionToolCallbacks {
  /**
   * Called when a plan is submitted.
   * Runtime may call an in-process callback or send a callback message.
   */
  onPlanSubmitted(planPath: string): void;

  /**
   * Called when authentication is requested.
   * Runtime may call an in-process callback or send a callback message.
   */
  onAuthRequest(request: AuthRequest): void;
}

// ============================================================
// File System Interface
// ============================================================

/**
 * File system abstraction for portability.
 * Allows mocking in tests and different implementations in different environments.
 */
export interface FileSystemInterface {
  /** Check if file/directory exists */
  exists(path: string): boolean;

  /** Read file as UTF-8 string */
  readFile(path: string): string;

  /** Read file as Buffer (for binary/images) */
  readFileBuffer(path: string): Buffer;

  /** Write file */
  writeFile(path: string, content: string): void;

  /** Check if path is a directory */
  isDirectory(path: string): boolean;

  /** List directory contents */
  readdir(path: string): string[];

  /** Get file stats */
  stat(path: string): { size: number; isDirectory(): boolean };
}

// ============================================================
// Credential Manager Interface
// ============================================================

/**
 * Credential manager abstraction.
 * Some runtimes have direct credential access; subprocess runtimes may rely on
 * credential cache files from the main process.
 */
export interface CredentialManagerInterface {
  /**
   * Check if a source has valid, non-expired credentials
   */
  hasValidCredentials(source: LoadedSource): Promise<boolean>;

  /**
   * Get the current access token for a source (null if expired/missing)
   */
  getToken(source: LoadedSource): Promise<string | null>;

  /**
   * Refresh the access token for a source
   */
  refresh(source: LoadedSource): Promise<string | null>;
}

// ============================================================
// Validator Interface
// ============================================================

/**
 * Config validation interface.
 * Full validators are used when available; subprocess runtimes can fall back to
 * simplified validators from session-tools-core.
 */
export interface ValidatorInterface {
  validateConfig(): import('./types.js').ValidationResult;
  validateSource(workspaceRootPath: string, sourceSlug: string): import('./types.js').ValidationResult;
  validateAllSources(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateStatuses(workspaceRootPath: string): import('./types.js').ValidationResult;
  validatePreferences(): import('./types.js').ValidationResult;
  validatePermissions(workspaceRootPath: string, sourceSlug?: string): import('./types.js').ValidationResult;
  validateAutomations(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateToolIcons(): import('./types.js').ValidationResult;
  validateAll(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateSkill(workspaceRootPath: string, skillSlug: string): import('./types.js').ValidationResult;
}

// ============================================================
// Session Tool Context
// ============================================================

/**
 * Main context interface for session tools.
 *
 * Each runtime creates its own implementation of this interface.
 */
export interface SessionToolContext {
  // ============================================================
  // Session Info
  // ============================================================

  /** Unique session identifier */
  sessionId: string;

  /** Absolute path to workspace folder (~/.craft-agent/workspaces/{id}) */
  workspacePath: string;

  /** Path to sources folder within workspace */
  get sourcesPath(): string;

  /** Path to skills folder within workspace */
  get skillsPath(): string;

  /** Path to session's plans folder */
  plansFolderPath: string;

  /** Working directory (project root) for the session, if set */
  workingDirectory?: string;

  // ============================================================
  // Callbacks (transport-agnostic)
  // ============================================================

  callbacks: SessionToolCallbacks;

  // ============================================================
  // File System
  // ============================================================

  fs: FileSystemInterface;

  // ============================================================
  // Validators (optional - may use basic or full)
  // ============================================================

  validators?: ValidatorInterface;

  // ============================================================
  // Optional Capabilities
  // ============================================================

  /**
   * Get credential manager for source authentication checks.
   * Only available in runtimes with direct credential access.
   */
  credentialManager?: CredentialManagerInterface;

  /**
   * Load a source config from the workspace.
   */
  loadSourceConfig(sourceSlug: string): SourceConfig | null;

  /**
   * Save a source config to the workspace.
   */
  saveSourceConfig?(source: SourceConfig): void;

  /**
   * Infer Google service from URL.
   */
  inferGoogleService?(url?: string): GoogleService | undefined;

  /**
   * Infer Slack service from URL.
   */
  inferSlackService?(url?: string): SlackService | undefined;

  /**
   * Infer Microsoft service from URL.
   */
  inferMicrosoftService?(url?: string): MicrosoftService | undefined;

  /**
   * Check if Google OAuth is configured.
   */
  isGoogleOAuthConfigured?(clientId?: string, clientSecret?: string): boolean;

  // ============================================================
  // Icon Management (for source_test)
  // ============================================================

  /**
   * Check if a value is a URL that can be used as an icon.
   */
  isIconUrl?(value: string): boolean;

  /**
   * Download an icon from URL to the source folder.
   * Returns the path to the cached icon, or null if download failed.
   */
  downloadSourceIcon?(sourceSlug: string, iconUrl: string): Promise<string | null>;

  /**
   * Derive a service URL from a source config (for favicon fetching).
   */
  deriveServiceUrl?(source: SourceConfig): string | null;

  /**
   * Get a high-quality logo URL from a service URL.
   */
  getHighQualityLogoUrl?(serviceUrl: string, slug: string): Promise<string | null>;

  /**
   * Download an icon to a specific destination path.
   */
  downloadIcon?(destPath: string, url: string, tag: string): Promise<string | null>;

  // ============================================================
  // MCP Connection Validation (for source_test)
  // ============================================================

  /**
   * Validate a stdio MCP connection by spawning the command.
   */
  validateStdioMcpConnection?(config: StdioMcpConfig): Promise<StdioValidationResult>;

  /**
   * Validate an HTTP/SSE MCP connection.
   */
  validateMcpConnection?(config: HttpMcpConfig): Promise<McpValidationResult>;

  // ============================================================
  // API Testing (for source_test)
  // ============================================================

  /**
   * Test an API source connection with full credential handling.
   */
  testApiSource?(source: SourceConfig): Promise<ApiTestResult>;

  /**
   * Test a Google source (OAuth token validation).
   */
  testGoogleSource?(source: SourceConfig): Promise<ApiTestResult>;

  // ============================================================
  // Preferences (for update_user_preferences)
  // ============================================================

  /**
   * Submit developer feedback. Implementations may write JSON files directly or
   * send over IPC.
   */
  submitFeedback?(feedback: import('./types.ts').DeveloperFeedback): void;

  /**
   * Update user preferences. Implementations can call config helpers or write
   * preferences.json directly.
   */
  updatePreferences?(updates: Record<string, unknown>): void;

  // ============================================================
  // Session Self-Management (for set_session_labels, etc.)
  // ============================================================

  /** Set labels on a session. Defaults to current session if no ID given. Injected by backend. */
  setSessionLabels?(sessionId: string | undefined, labels: string[]): void | Promise<void>;

  /** Set status on a session. Defaults to current session if no ID given. Injected by backend. */
  setSessionStatus?(sessionId: string | undefined, status: string): void | Promise<void>;

  /** Get detailed info about a session. Defaults to current session if no ID given. Injected by backend. */
  getSessionInfo?(sessionId?: string): SessionInfo | null;

  /** List sessions in the workspace with pagination. Injected by backend. */
  listSessions?(options?: ListSessionsOptions): ListSessionsResult;

  /** Resolve label display names to IDs against configured labels. Injected by backend. */
  resolveLabels?(labels: string[]): ResolvedLabelsResult;

  /** Resolve a status display name to its ID against configured statuses. Injected by backend. */
  resolveStatus?(status: string): ResolvedStatusResult;

  // ============================================================
  // Inter-Session Messaging
  // ============================================================

  /** Send a message to another session. Injected by backend (SessionManager). */
  sendAgentMessage?(sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>): Promise<void>;

  /**
   * Activate a source in the running session: add to enabledSourceSlugs,
   * build its MCP/API servers, apply to the agent.
   *
   * Only available in backends that can activate a source in the current session.
   * Other backends leave this undefined — callers should degrade gracefully.
   *
   * `availability` is always `'next-turn'` when activation succeeds: backend
   * tool registries generally require a new turn before tools are callable.
   * The backend handles this via the existing source_activated + auto_retry
   * machinery — the current turn is aborted and the renderer resends the user's
   * original message with a `[{slug} activated]` suffix.
   */
  activateSourceInSession?(sourceSlug: string): Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'next-turn';
  }>;

  // ============================================================
  // Messaging Gateway (for list/unbind messaging channels)
  // ============================================================

  /** Get messaging bindings for a session. Injected by backend when messaging is configured. */
  getMessagingBindings?(sessionId: string): Array<{
    platform: string;
    channelId: string;
    channelName?: string;
    enabled: boolean;
  }>;

  /** Unbind messaging channels from a session. Returns count of removed bindings. */
  unbindMessagingChannel?(sessionId: string, platform?: string): number;

  // ============================================================
  // Session Paths (for transform_data / render_template)
  // ============================================================

  /**
   * Absolute path to the session directory.
   * Used by transform_data for resolving input files.
   */
  sessionPath?: string;

  /**
   * Absolute path to the session's data directory.
   * Used by transform_data and render_template for output files.
   */
  dataPath?: string;
}

// ============================================================
// Session Self-Management Types — Resolution
// ============================================================

/** Result of resolving label names/IDs against configured labels. */
export interface ResolvedLabelsResult {
  /** Resolved label IDs (ready to store) */
  resolved: string[];
  /** Labels that couldn't be matched to any configured label */
  unknown: string[];
  /** All valid label IDs (for error messages) */
  available: string[];
  /**
   * Optional per-input rejection reason, keyed by the original input string.
   * Populated by `resolveSessionLabels()` from `@craft-agent/shared/labels`.
   * Handlers use this to build clearer errors (e.g. "label X doesn't accept a value").
   */
  reasons?: Record<string, string>;
}

/** Result of resolving a status name/ID against configured statuses. */
export interface ResolvedStatusResult {
  /** Matched status ID, or null if unknown */
  resolved: string | null;
  /** All valid status IDs (for error messages) */
  available: string[];
}

// ============================================================
// Session Self-Management Types
// ============================================================

/** Full metadata for a single session (returned by get_session_info). */
export interface SessionInfo {
  id: string;
  name: string;
  labels: string[];
  status: string;
  permissionMode: string;
  createdAt: number;
  updatedAt?: number;
  workingDirectory?: string;
  llmConnection?: string;
  model?: string;
  isActive: boolean;
}

/** Compact session summary (returned by list_sessions). */
export interface SessionListItem {
  id: string;
  name: string;
  labels: string[];
  status: string;
  createdAt: number;
}

/** Options for list_sessions filtering and pagination. */
export interface ListSessionsOptions {
  status?: string;
  label?: string;
  search?: string;
  sortBy?: 'recent' | 'name' | 'status';
  limit?: number;
  offset?: number;
}

/** Paginated result from list_sessions. */
export interface ListSessionsResult {
  total: number;
  returned: number;
  sessions: SessionListItem[];
}

// ============================================================
// MCP Validation Types
// ============================================================

/**
 * Config for stdio MCP connection validation
 */
export interface StdioMcpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Config for HTTP/SSE MCP connection validation.
 * Derived from McpSourceConfig to stay in sync automatically (DRY).
 */
export type HttpMcpConfig = Required<Pick<McpSourceConfig, 'url'>> & Pick<McpSourceConfig, 'authType' | 'headers' | 'headerNames' | 'transport'>;

/**
 * Result from stdio MCP validation
 */
export interface StdioValidationResult {
  success: boolean;
  error?: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
}

/**
 * Result from HTTP MCP validation
 */
export interface McpValidationResult {
  success: boolean;
  error?: string;
  needsAuth?: boolean;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
}

/**
 * Result from API source test
 */
export interface ApiTestResult {
  success: boolean;
  status?: number;
  error?: string;
  hint?: string;
}

// ============================================================
// Context Factory Helpers
// ============================================================

/**
 * Create a basic file system implementation using Node.js fs.
 */
export function createNodeFileSystem(): FileSystemInterface {
  // Dynamic import to work in both environments
  const fs = require('node:fs');

  return {
    exists: (path: string) => fs.existsSync(path),
    readFile: (path: string) => fs.readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => fs.readFileSync(path),
    writeFile: (path: string, content: string) => fs.writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => fs.existsSync(path) && fs.statSync(path).isDirectory(),
    readdir: (path: string) => fs.readdirSync(path),
    stat: (path: string) => {
      const stats = fs.statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };
}
