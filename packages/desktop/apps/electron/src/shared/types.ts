// =============================================================================
// Protocol re-exports (channels, DTOs, events, wire types)
// =============================================================================
export * from '@craft-agent/shared/protocol';

// =============================================================================
// Package re-exports (convenience for renderer imports)
// =============================================================================

// Core types
import type {
  Message as CoreMessage,
  MessageRole as CoreMessageRole,
  TypedError,
  TokenUsage as CoreTokenUsage,
  WorkspaceInfo as CoreWorkspaceInfo,
  Workspace as CoreWorkspace,
  SessionMetadata as CoreSessionMetadata,
  StoredAttachment as CoreStoredAttachment,
  ContentBadge,
  MessageTextElement,
  ToolDisplayMeta,
  AnnotationV1,
} from '@craft-agent/core/types';

// Mode types from dedicated subpath export (avoids pulling in SDK)
import type { PermissionMode } from '@craft-agent/shared/agent/modes';
export type { PermissionMode };
export { PERMISSION_MODE_CONFIG } from '@craft-agent/shared/agent/modes';

// Thinking level types
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';
export type { ThinkingLevel };
export {
  THINKING_LEVELS,
  DEFAULT_THINKING_LEVEL,
} from '@craft-agent/shared/agent/thinking-levels';

export type {
  CoreMessage as Message,
  CoreMessageRole as MessageRole,
  TypedError,
  CoreTokenUsage as TokenUsage,
  CoreWorkspaceInfo as WorkspaceInfo,
  CoreWorkspace as Workspace,
  CoreSessionMetadata as SessionMetadata,
  CoreStoredAttachment as StoredAttachment,
  ContentBadge,
  MessageTextElement,
  ToolDisplayMeta,
  AnnotationV1,
};

// Auth types for onboarding
import type { AuthState, SetupNeeds } from '@craft-agent/shared/auth/types';
import type { AuthType } from '@craft-agent/shared/config/types';
export type { AuthState, SetupNeeds, AuthType };

// Credential health types
import type {
  CredentialHealthStatus,
  CredentialHealthIssue,
  CredentialHealthIssueType,
} from '@craft-agent/shared/credentials/types';
export type {
  CredentialHealthStatus,
  CredentialHealthIssue,
  CredentialHealthIssueType,
};

// Source types for session source selection
import type {
  LoadedSource,
  FolderSourceConfig,
  SourceConnectionStatus,
} from '@craft-agent/shared/sources/types';
export type { LoadedSource, FolderSourceConfig, SourceConnectionStatus };

// Skill types
import type {
  LoadedSkill,
  SkillMetadata,
} from '@craft-agent/shared/skills/types';
export type { LoadedSkill, SkillMetadata };

// Resource bundle types (cross-workspace export/import)
import type {
  ExportResourcesOptions,
  ExportResult,
  ResourceImportMode,
  ResourceBundle,
  ResourceImportResult,
} from '@craft-agent/shared/resources';
export type {
  ExportResourcesOptions,
  ExportResult,
  ResourceImportMode,
  ResourceBundle,
  ResourceImportResult,
};

// LLM connection types
import type {
  LlmConnection,
  LlmConnectionWithStatus,
  LlmAuthType,
  LlmProviderType,
  NetworkProxySettings,
} from '@craft-agent/shared/config';
export type {
  LlmConnection,
  LlmConnectionWithStatus,
  LlmAuthType,
  LlmProviderType,
  NetworkProxySettings,
};

// =============================================================================
// GUI-only types (not used by server/handler code)
// =============================================================================

/**
 * Browser toolbar window IPC channels (preload <-> BrowserPaneManager).
 * Kept separate from RPC_CHANNELS because these are scoped to toolbar windows.
 */
export const BROWSER_TOOLBAR_CHANNELS = {
  NAVIGATE: 'browser-toolbar:navigate',
  GO_BACK: 'browser-toolbar:go-back',
  GO_FORWARD: 'browser-toolbar:go-forward',
  RELOAD: 'browser-toolbar:reload',
  STOP: 'browser-toolbar:stop',
  OPEN_MENU: 'browser-toolbar:open-menu',
  HIDE: 'browser-toolbar:hide',
  DESTROY: 'browser-toolbar:destroy',
  STATE_UPDATE: 'browser-toolbar:state-update',
  THEME_COLOR: 'browser-toolbar:theme-color',
} as const;

/** Tool icon mapping entry from tool-icons.json (with icon resolved to data URL) */
export interface ToolIconMapping {
  id: string;
  displayName: string;
  /** Data URL of the icon (e.g., data:image/png;base64,...) */
  iconDataUrl: string;
  commands: string[];
}

/**
 * Browser pane creation options
 */
export interface BrowserPaneCreateOptions {
  id?: string;
  show?: boolean;
  bindToSessionId?: string;
}

/**
 * Empty-state launch request from the browser empty-state renderer.
 */
export interface BrowserEmptyStateLaunchPayload {
  route: string;
  token?: string;
}

/**
 * Result of browser empty-state launch handling.
 */
export interface BrowserEmptyStateLaunchResult {
  ok: boolean;
  handled: boolean;
  reason?: string;
}

export type TransportMode = 'local' | 'remote';

export type TransportConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';

export type TransportConnectionErrorKind =
  | 'auth'
  | 'protocol'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown';

export interface TransportConnectionError {
  kind: TransportConnectionErrorKind;
  message: string;
  code?: string;
}

