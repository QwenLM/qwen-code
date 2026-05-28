/**
 * ISessionManager — abstract interface for the session lifecycle engine.
 *
 * Handler code in server-core programs against this interface;
 * concrete implementations (Electron SessionManager, headless, etc.)
 * satisfy it at runtime.
 */

import type {
  Workspace,
  WorkspaceInfo,
  ActiveSessionInfo,
} from '@craft-agent/core/types'
import type { StoredAttachment, AnnotationV1 } from '@craft-agent/core/types'
import type { PermissionMode } from '@craft-agent/shared/agent/mode-types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import type { AuthResult } from '@craft-agent/shared/agent'
import type {
  Session,
  SessionStatus,
  AvailableSlashCommand,
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  PermissionResponseOptions,
  CredentialResponse,
  PermissionModeState,
  UnreadSummary,
  ShareResult,
  RefreshAvailableCommandsOptions,
  PermissionRuleType,
  PermissionSettingsScope,
  QwenCoreSettingKey,
  QwenCoreSettingsSnapshot,
  QwenHookDefinition,
  QwenHookEvent,
  QwenMcpServerConfig,
  QwenPermissionSettings,
  QwenProviderCatalog,
  QwenProviderConnectParams,
  QwenProviderConnectResult,
  QwenSettingValue,
  QwenSettingsScope,
  QwenSkillDeleteRequest,
  QwenSkillDeleteResult,
  QwenSkillInstallRequest,
  QwenSkillInstallResult,
  QwenSkillSetEnabledRequest,
  QwenSkillSetEnabledResult,
} from '@craft-agent/shared/protocol'
import type { SessionBundle, DispatchMode } from '@craft-agent/shared/sessions'
import type { EventSink } from '../transport'