export interface TransportCloseInfo {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface TransportConnectionState {
  mode: TransportMode;
  status: TransportConnectionStatus;
  url: string;
  attempt: number;
  nextRetryInMs?: number;
  lastError?: TransportConnectionError;
  lastClose?: TransportCloseInfo;
  updatedAt: number;
}

// =============================================================================
// ElectronAPI — type-safe IPC API exposed to renderer
// =============================================================================

// Re-import types for ElectronAPI
import type {
  WorkspaceInfo,
  Workspace,
  StoredAttachment as StoredAttachmentType,
} from '@craft-agent/core/types';

// Import protocol types used by ElectronAPI (they come through the `export *` above,
// but we need them in scope for the interface definition)
import type {
  Session,
  UnreadSummary,
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  SessionEvent,
  PermissionResponseOptions,
  CredentialResponse,
  SessionCommand,
  ShareResult,
  RefreshTitleResult,
  FileSearchResult,
  SessionSearchResult,
  LlmConnectionSetup,
  TestLlmConnectionParams,
  TestLlmConnectionResult,
  SkillFile,
  SessionFile,
  OAuthResult,
  McpToolsResult,
  GitBashStatus,
  UpdateInfo,
  WorkspaceSettings,
  PermissionModeState,
  BrowserInstanceInfo,
  DeepLinkNavigation,
  TestAutomationPayload,
  TestAutomationResult,
  WindowCloseRequest,
  DirectoryListingResult,
  RemoteSessionTransferPayload,
  ImportRemoteSessionTransferResult,
  AvailableSlashCommand,
  QwenCoreSettingsSnapshot,
  QwenProviderCatalog,
  QwenProviderConnectParams,
  QwenProviderConnectResult,
} from '@craft-agent/shared/protocol';

export interface ElectronAPI {
  // Session management
  getSessions(): Promise<Session[]>;
  getSessionsForWorkspace(
    workspaceId: string,
    options?: { refreshExternal?: boolean },
  ): Promise<Session[]>;
  getUnreadSummary(): Promise<UnreadSummary>;
  markAllSessionsRead(workspaceId: string): Promise<void>;
  getSessionMessages(sessionId: string): Promise<Session | null>;
  createSession(
    workspaceId: string,
    options?: CreateSessionOptions,
  ): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachmentType[],
    options?: SendMessageOptions,
  ): Promise<void>;
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>;
  killShell(
    sessionId: string,
    shellId: string,
  ): Promise<{ success: boolean; error?: string }>;
  getTaskOutput(taskId: string): Promise<string | null>;
  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions,
  ): Promise<boolean>;
  respondToCredential(
    sessionId: string,
    requestId: string,
    response: CredentialResponse,
  ): Promise<boolean>;

  // Consolidated session command handler
  sessionCommand(
    sessionId: string,
    command: SessionCommand,
  ): Promise<
    | void
    | ShareResult
    | RefreshTitleResult
    | import('@craft-agent/shared/protocol').QwenPermissionSettings
    | QwenCoreSettingsSnapshot
    | { count: number }
    | {
        success: boolean;
        availableCommands?: AvailableSlashCommand[];
        availableSkills?: string[];
        availableSkillDetails?: Array<
          import('@craft-agent/core/types').AvailableSkillDetail
        >;
        error?: string;
      }
  >;

  // Server info (REMOTE_ELIGIBLE — returns data from whichever server owns the workspace)
  getServerHomeDir(): Promise<string>;

  // Server mode configuration
  getServerConfig(): Promise<
    import('@craft-agent/shared/config/server-config').ServerConfig
  >;
  setServerConfig(
    config: import('@craft-agent/shared/config/server-config').ServerConfig,
  ): Promise<void>;
  getServerStatus(): Promise<
    import('@craft-agent/shared/config/server-config').ServerStatus
  >;

  // App lifecycle
  relaunchApp(): Promise<void>;
  removeWorkspace(workspaceId: string): Promise<boolean>;
  setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<boolean>;
  reorderWorkspaces(orderedIds: string[]): Promise<boolean>;
  invokeOnServer(
    url: string,
    token: string,
    channel: string,
    ...args: unknown[]
  ): Promise<unknown>;

  // Remote session transfer (main-process orchestrated, supports chunked upload)
  transferSessionToWorkspace(
    sessionId: string,
    targetWorkspaceId: string,
    sessionIndex?: number,
    sessionCount?: number,
  ): Promise<{ sessionId: string }>;
  onTransferProgress(
    callback: (progress: {
      sessionIndex: number;
      sessionCount: number;
      chunkSent: number;
      chunkTotal: number;
    }) => void,
  ): () => void;

  // Session export/import (cross-workspace transfer)
  exportSession(sessionId: string): Promise<unknown>;
  importSession(
    targetWorkspaceId: string,
    bundle: unknown,
    mode: 'move' | 'fork',
  ): Promise<{ sessionId: string; warnings?: string[] }>;
  exportRemoteSessionTransfer(
    sessionId: string,
  ): Promise<RemoteSessionTransferPayload>;
  importRemoteSessionTransfer(
    targetWorkspaceId: string,
    payload: RemoteSessionTransferPayload,
  ): Promise<ImportRemoteSessionTransferResult>;

  // Pending plan execution (for reload recovery)
  getPendingPlanExecution(
    sessionId: string,
  ): Promise<{
    planPath: string;
    draftInputSnapshot?: string;
    awaitingCompaction: boolean;
    executionDispatched: boolean;
  } | null>;
  // Permission mode reconciliation
  getSessionPermissionModeState(
    sessionId: string,
  ): Promise<PermissionModeState | null>;

  // Workspace management
  getWorkspaces(): Promise<Workspace[]>;
  createWorkspace(
    folderPath: string,
    name: string,
    remoteServer?: { url: string; token: string; remoteWorkspaceId: string },
  ): Promise<Workspace>;
  checkWorkspaceSlug(slug: string): Promise<{ exists: boolean; path: string }>;
  updateWorkspaceRemoteServer(
    workspaceId: string,
    remoteServer: { url: string; token: string; remoteWorkspaceId: string },
  ): Promise<{ success: boolean }>;

  // Server-level workspace operations (for thin client / remote workspace discovery)
  getServerWorkspaces(): Promise<WorkspaceInfo[]>;
  createServerWorkspace(name: string): Promise<WorkspaceInfo>;

  testRemoteConnection(
    url: string,
    token: string,
  ): Promise<{
    ok: boolean;
    error?: string;
    needsWorkspace?: boolean;
    remoteWorkspaces?: Array<{ id: string; name: string }>;
    remoteWorkspaceId?: string; // auto-set when exactly one workspace
    remoteWorkspaceName?: string; // auto-set when exactly one workspace
    serverVersion?: string; // server app version from handshake
  }>;

  // Window management
  getWindowWorkspace(): Promise<string | null>;
  getWindowMode(): Promise<string | null>;
  openWorkspace(workspaceId: string): Promise<void>;
  openSessionInNewWindow(workspaceId: string, sessionId: string): Promise<void>;
  switchWorkspace(workspaceId: string): Promise<void>;
  closeWindow(): Promise<void>;
  confirmCloseWindow(): Promise<void>;
  /** Cancel a pending close request (renderer handled it by closing a modal/panel). */
  cancelCloseWindow(): Promise<void>;
  /** Listen for close requests and receive source metadata. Returns cleanup function. */
  onCloseRequested(callback: (request: WindowCloseRequest) => void): () => void;
  /** Show/hide macOS traffic light buttons (for fullscreen overlays) */
  setTrafficLightsVisible(visible: boolean): Promise<void>;

  // Event listeners
  onSessionEvent(callback: (event: SessionEvent) => void): () => void;
  onUnreadSummaryChanged(
    callback: (summary: UnreadSummary) => void,
  ): () => void;

  // File operations
  readFile(path: string): Promise<string>;
  /** Read a file as binary data (Uint8Array) */
  readFileBinary(path: string): Promise<Uint8Array>;
  /** Read a file as a data URL (data:{mime};base64,...) for binary preview (images, PDFs) */
  readFileDataUrl(path: string): Promise<string>;
  /** Read an image file as a size-bounded preview data URL for lightweight thumbnail rendering. */
  readFilePreviewDataUrl(path: string, maxSize?: number): Promise<string>;
  openFileDialog(): Promise<string[]>;
  readFileAttachment(path: string): Promise<FileAttachment | null>;
  /** Re-read a user-attached file by absolute path (bypasses workspace-dir validation).
   *  Used only by draft hydration for paths the user explicitly picked via OS dialog / drag. */
  readUserAttachment(path: string): Promise<FileAttachment | null>;
  storeAttachment(
    sessionId: string,
    attachment: FileAttachment,
  ): Promise<
    import('../../../../packages/core/src/types/index.ts').StoredAttachment
  >;
  generateThumbnail(base64: string, mimeType: string): Promise<string | null>;
  /** Returns the absolute filesystem path for a File (only works for file-picker / OS-drag Files). */
  getFilePath(file: File): string | null;

  // Filesystem search (for @ mention file selection)
  searchFiles(basePath: string, query: string): Promise<FileSearchResult[]>;

  // Server filesystem browsing (remote mode)
  listServerDirectory(dirPath: string): Promise<DirectoryListingResult>;
  // Debug: send renderer logs to main process log file
  debugLog(...args: unknown[]): void;

  // Theme
  getSystemTheme(): Promise<boolean>;
  onSystemThemeChange(callback: (isDark: boolean) => void): () => void;

  // System
  getVersions(): { node: string; chrome: string; electron: string };
  /** Returns the renderer host environment without going through RPC. */
  getRuntimeEnvironment(): 'electron' | 'web';
  getHomeDir(): Promise<string>;
  isDebugMode(): Promise<boolean>;

  // Transport connection status (preload-local, not RPC channels)
  getTransportConnectionState(): Promise<TransportConnectionState>;
  onTransportConnectionStateChanged(
    callback: (state: TransportConnectionState) => void,
  ): () => void;
  reconnectTransport(): Promise<void>;

  /** Fired after a WebSocket reconnect. isStale=true means buffer was evicted — full refresh needed. */
  onReconnected(callback: (isStale: boolean) => void): () => void;

  /** Check whether the server registered a handler for a given RPC channel. */
  isChannelAvailable(channel: string): boolean;

  // Auto-update
  checkForUpdates(): Promise<UpdateInfo>;
  getUpdateInfo(): Promise<UpdateInfo>;
  installUpdate(): Promise<void>;
  dismissUpdate(version: string): Promise<void>;
  getDismissedUpdateVersion(): Promise<string | null>;
  onUpdateAvailable(callback: (info: UpdateInfo) => void): () => void;
  onUpdateDownloadProgress(callback: (progress: number) => void): () => void;

  // Release notes
  getReleaseNotes(): Promise<string>;
  getLatestReleaseVersion(): Promise<string | undefined>;

  // System warnings (startup checks)
  getSystemWarnings(): Promise<{
    vcredistMissing: boolean;
    downloadUrl?: string;
  }>;

  // Shell operations
  openUrl(url: string): Promise<void>;
  openFile(path: string): Promise<void>;
  showInFolder(path: string): Promise<void>;

  // Menu event listeners
  onMenuNewChat(callback: () => void): () => void;
  onMenuOpenSettings(callback: () => void): () => void;
  onMenuKeyboardShortcuts(callback: () => void): () => void;
  onMenuToggleFocusMode(callback: () => void): () => void;
  onMenuToggleSidebar(callback: () => void): () => void;

  // Deep link navigation listener (for external craftagents:// URLs)
  onDeepLinkNavigate(callback: (nav: DeepLinkNavigation) => void): () => void;

  // Auth
  showLogoutConfirmation(): Promise<boolean>;
  showDeleteSessionConfirmation(name: string): Promise<boolean>;
  logout(): Promise<void>;

  // Credential health check (startup validation)
  getCredentialHealth(): Promise<CredentialHealthStatus>;

  // Onboarding
  getAuthState(): Promise<AuthState>;
  getSetupNeeds(): Promise<SetupNeeds>;
  startWorkspaceMcpOAuth(
    mcpUrl: string,
  ): Promise<OAuthResult & { clientId?: string }>;
  /** Defer onboarding setup — user chose "Setup later" */
  deferSetup(): Promise<{ success: boolean }>;

  /** Unified LLM connection setup */
  setupLlmConnection(
    setup: LlmConnectionSetup,
  ): Promise<{ success: boolean; error?: string }>;
  /** Unified connection test — spawns a lightweight agent subprocess to validate credentials */
  testLlmConnectionSetup(
    params: TestLlmConnectionParams,
  ): Promise<TestLlmConnectionResult>;
  listQwenProviders(): Promise<QwenProviderCatalog>;
  connectQwenProvider(
    params: QwenProviderConnectParams,
  ): Promise<QwenProviderConnectResult>;

  // Session-specific model (overrides global)
  getSessionModel(
    sessionId: string,
    workspaceId: string,
  ): Promise<string | null>;
  setSessionModel(
    sessionId: string,
    workspaceId: string,
    model: string | null,
    connection?: string,
  ): Promise<void>;

  // Workspace Settings (per-workspace configuration)
  getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings | null>;
  updateWorkspaceSetting<K extends keyof WorkspaceSettings>(
    workspaceId: string,
    key: K,
    value: WorkspaceSettings[K],
  ): Promise<void>;

  // Folder dialog
  openFolderDialog(): Promise<string | null>;

  // User Preferences
  readPreferences(): Promise<{
    content: string;
    exists: boolean;
    path: string;
  }>;
  writePreferences(
    content: string,
  ): Promise<{ success: boolean; error?: string }>;

  // Session Drafts (persisted composer state — text + attachment refs)
  getDraft(
    sessionId: string,
  ): Promise<import('@craft-agent/shared/config').SessionDraft | null>;
  setDraft(
    sessionId: string,
    draft: import('@craft-agent/shared/config').SessionDraft,
  ): Promise<void>;
  deleteDraft(sessionId: string): Promise<void>;
  getAllDrafts(): Promise<
    Record<string, import('@craft-agent/shared/config').SessionDraft>
  >;

  // Session Info Panel
  getSessionFiles(sessionId: string): Promise<SessionFile[]>;
  getSessionNotes(sessionId: string): Promise<string>;
  setSessionNotes(sessionId: string, content: string): Promise<void>;
  watchSessionFiles(sessionId: string): Promise<void>;
  unwatchSessionFiles(): Promise<void>;
  onSessionFilesChanged(callback: (sessionId: string) => void): () => void;

  // Sources
  getSources(workspaceId: string): Promise<LoadedSource[]>;
  createSource(
    workspaceId: string,
    config: Partial<FolderSourceConfig>,
  ): Promise<FolderSourceConfig>;
  deleteSource(workspaceId: string, sourceSlug: string): Promise<void>;
  startSourceOAuth(
    workspaceId: string,
    sourceSlug: string,
  ): Promise<{ success: boolean; error?: string }>;
  saveSourceCredentials(
    workspaceId: string,
    sourceSlug: string,
    credential: string,
  ): Promise<void>;
  getSourcePermissionsConfig(
    workspaceId: string,
    sourceSlug: string,
  ): Promise<import('@craft-agent/shared/agent').PermissionsConfigFile | null>;
  getWorkspacePermissionsConfig(
    workspaceId: string,
  ): Promise<import('@craft-agent/shared/agent').PermissionsConfigFile | null>;
  getDefaultPermissionsConfig(): Promise<{
    config: import('@craft-agent/shared/agent').PermissionsConfigFile | null;
    path: string;
  }>;
  getMcpTools(workspaceId: string, sourceSlug: string): Promise<McpToolsResult>;

  // OAuth (server-owned credentials, client-orchestrated flow)
  performOAuth(args: {
    sourceSlug: string;
    sessionId?: string;
    authRequestId?: string;
  }): Promise<{ success: boolean; error?: string; email?: string }>;
  oauthRevoke(sourceSlug: string): Promise<{ success: boolean }>;

  // Session content search (full-text search via ripgrep)
  searchSessionContent(
    workspaceId: string,
    query: string,
    searchId?: string,
  ): Promise<SessionSearchResult[]>;

  // Sources change listener (live updates when sources are added/removed)
  onSourcesChanged(
    callback: (workspaceId: string, sources: LoadedSource[]) => void,
  ): () => void;

  // Default permissions change listener (live updates when default.json changes)
  onDefaultPermissionsChanged(callback: () => void): () => void;

  // Skills
  getSkills(
    workspaceId: string,
    workingDirectory?: string,
  ): Promise<LoadedSkill[]>;
  getSkillFiles?(workspaceId: string, skillSlug: string): Promise<SkillFile[]>;
  deleteSkill(workspaceId: string, skillSlug: string): Promise<void>;
  openSkillInEditor(workspaceId: string, skillSlug: string): Promise<void>;
  openSkillInFinder(workspaceId: string, skillSlug: string): Promise<void>;

  // Skills change listener (live updates when skills are added/removed/modified)
  onSkillsChanged(
    callback: (workspaceId: string, skills: LoadedSkill[]) => void,
  ): () => void;

  // Statuses (workspace-scoped)
  listStatuses(
    workspaceId: string,
  ): Promise<Array<import('@craft-agent/shared/statuses').StatusConfig>>;
  reorderStatuses(workspaceId: string, orderedIds: string[]): Promise<void>;
  onStatusesChanged(callback: (workspaceId: string) => void): () => void;

  // Labels (workspace-scoped)
  listLabels(
    workspaceId: string,
  ): Promise<Array<import('@craft-agent/shared/labels').LabelConfig>>;
  createLabel(
    workspaceId: string,
    input: import('@craft-agent/shared/labels').CreateLabelInput,
  ): Promise<import('@craft-agent/shared/labels').LabelConfig>;
  deleteLabel(
    workspaceId: string,
    labelId: string,
  ): Promise<{ stripped: number }>;
  onLabelsChanged(callback: (workspaceId: string) => void): () => void;

  // LLM connections change listener
  onLlmConnectionsChanged(callback: () => void): () => void;

  // Views (workspace-scoped, stored in views.json)
  listViews(
    workspaceId: string,
  ): Promise<Array<import('@craft-agent/shared/views').ViewConfig>>;
  saveViews(
    workspaceId: string,
    views: Array<import('@craft-agent/shared/views').ViewConfig>,
  ): Promise<void>;

  // Generic workspace image loading/saving
  readWorkspaceImage(
    workspaceId: string,
    relativePath: string,
  ): Promise<string>;
  writeWorkspaceImage(
    workspaceId: string,
    relativePath: string,
    base64: string,
    mimeType: string,
  ): Promise<void>;

  // Tool icon mappings
  getToolIconMappings(): Promise<ToolIconMapping[]>;

  // Theme (app-level default)
  getAppTheme(): Promise<import('@config/theme').ThemeOverrides | null>;
  loadPresetThemes(): Promise<Array<import('@config/theme').PresetTheme>>;
  loadPresetTheme(
    themeId: string,
  ): Promise<import('@config/theme').PresetTheme | null>;
  getColorTheme(): Promise<string>;
  setColorTheme(themeId: string): Promise<void>;
  getWorkspaceColorTheme(workspaceId: string): Promise<string | null>;
  setWorkspaceColorTheme(
    workspaceId: string,
    themeId: string | null,
  ): Promise<void>;
  getAllWorkspaceThemes(): Promise<Record<string, string | undefined>>;

  // Theme change listeners
  onAppThemeChange(
    callback: (theme: import('@config/theme').ThemeOverrides | null) => void,
  ): () => void;

  // Logo URL resolution
  getLogoUrl(serviceUrl: string, provider?: string): Promise<string | null>;

  // Notifications
  showNotification(
    title: string,
    body: string,
    workspaceId: string,
    sessionId: string,
  ): Promise<void>;
  getNotificationsEnabled(): Promise<boolean>;
  setNotificationsEnabled(enabled: boolean): Promise<void>;

  // Input settings
  getAutoCapitalisation(): Promise<boolean>;
  setAutoCapitalisation(enabled: boolean): Promise<void>;
  getSendMessageKey(): Promise<'enter' | 'cmd-enter'>;
  setSendMessageKey(key: 'enter' | 'cmd-enter'): Promise<void>;
  getSpellCheck(): Promise<boolean>;
  setSpellCheck(enabled: boolean): Promise<void>;

  // Power settings
  getKeepAwakeWhileRunning(): Promise<boolean>;
  setKeepAwakeWhileRunning(enabled: boolean): Promise<void>;

  // Tools settings
  getBrowserToolEnabled(): Promise<boolean>;
  setBrowserToolEnabled(enabled: boolean): Promise<void>;

  // Appearance settings
  getRichToolDescriptions(): Promise<boolean>;
  setRichToolDescriptions(enabled: boolean): Promise<void>;

  // Prompt caching & context
  getExtendedPromptCache(): Promise<boolean>;
  setExtendedPromptCache(enabled: boolean): Promise<void>;
  getEnable1MContext(): Promise<boolean>;
  setEnable1MContext(enabled: boolean): Promise<void>;

  // Memory settings
  getQwenMemorySettings(): Promise<
    import('@craft-agent/shared/config').QwenMemorySettings
  >;
  setQwenMemorySettings(
    settings: Partial<import('@craft-agent/shared/config').QwenMemorySettings>,
  ): Promise<import('@craft-agent/shared/config').QwenMemorySettings>;
  getQwenMemorySettingsPath(): Promise<string>;
  getQwenMemoryPaths(
    workspaceId?: string,
  ): Promise<import('@craft-agent/shared/config').QwenMemoryPaths>;
  openQwenMemoryPath(
    target: import('@craft-agent/shared/config').QwenMemoryPathTarget,
    workspaceId?: string,
  ): Promise<void>;

  // Network proxy settings
  getNetworkProxySettings(): Promise<NetworkProxySettings | undefined>;
  setNetworkProxySettings(settings: NetworkProxySettings): Promise<void>;

  refreshBadge(): Promise<void>;
  setDockIconWithBadge(dataUrl: string): Promise<void>;
  onBadgeDraw(
    callback: (data: { count: number; iconDataUrl: string }) => void,
  ): () => void;
  onBadgeDrawWindows(callback: (data: { count: number }) => void): () => void;
  getWindowFocusState(): Promise<boolean>;
  onWindowFocusChange(callback: (isFocused: boolean) => void): () => void;
  onNotificationNavigate(
    callback: (data: { workspaceId: string; sessionId: string }) => void,
  ): () => void;

  // Theme preferences sync across windows
  broadcastThemePreferences(preferences: {
    mode: string;
    colorTheme: string;
    font: string;
  }): Promise<void>;
  onThemePreferencesChange(
    callback: (preferences: {
      mode: string;
      colorTheme: string;
      font: string;
    }) => void,
  ): () => void;

  // Workspace theme sync across windows
  broadcastWorkspaceThemeChange(
    workspaceId: string,
    themeId: string | null,
  ): Promise<void>;
  onWorkspaceThemeChange(
    callback: (data: { workspaceId: string; themeId: string | null }) => void,
  ): () => void;

  // Git operations
  getGitBranch(dirPath: string): Promise<string | null>;

  // Git Bash (Windows)
  checkGitBash(): Promise<GitBashStatus>;
  browseForGitBash(): Promise<string | null>;
  setGitBashPath(path: string): Promise<{ success: boolean; error?: string }>;

  // Menu actions (from renderer to main)
  menuQuit(): Promise<void>;
  menuNewWindow(): Promise<void>;
  menuMinimize(): Promise<void>;
  menuMaximize(): Promise<void>;
  menuZoomIn(): Promise<void>;
  menuZoomOut(): Promise<void>;
  menuZoomReset(): Promise<void>;
  menuToggleDevTools(): Promise<void>;
  menuUndo(): Promise<void>;
  menuRedo(): Promise<void>;
  menuCut(): Promise<void>;
  menuCopy(): Promise<void>;
  menuPaste(): Promise<void>;
  menuSelectAll(): Promise<void>;

  // Browser pane management
  browserPane: {
    create(input?: string | BrowserPaneCreateOptions): Promise<string>;
    destroy(id: string): Promise<void>;
    list(): Promise<BrowserInstanceInfo[]>;
    navigate(id: string, url: string): Promise<{ url: string; title: string }>;
    goBack(id: string): Promise<void>;
    goForward(id: string): Promise<void>;
    reload(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    focus(id: string): Promise<void>;
    emptyStateLaunch(
      payload: BrowserEmptyStateLaunchPayload,
    ): Promise<BrowserEmptyStateLaunchResult>;
    onStateChanged(callback: (info: BrowserInstanceInfo) => void): () => void;
    onRemoved(callback: (id: string) => void): () => void;
    onInteracted(callback: (id: string) => void): () => void;
  };

  // LLM Connections (provider configurations)
  listLlmConnections(): Promise<LlmConnection[]>;
  listLlmConnectionsWithStatus(): Promise<LlmConnectionWithStatus[]>;
  getLlmConnection(slug: string): Promise<LlmConnection | null>;
  getLlmConnectionApiKey(slug: string): Promise<string | null>;
  saveLlmConnection(
    connection: LlmConnection,
  ): Promise<{ success: boolean; error?: string }>;
  deleteLlmConnection(
    slug: string,
  ): Promise<{ success: boolean; error?: string }>;
  testLlmConnection(
    slug: string,
  ): Promise<{ success: boolean; error?: string }>;
  setDefaultLlmConnection(
    slug: string,
  ): Promise<{ success: boolean; error?: string }>;
  refreshLlmConnectionModels(
    slug: string,
  ): Promise<{ success: boolean; error?: string }>;
  getDefaultThinkingLevel(): Promise<ThinkingLevel>;
  setDefaultThinkingLevel(
    level: ThinkingLevel,
  ): Promise<{ success: boolean; error?: string }>;
  setWorkspaceDefaultLlmConnection(
    workspaceId: string,
    slug: string | null,
  ): Promise<{ success: boolean; error?: string }>;

  // Automations
  getAutomations(workspaceId: string): Promise<unknown>;

  // Automation testing (manual trigger)
  testAutomation(payload: TestAutomationPayload): Promise<TestAutomationResult>;

  // Automation state management
  setAutomationEnabled(
    workspaceId: string,
    eventName: string,
    matcherIndex: number,
    enabled: boolean,
  ): Promise<void>;
  duplicateAutomation(
    workspaceId: string,
    eventName: string,
    matcherIndex: number,
  ): Promise<void>;
  deleteAutomation(
    workspaceId: string,
    eventName: string,
    matcherIndex: number,
  ): Promise<void>;
  getAutomationHistory(
    workspaceId: string,
    automationId: string,
    limit?: number,
  ): Promise<
    Array<{
      id: string;
      ts: number;
      ok: boolean;
      sessionId?: string;
      prompt?: string;
      error?: string;
      webhook?: {
        method: string;
        url: string;
        statusCode: number;
        durationMs: number;
        attempts?: number;
        error?: string;
        responseBody?: string;
      };
    }>
  >;
  getAutomationLastExecuted(
    workspaceId: string,
  ): Promise<Record<string, number>>;
  replayAutomation(
    workspaceId: string,
    automationId: string,
    eventName: string,
  ): Promise<{
    results: Array<{
      type: string;
      url: string;
      statusCode: number;
      success: boolean;
      error?: string;
      duration: number;
    }>;
  }>;

  // Automations change listener
  onAutomationsChanged(callback: (workspaceId: string) => void): () => void;

  // Language
  changeLanguage(lang: string): Promise<void>;

  // Resources (cross-workspace export/import)
  exportResources(
    workspaceId: string,
    options: ExportResourcesOptions,
  ): Promise<ExportResult>;
  importResources(
    workspaceId: string,
    bundle: ResourceBundle,
    mode: ResourceImportMode,
  ): Promise<ResourceImportResult>;

  // Messaging gateway — workspaceId is taken from the client handshake (ctx.workspaceId)
  getMessagingConfig(): Promise<{
    enabled: boolean;
    platforms: Record<string, { enabled: boolean } | undefined>;
    runtime: Record<string, MessagingPlatformRuntimeInfo | undefined>;
  } | null>;
  updateMessagingConfig(config: Record<string, unknown>): Promise<void>;
  testTelegramToken(
    token: string,
  ): Promise<{
    success: boolean;
    botName?: string;
    botUsername?: string;
    error?: string;
  }>;
  saveTelegramToken(token: string): Promise<void>;
  disconnectMessagingPlatform(platform: string): Promise<void>;
  forgetMessagingPlatform(platform: string): Promise<void>;
  getMessagingBindings(): Promise<
    Array<{
      id: string;
      workspaceId: string;
      sessionId: string;
      platform: string;
      channelId: string;
      channelName?: string;
      enabled: boolean;
      createdAt: number;
    }>
  >;
  generateMessagingPairingCode(
    sessionId: string,
    platform: string,
  ): Promise<{ code: string; expiresAt: number; botUsername?: string }>;
  unbindMessagingSession(sessionId: string, platform?: string): Promise<void>;
  unbindMessagingBinding(bindingId: string): Promise<{ success: boolean }>;
  onMessagingBindingChanged(
    callback: (workspaceId: string) => void,
  ): () => void;
  onMessagingPlatformStatus(
    callback: (
      workspaceId: string,
      platform: string,
      status: MessagingPlatformRuntimeInfo,
    ) => void,
  ): () => void;
  // WhatsApp (subprocess-based Baileys adapter)
  startWhatsAppConnect(): Promise<{ success: boolean }>;
  submitWhatsAppPhone(phoneNumber: string): Promise<{ success: boolean }>;
  onWhatsAppEvent(
    callback: (payload: {
      workspaceId: string;
      event: WhatsAppUiEvent;
    }) => void,
  ): () => void;
}

export interface MessagingPlatformRuntimeInfo {
  platform: string;
  configured: boolean;
  connected: boolean;
  state:
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnect_required'
    | 'error';
  identity?: string;
  lastError?: string;
  updatedAt: number;
}

/** Event payloads broadcast from the WhatsApp subprocess to the UI. */
export type WhatsAppUiEvent =
  | { type: 'qr'; qr: string }
  | { type: 'pairing_code'; code: string }
  | { type: 'connected'; jid?: string; name?: string }
  | { type: 'disconnected'; loggedOut: boolean; reason?: string }
  | { type: 'unavailable'; reason: string; message: string }
  | { type: 'error'; message: string };

// =============================================================================
// Navigation types (renderer-only)
// =============================================================================

/**
 * Right sidebar panel types
 */
export type RightSidebarPanel =
  | { type: 'files'; path?: string }
  | { type: 'history' }
  | { type: 'none' };

/**
 * Session filter options
 */
export type SessionFilter =
  | { kind: 'allSessions' }
  | { kind: 'flagged' }
  | { kind: 'state'; stateId: string }
  | { kind: 'label'; labelId: string }
  | { kind: 'view'; viewId: string }
  | { kind: 'archived' };

/**
 * Settings subpage options - re-exported from settings-registry (single source of truth)
 */