export interface ISessionManager {
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  waitForInit(): Promise<void>
  initialize(): Promise<void>
  cleanup(): void
  setEventSink(sink: EventSink): void
  flushAllSessions(): Promise<void>

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  getSessions(workspaceId?: string): Session[]
  refreshExternalSessions?(workspaceId?: string): Promise<void>
  getSession(sessionId: string): Promise<Session | null>
  createSession(
    workspaceId: string,
    options?: CreateSessionOptions,
  ): Promise<Session>
  deleteSession(sessionId: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------

  flagSession(sessionId: string): Promise<void>
  unflagSession(sessionId: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, name: string): Promise<void>
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<void>
  markSessionRead(sessionId: string): Promise<void>
  markSessionUnread(sessionId: string): Promise<void>
  markAllSessionsRead(workspaceId: string): Promise<void>
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void
  clearActiveViewingSession(workspaceId: string): void

  // ---------------------------------------------------------------------------
  // Session configuration
  // ---------------------------------------------------------------------------

  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void
  updateWorkingDirectory(sessionId: string, path: string): void
  setSessionSources(sessionId: string, sourceSlugs: string[]): Promise<void>
  setSessionLabels(sessionId: string, labels: string[]): void
  setSessionConnection(sessionId: string, connectionSlug: string): Promise<void>
  updateSessionModel(
    sessionId: string,
    workspaceId: string,
    model: string | null,
    connection?: string,
  ): Promise<void>

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
  ): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  killShell(
    sessionId: string,
    shellId: string,
  ): Promise<{ success: boolean; error?: string }>
  getTaskOutput(taskId: string): Promise<string | null>
  updateMessageContent(
    sessionId: string,
    messageId: string,
    content: string,
  ): Promise<void>
  addMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotation: AnnotationV1,
  ): void
  removeMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
  ): void
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<AnnotationV1>,
  ): void

  // ---------------------------------------------------------------------------
  // Permissions & credentials
  // ---------------------------------------------------------------------------

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions,
  ): boolean
  respondToCredential(
    sessionId: string,
    requestId: string,
    response: CredentialResponse,
  ): Promise<boolean>
  getSessionPermissionModeState(sessionId: string): PermissionModeState | null
  getSessionPermissionSettings(
    sessionId: string,
  ): Promise<QwenPermissionSettings>
  setSessionPermissionRules(
    sessionId: string,
    scope: PermissionSettingsScope,
    ruleType: PermissionRuleType,
    rules: string[],
  ): Promise<QwenPermissionSettings>
  getSessionQwenCoreSettings(
    sessionId: string,
  ): Promise<QwenCoreSettingsSnapshot>
  listSessionQwenProviders(sessionId: string): Promise<QwenProviderCatalog>
  connectSessionQwenProvider(
    sessionId: string,
    params: QwenProviderConnectParams,
  ): Promise<QwenProviderConnectResult>
  setSessionQwenCoreSetting(
    sessionId: string,
    scope: QwenSettingsScope,
    key: QwenCoreSettingKey,
    value: QwenSettingValue,
  ): Promise<QwenCoreSettingsSnapshot>
  setSessionQwenMcpServer(
    sessionId: string,
    scope: QwenSettingsScope,
    name: string,
    server: QwenMcpServerConfig,
  ): Promise<QwenCoreSettingsSnapshot>
  removeSessionQwenMcpServer(
    sessionId: string,
    scope: QwenSettingsScope,
    name: string,
  ): Promise<QwenCoreSettingsSnapshot>
  setSessionQwenHook(
    sessionId: string,
    scope: QwenSettingsScope,
    event: QwenHookEvent,
    index: number | undefined,
    hook: QwenHookDefinition,
  ): Promise<QwenCoreSettingsSnapshot>
  removeSessionQwenHook(
    sessionId: string,
    scope: QwenSettingsScope,
    event: QwenHookEvent,
    index: number,
  ): Promise<QwenCoreSettingsSnapshot>
  setSessionQwenExtensionSetting(
    sessionId: string,
    extensionId: string,
    settingKey: string,
    scope: QwenSettingsScope,
    value: QwenSettingValue,
  ): Promise<QwenCoreSettingsSnapshot>

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  setPendingPlanExecution(
    sessionId: string,
    planPath: string,
    draftInputSnapshot?: string,
  ): Promise<void>
  markPendingPlanExecutionDispatched(sessionId: string): Promise<void>
  clearPendingPlanExecution(sessionId: string): Promise<void>
  getPendingPlanExecution(sessionId: string): {
    planPath: string
    draftInputSnapshot?: string
    awaitingCompaction: boolean
    executionDispatched: boolean
  } | null
  markCompactionComplete(sessionId: string): Promise<void>

  /**
   * Send the plan-approval "I approve this plan, please execute it" message
   * to the session as if the user had clicked "Accept plan" in the desktop UI.
   * If the session is in Explore (safe) mode, also switches it to allow-all
   * so the plan can actually run without per-tool prompts.
   *
   * Used by the messaging gateway so Telegram/WhatsApp accept buttons produce
   * the same server-side effect as the desktop accept button.
   */
  acceptPlan(sessionId: string, planPath?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  shareToViewer(sessionId: string): Promise<ShareResult>
  updateShare(sessionId: string): Promise<ShareResult>
  revokeShare(sessionId: string): Promise<ShareResult>

  // ---------------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------------

  /**
   * Export a session as a portable bundle.
   * Flushes pending writes, serializes session data + files.
   * Session must be stopped before export.
   */
  exportSession(
    sessionId: string,
    workspaceId: string,
  ): Promise<SessionBundle | null>

  /**
   * Export a session as a summary-based payload for cross-server transfer.
   * Generates a mini-model summary instead of shipping the full transcript.
   */
  exportRemoteSessionTransfer(
    sessionId: string,
    workspaceId: string,
  ): Promise<
    import('@craft-agent/shared/protocol').RemoteSessionTransferPayload | null
  >

  /**
   * Import a session bundle into a target workspace.
   * Creates session directory, writes JSONL + files, registers in memory.
   * Returns the new session ID and any compatibility warnings.
   */
  importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }>

  /**
   * Import a summary-based remote transfer payload into a target workspace.
   */
  importRemoteSessionTransfer(
    workspaceId: string,
    payload: import('@craft-agent/shared/protocol').RemoteSessionTransferPayload,
  ): Promise<
    import('@craft-agent/shared/protocol').ImportRemoteSessionTransferResult
  >

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  getSessionPath(sessionId: string): string | null
  refreshTitle(
    sessionId: string,
  ): Promise<{ success: boolean; title?: string; error?: string }>
  refreshAvailableCommands(
    sessionId: string,
    options?: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    availableCommands?: AvailableSlashCommand[]
    availableSkills?: string[]
    availableSkillDetails?: Array<
      import('@craft-agent/core/types').AvailableSkillDetail
    >
    error?: string
  }>
  installQwenSkill(
    sessionId: string,
    skill: QwenSkillInstallRequest,
    options?: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    skill?: QwenSkillInstallResult
    availableCommands?: AvailableSlashCommand[]
    availableSkills?: string[]
    availableSkillDetails?: Array<
      import('@craft-agent/core/types').AvailableSkillDetail
    >
    error?: string
  }>
  deleteQwenSkill(
    sessionId: string,
    skill: QwenSkillDeleteRequest,
    options?: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    skill?: QwenSkillDeleteResult
    availableCommands?: AvailableSlashCommand[]
    availableSkills?: string[]
    availableSkillDetails?: Array<
      import('@craft-agent/core/types').AvailableSkillDetail
    >
    error?: string
  }>
  setQwenSkillEnabled(
    sessionId: string,
    skill: QwenSkillSetEnabledRequest,
    options?: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    skill?: QwenSkillSetEnabledResult
    availableCommands?: AvailableSlashCommand[]
    availableSkills?: string[]
    availableSkillDetails?: Array<
      import('@craft-agent/core/types').AvailableSkillDetail
    >
    error?: string
  }>
  refreshBadge(): void
  getUnreadSummary(): UnreadSummary

  // ---------------------------------------------------------------------------
  // Workspace
  // ---------------------------------------------------------------------------

  getWorkspaces(): Workspace[]
  /** Return client-safe workspace list (no rootPath) for remote clients. */
  getWorkspacesInfo(): WorkspaceInfo[]
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void
  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void

  // ---------------------------------------------------------------------------
  // Server-level observability
  // ---------------------------------------------------------------------------

  /** Count of sessions with active backend processes. Pass workspaceId to scope. */
  getActiveSessionCount(workspaceId?: string): number
  /** Automation summary for a workspace (count of configured automations + scheduler state). */
  getWorkspaceAutomationSummary(workspaceId: string): {
    automationCount: number
    schedulerRunning: boolean
  }
  /** Active sessions across all workspaces (sessions with running backend processes). */
  getActiveSessionsInfo(): ActiveSessionInfo[]

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  reinitializeAuth(connectionSlug?: string): Promise<void>
  completeAuthRequest(sessionId: string, result: AuthResult): Promise<void>
  executePromptAutomation(
    workspaceId: string,
    workspaceRootPath: string,
    prompt: string,
    labels?: string[],
    permissionMode?: PermissionMode,
    mentions?: string[],
    llmConnection?: string,
    model?: string,
    automationName?: string,
  ): Promise<{ sessionId: string }>
}