export type { SettingsSubpage } from './settings-registry';
import {
  DEFAULT_SETTINGS_SUBPAGE,
  isValidSettingsSubpage,
  type SettingsSubpage,
} from './settings-registry';

/**
 * Sessions navigation state
 */
export interface SessionsNavigationState {
  navigator: 'sessions';
  filter: SessionFilter;
  details: { type: 'session'; sessionId: string } | null;
  rightSidebar?: RightSidebarPanel;
}

/**
 * Source type filter for sources navigation
 */
export interface SourceFilter {
  kind: 'type';
  sourceType: 'api' | 'mcp' | 'local';
}

/**
 * Automation type filter for automations navigation
 */
export interface AutomationFilter {
  kind: 'type';
  automationType: 'scheduled' | 'event' | 'agentic';
}

/**
 * Sources navigation state
 */
export interface SourcesNavigationState {
  navigator: 'sources';
  filter?: SourceFilter;
  details: { type: 'source'; sourceSlug: string } | null;
  rightSidebar?: RightSidebarPanel;
}

/**
 * Settings navigation state
 */
export interface SettingsNavigationState {
  navigator: 'settings';
  subpage: SettingsSubpage;
  rightSidebar?: RightSidebarPanel;
}

/**
 * Skills navigation state
 */
export interface SkillsNavigationState {
  navigator: 'skills';
  details: { type: 'skill'; skillSlug: string } | null;
  rightSidebar?: RightSidebarPanel;
}

/**
 * Automations navigation state
 */
export interface AutomationsNavigationState {
  navigator: 'automations';
  filter?: AutomationFilter;
  details: { type: 'automation'; automationId: string } | null;
  rightSidebar?: RightSidebarPanel;
}

/**
 * Unified navigation state
 */
export type NavigationState =
  | SessionsNavigationState
  | SourcesNavigationState
  | SettingsNavigationState
  | SkillsNavigationState
  | AutomationsNavigationState;

export const isSessionsNavigation = (
  state: NavigationState,
): state is SessionsNavigationState => state.navigator === 'sessions';

export const isSourcesNavigation = (
  state: NavigationState,
): state is SourcesNavigationState => state.navigator === 'sources';

export const isSettingsNavigation = (
  state: NavigationState,
): state is SettingsNavigationState => state.navigator === 'settings';

export const isSkillsNavigation = (
  state: NavigationState,
): state is SkillsNavigationState => state.navigator === 'skills';

export const isAutomationsNavigation = (
  state: NavigationState,
): state is AutomationsNavigationState => state.navigator === 'automations';

export const DEFAULT_NAVIGATION_STATE: NavigationState = {
  navigator: 'sessions',
  filter: { kind: 'allSessions' },
  details: null,
};

export const getNavigationStateKey = (state: NavigationState): string => {
  if (state.navigator === 'sources') {
    if (state.details) {
      return `sources/source/${state.details.sourceSlug}`;
    }
    return 'sources';
  }
  if (state.navigator === 'skills') {
    if (state.details?.type === 'skill') {
      return `skills/skill/${state.details.skillSlug}`;
    }
    return 'skills';
  }
  if (state.navigator === 'automations') {
    if (state.details?.type === 'automation') {
      return `automations/automation/${state.details.automationId}`;
    }
    return 'automations';
  }
  if (state.navigator === 'settings') {
    return `settings:${state.subpage}`;
  }
  // Chats
  const f = state.filter;
  let base: string;
  if (f.kind === 'state') base = `state:${f.stateId}`;
  else if (f.kind === 'label') base = `label:${f.labelId}`;
  else if (f.kind === 'view') base = `view:${f.viewId}`;
  else base = f.kind;
  if (state.details) {
    return `${base}/chat/${state.details.sessionId}`;
  }
  return base;
};

export const parseNavigationStateKey = (
  key: string,
): NavigationState | null => {
  // Handle sources
  if (key === 'sources') return { navigator: 'sources', details: null };
  if (key.startsWith('sources/source/')) {
    const sourceSlug = key.slice(15);
    if (sourceSlug) {
      return { navigator: 'sources', details: { type: 'source', sourceSlug } };
    }
    return { navigator: 'sources', details: null };
  }

  // Handle skills
  if (key === 'skills') return { navigator: 'skills', details: null };
  if (key.startsWith('skills/skill/')) {
    const skillSlug = key.slice(13);
    if (skillSlug) {
      return { navigator: 'skills', details: { type: 'skill', skillSlug } };
    }
    return { navigator: 'skills', details: null };
  }

  // Handle automations
  if (key === 'automations') return { navigator: 'automations', details: null };
  if (key.startsWith('automations/automation/')) {
    const automationId = key.slice(22);
    if (automationId) {
      return {
        navigator: 'automations',
        details: { type: 'automation', automationId },
      };
    }
    return { navigator: 'automations', details: null };
  }

  // Handle settings
  if (key === 'settings') {
    return { navigator: 'settings', subpage: DEFAULT_SETTINGS_SUBPAGE };
  }
  if (key.startsWith('settings:')) {
    const subpage = key.slice(9);
    if (isValidSettingsSubpage(subpage)) {
      return { navigator: 'settings', subpage };
    }
  }

  // Handle sessions
  const parseSessionsKey = (
    filterKey: string,
    sessionId?: string,
  ): NavigationState | null => {
    let filter: SessionFilter;
    if (filterKey === 'allSessions') filter = { kind: 'allSessions' };
    else if (filterKey === 'flagged') filter = { kind: 'flagged' };
    else if (filterKey === 'archived') filter = { kind: 'archived' };
    else if (filterKey.startsWith('state:')) {
      const stateId = filterKey.slice(6);
      if (!stateId) return null;
      filter = { kind: 'state', stateId };
    } else if (filterKey.startsWith('label:')) {
      const labelId = filterKey.slice(6);
      if (!labelId) return null;
      filter = { kind: 'label', labelId };
    } else if (filterKey.startsWith('view:')) {
      const viewId = filterKey.slice(5);
      if (!viewId) return null;
      filter = { kind: 'view', viewId };
    } else {
      return null;
    }
    return {
      navigator: 'sessions',
      filter,
      details: sessionId ? { type: 'session', sessionId } : null,
    };
  };

  // Check for session details
  if (key.includes('/session/')) {
    const [filterPart, , sessionId] = key.split('/');
    return parseSessionsKey(filterPart, sessionId);
  }

  // Simple filter key
  return parseSessionsKey(key);
};

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
