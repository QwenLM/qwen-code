import type { EventSink } from '@craft-agent/server-core/transport'
import type {
  ISessionManager,
  IBrowserPaneManager,
} from '@craft-agent/server-core/handlers'
import {
  validateFilePath,
  getWorkspaceAllowedDirs,
} from '@craft-agent/server-core/handlers'
import {
  createScopedLogger,
  CONSOLE_LOGGER,
  type PlatformServices,
  type Logger,
} from '@craft-agent/server-core/runtime'
import { basename, extname, join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import {
  setPermissionMode,
  hydratePreviousPermissionMode,
  getPermissionModeDiagnostics,
  type PermissionMode,
  unregisterSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  AbortReason,
  type AuthRequest,
  type AuthResult,
  type CredentialAuthRequest,
  type BrowserPaneFns,
  generateConversationSummary,
} from '@craft-agent/shared/agent'
import {
  resolveSessionConnection,
  createBackendFromConnection,
  resolveBackendContext,
  createBackendFromResolvedContext,
  cleanupSourceRuntimeArtifacts,
  providerTypeToAgentProvider,
  resolveModelForProvider,
  type AgentBackend,
  type BackendSessionInfo,
  type BackendHostRuntimeContext,
  type AvailableCommandsSnapshot,
  type BackendSessionMessagesResult,
} from '@craft-agent/shared/agent/backend'
import {
  getLlmConnection,
  getLlmConnections,
  getDefaultLlmConnection,
  getDefaultThinkingLevel,
  QWEN_CODE_CONNECTION_SLUG,
  type ModelDefinition,
} from '@craft-agent/shared/config'
import { PrivilegedExecutionBroker } from '@craft-agent/server-core/services'
import { isValidWorkingDirectory } from '../utils/path-validation'
import { InitGate } from '@craft-agent/server-core/domain'
import {
  i18n,
  LOCALE_REGISTRY,
  type LanguageCode,
} from '@craft-agent/shared/i18n'
import {
  getWorkspaces,
  getWorkspaceByNameOrId,
  loadConfigDefaults,
  migrateLegacyCredentials,
  migrateLegacyLlmConnectionsConfig,
  migrateOrphanedDefaultConnections,
  MODEL_REGISTRY,
  type Workspace,
  type WorkspaceInfo,
} from '@craft-agent/shared/config'
import type {
  ActiveSessionInfo,
  SessionProcessingStatus,
} from '@craft-agent/core/types'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import {
  // Session persistence functions
  listSessions as listStoredSessions,
  loadSession as loadStoredSession,
  saveSession as saveStoredSession,
  createSession as createStoredSession,
  deleteSession as deleteStoredSession,
  updateSessionMetadata,
  setPendingPlanExecution as setStoredPendingPlanExecution,
  markCompactionComplete as markStoredCompactionComplete,
  markPendingPlanExecutionDispatched as markStoredPendingPlanExecutionDispatched,
  clearPendingPlanExecution as clearStoredPendingPlanExecution,
  getPendingPlanExecution as getStoredPendingPlanExecution,
  getSessionPath as getSessionStoragePath,
  ensureSessionDir,
  getSessionFilePath,
  generateSessionId,
  sessionPersistenceQueue,
  getHeaderMetadataSignature,
  createSessionHeader,
  writeSessionJsonl,
  serializeSession,
  validateBundle,
  type SessionBundle,
  type DispatchMode,
  type StoredSession,
  type StoredMessage,
  type SessionStatus,
  type SessionHeader,
  type SessionConfig,
  pickSessionFields,
} from '@craft-agent/shared/sessions'
import {
  loadWorkspaceSources,
  loadAllSources,
  getSourcesBySlugs,
  isSourceUsable,
  type LoadedSource,
  getSourceCredentialManager,
  getSourceServerBuilder,
  type SourceWithCredential,
  isApiOAuthProvider,
  hasRenewEndpoint,
  SERVER_BUILD_ERRORS,
  TokenRefreshManager,
  createTokenGetter,
} from '@craft-agent/shared/sources'
import {
  ConfigWatcher,
  type ConfigWatcherCallbacks,
} from '@craft-agent/shared/config'
import { resolveAuthEnvVars } from '@craft-agent/shared/config'
import {
  toolMetadataStore,
  getLastApiError,
} from '@craft-agent/shared/interceptor'
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames'
import { restoreFiles } from '@craft-agent/shared/utils/bundle-files'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { McpClientPool, McpPoolServer } from '@craft-agent/shared/mcp'
import {
  type Session,
  type SessionEvent,
  type FileAttachment,
  type SendMessageOptions,
  type UnreadSummary,
  type RemoteSessionTransferPayload,
  type ImportRemoteSessionTransferResult,
  type AvailableSlashCommand,
  type RefreshAvailableCommandsOptions,
  type PermissionRuleType,
  type PermissionSettingsScope,
  type QwenPermissionSettings,
  type QwenCoreSettingKey,
  type QwenCoreSettingsSnapshot,
  type QwenHookDefinition,
  type QwenHookEvent,
  type QwenMcpServerConfig,
  type QwenProviderCatalog,
  type QwenProviderConnectParams,
  type QwenProviderConnectResult,
  type QwenSettingValue,
  type QwenSettingsScope,
  type QwenSkillDeleteRequest,
  type QwenSkillDeleteResult,
  type QwenSkillInstallRequest,
  type QwenSkillInstallResult,
  type QwenSkillSetEnabledRequest,
  type QwenSkillSetEnabledResult,
  RPC_CHANNELS,
  generateMessageId,
} from '@craft-agent/shared/protocol'
import {
  messageToStored,
  storedToMessage,
  type AgentEvent,
  type Message,
  type StoredAttachment,
  type ToolDisplayMeta,
} from '@craft-agent/core/types'
import { textElementsToContentBadges } from '@craft-agent/core/utils'
import {
  formatPathsToRelative,
  formatToolInputPaths,
  perf,
  encodeIconToDataUrlAsync,
  getEmojiIcon,
  resetSummarizationClient,
  resolveToolIcon,
  readFileAttachment,
  selectSpreadMessages,
  normalizePath,
  truncateTitle,
} from '@craft-agent/shared/utils'
import {
  loadAllSkills,
  loadSkillBySlug,
  invalidateSkillsCache,
} from '@craft-agent/shared/skills'
import { invalidateContextFileCache } from '@craft-agent/shared/prompts/system'
import { getToolIconsDir, getMiniModel } from '@craft-agent/shared/config'
import { getDefaultSummarizationModel } from '@craft-agent/shared/config/models'
import type { SummarizeCallback } from '@craft-agent/shared/sources'
import {
  type ThinkingLevel,
  normalizeThinkingLevel,
} from '@craft-agent/shared/agent/thinking-levels'
import { evaluateAutoLabels } from '@craft-agent/shared/labels/auto'
import {
  listLabels,
  loadLabelConfig,
} from '@craft-agent/shared/labels/storage'
import { resolveSessionLabels } from '@craft-agent/shared/labels'
import { ensureLabelsExist } from '@craft-agent/shared/labels/crud'
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage'
import {
  AutomationSystem,
  createPromptHistoryEntry,
  appendAutomationHistoryEntry,
} from '@craft-agent/shared/automations'
import { getModelRefreshService } from '@craft-agent/server-core/model-fetchers'

// Import from server-core domain utilities
import {
  sanitizeForTitle,
  shouldActivateBrowserOverlay,
  normalizeBrowserToolName,
  rollbackFailedBranchCreation,
  releaseBrowserOwnershipOnForcedStop,
} from '@craft-agent/server-core/domain'
import {
  resizeImageForAPI,
  resizeIconBuffer,
} from '@craft-agent/server-core/services'
export { sanitizeForTitle }

// Module-level platform ref — set once during init via setSessionPlatform()
let _platform: PlatformServices | null = null

// Scoped logger — upgraded from console fallback when setSessionPlatform() is called.
// Named `sessionLog` so all ~30 existing call sites remain unchanged.
let sessionLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'session')

export function setSessionPlatform(platform: PlatformServices): void {
  _platform = platform
  sessionLog = createScopedLogger(platform.logger, 'session')
}

interface SessionRuntimeHooks {
  updateBadgeCount: (count: number) => void
  captureException: (
    error: unknown,
    context?: { errorSource?: string; sessionId?: string },
  ) => void
  onSessionStarted: () => void
  onSessionStopped: () => void
}

const defaultSessionRuntimeHooks: SessionRuntimeHooks = {
  updateBadgeCount: () => {},
  onSessionStarted: () => {},
  onSessionStopped: () => {},
  captureException: (error, context) => {
    const err = error instanceof Error ? error : new Error(String(error))
    if (_platform?.captureError) {
      _platform.captureError(err)
      return
    }
    sessionLog.error('[runtime-hooks] captureException fallback:', {
      errorSource: context?.errorSource,
      sessionId: context?.sessionId,
      message: err.message,
      stack: err.stack,
    })
  },
}

let sessionRuntimeHooks: SessionRuntimeHooks = defaultSessionRuntimeHooks

export function setSessionRuntimeHooks(
  hooks: Partial<SessionRuntimeHooks>,
): void {
  sessionRuntimeHooks = {
    ...sessionRuntimeHooks,
    ...hooks,
  }
}

function buildBackendHostRuntimeContext(): BackendHostRuntimeContext {
  if (!_platform)
    throw new Error(
      'setSessionPlatform() must be called before session creation',
    )
  return {
    appRootPath: _platform.appRootPath,
    resourcesPath: _platform.resourcesPath,
    isPackaged: _platform.isPackaged,
  }
}

/**
 * Feature flags for agent behavior
 */
export const AGENT_FLAGS = {
  /** Default modes enabled for new sessions */
  defaultModesEnabled: true,
} as const

const MAX_ADMIN_REMEMBER_MINUTES = 60
const MAX_ANNOTATIONS_PER_MESSAGE = 200
const MAX_ANNOTATION_JSON_BYTES = 32 * 1024
const EXTERNAL_SESSION_LIST_SYNC_INTERVAL_MS = 5_000
const EXTERNAL_SESSION_LIST_PAGE_SIZE = 100
const EXTERNAL_SESSION_LIST_MAX_PAGES = 20
const EXTERNAL_SESSION_PLACEHOLDER_TITLE = '(session)'
const EXTERNAL_SESSION_PLACEHOLDER_TITLES = new Set([
  EXTERNAL_SESSION_PLACEHOLDER_TITLE,
  'New chat',
  '新聊天',
])

function isSlashCommandMessage(message: string): boolean {
  return /^\/[A-Za-z][\w-]*(?:\s|$)/.test(message.trim())
}

/**
 * Text sent to the session when a plan is approved from outside the desktop
 * UI (e.g. Telegram button). Mirrors the English `plan.approved` i18n key
 * used by the desktop flow at `plan-approval-message.ts`. Not localized —
 * the agent reads this, not the end user.
 */
const PLAN_APPROVAL_MESSAGE = 'Plan approved, please execute.'

// validateSpawnAttachmentPath removed — use shared validateFilePath from @craft-agent/server-core/handlers

/**
 * Build MCP and API servers from sources using the new unified modules.
 * Handles credential loading and server building in one step.
 * When auth errors occur, updates source configs to reflect actual state.
 *
 * @param sources - Sources to build servers for
 * @param sessionPath - Optional path to session folder for saving large API responses
 * @param tokenRefreshManager - Optional TokenRefreshManager for OAuth token refresh
 */
async function buildServersFromSources(
  sources: LoadedSource[],
  sessionPath?: string,
  tokenRefreshManager?: TokenRefreshManager,
  summarize?: SummarizeCallback,
) {
  const span = perf.span('sources.buildServers', { count: sources.length })
  const credManager = getSourceCredentialManager()
  const serverBuilder = getSourceServerBuilder()

  // Load credentials for all sources
  const sourcesWithCreds: SourceWithCredential[] = await Promise.all(
    sources.map(async (source) => ({
      source,
      token: await credManager.getToken(source),
      credential: await credManager.getApiCredential(source),
    })),
  )
  span.mark('credentials.loaded')

  // Build token getter for refreshable sources (OAuth + renew-endpoint)
  // Uses TokenRefreshManager for unified refresh logic (DRY principle)
  const getTokenForSource = (source: LoadedSource) => {
    const provider = source.config.provider
    // Provider-specific OAuth (Google, Slack, Microsoft) or generic OAuth (authType: 'oauth')
    if (
      isApiOAuthProvider(provider) ||
      source.config.api?.authType === 'oauth'
    ) {
      const manager =
        tokenRefreshManager ??
        new TokenRefreshManager(credManager, {
          log: (msg) => sessionLog.debug(msg),
        })
      return createTokenGetter(manager, source)
    }
    // API renew endpoint — non-OAuth token refresh
    if (hasRenewEndpoint(source)) {
      const manager =
        tokenRefreshManager ??
        new TokenRefreshManager(credManager, {
          log: (msg) => sessionLog.debug(msg),
        })
      return createTokenGetter(manager, source)
    }
    return undefined
  }

  // Pass sessionPath to enable saving large API responses to session folder
  const result = await serverBuilder.buildAll(
    sourcesWithCreds,
    getTokenForSource,
    sessionPath,
    summarize,
  )
  span.mark('servers.built')
  span.setMetadata('mcpCount', Object.keys(result.mcpServers).length)
  span.setMetadata('apiCount', Object.keys(result.apiServers).length)

  // Update source configs for auth errors so UI reflects actual state
  for (const error of result.errors) {
    if (error.error === SERVER_BUILD_ERRORS.AUTH_REQUIRED) {
      const source = sources.find((s) => s.config.slug === error.sourceSlug)
      if (source) {
        credManager.markSourceNeedsReauth(source, 'Token missing or expired')
        sessionLog.info(`Marked source ${error.sourceSlug} as needing re-auth`)
      }
    }
  }

  span.end()
  return result
}

/**
 * Result of OAuth token refresh operation.
 */
interface OAuthTokenRefreshResult {
  /** Whether any tokens were refreshed (configs were updated) */
  tokensRefreshed: boolean
  /** Sources that failed to refresh (for warning display) */
  failedSources: Array<{ slug: string; reason: string }>
}

/**
 * Refresh expired OAuth tokens and rebuild server configs.
 * Uses TokenRefreshManager for unified refresh logic (DRY/SOLID principles).
 *
 * This implements "proactive refresh at query time" - tokens are refreshed before
 * each agent.chat() call, then server configs are rebuilt with fresh headers.
 *
 * Handles both:
 * - MCP OAuth sources (e.g., Linear, Notion)
 * - API OAuth sources (Google, Slack, Microsoft)
 *
 * @param agent - The agent to update server configs on
 * @param sources - All loaded sources for the session
 * @param sessionPath - Path to session folder for API response storage
 * @param tokenRefreshManager - TokenRefreshManager instance for this session
 */
async function refreshOAuthTokensIfNeeded(
  agent: AgentInstance,
  sources: LoadedSource[],
  sessionPath: string,
  tokenRefreshManager: TokenRefreshManager,
  options?: {
    sessionId?: string
    workspaceRootPath?: string
    poolServerUrl?: string
  },
): Promise<OAuthTokenRefreshResult> {
  sessionLog.debug('[OAuth] Checking if any OAuth tokens need refresh')

  // Use TokenRefreshManager to find sources needing refresh (handles rate limiting)
  const needRefresh =
    await tokenRefreshManager.getSourcesNeedingRefresh(sources)

  if (needRefresh.length === 0) {
    return { tokensRefreshed: false, failedSources: [] }
  }

  sessionLog.debug(
    `[OAuth] Found ${needRefresh.length} source(s) needing token refresh: ${needRefresh.map((s) => s.config.slug).join(', ')}`,
  )

  // Use TokenRefreshManager to refresh all tokens (handles rate limiting and error tracking)
  const { refreshed, failed } =
    await tokenRefreshManager.refreshSources(needRefresh)

  // Convert failed results to the expected format
  const failedSources = failed.map(({ source, reason }) => ({
    slug: source.config.slug,
    reason,
  }))

  if (refreshed.length > 0) {
    // Rebuild server configs with fresh tokens
    sessionLog.debug(
      `[OAuth] Rebuilding servers after ${refreshed.length} token refresh(es)`,
    )
    const enabledSources = sources.filter(isSourceUsable)
    const { mcpServers, apiServers } = await buildServersFromSources(
      enabledSources,
      sessionPath,
      tokenRefreshManager,
      agent.getSummarizeCallback(),
    )
    const intendedSlugs = enabledSources.map((s) => s.config.slug)
    await agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

    // Update bridge-mcp-server config/credentials for backends that need it
    if (options?.sessionId && options?.workspaceRootPath) {
      await applyBridgeUpdates(
        agent,
        sessionPath,
        enabledSources,
        mcpServers,
        options.sessionId,
        options.workspaceRootPath,
        'token refresh',
        options.poolServerUrl,
      )
    }

    return { tokensRefreshed: true, failedSources }
  }

  return { tokensRefreshed: false, failedSources }
}

/**
 * Apply bridge-mcp-server updates for backends that use it.
 * Delegates to the backend's own applyBridgeUpdates() method.
 * Each backend handles its own strategy via applyBridgeUpdates().
 */
async function applyBridgeUpdates(
  agent: AgentInstance,
  sessionPath: string,
  enabledSources: LoadedSource[],
  mcpServers: Record<
    string,
    import('@craft-agent/shared/agent/backend').SdkMcpServerConfig
  >,
  sessionId: string,
  workspaceRootPath: string,
  context: string,
  poolServerUrl?: string,
): Promise<void> {
  await agent.applyBridgeUpdates({
    sessionPath,
    enabledSources,
    mcpServers,
    sessionId,
    workspaceRootPath,
    context,
    poolServerUrl,
  })
}

/**
 * Resolve tool display metadata for a tool call.
 * Returns metadata with base64-encoded icon for viewer compatibility.
 *
 * @param toolName - Tool name from the event (e.g., "Skill", "mcp__linear__list_issues")
 * @param toolInput - Tool input (used for Skill tool to get skill identifier)
 * @param workspaceRootPath - Path to workspace for loading skills/sources
 * @param sources - Loaded sources for the workspace
 */
const BROWSER_TOOL_ICON_FILENAME = 'chrome.svg'
let browserToolIconDataUrlCache: string | null | undefined

async function getBrowserToolIconDataUrl(): Promise<string | undefined> {
  // Cache miss sentinel: undefined means "not computed yet"
  if (browserToolIconDataUrlCache !== undefined) {
    return browserToolIconDataUrlCache ?? undefined
  }

  try {
    const iconCandidates = [
      join(getToolIconsDir(), BROWSER_TOOL_ICON_FILENAME),
      // Dev fallback (before sync to ~/.craft-agent/tool-icons)
      join(
        process.cwd(),
        'apps',
        'electron',
        'resources',
        'tool-icons',
        BROWSER_TOOL_ICON_FILENAME,
      ),
      // Packaged fallback (app resources)
      join(process.resourcesPath, 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
    ]

    for (const iconPath of iconCandidates) {
      if (!existsSync(iconPath)) continue
      const encoded = await encodeIconToDataUrlAsync(iconPath, {
        resize: resizeIconBuffer,
      })
      if (encoded) {
        browserToolIconDataUrlCache = encoded
        return encoded
      }
    }

    browserToolIconDataUrlCache = null
  } catch {
    browserToolIconDataUrlCache = null
  }

  return browserToolIconDataUrlCache ?? undefined
}

async function resolveToolDisplayMeta(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  workspaceRootPath: string,
  sources: LoadedSource[],
): Promise<ToolDisplayMeta | undefined> {
  // Check if it's an MCP tool (format: mcp__<serverSlug>__<toolName>)
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    if (parts.length >= 3) {
      const serverSlug = parts[1]
      const toolSlug = parts.slice(2).join('__')

      // Internal MCP server tools (session, docs)
      const internalMcpServers: Record<string, Record<string, string>> = {
        session: {
          SubmitPlan: 'Submit Plan',
          call_llm: 'LLM Query',
          config_validate: 'Validate Config',
          skill_validate: 'Validate Skill',
          mermaid_validate: 'Validate Mermaid',
          source_test: 'Test Source',
          source_oauth_trigger: 'OAuth',
          source_google_oauth_trigger: 'Google Auth',
          source_slack_oauth_trigger: 'Slack Auth',
          source_microsoft_oauth_trigger: 'Microsoft Auth',
          source_credential_prompt: 'Enter Credentials',
          transform_data: 'Transform Data',
          render_template: 'Render Template',
          update_user_preferences: 'Update Preferences',
          send_developer_feedback: 'Send Feedback',
          browser_tool: 'Browser',
        },
        'craft-agents-docs': {
          SearchCraftAgents: 'Search Docs',
        },
      }

      const internalServer = internalMcpServers[serverSlug]
      if (internalServer) {
        const displayName = internalServer[toolSlug]
        if (displayName) {
          const normalizedBrowserTool = normalizeBrowserToolName(toolSlug)
          return {
            displayName,
            iconDataUrl: normalizedBrowserTool
              ? await getBrowserToolIconDataUrl()
              : undefined,
            category: 'native' as const,
          }
        }
      }

      // External source tools
      let sourceSlug = serverSlug

      // Special case: api-bridge server embeds source slug in tool name as "api_{slug}"
      // e.g., mcp__api-bridge__api_stripe → sourceSlug = "stripe"
      if (sourceSlug === 'api-bridge' && toolSlug.startsWith('api_')) {
        sourceSlug = toolSlug.slice(4)
      }

      const source = sources.find((s) => s.config.slug === sourceSlug)
      if (source) {
        // Try file-based icon first, fall back to emoji icon from config
        const iconDataUrl = source.iconPath
          ? await encodeIconToDataUrlAsync(source.iconPath, {
              resize: resizeIconBuffer,
            })
          : getEmojiIcon(source.config.icon)
        return {
          displayName: source.config.name,
          iconDataUrl,
          description: source.config.tagline,
          category: 'source' as const,
        }
      }
    }
    return undefined
  }

  // Check if it's the Skill tool
  if (toolName === 'Skill' && toolInput) {
    // Skill input has 'skill' param with format: "skillSlug" or "workspaceId:skillSlug"
    const skillParam = toolInput.skill as string | undefined
    if (skillParam) {
      // Extract skill slug (remove workspace prefix if present)
      const skillSlug = skillParam.includes(':')
        ? skillParam.split(':').pop()
        : skillParam
      if (skillSlug) {
        // Load skills and find the one being invoked
        try {
          const skills = loadAllSkills(workspaceRootPath)
          const skill = skills.find((s) => s.slug === skillSlug)
          if (skill) {
            // Try file-based icon first, fall back to emoji icon from metadata
            const iconDataUrl = skill.iconPath
              ? await encodeIconToDataUrlAsync(skill.iconPath, {
                  resize: resizeIconBuffer,
                })
              : getEmojiIcon(skill.metadata.icon)
            return {
              displayName: skill.metadata.name,
              iconDataUrl,
              description: skill.metadata.description,
              category: 'skill' as const,
            }
          }
        } catch {
          // Skills loading failed, skip
        }
      }
    }
    return undefined
  }

  // CLI tool icon resolution for Bash commands
  // Parses the command string to detect known tools (git, npm, docker, etc.)
  // and resolves their brand icon from ~/.craft-agent/tool-icons/
  if (toolName === 'Bash' && toolInput?.command) {
    try {
      const toolIconsDir = getToolIconsDir()
      const match = resolveToolIcon(String(toolInput.command), toolIconsDir)
      if (match) {
        return {
          displayName: match.displayName,
          iconDataUrl: match.iconDataUrl,
          category: 'native' as const,
        }
      }
    } catch {
      // Icon resolution is best-effort — never crash the session for it
    }
  }

  // Native browser tool names (with Chrome icon)
  const normalizedBrowserToolName = normalizeBrowserToolName(toolName)
  if (normalizedBrowserToolName) {
    const browserDisplayName = normalizedBrowserToolName
      .split('_')
      .map((part, index) =>
        index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
      )
      .join(' ')
      .replace(/^browser\s+/i, 'Browser ')

    return {
      displayName: browserDisplayName,
      iconDataUrl: await getBrowserToolIconDataUrl(),
      category: 'native' as const,
    }
  }

  // Native tool display names (no icons - UI handles these with built-in icons)
  // This ensures toolDisplayMeta is always populated for consistent display
  const nativeToolNames: Record<string, string> = {
    Read: 'Read',
    Write: 'Write',
    Edit: 'Edit',
    Bash: 'Terminal',
    Grep: 'Search',
    Glob: 'Find Files',
    Task: 'Agent',
    Agent: 'Agent',
    WebFetch: 'Fetch URL',
    WebSearch: 'Web Search',
    TodoWrite: 'Update Todos',
    NotebookEdit: 'Edit Notebook',
    KillShell: 'Kill Shell',
    TaskOutput: 'Task Output',
  }

  const nativeDisplayName = nativeToolNames[toolName]
  if (nativeDisplayName) {
    return {
      displayName: nativeDisplayName,
      category: 'native' as const,
    }
  }

  // Unknown tool - no display metadata (will fall back to tool name in UI)
  return undefined
}

/** Agent type - unified backend interface for all providers */
type AgentInstance = AgentBackend

type RewindableAgent = AgentBackend & {
  rewindToUserTurn(targetTurnIndex: number): Promise<unknown>
}

type PermissionSettingsAgent = AgentBackend & {
  getPermissionSettings(): Promise<QwenPermissionSettings>
  setPermissionRules(
    scope: PermissionSettingsScope,
    ruleType: PermissionRuleType,
    rules: string[],
  ): Promise<QwenPermissionSettings>
}

type QwenSettingsAgent = AgentBackend & {
  getCoreSettings(): Promise<QwenCoreSettingsSnapshot>
  setCoreSetting(
    scope: QwenSettingsScope,
    key: QwenCoreSettingKey,
    value: QwenSettingValue,
  ): Promise<QwenCoreSettingsSnapshot>
  setMcpServer(
    scope: QwenSettingsScope,
    name: string,
    server: QwenMcpServerConfig,
  ): Promise<QwenCoreSettingsSnapshot>
  removeMcpServer(
    scope: QwenSettingsScope,
    name: string,
  ): Promise<QwenCoreSettingsSnapshot>
  setHook(
    scope: QwenSettingsScope,
    event: QwenHookEvent,
    index: number | undefined,
    hook: QwenHookDefinition,
  ): Promise<QwenCoreSettingsSnapshot>
  removeHook(
    scope: QwenSettingsScope,
    event: QwenHookEvent,
    index: number,
  ): Promise<QwenCoreSettingsSnapshot>
  setExtensionSetting(
    extensionId: string,
    settingKey: string,
    scope: QwenSettingsScope,
    value: QwenSettingValue,
  ): Promise<QwenCoreSettingsSnapshot>
}

type QwenProvidersAgent = AgentBackend & {
  listProviders(): Promise<QwenProviderCatalog>
  connectProvider(
    params: QwenProviderConnectParams,
  ): Promise<QwenProviderConnectResult>
}

function canRewindToUserTurn(agent: AgentBackend): agent is RewindableAgent {
  return typeof agent.rewindToUserTurn === 'function'
}

function canManagePermissionSettings(
  agent: AgentBackend,
): agent is PermissionSettingsAgent {
  const candidate = agent as Partial<PermissionSettingsAgent>
  return (
    typeof candidate.getPermissionSettings === 'function' &&
    typeof candidate.setPermissionRules === 'function'
  )
}

function canManageQwenSettings(
  agent: AgentBackend,
): agent is QwenSettingsAgent {
  const candidate = agent as Partial<QwenSettingsAgent>
  return (
    typeof candidate.getCoreSettings === 'function' &&
    typeof candidate.setCoreSetting === 'function' &&
    typeof candidate.setMcpServer === 'function' &&
    typeof candidate.removeMcpServer === 'function' &&
    typeof candidate.setHook === 'function' &&
    typeof candidate.removeHook === 'function' &&
    typeof candidate.setExtensionSetting === 'function'
  )
}

function canManageQwenProviders(
  agent: AgentBackend,
): agent is QwenProvidersAgent {
  const candidate = agent as Partial<QwenProvidersAgent>
  return (
    typeof candidate.listProviders === 'function' &&
    typeof candidate.connectProvider === 'function'
  )
}

function isQwenNativeHistoryMessageId(
  messageId: string,
  sdkSessionId?: string,
): boolean {
  return !!sdkSessionId && messageId.startsWith(`qwen-${sdkSessionId}-`)
}

const IMAGE_PREVIEW_BLOCK_PATTERN = /```image-preview[\s\S]*?```/g
const LEGACY_ATTACHMENT_MATCH_WINDOW_MS = 5 * 60 * 1000
const LEGACY_ATTACHMENT_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})
const LEGACY_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function legacyStoredAttachmentName(fileName: string): string {
  return fileName.replace(/^[0-9a-f-]{36}_/i, '')
}

function hasImagePreviewContent(message: Message): boolean {
  return message.content.includes('```image-preview')
}

function stripImagePreviewBlocks(content: string): string {
  return content.replace(IMAGE_PREVIEW_BLOCK_PATTERN, '')
}

function normalizeQwenVisualMatchContent(content: string): string {
  return stripImagePreviewBlocks(content).replace(/\s+/g, ' ').trim()
}

function extractImagePreviewBlocks(content: string): string[] {
  return content.match(IMAGE_PREVIEW_BLOCK_PATTERN) ?? []
}

function hasQwenCanonicalLocalVisualState(message: Message): boolean {
  return (
    (message.attachments?.length ?? 0) > 0 || hasImagePreviewContent(message)
  )
}

function qwenCanonicalLocalVisualMessages(messages: Message[]): Message[] {
  return messages.filter(
    (message) =>
      message.role !== 'status' && hasQwenCanonicalLocalVisualState(message),
  )
}

function findQwenCanonicalVisualOverlayMatch(
  message: Message,
  overlays: Message[],
  usedOverlayIndexes: Set<number>,
): number {
  let bestIndex = -1
  let bestScore = 0
  const normalized = normalizeQwenVisualMatchContent(message.content)

  overlays.forEach((overlay, index) => {
    if (usedOverlayIndexes.has(index) || overlay.role !== message.role) return

    const overlayNormalized = normalizeQwenVisualMatchContent(overlay.content)
    const timeDiff = Math.abs(overlay.timestamp - message.timestamp)
    let score = 0

    if (overlay.id === message.id) score += 1000
    if (overlay.content === message.content) score += 500
    if (overlayNormalized && overlayNormalized === normalized) score += 400
    if (
      overlayNormalized &&
      normalized &&
      Math.min(overlayNormalized.length, normalized.length) >= 16 &&
      (overlayNormalized.includes(normalized) ||
        normalized.includes(overlayNormalized))
    ) {
      score += 250
    }
    if (timeDiff <= 30_000) score += 100 - Math.floor(timeDiff / 1_000)

    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  })

  return bestScore > 0 ? bestIndex : -1
}

function mergeQwenCanonicalVisualOverlay(
  message: Message,
  overlay: Message,
): Message {
  const next: Message = { ...message }

  if (overlay.attachments?.length) {
    next.attachments = overlay.attachments
  }
  if (overlay.textElements?.length && !next.textElements?.length) {
    next.textElements = overlay.textElements
  }
  if (overlay.annotations?.length && !next.annotations?.length) {
    next.annotations = overlay.annotations
  }

  const overlayImageBlocks = extractImagePreviewBlocks(overlay.content)
  if (overlayImageBlocks.length > 0 && !hasImagePreviewContent(next)) {
    const normalized = normalizeQwenVisualMatchContent(next.content)
    const overlayNormalized = normalizeQwenVisualMatchContent(overlay.content)
    next.content =
      !normalized ||
      (overlayNormalized &&
        (overlayNormalized.includes(normalized) ||
          normalized.includes(overlayNormalized)))
        ? overlay.content
        : `${next.content.trimEnd()}\n\n${overlayImageBlocks.join('\n\n')}`
  }

  return next
}

function mergeQwenCanonicalLocalVisualMessages(
  messages: Message[],
  localMessages: Message[],
): Message[] {
  const overlays = qwenCanonicalLocalVisualMessages(localMessages)
  if (overlays.length === 0) return messages

  const usedOverlayIndexes = new Set<number>()
  const merged = messages.map((message) => {
    const overlayIndex = findQwenCanonicalVisualOverlayMatch(
      message,
      overlays,
      usedOverlayIndexes,
    )
    if (overlayIndex === -1) return message

    usedOverlayIndexes.add(overlayIndex)
    return mergeQwenCanonicalVisualOverlay(message, overlays[overlayIndex]!)
  })

  overlays.forEach((overlay, index) => {
    if (!usedOverlayIndexes.has(index)) {
      merged.push(overlay)
    }
  })

  return merged.sort((a, b) => a.timestamp - b.timestamp)
}

interface ManagedSession {
  id: string
  workspace: Workspace
  agent: AgentInstance | null // Lazy-loaded - null until first message
  // Runtime-only single-flight guard for lazy agent construction.
  agentCreatePromise?: Promise<AgentInstance>
  messages: Message[]
  isProcessing: boolean
  /** Set when user requests stop - allows event loop to drain before clearing isProcessing */
  stopRequested?: boolean
  lastUsedAt?: number
  lastMessageAt: number
  streamingText: string
  // Incremented each time a new message starts processing.
  // Used to detect if a follow-up message has superseded the current one (stale-request guard).
  processingGeneration: number
  // NOTE: Parent-child tracking state (pendingTools, parentToolStack, toolToParentMap,
  // pendingTextParent) has been removed. CraftAgent now provides parentToolUseId
  // directly on all events using the SDK's authoritative parent_tool_use_id field.
  // See: packages/shared/src/agent/tool-matching.ts
  // Session name (user-defined or AI-generated)
  name?: string
  // Runtime-only guard for provider-native title synchronization.
  externalBackendSyncedTitle?: string
  externalBackendTitleSyncChain?: Promise<void>
  isFlagged: boolean
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
  /** Permission mode for this session */
  permissionMode?: PermissionMode
  /** Previous permission mode (runtime-only session_state modeTransition context) */
  previousPermissionMode?: PermissionMode
  /** Centralized MCP client pool for this session's source connections */
  mcpPool?: McpClientPool
  /** HTTP MCP server exposing pool tools to external SDK subprocesses */
  poolServer?: McpPoolServer
  // SDK session ID for conversation continuity
  sdkSessionId?: string
  // Token usage for display
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** Model's context window size in tokens (from SDK modelUsage) */
    contextWindow?: number
  }
  // Provider-advertised slash commands for the current session.
  availableCommands?: AvailableSlashCommand[]
  // Provider-advertised skill command names for the current session.
  availableSkills?: string[]
  // Provider-advertised skill metadata for the current session.
  availableSkillDetails?: Array<
    import('@craft-agent/core/types').AvailableSkillDetail
  >
  // Session status (user-controlled) - determines open vs closed
  // Dynamic status ID referencing workspace status config
  sessionStatus?: string
  // Read/unread tracking - ID of last message user has read
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  // Per-session source selection (slugs of enabled sources)
  enabledSourceSlugs?: string[]
  // Labels applied to this session (additive tags, many-per-session)
  labels?: string[]
  // Working directory for this session (used by agent for bash commands)
  workingDirectory?: string
  // SDK cwd for session storage - set once at creation, never changes.
  // Ensures SDK can find session transcripts regardless of workingDirectory changes.
  sdkCwd?: string
  // Shared viewer URL (if shared via viewer)
  sharedUrl?: string
  // Shared session ID in viewer (for revoke)
  sharedId?: string
  // Model to use for this session (overrides global config if set)
  model?: string
  // LLM connection slug for this session (locked after first message)
  llmConnection?: string
  // Whether the connection is locked (cannot be changed after first agent creation)
  connectionLocked?: boolean
  // Thinking level for this session ('off', 'think', 'max')
  thinkingLevel?: ThinkingLevel
  // System prompt preset for mini agents ('default' | 'mini')
  systemPromptPreset?: 'default' | 'mini' | string
  // Role/type of the last message (for badge display without loading messages)
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  // ID of the last final (non-intermediate) assistant message - pre-computed for unread detection
  lastFinalMessageId?: string
  // Turn baseline: last final assistant message ID at turn start (runtime-only, not persisted)
  turnStartFinalMessageId?: string
  // External session metadata updates seen while processing (applied after turn stop)
  pendingExternalMetadata?: SessionHeader
  // Guard: suppress external metadata revert after programmatic writes (setSessionStatus/setSessionLabels).
  // fs.watch fires during atomic write (unlink+rename) and can read stale data, reverting in-memory state.
  _metadataWriteGuardUntil?: number
  // Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration)
  // Used for shimmer effect on session title
  isAsyncOperationOngoing?: boolean
  // Preview of first user message (for sidebar display fallback)
  preview?: string
  // When the session was first created (ms timestamp from JSONL header)
  createdAt?: number
  // Total message count (pre-computed in JSONL header for fast list loading)
  messageCount?: number
  // Message queue for handling new messages while processing. Qwen can consume
  // some entries mid-turn; those stay here as backup until ACP acknowledges.
  messageQueue: Array<{
    message: string
    attachments?: FileAttachment[]
    storedAttachments?: StoredAttachment[]
    options?: SendMessageOptions
    messageId?: string // Pre-generated ID for matching with UI
    optimisticMessageId?: string // Frontend's ID for reliable event matching
    eventClientId?: string // Renderer that initiated the send, for workspace-switch continuity
    midTurnPending?: boolean // Backup replay until ACP confirms injection
  }>
  // Map of shellId -> command for killing background shells
  backgroundShellCommands: Map<string, string>
  // Map of taskId -> output info for background task results
  backgroundTaskOutputs: Map<
    string,
    { outputFile: string; summary: string; status: string; completedAt: number }
  >
  // Whether messages have been loaded from disk (for lazy loading)
  messagesLoaded: boolean
  // Runtime guard: for provider-native sessions with empty local JSONL, try one
  // native-history backfill even if a previous render path marked messages loaded.
  externalMessagesLoadAttempted?: boolean
  // Provider-native history cache watermark. For Qwen canonical sessions, messages
  // are rendered from ACP but not persisted into Craft JSONL, so re-load only
  // when provider listing metadata reports a newer external update.
  externalMessagesLoadedThroughAt?: number
  // Pending auth request tracking (for unified auth flow)
  pendingAuthRequestId?: string
  pendingAuthRequest?: AuthRequest
  // Auth retry tracking (for mid-session token expiry)
  // Store last sent message/attachments to enable retry after token refresh
  lastSentMessage?: string
  lastSentAttachments?: FileAttachment[]
  lastSentStoredAttachments?: StoredAttachment[]
  lastSentOptions?: SendMessageOptions
  // Flag to prevent infinite retry loops (reset at start of each sendMessage)
  authRetryAttempted?: boolean
  // Flag indicating auth retry is in progress (to prevent complete handler from interfering)
  authRetryInProgress?: boolean
  // Whether this session is hidden from session list (e.g., mini edit sessions)
  hidden?: boolean
  branchFromMessageId?: string
  // Branch context strategy:
  // - sdk-fork: provider-level fork from parent SDK session
  // - seeded-fresh-session: fresh backend session seeded with transcript up to branch cutoff
  branchContextStrategy?: 'sdk-fork' | 'seeded-fresh-session'
  // Parent session's SDK session ID (used only when branchContextStrategy === 'sdk-fork')
  branchFromSdkSessionId?: string
  // Parent session's storage path (used only when branchContextStrategy === 'sdk-fork')
  branchFromSessionPath?: string
  // Parent session's sdkCwd — needed so the backend can locate the parent session file.
  branchFromSdkCwd?: string
  // Provider-native assistant turn ID at the branch point.
  branchFromSdkTurnId?: string
  // One-shot flag for seeded branch mode - set true after first turn seed injection.
  branchSeedApplied?: boolean
  // One-shot hidden summary injected on the first turn after a remote transfer.
  transferredSessionSummary?: string
  // Whether the transferred-session summary has already been injected.
  transferredSessionSummaryApplied?: boolean
  // Token refresh manager for OAuth token refresh with rate limiting
  tokenRefreshManager: TokenRefreshManager
  // Metadata for sessions created by automations
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number }
  // Promise that resolves when the agent instance is ready (for title gen to await)
  agentReady?: Promise<void>
  agentReadyResolve?: () => void
  // Per-session env overrides for backend subprocesses.
  // Stored on managed session so it persists across agent recreations (auth-retry, etc.)
  envOverrides?: Record<string, string>
  // Whether the previous turn was interrupted (for context injection on next message).
  // Ephemeral — not persisted to disk. Cleared after one-shot injection.
  wasInterrupted?: boolean
}

/**
 * Create a ManagedSession from any session-like source (SessionMetadata, SessionConfig, StoredSession).
 * Spreads all matching fields from the source so new persistent fields automatically propagate.
 * Runtime-only fields get sensible defaults.
 */
export function createManagedSession(
  source: { id: string } & Partial<ManagedSession>,
  workspace: Workspace,
  overrides?: Partial<ManagedSession>,
): ManagedSession {
  const s = source as Record<string, unknown>
  const sourceFields = Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined),
  ) as Partial<ManagedSession>

  if ('thinkingLevel' in sourceFields) {
    // TODO: Remove legacy 'think' normalization after old persisted session
    // headers have realistically aged out across upgrades.
    const normalizedThinkingLevel = normalizeThinkingLevel(
      sourceFields.thinkingLevel,
    )
    if (normalizedThinkingLevel) {
      sourceFields.thinkingLevel = normalizedThinkingLevel
    } else {
      delete sourceFields.thinkingLevel
    }
  }

  const managed = {
    // Spread all session-like fields from source (id, name, permissionMode, labels, model, etc.)
    // This ensures new persistent fields automatically flow through without manual copying.
    ...sourceFields,
    // Runtime-only defaults (not persisted)
    workspace,
    agent: null,
    messages: [],
    isProcessing: false,
    lastMessageAt: (s.lastMessageAt ??
      s.lastUsedAt ??
      s.createdAt ??
      0) as number,
    streamingText: '',
    processingGeneration: 0,
    isFlagged: (s.isFlagged ?? false) as boolean,
    messageQueue: [],
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    messagesLoaded: false,
    tokenRefreshManager: new TokenRefreshManager(getSourceCredentialManager(), {
      log: (msg) => sessionLog.debug(msg),
    }),
    // Caller overrides (permissionMode defaults, thinkingLevel, messagesLoaded, etc.)
    ...overrides,
  } as ManagedSession

  if (managed.branchFromMessageId && !managed.branchContextStrategy) {
    managed.branchContextStrategy = managed.branchFromSdkSessionId
      ? 'sdk-fork'
      : 'seeded-fresh-session'
  }

  if (
    managed.branchContextStrategy === 'seeded-fresh-session' &&
    managed.branchSeedApplied === undefined
  ) {
    // If an SDK session ID already exists, first turn has already happened.
    managed.branchSeedApplied = !!managed.sdkSessionId
  }

  return managed
}

interface SessionManagerOptions {
  createExternalSessionAgent?: (
    workspace: Workspace,
    backendContext: ReturnType<typeof resolveBackendContext>,
  ) => AgentBackend
}

type ExternalMessageLoadResult = 'loaded' | 'empty' | 'unavailable' | 'failed'
type BackendSessionMessagesPayload = Message[] | BackendSessionMessagesResult

function normalizeBackendSessionMessages(
  payload: BackendSessionMessagesPayload | undefined,
): BackendSessionMessagesResult | undefined {
  if (!payload) return undefined
  if (Array.isArray(payload)) return { messages: payload }
  return payload
}

/**
 * Resolve supportsBranching for a managed session.
 * Prefers the live agent instance; falls back to true for all backends.
 */
function resolveSupportsBranching(managed: ManagedSession): boolean {
  // If agent is live, use its instance property (authoritative)
  if (managed.agent) {
    return managed.agent.supportsBranching
  }

  return true // default: branching enabled for all backends
}

const DEFAULT_TOKEN_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  contextTokens: 0,
  costUsd: 0,
}

type StoredSessionWithHeaderOptions = StoredSession & {
  omitMessageDerivedHeaderFields?: boolean
  omitTranscriptDerivedHeaderFields?: boolean
  omitHeaderTokenUsage?: boolean
  preserveSessionTimestamps?: boolean
}

function isQwenCanonicalManagedSession(
  managed: Pick<ManagedSession, 'sdkSessionId' | 'llmConnection'>,
): boolean {
  return (
    !!managed.sdkSessionId &&
    (managed.llmConnection === QWEN_CODE_CONNECTION_SLUG ||
      managed.llmConnection === undefined)
  )
}

function stripQwenCanonicalStoredFields<T extends Partial<StoredSession>>(
  session: T,
): T {
  const stripped = { ...session }
  delete stripped.name
  delete stripped.createdAt
  delete stripped.lastUsedAt
  delete stripped.lastMessageAt
  delete stripped.workingDirectory
  delete stripped.sdkCwd
  return stripped
}

function parseOptionalTimestamp(value?: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Convert a ManagedSession to a renderer-side Session object.
 * Uses pickSessionFields() for persistent fields so new fields propagate automatically.
 */
function managedToSession(
  m: ManagedSession,
  overrides?: Partial<Session>,
): Session {
  const persistableMessages = m.messages.filter(
    (message) => message.role !== 'status',
  )
  const derivedHeader =
    persistableMessages.length > 0 && !isQwenCanonicalManagedSession(m)
      ? createSessionHeader({
          ...pickSessionFields(m),
          workspaceRootPath: m.workspace.rootPath,
          messages: persistableMessages.map(messageToStored),
          tokenUsage: m.tokenUsage ?? DEFAULT_TOKEN_USAGE,
        } as StoredSession)
      : undefined

  return {
    ...pickSessionFields(m),
    // Pre-computed fields from header (not in SESSION_PERSISTENT_FIELDS)
    preview: derivedHeader?.preview ?? m.preview,
    lastMessageRole: derivedHeader?.lastMessageRole ?? m.lastMessageRole,
    tokenUsage: m.tokenUsage,
    messageCount: isQwenCanonicalManagedSession(m)
      ? undefined
      : (derivedHeader?.messageCount ?? m.messageCount),
    lastFinalMessageId:
      derivedHeader?.lastFinalMessageId ?? m.lastFinalMessageId,
    // Runtime-only fields
    permissionMode: m.permissionMode,
    previousPermissionMode: m.previousPermissionMode,
    workspaceId: m.workspace.id,
    workspaceName: m.workspace.name,
    messages: [],
    isProcessing: m.isProcessing,
    sessionFolderPath: getSessionStoragePath(m.workspace.rootPath, m.id),
    supportsBranching: resolveSupportsBranching(m),
    availableCommands: m.availableCommands,
    availableSkills: m.availableSkills,
    availableSkillDetails: m.availableSkillDetails,
    ...overrides,
  } as Session
}

function getManagedSessionOrderTime(
  session: Pick<ManagedSession, 'lastMessageAt' | 'lastUsedAt' | 'createdAt'>,
): number {
  return session.lastMessageAt ?? session.lastUsedAt ?? session.createdAt ?? 0
}

function compareManagedSessionsByActivityDesc(
  a: ManagedSession,
  b: ManagedSession,
): number {
  const byTime = getManagedSessionOrderTime(b) - getManagedSessionOrderTime(a)
  if (byTime !== 0) return byTime

  const byCreatedAt = (b.createdAt ?? 0) - (a.createdAt ?? 0)
  if (byCreatedAt !== 0) return byCreatedAt

  return a.id.localeCompare(b.id)
}

function mapPermissionModeToQwenApprovalMode(mode: PermissionMode): string {
  switch (mode) {
    case 'allow-all':
      return 'yolo'
    case 'safe':
      return 'plan'
    case 'auto-edit':
      return 'auto-edit'
    case 'ask':
    default:
      return 'default'
  }
}

// Performance: Batch IPC delta events to reduce renderer load
const DELTA_BATCH_INTERVAL_MS = 50 // Flush batched deltas every 50ms

interface PendingDelta {
  delta: string
  turnId?: string
}

export class SessionManager implements ISessionManager {
  private readonly createExternalSessionAgentOverride?: SessionManagerOptions['createExternalSessionAgent']
  private sessions: Map<string, ManagedSession> = new Map()
  // Delta batching for performance - reduces IPC events from 50+/sec to ~20/sec
  private pendingDeltas: Map<string, PendingDelta> = new Map()
  private deltaFlushTimers: Map<string, NodeJS.Timeout> = new Map()
  // Config watchers for live updates (sources, etc.) - one per workspace
  private configWatchers: Map<string, ConfigWatcher> = new Map()
  // Automation systems for workspace event automations - one per workspace (includes scheduler, diffing, and handlers)
  private automationSystems: Map<string, AutomationSystem> = new Map()
  // Pending credential request resolvers (keyed by requestId)
  private pendingCredentialResolvers: Map<
    string,
    (
      response: import('@craft-agent/shared/protocol').CredentialResponse,
    ) => void
  > = new Map()
  // Permission request metadata tracking (keyed by requestId)
  private pendingPermissionRequests: Map<
    string,
    {
      sessionId: string
      type?:
        | 'bash'
        | 'file_write'
        | 'mcp_mutation'
        | 'api_mutation'
        | 'admin_approval'
        | 'ask_user_question'
      commandHash?: string
    }
  > = new Map()
  // Privileged approval binding + audit logger
  private privilegedExecutionBroker = new PrivilegedExecutionBroker(sessionLog)
  // Session-local admin remember windows (exact command hash binding)
  private adminRememberApprovals: Map<
    string,
    {
      createdAt: number
      expiresAt: number
      sourceRequestId: string
    }
  > = new Map()
  // Promise deduplication for lazy-loading messages (prevents race conditions)
  private messageLoadingPromises: Map<string, Promise<void>> = new Map()
  // Per-workspace provider-native history sync (currently Qwen ACP session/list).
  private externalSessionListSyncAt: Map<string, number> = new Map()
  private externalSessionListSyncPromises: Map<string, Promise<void>> =
    new Map()
  private pendingExternalSessionDeletes: Set<string> = new Set()
  /**
   * Track which session the user is actively viewing (per workspace).
   * Map of workspaceId -> sessionId. Used to determine if a session should be
   * marked as unread when assistant completes - if user is viewing it, don't mark unread.
   */
  private activeViewingSession: Map<string, string> = new Map()
  /** Coordinates startup initialization waiters from IPC handlers. */
  private initGate = new InitGate()
  // O(1) index: taskId → sessionId for background task output lookup (avoids O(n) session scan)
  private taskOutputIndex: Map<string, string> = new Map()
  /** Monotonic clock to ensure strictly increasing message timestamps */
  private lastTimestamp = 0
  /** Originating renderer for an active send; keeps events flowing across workspace switches. */
  private sessionEventClientIds: Map<string, string> = new Map()
  private currentGlobalPermissionMode: PermissionMode =
    loadConfigDefaults().workspaceDefaults.permissionMode

  constructor(options: SessionManagerOptions = {}) {
    this.createExternalSessionAgentOverride =
      options.createExternalSessionAgent
  }

  /**
   * Centralized setter for session processing state.
   * Automatically notifies the power manager on transitions (true→false, false→true)
   * so callers don't need to remember to call onSessionStarted/onSessionStopped.
   */
  private setProcessing(managed: ManagedSession, processing: boolean): void {
    const was = managed.isProcessing
    managed.isProcessing = processing
    if (!was && processing) {
      sessionRuntimeHooks.onSessionStarted()
    } else if (was && !processing) {
      sessionRuntimeHooks.onSessionStopped()
    }
  }

  /** Wait until initialize() has completed (sessions loaded from disk).
   *  Resolves immediately if already initialized. */
  waitForInit(): Promise<void> {
    return this.initGate.wait()
  }

  private browserPaneManager: IBrowserPaneManager | null = null
  private eventSink: EventSink | null = null

  setEventSink(sink: EventSink): void {
    this.eventSink = sink
  }

  setBrowserPaneManager(bpm: IBrowserPaneManager): void {
    this.browserPaneManager = bpm
    bpm.setSessionPathResolver((sessionId) => this.getSessionPath(sessionId))
  }

  /** Returns a strictly increasing timestamp (ms). When Date.now() collides with
   *  the previous value, increments by 1 to preserve event ordering. */
  private monotonic(): number {
    const now = Date.now()
    this.lastTimestamp =
      now > this.lastTimestamp ? now : this.lastTimestamp + 1
    return this.lastTimestamp
  }

  private getAdminRememberKey(sessionId: string, commandHash: string): string {
    return `${sessionId}:${commandHash}`
  }

  private hasActiveAdminRememberApproval(
    sessionId: string,
    commandHash: string,
  ): boolean {
    const key = this.getAdminRememberKey(sessionId, commandHash)
    const entry = this.adminRememberApprovals.get(key)
    if (!entry) {
      return false
    }

    if (Date.now() > entry.expiresAt) {
      this.adminRememberApprovals.delete(key)
      this.privilegedExecutionBroker.auditEvent(
        'privileged_remember_window_expired',
        {
          sessionId,
          commandHash,
          sourceRequestId: entry.sourceRequestId,
          expiresAt: entry.expiresAt,
        },
      )
      return false
    }

    return true
  }

  private storeAdminRememberApproval(
    sessionId: string,
    commandHash: string,
    sourceRequestId: string,
    rememberForMinutes: number,
  ): void {
    const boundedMinutes = Math.min(
      Math.max(Math.floor(rememberForMinutes), 1),
      MAX_ADMIN_REMEMBER_MINUTES,
    )
    const now = Date.now()
    const expiresAt = now + boundedMinutes * 60 * 1000

    this.adminRememberApprovals.set(
      this.getAdminRememberKey(sessionId, commandHash),
      {
        createdAt: now,
        expiresAt,
        sourceRequestId,
      },
    )

    this.privilegedExecutionBroker.auditEvent(
      'privileged_remember_window_stored',
      {
        sessionId,
        commandHash,
        sourceRequestId,
        rememberForMinutes: boundedMinutes,
        createdAt: now,
        expiresAt,
      },
    )
  }

  private clearAdminRememberApprovalsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const key of this.adminRememberApprovals.keys()) {
      if (key.startsWith(prefix)) {
        this.adminRememberApprovals.delete(key)
      }
    }
  }

  private clearPendingPermissionRequestsForSession(sessionId: string): void {
    for (const [
      requestId,
      metadata,
    ] of this.pendingPermissionRequests.entries()) {
      if (metadata.sessionId === sessionId) {
        this.pendingPermissionRequests.delete(requestId)
      }
    }
  }

  /**
   * Apply external session header metadata to in-memory state and emit UI events.
   * Returns true if any in-memory metadata field changed.
   */
  private applyExternalSessionMetadata(
    managed: ManagedSession,
    header: SessionHeader,
  ): boolean {
    const sessionId = managed.id
    let changed = false

    // Labels
    const oldLabels = JSON.stringify(managed.labels ?? [])
    const newLabels = JSON.stringify(header.labels ?? [])
    if (oldLabels !== newLabels) {
      managed.labels = header.labels
      this.sendEvent(
        { type: 'labels_changed', sessionId, labels: header.labels ?? [] },
        managed.workspace.id,
      )
      changed = true
    }

    // Flagged
    if ((managed.isFlagged ?? false) !== (header.isFlagged ?? false)) {
      managed.isFlagged = header.isFlagged ?? false
      this.sendEvent(
        {
          type: header.isFlagged ? 'session_flagged' : 'session_unflagged',
          sessionId,
        },
        managed.workspace.id,
      )
      changed = true
    }

    // Session status
    if (managed.sessionStatus !== header.sessionStatus) {
      managed.sessionStatus = header.sessionStatus
      this.sendEvent(
        {
          type: 'session_status_changed',
          sessionId,
          sessionStatus: header.sessionStatus ?? '',
        },
        managed.workspace.id,
      )
      changed = true
    }

    // Qwen canonical mirrors intentionally omit provider titles from local
    // headers. Treat an absent local name as "unknown", not as a delete.
    if (
      !(
        header.name === undefined && this.isQwenCanonicalMessageSession(managed)
      ) &&
      managed.name !== header.name
    ) {
      managed.name = header.name
      this.sendEvent(
        { type: 'name_changed', sessionId, name: header.name },
        managed.workspace.id,
      )
      changed = true
    }

    if (changed) {
      sessionLog.info(
        `External metadata change detected for session ${sessionId}`,
      )

      // Prevent stale pending writes from reverting externally-updated metadata.
      sessionPersistenceQueue.cancel(sessionId)
      this.persistSession(managed)
    }

    return changed
  }

  /**
   * Set up ConfigWatcher for a workspace to broadcast live updates
   * (sources added/removed, guide.md changes, etc.)
   * Called eagerly at boot for all workspaces (automations/scheduler) and
   * on client connect (GET_WORKSPACE / SWITCH_WORKSPACE).
   * Idempotent — returns immediately if already watching.
   * workspaceId must be the global config ID (what the renderer knows).
   */
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {
    // Check if already watching this workspace
    if (this.configWatchers.has(workspaceRootPath)) {
      return // Already watching this workspace
    }

    sessionLog.info(
      `Setting up ConfigWatcher for workspace: ${workspaceId} (${workspaceRootPath})`,
    )

    const callbacks: ConfigWatcherCallbacks = {
      onSourcesListChange: async (sources: LoadedSource[]) => {
        sessionLog.info(
          `Sources list changed in ${workspaceRootPath} (${sources.length} sources)`,
        )
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceChange: async (slug: string, source: LoadedSource | null) => {
        sessionLog.info(
          `Source '${slug}' changed:`,
          source ? 'updated' : 'deleted',
        )
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceGuideChange: (sourceSlug: string) => {
        sessionLog.info(`Source guide changed: ${sourceSlug}`)
        // Broadcast the updated sources list so sidebar picks up guide changes
        // Note: Guide changes don't require session source reload (no server changes)
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
      },
      onStatusConfigChange: () => {
        sessionLog.info(`Status config changed in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onStatusIconChange: (_workspaceId: string, iconFilename: string) => {
        sessionLog.info(
          `Status icon changed: ${iconFilename} in ${workspaceId}`,
        )
        this.broadcastStatusesChanged(workspaceId)
      },
      onLabelConfigChange: () => {
        sessionLog.info(`Label config changed in ${workspaceId}`)
        this.broadcastLabelsChanged(workspaceId)
        // Emit LabelConfigChange event via AutomationSystem
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          automationSystem.emitLabelConfigChange().catch((error) => {
            sessionLog.error(
              `[Automations] Failed to emit LabelConfigChange:`,
              error,
            )
          })
        }
      },
      onAutomationsConfigChange: () => {
        sessionLog.info(`Automations config changed in ${workspaceId}`)
        // Reload automations config via AutomationSystem
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          const result = automationSystem.reloadConfig()
          if (result.errors.length === 0) {
            sessionLog.info(
              `Reloaded ${result.automationCount} automations for workspace ${workspaceId}`,
            )
          } else {
            sessionLog.error(
              `Failed to reload automations for workspace ${workspaceId}:`,
              result.errors,
            )
          }
        }
        // Notify renderer to re-read automations.json
        this.broadcastAutomationsChanged(workspaceId)
      },
      onLlmConnectionsChange: () => {
        sessionLog.info(`LLM connections changed in ${workspaceId}`)
        this.broadcastLlmConnectionsChanged()
      },
      onAppThemeChange: (theme) => {
        sessionLog.info(`App theme changed`)
        this.broadcastAppThemeChanged(theme)
      },
      onDefaultPermissionsChange: () => {
        sessionLog.info('Default permissions changed')
        this.broadcastDefaultPermissionsChanged()
      },
      onSkillsListChange: async (skills) => {
        sessionLog.info(
          `Skills list changed in ${workspaceRootPath} (${skills.length} skills)`,
        )
        this.broadcastSkillsChanged(workspaceId, skills)
      },
      onSkillChange: async (slug, skill) => {
        sessionLog.info(
          `Skill '${slug}' changed:`,
          skill ? 'updated' : 'deleted',
        )
        // Broadcast updated list to UI
        const { loadAllSkills } = await import('@craft-agent/shared/skills')
        const skills = loadAllSkills(workspaceRootPath)
        this.broadcastSkillsChanged(workspaceId, skills)
      },

      // Session metadata changes (edits to session.jsonl headers).
      // Detects changes from both internal writes (self) and external sources
      // (other instances, scripts, manual edits).
      onSessionMetadataChange: (sessionId, header) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return

        // Check if this is our own write echoing back via fs.watch().
        // Self-writes don't need in-memory sync (already up to date), but
        // still need to notify the automation system for event matching.
        const incomingSignature = getHeaderMetadataSignature(header)
        const lastWrittenSignature =
          sessionPersistenceQueue.getLastWrittenSignature(sessionId)
        const isSelfWrite = !!(
          lastWrittenSignature && incomingSignature === lastWrittenSignature
        )

        // For external writes: sync in-memory state + emit UI events.
        // Skip for self-writes to avoid feedback loops (especially on Windows
        // where fs.watch fires aggressively: unlink + rename = 2+ events).
        if (!isSelfWrite) {
          // Defer external metadata application when:
          // 1. Session is actively processing (agent running), OR
          // 2. Session was just written programmatically (set_session_status/labels tool)
          //    — fs.watch fires during atomic write (unlink+rename) and can read stale data
          const hasWriteGuard =
            managed._metadataWriteGuardUntil &&
            Date.now() < managed._metadataWriteGuardUntil
          if (managed.isProcessing || hasWriteGuard) {
            managed.pendingExternalMetadata = header
            if (hasWriteGuard) {
              sessionLog.info(
                `Deferred external metadata update for session ${sessionId} (recent programmatic write)`,
              )
            } else {
              sessionLog.info(
                `Deferred external metadata update for session ${sessionId} (processing active)`,
              )
            }
          } else {
            this.applyExternalSessionMetadata(managed, header)
          }
        }

        // Always notify automation system — it does its own diffing and needs
        // to see both self-writes and external changes for event matching.
        const automationSystem = this.automationSystems.get(
          managed.workspace.rootPath,
        )
        if (automationSystem) {
          automationSystem
            .updateSessionMetadata(sessionId, {
              permissionMode: header.permissionMode,
              labels: header.labels,
              isFlagged: header.isFlagged,
              sessionStatus: header.sessionStatus,
              sessionName: header.name,
            })
            .catch((error) => {
              sessionLog.error(
                `[Automations] Failed to update session metadata:`,
                error,
              )
            })
        }
      },
    }

    const watcher = new ConfigWatcher(workspaceRootPath, callbacks)
    watcher.start()
    this.configWatchers.set(workspaceRootPath, watcher)

    // Initialize AutomationSystem for this workspace (includes scheduler, handlers, and event logging)
    if (!this.automationSystems.has(workspaceRootPath)) {
      const automationSystem = new AutomationSystem({
        workspaceRootPath,
        workspaceId,
        enableScheduler: true,
        onPromptsReady: async (prompts) => {
          // Execute prompt automations by creating new sessions
          const settled = await Promise.allSettled(
            prompts.map((pending) =>
              this.executePromptAutomation(
                workspaceId,
                workspaceRootPath,
                pending.prompt,
                pending.labels,
                pending.permissionMode,
                pending.mentions,
                pending.llmConnection,
                pending.model,
                pending.automationName,
              ),
            ),
          )

          // Write enriched history entries (with session IDs and prompt summaries)
          for (const [idx, result] of settled.entries()) {
            const pending = prompts[idx]
            if (!pending.matcherId) continue

            const entry = createPromptHistoryEntry({
              matcherId: pending.matcherId,
              ok: result.status === 'fulfilled',
              sessionId:
                result.status === 'fulfilled'
                  ? result.value.sessionId
                  : undefined,
              prompt: pending.prompt,
              error:
                result.status === 'rejected'
                  ? String(result.reason)
                  : undefined,
            })

            appendAutomationHistoryEntry(workspaceRootPath, entry).catch((e) =>
              sessionLog.warn('[Automations] Failed to write history:', e),
            )

            if (result.status === 'rejected') {
              sessionLog.error(
                `[Automations] Failed to execute prompt action ${idx + 1}:`,
                result.reason,
              )
            } else {
              sessionLog.info(
                `[Automations] Created session ${result.value.sessionId} from prompt action`,
              )
            }
          }
        },
        onError: (event, error) => {
          sessionLog.error(`Automation failed for ${event}:`, error.message)
        },
      })
      this.automationSystems.set(workspaceRootPath, automationSystem)
      sessionLog.info(
        `Initialized AutomationSystem for workspace ${workspaceId}`,
      )
    }
  }

  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(
    workspaceRootPath: string,
    relativePath: string,
  ): void {
    const watcher = this.configWatchers.get(workspaceRootPath)
    watcher?.notifyFileChange(relativePath)
  }

  /**
   * Reload sources for all sessions in a workspace, skipping those currently processing.
   */
  private async reloadSourcesForWorkspace(
    workspaceRootPath: string,
  ): Promise<void> {
    for (const [_, managed] of this.sessions) {
      if (managed.workspace.rootPath === workspaceRootPath) {
        if (managed.isProcessing) {
          sessionLog.info(
            `Skipping source reload for session ${managed.id} (processing)`,
          )
          continue
        }
        await this.reloadSessionSources(managed)
      }
    }
  }

  private broadcastSourcesChanged(
    workspaceId: string,
    sources: LoadedSource[],
  ): void {
    if (!this.eventSink) return
    this.eventSink(
      RPC_CHANNELS.sources.CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
      sources,
    )
  }

  private broadcastStatusesChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting statuses changed for ${workspaceId}`)
    this.eventSink(
      RPC_CHANNELS.statuses.CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
    )
  }

  private broadcastLabelsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting labels changed for ${workspaceId}`)
    this.eventSink(
      RPC_CHANNELS.labels.CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
    )
  }

  private broadcastAutomationsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting automations changed for ${workspaceId}`)
    this.eventSink(
      RPC_CHANNELS.automations.CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
    )
  }

  private broadcastAppThemeChanged(
    theme: import('@craft-agent/shared/config').ThemeOverrides | null,
  ): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting app theme changed`)
    this.eventSink(RPC_CHANNELS.theme.APP_CHANGED, { to: 'all' }, theme)
  }

  private broadcastLlmConnectionsChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting LLM connections changed')
    this.eventSink(RPC_CHANNELS.llmConnections.CHANGED, { to: 'all' })
  }

  private updateQwenConnectionModels(
    slug: string,
    models: ModelDefinition[],
    currentModelId?: string,
  ): void {
    const connection = getLlmConnection(slug)
    if (
      !connection ||
      connection.providerType !== 'qwen' ||
      models.length === 0
    )
      return

    let changed = false
    try {
      const previous = getModelRefreshService().getRuntimeModelState(slug)
      changed = getModelRefreshService().setRuntimeModelState(slug, {
        models,
        serverDefault: currentModelId ?? previous?.serverDefault,
      })
    } catch (error) {
      sessionLog.warn(
        `Qwen runtime model cache unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (changed) this.broadcastLlmConnectionsChanged()
  }

  private updateQwenConnectionDefault(slug: string, model: string): void {
    const connection = getLlmConnection(slug)
    if (!connection || connection.providerType !== 'qwen') return

    try {
      const previous = getModelRefreshService().getRuntimeModelState(slug)
      const changed = getModelRefreshService().setRuntimeModelState(slug, {
        models: previous?.models ?? [],
        serverDefault: model,
      })
      if (changed) this.broadcastLlmConnectionsChanged()
    } catch (error) {
      sessionLog.warn(
        `Qwen runtime default model update failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private broadcastSkillsChanged(
    workspaceId: string,
    skills: Array<import('@craft-agent/shared/skills').LoadedSkill>,
  ): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting skills changed (${skills.length} skills)`)
    this.eventSink(
      RPC_CHANNELS.skills.CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
      skills,
    )
  }

  private broadcastDefaultPermissionsChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting default permissions changed')
    this.eventSink(
      RPC_CHANNELS.permissions.DEFAULTS_CHANGED,
      { to: 'all' },
      null,
    )
  }

  /**
   * Reload sources for a session with an active agent.
   * Called by ConfigWatcher when source files change on disk.
   * If agent is null (session hasn't sent any messages), skip - fresh build happens on next message.
   */
  private async reloadSessionSources(managed: ManagedSession): Promise<void> {
    if (!managed.agent) return // No agent = nothing to update (fresh build on next message)

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Reloading sources for session ${managed.id}`)

    // Reload all sources from disk (craft-agents-docs is always available as MCP server)
    const allSources = loadAllSources(workspaceRootPath)
    managed.agent.setAllSources(allSources)

    // Rebuild MCP and API servers for session's enabled sources
    const enabledSlugs = managed.enabledSourceSlugs || []
    const enabledSources = allSources.filter(
      (s) => enabledSlugs.includes(s.config.slug) && isSourceUsable(s),
    )
    // Pass session path so large API responses can be saved to session folder
    const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
    const { mcpServers, apiServers } = await buildServersFromSources(
      enabledSources,
      sessionPath,
      managed.tokenRefreshManager,
      managed.agent?.getSummarizeCallback(),
    )
    const intendedSlugs = enabledSources.map((s) => s.config.slug)

    // Update bridge-mcp-server config/credentials for backends that need it
    await applyBridgeUpdates(
      managed.agent,
      sessionPath,
      enabledSources,
      mcpServers,
      managed.id,
      workspaceRootPath,
      'source reload',
      managed.poolServer?.url,
    )

    await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

    sessionLog.info(
      `Sources reloaded for session ${managed.id}: ${Object.keys(mcpServers).length} MCP, ${Object.keys(apiServers).length} API`,
    )
  }

  /**
   * Reinitialize authentication environment variables.
   * Call this after onboarding or settings changes to pick up new credentials.
   *
   * SECURITY NOTE: these env vars are propagated only from trusted app settings,
   * not from a user's project environment.
   */
  /**
   * Reinitialize authentication environment variables.
   *
   * Uses the default LLM connection to determine which credentials to set.
   *
   * @param connectionSlug - Optional connection slug to use (overrides default)
   */
  async reinitializeAuth(connectionSlug?: string): Promise<void> {
    try {
      // Get the connection to use (explicit parameter or default)
      const slug = connectionSlug || getDefaultLlmConnection()
      if (!slug) {
        sessionLog.warn(
          'No LLM connection slug available for reinitializeAuth',
        )
      }
      const connection = slug ? getLlmConnection(slug) : null

      if (!connection) {
        sessionLog.error(`No LLM connection found for slug: ${slug}`)
        resetSummarizationClient()
        return
      }

      sessionLog.info(
        `Reinitializing auth for connection: ${slug} (${connection.authType})`,
      )

      const result = await resolveAuthEnvVars()

      if (!result.success) {
        sessionLog.error(
          `Auth resolution failed for ${slug}: ${result.warning}`,
        )
      } else {
        // Apply resolved env vars to process.env
        for (const [key, value] of Object.entries(result.envVars)) {
          process.env[key] = value
        }
        sessionLog.info(`Auth env vars set for connection: ${slug}`)
      }

      // Reset cached summarization client so it picks up new credentials/base URL
      resetSummarizationClient()
    } catch (error) {
      sessionLog.error('Failed to reinitialize auth:', error)
      throw error
    }
  }

  async initialize(): Promise<void> {
    try {
      // Backfill missing `models` arrays on existing LLM connections
      migrateLegacyLlmConnectionsConfig()

      // Fix defaultLlmConnection if it points to a non-existent connection
      migrateOrphanedDefaultConnections()

      // Migrate legacy credentials to LLM connection format (one-time migration)
      // This ensures credentials saved before LLM connections are available via the new system
      await migrateLegacyCredentials()

      // Set up authentication environment variables (critical for SDK to work)
      await this.reinitializeAuth()

      // Eagerly activate ConfigWatcher + AutomationSystem for every workspace so
      // the scheduler and event handlers start at boot — not lazily on first
      // client connect. This is critical for headless servers where no UI may
      // ever connect, yet scheduled/event-driven automations must still fire.
      const workspaces = getWorkspaces()
      for (const workspace of workspaces) {
        this.setupConfigWatcher(workspace.rootPath, workspace.id)
      }

      // Load existing sessions from disk
      this.loadSessionsFromDisk()

      // Signal that initialization is complete — IPC handlers waiting on initGate will proceed
      this.initGate.markReady()
    } catch (error) {
      this.initGate.markFailed(error)
      throw error
    }
  }

  // Load all existing sessions from disk into memory (metadata only - messages are lazy-loaded)
  private loadSessionsFromDisk(): void {
    try {
      const workspaces = getWorkspaces()
      const globalPermissionMode = this.currentGlobalPermissionMode
      let totalSessions = 0

      // Iterate over each workspace and load its sessions
      for (const workspace of workspaces) {
        const workspaceRootPath = workspace.rootPath
        const sessionMetadata = listStoredSessions(workspaceRootPath)
        // Load workspace config once per workspace for default working directory
        const wsConfig = loadWorkspaceConfig(workspaceRootPath)
        const wsDefaultWorkingDir = wsConfig?.defaults?.workingDirectory

        for (const meta of sessionMetadata) {
          // Create managed session from metadata only (messages lazy-loaded on demand)
          // This dramatically reduces memory usage at startup - messages are loaded
          // when getSession() is called for a specific session
          const managed = createManagedSession(meta, workspace, {
            enabledSourceSlugs: undefined, // Loaded with messages
            workingDirectory: meta.workingDirectory ?? wsDefaultWorkingDir,
            permissionMode: globalPermissionMode,
          })

          // Migration: clear orphaned llmConnection references (e.g., after connection was deleted)
          if (managed.llmConnection) {
            const conn = resolveSessionConnection(
              managed.llmConnection,
              undefined,
            )
            if (!conn) {
              sessionLog.warn(
                `Session ${meta.id} has orphaned llmConnection "${managed.llmConnection}", clearing`,
              )
              managed.llmConnection = undefined
              managed.connectionLocked = false
            }
          }

          // Initialize mode-manager state for restored sessions even before
          // agent creation. The app-wide mode is authoritative.
          setPermissionMode(meta.id, globalPermissionMode, {
            changedBy: 'restore',
          })
          if (managed.previousPermissionMode) {
            hydratePreviousPermissionMode(
              meta.id,
              managed.previousPermissionMode,
            )
          }

          this.sessions.set(meta.id, managed)

          // Initialize session metadata in AutomationSystem for diffing
          const automationSystem =
            this.automationSystems.get(workspaceRootPath)
          if (automationSystem) {
            automationSystem.setInitialSessionMetadata(meta.id, {
              permissionMode: meta.permissionMode,
              labels: meta.labels,
              isFlagged: meta.isFlagged,
              sessionStatus: meta.sessionStatus,
              sessionName: managed.name,
            })
          }

          totalSessions++
        }
      }

      sessionLog.info(
        `Loaded ${totalSessions} sessions from disk (metadata only)`,
      )
    } catch (error) {
      sessionLog.error('Failed to load sessions from disk:', error)
    }
  }

  async refreshExternalSessions(workspaceId?: string): Promise<void> {
    const workspaces = getWorkspaces().filter(
      (workspace) => !workspaceId || workspace.id === workspaceId,
    )

    await Promise.all(
      workspaces.map((workspace) =>
        this.refreshExternalSessionsForWorkspace(workspace),
      ),
    )
  }

  private async refreshExternalSessionsForWorkspace(
    workspace: Workspace,
  ): Promise<void> {
    const lastSync = this.externalSessionListSyncAt.get(workspace.id) ?? 0
    if (Date.now() - lastSync < EXTERNAL_SESSION_LIST_SYNC_INTERVAL_MS) return

    const inFlight = this.externalSessionListSyncPromises.get(workspace.id)
    if (inFlight) {
      await inFlight
      return
    }

    const syncPromise = this.doRefreshExternalSessionsForWorkspace(workspace)
      .catch((error) => {
        sessionLog.warn(
          `Failed to sync provider session list for workspace ${workspace.id}:`,
          error,
        )
      })
      .finally(() => {
        this.emitSessionListRefreshStateChanged(workspace.id, false)
        this.externalSessionListSyncAt.set(workspace.id, Date.now())
        this.externalSessionListSyncPromises.delete(workspace.id)
      })

    this.externalSessionListSyncPromises.set(workspace.id, syncPromise)
    this.emitSessionListRefreshStateChanged(workspace.id, true)
    await syncPromise
  }

  private async doRefreshExternalSessionsForWorkspace(
    workspace: Workspace,
  ): Promise<void> {
    const workspaceConfig = loadWorkspaceConfig(workspace.rootPath)
    const sessionListCwd =
      workspaceConfig?.defaults?.workingDirectory || workspace.rootPath
    const defaultPermissionMode = this.currentGlobalPermissionMode
    const backendContext = resolveBackendContext({
      workspaceDefaultConnectionSlug:
        workspaceConfig?.defaults?.defaultLlmConnection,
    })

    if (
      !backendContext.capabilities.listsSessions ||
      !backendContext.connection
    )
      return

    await this.withExternalSessionAgentForWorkspace(
      workspace,
      backendContext,
      async (agent) => {
        if (!agent.listSessions) return

        const listedSessions: BackendSessionInfo[] = []
        let cursor: string | null | undefined
        let reachedEnd = false

        for (let page = 0; page < EXTERNAL_SESSION_LIST_MAX_PAGES; page++) {
          const result = await agent.listSessions({
            cwd: sessionListCwd,
            cursor,
            size: EXTERNAL_SESSION_LIST_PAGE_SIZE,
          })
          listedSessions.push(...result.sessions)
          cursor = result.nextCursor
          if (!cursor) {
            reachedEnd = true
            break
          }
        }

        const seenSdkSessionIds = new Set<string>()
        for (const info of listedSessions) {
          const didUpsert = await this.upsertExternalListedSession({
            workspace,
            info,
            connectionSlug: backendContext.connection.slug,
            model: backendContext.resolvedModel || undefined,
            defaultPermissionMode,
            defaultThinkingLevel:
              normalizeThinkingLevel(
                workspaceConfig?.defaults?.thinkingLevel,
              ) ?? getDefaultThinkingLevel(),
            loadMessages: agent.loadSessionMessages
              ? (sessionInfo) =>
                  agent.loadSessionMessages!(sessionInfo.sessionId, {
                    cwd: sessionInfo.cwd,
                  })
              : undefined,
          })
          if (didUpsert) seenSdkSessionIds.add(info.sessionId)
        }

        const removedMissingSessions = reachedEnd
          ? await this.removeMissingExternalListedSessions(
              workspace,
              backendContext.connection.slug,
              seenSdkSessionIds,
            )
          : false

        if (listedSessions.length > 0) {
          sessionLog.info(
            `Synced ${seenSdkSessionIds.size} provider session(s) for workspace ${workspace.id}`,
          )
        }

        if (seenSdkSessionIds.size > 0 || removedMissingSessions) {
          this.emitSessionListChanged(workspace.id)
        }
      },
    )
  }

  private createExternalSessionListAgent(
    workspace: Workspace,
    backendContext: ReturnType<typeof resolveBackendContext>,
  ): AgentBackend {
    const overrideAgent = this.createExternalSessionAgentOverride?.(
      workspace,
      backendContext,
    )
    if (overrideAgent) return overrideAgent

    return createBackendFromResolvedContext({
      context: backendContext,
      hostRuntime: buildBackendHostRuntimeContext(),
      coreConfig: {
        workspace,
        miniModel: backendContext.connection?.defaultModel,
        isHeadless: true,
        skipConfigWatcher: true,
        envOverrides: {
          CRAFT_WORKSPACE_PATH: workspace.rootPath,
        },
      },
    })
  }

  private async withExternalSessionAgentForWorkspace<T>(
    workspace: Workspace,
    backendContext: ReturnType<typeof resolveBackendContext>,
    callback: (agent: AgentBackend) => Promise<T>,
  ): Promise<T> {
    const agent = this.createExternalSessionListAgent(
      workspace,
      backendContext,
    )
    agent.onDebug = (msg: string) => sessionLog.debug(msg)
    try {
      return await callback(agent)
    } finally {
      agent.dispose()
    }
  }

  private async withExternalSessionAgent<T>(
    managed: ManagedSession,
    callback: (agent: AgentBackend) => Promise<T>,
  ): Promise<T | undefined> {
    const sessionConnectionSlug =
      this.resolveExternalSessionConnectionSlug(managed)
    if (!sessionConnectionSlug) return undefined

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const backendContext = resolveBackendContext({
      sessionConnectionSlug,
      workspaceDefaultConnectionSlug:
        workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model,
    })

    if (
      !backendContext.capabilities.listsSessions ||
      !backendContext.connection
    )
      return undefined

    return await this.withExternalSessionAgentForWorkspace(
      managed.workspace,
      backendContext,
      callback,
    )
  }

  private resolveExternalSessionConnectionSlug(
    managed: ManagedSession,
  ): string | undefined {
    if (managed.llmConnection) return managed.llmConnection

    // Qwen-only sessions no longer persist llmConnection in desktop JSONL.
    // Any session with a provider SDK id resumes through the built-in Qwen backend.
    if (managed.sdkSessionId) {
      return QWEN_CODE_CONNECTION_SLUG
    }

    return undefined
  }

  private isQwenCanonicalMessageSession(managed: ManagedSession): boolean {
    return isQwenCanonicalManagedSession({
      sdkSessionId: managed.sdkSessionId,
      llmConnection: this.resolveExternalSessionConnectionSlug(managed),
    })
  }

  private resolveQwenCanonicalCwd(managed: ManagedSession): string {
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    return (
      managed.workingDirectory ||
      managed.sdkCwd ||
      workspaceConfig?.defaults?.workingDirectory ||
      managed.workspace.rootPath
    )
  }

  private async canonicalizeQwenManagedSessionId(
    workspace: Workspace,
    managed: ManagedSession,
    sdkSessionId: string,
  ): Promise<ManagedSession> {
    if (managed.id === sdkSessionId) return managed
    if (
      this.resolveExternalSessionConnectionSlug(managed) !==
      QWEN_CODE_CONNECTION_SLUG
    )
      return managed
    if (managed.isProcessing) return managed

    const existing = this.sessions.get(sdkSessionId)
    if (existing && existing !== managed) {
      if (existing.isProcessing) return managed
      this.removeExternalListedLocalMirror(workspace, existing)
    } else if (
      existsSync(getSessionStoragePath(workspace.rootPath, sdkSessionId))
    ) {
      deleteStoredSession(workspace.rootPath, sdkSessionId)
    }

    const previousId = managed.id
    const previousPath = getSessionStoragePath(workspace.rootPath, previousId)
    const nextPath = getSessionStoragePath(workspace.rootPath, sdkSessionId)

    await sessionPersistenceQueue.flush(previousId).catch((error) => {
      sessionLog.debug(
        `Failed to flush session ${previousId} before Qwen id canonicalization:`,
        error,
      )
    })

    managed.id = sdkSessionId
    managed.sdkSessionId = sdkSessionId
    this.sessions.delete(previousId)
    this.sessions.set(sdkSessionId, managed)

    if (existsSync(previousPath)) {
      await rename(previousPath, nextPath)
    } else {
      ensureSessionDir(workspace.rootPath, sdkSessionId)
    }

    const automationSystem = this.automationSystems.get(workspace.rootPath)
    automationSystem?.removeSessionMetadata(previousId)
    automationSystem?.setInitialSessionMetadata(sdkSessionId, {
      permissionMode: managed.permissionMode,
      labels: managed.labels,
      isFlagged: managed.isFlagged,
      sessionStatus: managed.sessionStatus,
      sessionName: managed.name,
    })

    this.persistSession(managed)
    await sessionPersistenceQueue.flush(sdkSessionId)

    // This is a rename, not a delete+create. Emitting session_deleted +
    // session_created leaves the renderer unable to correlate the two events,
    // so it deselects the active session (on delete) and never re-selects it
    // (the create doesn't auto-select), stranding the open chat on a dead id.
    // A single rename event lets the renderer migrate selection + per-session
    // state from previousId -> sdkSessionId in place.
    this.sendEvent(
      { type: 'session_id_changed', previousId, sessionId: sdkSessionId },
      workspace.id,
    )
    sessionLog.info(
      `Canonicalized Qwen session id ${previousId} -> ${sdkSessionId}`,
    )

    return managed
  }

  private externalSessionDeleteKey(
    workspaceId: string,
    sdkSessionId: string,
  ): string {
    return `${workspaceId}:${sdkSessionId}`
  }

  private externalSessionDeleteKeyForManaged(
    managed: ManagedSession,
  ): string | undefined {
    return managed.sdkSessionId
      ? this.externalSessionDeleteKey(
          managed.workspace.id,
          managed.sdkSessionId,
        )
      : undefined
  }

  private isExternalSessionDeletePending(
    workspaceId: string,
    sdkSessionId: string,
  ): boolean {
    return this.pendingExternalSessionDeletes.has(
      this.externalSessionDeleteKey(workspaceId, sdkSessionId),
    )
  }

  private async renameExternalBackendSessionIfSupported(
    managed: ManagedSession,
    title: string,
  ): Promise<boolean> {
    if (!managed.sdkSessionId) return false
    try {
      const renamed = await this.withExternalSessionAgent(
        managed,
        async (agent) => {
          if (!agent.renameBackendSession) return false
          return agent.renameBackendSession(managed.sdkSessionId!, title, {
            cwd: this.resolveQwenCanonicalCwd(managed),
          })
        },
      )
      return renamed === true
    } catch (error) {
      sessionLog.warn(
        `Failed to rename provider session ${managed.sdkSessionId}:`,
        error,
      )
      return false
    }
  }

  private syncExternalBackendTitleIfSupported(
    managed: ManagedSession,
    title: string,
  ): Promise<void> {
    const normalizedTitle = title.trim()
    if (
      !normalizedTitle ||
      !managed.sdkSessionId ||
      managed.externalBackendSyncedTitle === normalizedTitle
    ) {
      return Promise.resolve()
    }

    const previous = managed.externalBackendTitleSyncChain ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (
          !managed.sdkSessionId ||
          managed.externalBackendSyncedTitle === normalizedTitle
        )
          return
        const synced = await this.renameExternalBackendSessionIfSupported(
          managed,
          normalizedTitle,
        )
        if (synced) {
          managed.externalBackendSyncedTitle = normalizedTitle
        }
      })

    const guarded = next.finally(() => {
      if (managed.externalBackendTitleSyncChain === guarded) {
        managed.externalBackendTitleSyncChain = undefined
      }
    })
    managed.externalBackendTitleSyncChain = guarded

    return guarded
  }

  private async deleteExternalBackendSessionIfSupported(
    managed: ManagedSession,
  ): Promise<void> {
    if (!managed.sdkSessionId) return
    try {
      await this.withExternalSessionAgent(managed, async (agent) => {
        if (!agent.deleteBackendSession) return false
        return agent.deleteBackendSession(managed.sdkSessionId!, {
          cwd: this.resolveQwenCanonicalCwd(managed),
        })
      })
    } catch (error) {
      sessionLog.warn(
        `Failed to delete provider session ${managed.sdkSessionId}:`,
        error,
      )
    }
  }

  private findManagedSessionsBySdkSessionId(
    workspaceId: string,
    sdkSessionId: string,
  ): ManagedSession[] {
    return Array.from(this.sessions.values()).filter(
      (managed) =>
        managed.workspace.id === workspaceId &&
        (managed.sdkSessionId === sdkSessionId || managed.id === sdkSessionId),
    )
  }

  private selectManagedSessionBySdkSessionId(
    workspaceId: string,
    sdkSessionId: string,
  ): ManagedSession | undefined {
    const matches = this.findManagedSessionsBySdkSessionId(
      workspaceId,
      sdkSessionId,
    )
    if (matches.length === 0) return undefined

    const byActivityDesc = (a: ManagedSession, b: ManagedSession) =>
      Math.max(b.lastMessageAt ?? 0, b.lastUsedAt ?? 0) -
      Math.max(a.lastMessageAt ?? 0, a.lastUsedAt ?? 0)

    // Prefer the Craft-owned session when it has already captured this provider
    // session ID. A provider-native mirror uses id === sdkSessionId and should not
    // win once the real local session is linked.
    const localOwners = matches.filter(
      (managed) => managed.id !== sdkSessionId,
    )
    if (localOwners.length > 0) {
      return localOwners.sort(byActivityDesc)[0]
    }

    return matches.sort(byActivityDesc)[0]
  }

  private removeDuplicateExternalListedMirrors(
    workspace: Workspace,
    owner: ManagedSession,
    sdkSessionId: string,
  ): void {
    const matches = this.findManagedSessionsBySdkSessionId(
      workspace.id,
      sdkSessionId,
    )
    for (const duplicate of matches) {
      if (duplicate.id === owner.id) continue
      if (duplicate.isProcessing) continue

      // Only delete provider-native mirror records. If two Craft-owned sessions
      // somehow share an SDK ID, keep both rather than risking user data loss.
      if (duplicate.id === sdkSessionId) {
        sessionLog.info(
          `Removing duplicate provider-native mirror ${duplicate.id}; owner is ${owner.id}`,
        )
        this.removeExternalListedLocalMirror(workspace, duplicate)
      }
    }
  }

  private parseExternalSessionTimestamp(updatedAt?: string | null): number {
    if (!updatedAt) return Date.now()
    const parsed = Date.parse(updatedAt)
    return Number.isFinite(parsed) ? parsed : Date.now()
  }

  private isExternalSessionPlaceholderTitle(title: string): boolean {
    return EXTERNAL_SESSION_PLACEHOLDER_TITLES.has(title.trim())
  }

  private hasNoRenderableLocalMessages(managed: ManagedSession): boolean {
    const loadedMessageCount = managed.messages.length
    const persistedMessageCount = managed.messageCount ?? loadedMessageCount
    return loadedMessageCount === 0 && persistedMessageCount === 0
  }

  private isUnresolvedQwenCanonicalMirror(managed: ManagedSession): boolean {
    if (managed.isProcessing) return false
    if (!managed.sdkSessionId || managed.id !== managed.sdkSessionId)
      return false
    if (
      this.resolveExternalSessionConnectionSlug(managed) !==
      QWEN_CODE_CONNECTION_SLUG
    )
      return false
    if (managed.messages.length > 0) return false
    if (managed.name && !this.isExternalSessionPlaceholderTitle(managed.name))
      return false
    if (managed.preview || managed.lastMessageRole) return false
    if (
      [managed.createdAt, managed.lastUsedAt, managed.lastMessageAt].some(
        (timestamp) => typeof timestamp === 'number' && timestamp > 0,
      )
    )
      return false

    return true
  }

  private shouldInspectExternalPlaceholderSession(
    managed?: ManagedSession,
  ): boolean {
    if (!managed) return true
    if (this.hasNoRenderableLocalMessages(managed)) return true
    if (managed.preview) return false

    const hasLoadedUserMessage = managed.messages.some(
      (message) => message.role === 'user' && message.content.trim(),
    )
    if (hasLoadedUserMessage) return false

    const persistedMessageCount =
      managed.messageCount ?? managed.messages.length
    return persistedMessageCount > 0 && managed.lastMessageRole === 'assistant'
  }

  private extractMessagePreview(messages: Message[]): string | undefined {
    const firstUserMessage = messages.find(
      (message) => message.role === 'user',
    )
    if (!firstUserMessage?.content) return undefined

    const sanitized = firstUserMessage.content
      .replace(/<edit_request>[\s\S]*?<\/edit_request>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[skill:(?:[\w-]+:)?[\w-]+\]/g, '')
      .replace(/\[source:[\w-]+\]/g, '')
      .replace(/\[file:[^\]]+\]/g, '')
      .replace(/\[folder:[^\]]+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    return sanitized.substring(0, 150) || undefined
  }

  private async loadExternalListedMessages(
    info: BackendSessionInfo,
    loadMessages?: (
      info: BackendSessionInfo,
    ) => Promise<BackendSessionMessagesPayload | undefined>,
  ): Promise<BackendSessionMessagesResult | undefined> {
    if (!loadMessages) return undefined
    try {
      return normalizeBackendSessionMessages(await loadMessages(info))
    } catch (error) {
      sessionLog.debug(
        `Failed to inspect provider-native session ${info.sessionId}:`,
        error,
      )
      return undefined
    }
  }

  private removeExternalListedLocalMirror(
    workspace: Workspace,
    managed: ManagedSession,
  ): void {
    this.sessions.delete(managed.id)
    unregisterSessionScopedToolCallbacks(managed.id)
    deleteStoredSession(workspace.rootPath, managed.id)
    this.automationSystems
      .get(workspace.rootPath)
      ?.removeSessionMetadata(managed.id)
  }

  private applyAvailableCommandsSnapshot(
    managed: ManagedSession,
    snapshot: AvailableCommandsSnapshot,
    source: string,
  ): void {
    if (
      snapshot.availableCommands.length === 0 &&
      (!snapshot.availableSkills || snapshot.availableSkills.length === 0)
    )
      return

    managed.availableCommands = snapshot.availableCommands
    managed.availableSkills = snapshot.availableSkills
    managed.availableSkillDetails = snapshot.availableSkillDetails
    sessionLog.info('Available commands updated', {
      sessionId: managed.id,
      source,
      commandCount: snapshot.availableCommands.length,
      skillCount: snapshot.availableSkills?.length ?? 0,
      skillDetailCount: snapshot.availableSkillDetails?.length ?? 0,
      commandNames: snapshot.availableCommands.map((command) => command.name),
      skillNames: snapshot.availableSkills ?? [],
    })
    this.sendEvent(
      {
        type: 'available_commands_update',
        sessionId: managed.id,
        availableCommands: snapshot.availableCommands,
        ...(snapshot.availableSkills
          ? { availableSkills: snapshot.availableSkills }
          : {}),
        ...(snapshot.availableSkillDetails
          ? { availableSkillDetails: snapshot.availableSkillDetails }
          : {}),
      },
      managed.workspace.id,
    )
  }

  private applyAvailableCommandsFromMessagesResult(
    managed: ManagedSession,
    result: BackendSessionMessagesResult | undefined,
    source: string,
  ): void {
    if (
      !result ||
      (!result.availableCommands?.length && !result.availableSkills?.length)
    )
      return
    this.applyAvailableCommandsSnapshot(
      managed,
      {
        availableCommands: result.availableCommands ?? [],
        ...(result.availableSkills
          ? { availableSkills: result.availableSkills }
          : {}),
        ...(result.availableSkillDetails
          ? { availableSkillDetails: result.availableSkillDetails }
          : {}),
      },
      source,
    )
  }

  private applyTokenUsageFromMessagesResult(
    managed: ManagedSession,
    result: BackendSessionMessagesResult | undefined,
  ): void {
    if (!result?.tokenUsage) return
    managed.tokenUsage = { ...result.tokenUsage }
  }

  private applyLoadedExternalMessages(
    managed: ManagedSession,
    messages: Message[],
  ): void {
    const usesQwenCanonicalMessages =
      this.isQwenCanonicalMessageSession(managed)
    managed.messages = usesQwenCanonicalMessages
      ? mergeQwenCanonicalLocalVisualMessages(messages, [
          ...managed.messages,
          ...this.inferLegacyQwenCanonicalAttachmentOverlays(managed, messages),
        ])
      : messages
    if (usesQwenCanonicalMessages) {
      delete managed.messageCount
    } else {
      managed.messageCount = managed.messages.length
    }
    managed.preview = this.extractMessagePreview(managed.messages)

    const firstMessage = managed.messages[0]
    if (firstMessage && this.isQwenCanonicalMessageSession(managed)) {
      managed.createdAt = firstMessage.timestamp
    }

    const lastMessage = managed.messages[managed.messages.length - 1]
    if (lastMessage) {
      managed.lastMessageAt = lastMessage.timestamp
      if (
        lastMessage.role === 'user' ||
        lastMessage.role === 'assistant' ||
        lastMessage.role === 'tool' ||
        lastMessage.role === 'plan' ||
        lastMessage.role === 'error'
      ) {
        managed.lastMessageRole = lastMessage.role
      }
      managed.lastUsedAt = this.isQwenCanonicalMessageSession(managed)
        ? lastMessage.timestamp
        : Math.max(managed.lastUsedAt ?? 0, lastMessage.timestamp)
    }

    const lastFinalAssistant = [...managed.messages]
      .reverse()
      .find(
        (message) => message.role === 'assistant' && !message.isIntermediate,
      )
    managed.lastFinalMessageId = lastFinalAssistant?.id
  }

  private inferLegacyQwenCanonicalAttachmentOverlays(
    managed: ManagedSession,
    messages: Message[],
  ): Message[] {
    if (qwenCanonicalLocalVisualMessages(managed.messages).length > 0) {
      return []
    }

    const userMessages = messages.filter((message) => message.role === 'user')
    if (userMessages.length === 0) return []

    const attachmentsDir = join(
      getSessionStoragePath(managed.workspace.rootPath, managed.id),
      'attachments',
    )
    if (!existsSync(attachmentsDir)) return []

    const attachmentsByMessageId = new Map<string, StoredAttachment[]>()
    try {
      const legacyAttachments = readdirSync(attachmentsDir)
        .filter((fileName) => !fileName.includes('_thumb.'))
        .map((fileName) => {
          const extension = extname(fileName).toLowerCase()
          const mimeType = LEGACY_IMAGE_MIME_BY_EXTENSION[extension]
          if (!mimeType) return null

          const storedPath = join(attachmentsDir, fileName)
          return {
            fileName,
            mimeType,
            name: legacyStoredAttachmentName(fileName),
            stats: statSync(storedPath),
            storedPath,
          }
        })
        .filter((item) => item !== null)
        .sort(
          (a, b) =>
            LEGACY_ATTACHMENT_NAME_COLLATOR.compare(a.name, b.name) ||
            a.stats.mtimeMs - b.stats.mtimeMs ||
            a.fileName.localeCompare(b.fileName),
        )

      for (const {
        fileName,
        mimeType,
        name,
        stats,
        storedPath,
      } of legacyAttachments) {
        const matchedMessage = userMessages
          .map((message) => ({
            message,
            delta: Math.abs(message.timestamp - stats.mtimeMs),
          }))
          .filter(({ delta }) => delta <= LEGACY_ATTACHMENT_MATCH_WINDOW_MS)
          .sort((a, b) => a.delta - b.delta)[0]?.message
        if (!matchedMessage) continue

        const attachmentId =
          fileName.match(/^([0-9a-f-]{36})_/i)?.[1] ?? randomUUID()
        const thumbPath = join(attachmentsDir, `${attachmentId}_thumb.png`)
        const thumbnailBase64 = existsSync(thumbPath)
          ? readFileSync(thumbPath).toString('base64')
          : undefined
        const attachment: StoredAttachment = {
          id: attachmentId,
          type: 'image',
          name,
          mimeType,
          size: stats.size,
          storedPath,
          ...(thumbnailBase64
            ? { thumbnailPath: thumbPath, thumbnailBase64 }
            : {}),
        }

        const existing = attachmentsByMessageId.get(matchedMessage.id) ?? []
        existing.push(attachment)
        attachmentsByMessageId.set(matchedMessage.id, existing)
      }
    } catch (error) {
      sessionLog.warn(
        `Failed to infer legacy Qwen attachments for session ${managed.id}:`,
        error,
      )
      return []
    }

    const overlays: Message[] = []
    for (const message of userMessages) {
      const attachments = attachmentsByMessageId.get(message.id)
      if (attachments?.length) {
        overlays.push({ ...message, attachments })
      }
    }
    return overlays
  }

  private async upsertExternalListedSession(args: {
    workspace: Workspace
    info: BackendSessionInfo
    connectionSlug: string
    model?: string
    defaultPermissionMode: PermissionMode
    defaultThinkingLevel: ThinkingLevel
    loadMessages?: (
      info: BackendSessionInfo,
    ) => Promise<BackendSessionMessagesPayload | undefined>
  }): Promise<boolean> {
    const {
      workspace,
      info,
      connectionSlug,
      model,
      defaultPermissionMode,
      defaultThinkingLevel,
      loadMessages,
    } = args
    if (!info.sessionId || !info.cwd) return false
    if (this.isExternalSessionDeletePending(workspace.id, info.sessionId))
      return false

    const timestamp = this.parseExternalSessionTimestamp(info.updatedAt)
    const createdTimestamp =
      parseOptionalTimestamp(info.createdAt) ??
      parseOptionalTimestamp(info.startTime)
    let title = info.title?.trim() || EXTERNAL_SESSION_PLACEHOLDER_TITLE
    let managed = this.selectManagedSessionBySdkSessionId(
      workspace.id,
      info.sessionId,
    )
    if (managed) {
      this.removeDuplicateExternalListedMirrors(
        workspace,
        managed,
        info.sessionId,
      )
      if (connectionSlug === QWEN_CODE_CONNECTION_SLUG) {
        managed = await this.canonicalizeQwenManagedSessionId(
          workspace,
          managed,
          info.sessionId,
        )
      }
    }
    let inspectedResult: BackendSessionMessagesResult | undefined

    if (
      this.isExternalSessionPlaceholderTitle(title) &&
      this.shouldInspectExternalPlaceholderSession(managed)
    ) {
      inspectedResult = await this.loadExternalListedMessages(
        info,
        loadMessages,
      )
      const inspectedMessages = inspectedResult?.messages

      if (!inspectedMessages || inspectedMessages.length === 0) {
        if (
          managed &&
          !managed.isProcessing &&
          this.hasNoRenderableLocalMessages(managed)
        ) {
          this.removeExternalListedLocalMirror(workspace, managed)
        }
        return (
          !!managed &&
          (managed.isProcessing || !this.hasNoRenderableLocalMessages(managed))
        )
      }
      title = this.extractMessagePreview(inspectedMessages) ?? title
    }

    if (managed) {
      managed.sdkSessionId = info.sessionId
      managed.workingDirectory = info.cwd
      managed.sdkCwd = info.cwd
      managed.name = title
      if (info.preview !== undefined)
        managed.preview = info.preview ?? undefined
      if (!managed.llmConnection) managed.llmConnection = connectionSlug
      if (!managed.model && model) managed.model = model
      if (!managed.thinkingLevel) managed.thinkingLevel = defaultThinkingLevel
      if (connectionSlug === QWEN_CODE_CONNECTION_SLUG) {
        managed.createdAt = createdTimestamp ?? managed.createdAt ?? timestamp
        managed.lastUsedAt = timestamp
        managed.lastMessageAt = timestamp
        delete managed.messageCount
      } else {
        managed.createdAt = createdTimestamp ?? managed.createdAt
        if (typeof info.messageCount === 'number')
          managed.messageCount = info.messageCount
        managed.lastUsedAt = Math.max(managed.lastUsedAt ?? 0, timestamp)
        managed.lastMessageAt = Math.max(managed.lastMessageAt ?? 0, timestamp)
      }
      this.applyAvailableCommandsFromMessagesResult(
        managed,
        inspectedResult,
        'provider-native session inspection',
      )
      this.applyTokenUsageFromMessagesResult(managed, inspectedResult)
      const inspectedMessages = inspectedResult?.messages
      if (inspectedMessages?.length) {
        this.applyLoadedExternalMessages(managed, inspectedMessages)
        this.markExternalMessagesLoadedThrough(managed)
        managed.messagesLoaded = true
        this.persistSession(managed)
      }
      return true
    }

    const inspectedMessages = inspectedResult?.messages
    const lastInspectedMessage =
      inspectedMessages?.[inspectedMessages.length - 1]
    const firstInspectedMessage = inspectedMessages?.[0]
    const shouldPersistInspectedMessages =
      connectionSlug !== QWEN_CODE_CONNECTION_SLUG
    const createdAt =
      firstInspectedMessage?.timestamp ?? createdTimestamp ?? timestamp
    const inMemoryLastMessageAt = lastInspectedMessage?.timestamp ?? timestamp
    const storedSessionBase: StoredSession = {
      id: info.sessionId,
      workspaceRootPath: workspace.rootPath,
      sdkSessionId: info.sessionId,
      sdkCwd: info.cwd,
      workingDirectory: info.cwd,
      name: title,
      createdAt,
      lastUsedAt: Math.max(timestamp, inMemoryLastMessageAt),
      lastMessageAt: inMemoryLastMessageAt,
      ...(model ? { model } : {}),
      thinkingLevel: defaultThinkingLevel,
      messages: shouldPersistInspectedMessages
        ? (inspectedMessages?.map(messageToStored) ?? [])
        : [],
      tokenUsage: { ...DEFAULT_TOKEN_USAGE },
    } as StoredSession

    const storedSession = (
      connectionSlug === QWEN_CODE_CONNECTION_SLUG
        ? {
            ...stripQwenCanonicalStoredFields(storedSessionBase),
            omitMessageDerivedHeaderFields: true,
            omitTranscriptDerivedHeaderFields: true,
            omitHeaderTokenUsage: true,
            preserveSessionTimestamps: true,
          }
        : storedSessionBase
    ) as StoredSessionWithHeaderOptions

    await saveStoredSession(storedSession)

    const storedMetadata = pickSessionFields(storedSession) as {
      id: string
    } & Partial<ManagedSession>
    const imported = createManagedSession(storedMetadata, workspace, {
      messages: inspectedMessages ?? [],
      messagesLoaded: !!inspectedMessages,
      tokenUsage: { ...storedSession.tokenUsage },
      sdkCwd: info.cwd,
      workingDirectory: info.cwd,
      name: title,
      createdAt,
      lastUsedAt: Math.max(timestamp, inMemoryLastMessageAt),
      lastMessageAt: inMemoryLastMessageAt,
      permissionMode: defaultPermissionMode,
      preview: info.preview ?? undefined,
      ...(connectionSlug !== QWEN_CODE_CONNECTION_SLUG &&
      typeof info.messageCount === 'number'
        ? { messageCount: info.messageCount }
        : {}),
    })
    if (
      inspectedResult?.availableCommands?.length ||
      inspectedResult?.availableSkills?.length
    ) {
      imported.availableCommands = inspectedResult.availableCommands ?? []
      imported.availableSkills = inspectedResult.availableSkills
    }
    this.applyTokenUsageFromMessagesResult(imported, inspectedResult)
    if (inspectedMessages?.length) {
      this.applyLoadedExternalMessages(imported, inspectedMessages)
      this.markExternalMessagesLoadedThrough(imported)
    }
    this.sessions.set(imported.id, imported)
    setPermissionMode(imported.id, defaultPermissionMode, {
      changedBy: 'restore',
    })

    const automationSystem = this.automationSystems.get(workspace.rootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(imported.id, {
        labels: imported.labels,
        isFlagged: imported.isFlagged,
        sessionStatus: imported.sessionStatus,
        sessionName: imported.name,
      })
    }

    return true
  }

  private async removeMissingExternalListedSessions(
    workspace: Workspace,
    connectionSlug: string,
    seenSdkSessionIds: Set<string>,
  ): Promise<boolean> {
    let removed = false

    for (const managed of Array.from(this.sessions.values())) {
      if (managed.workspace.id !== workspace.id) continue
      if (this.resolveExternalSessionConnectionSlug(managed) !== connectionSlug)
        continue
      if (!managed.sdkSessionId || managed.id !== managed.sdkSessionId)
        continue
      if (seenSdkSessionIds.has(managed.sdkSessionId)) continue
      if (managed.isProcessing) continue

      this.sessions.delete(managed.id)
      removed = true
      unregisterSessionScopedToolCallbacks(managed.id)
      deleteStoredSession(workspace.rootPath, managed.id)

      const automationSystem = this.automationSystems.get(workspace.rootPath)
      automationSystem?.removeSessionMetadata(managed.id)
    }

    return removed
  }

  // Persist a session to disk (async with debouncing)
  private persistSession(managed: ManagedSession): void {
    try {
      const usesQwenCanonicalMessages =
        this.isQwenCanonicalMessageSession(managed)
      // Filter out transient status messages (progress indicators like "Compacting...")
      // Error messages are now persisted with rich fields for diagnostics
      const persistableMessages = usesQwenCanonicalMessages
        ? qwenCanonicalLocalVisualMessages(managed.messages)
        : managed.messages.filter((m) => m.role !== 'status')
      // If messages haven't been loaded yet (e.g., branched session not yet opened),
      // skip persistence to avoid overwriting JSONL messages with empty array
      if (!managed.messagesLoaded && !usesQwenCanonicalMessages) {
        return
      }

      const storedSessionBase: StoredSession = {
        ...pickSessionFields(managed),
        workspaceRootPath: managed.workspace.rootPath,
        createdAt: managed.createdAt ?? Date.now(),
        lastUsedAt: usesQwenCanonicalMessages
          ? (managed.lastUsedAt ??
            managed.lastMessageAt ??
            managed.createdAt ??
            Date.now())
          : Date.now(),
        messages: persistableMessages.map(messageToStored),
        tokenUsage: managed.tokenUsage ?? DEFAULT_TOKEN_USAGE,
      } as StoredSession
      const storedSession = (
        usesQwenCanonicalMessages
          ? {
              ...stripQwenCanonicalStoredFields(storedSessionBase),
              omitMessageDerivedHeaderFields: true,
              omitTranscriptDerivedHeaderFields: true,
              omitHeaderTokenUsage: true,
              preserveSessionTimestamps: true,
            }
          : storedSessionBase
      ) as StoredSessionWithHeaderOptions

      // Queue for async persistence with debouncing
      sessionPersistenceQueue.enqueue(storedSession)
    } catch (error) {
      sessionLog.error(
        `Failed to queue session ${managed.id} for persistence:`,
        error,
      )
    }
  }

  // Flush a specific session immediately (call on session close/switch)
  async flushSession(sessionId: string): Promise<void> {
    await sessionPersistenceQueue.flush(sessionId)
  }

  private async persistSessionMetadataUpdate(
    managed: ManagedSession,
    updates: Partial<
      Pick<
        SessionConfig,
        | 'isFlagged'
        | 'name'
        | 'sessionStatus'
        | 'labels'
        | 'lastReadMessageId'
        | 'hasUnread'
        | 'enabledSourceSlugs'
        | 'workingDirectory'
        | 'sdkCwd'
        | 'sharedUrl'
        | 'sharedId'
        | 'model'
        | 'llmConnection'
        | 'isArchived'
        | 'archivedAt'
      >
    >,
  ): Promise<void> {
    if (this.isQwenCanonicalMessageSession(managed)) {
      this.persistSession(managed)
      await this.flushSession(managed.id)
      return
    }

    await updateSessionMetadata(
      managed.workspace.rootPath,
      managed.id,
      updates,
    )
  }

  // Flush all pending sessions (call on app quit)
  async flushAllSessions(): Promise<void> {
    await sessionPersistenceQueue.flushAll()
  }

  // ============================================
  // Unified Auth Request Helpers
  // ============================================

  /**
   * Get human-readable description for auth request
   */
  private getAuthRequestDescription(request: AuthRequest): string {
    switch (request.type) {
      case 'credential':
        return `Authentication required for ${request.sourceName}`
      case 'oauth':
        return `OAuth authentication for ${request.sourceName}`
      case 'oauth-google':
        return `Sign in with Google for ${request.sourceName}`
      case 'oauth-slack':
        return `Sign in with Slack for ${request.sourceName}`
      case 'oauth-microsoft':
        return `Sign in with Microsoft for ${request.sourceName}`
      default:
        return 'Authentication required'
    }
  }

  /**
   * Format auth result message to send back to agent
   */
  private formatAuthResultMessage(result: AuthResult): string {
    if (result.success) {
      let msg = `Authentication completed for ${result.sourceSlug}.`
      if (result.email) msg += ` Signed in as ${result.email}.`
      if (result.workspace)
        msg += ` Connected to workspace: ${result.workspace}.`
      msg += ' Credentials have been saved.'
      return msg
    }
    if (result.cancelled) {
      return `Authentication cancelled for ${result.sourceSlug}.`
    }
    return `Authentication failed for ${result.sourceSlug}: ${result.error || 'Unknown error'}`
  }

  /**
   * Complete an auth request and send result back to agent
   * This updates the auth message status and sends a faked user message
   */
  async completeAuthRequest(
    sessionId: string,
    result: AuthResult,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(
        `Cannot complete auth request - session ${sessionId} not found`,
      )
      return
    }

    // Find and update the pending auth-request message
    const authMessage = managed.messages.find(
      (m) =>
        m.role === 'auth-request' &&
        m.authRequestId === result.requestId &&
        m.authStatus === 'pending',
    )

    if (authMessage) {
      authMessage.authStatus = result.success
        ? 'completed'
        : result.cancelled
          ? 'cancelled'
          : 'failed'
      authMessage.authError = result.error
      authMessage.authEmail = result.email
      authMessage.authWorkspace = result.workspace
    }

    // Emit auth_completed event to update UI
    this.sendEvent(
      {
        type: 'auth_completed',
        sessionId,
        requestId: result.requestId,
        success: result.success,
        cancelled: result.cancelled,
        error: result.error,
      },
      managed.workspace.id,
    )

    // Create faked user message with result
    const resultContent = this.formatAuthResultMessage(result)

    // Clear pending auth state
    managed.pendingAuthRequestId = undefined
    managed.pendingAuthRequest = undefined

    // Auto-enable the source in the session after successful auth
    if (result.success && result.sourceSlug) {
      const slugSet = new Set(managed.enabledSourceSlugs || [])
      if (!slugSet.has(result.sourceSlug)) {
        slugSet.add(result.sourceSlug)
        managed.enabledSourceSlugs = Array.from(slugSet)
        sessionLog.info(
          `Auto-enabled source ${result.sourceSlug} in session ${sessionId} after auth`,
        )
      }

      // Clear any refresh cooldown so the source is immediately usable
      managed.tokenRefreshManager.clearCooldown(result.sourceSlug)
    }

    // Persist session with updated auth message and enabled sources
    this.persistSession(managed)

    // Update bridge-mcp-server config/credentials for backends that need it
    if (result.success && result.sourceSlug && managed.agent) {
      const workspaceRootPath = managed.workspace.rootPath
      const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
      const enabledSlugs = managed.enabledSourceSlugs || []
      const allSources = loadAllSources(workspaceRootPath)
      const enabledSources = allSources.filter(
        (s) => enabledSlugs.includes(s.config.slug) && isSourceUsable(s),
      )
      const { mcpServers } = await buildServersFromSources(
        enabledSources,
        sessionPath,
        managed.tokenRefreshManager,
      )
      await applyBridgeUpdates(
        managed.agent,
        sessionPath,
        enabledSources,
        mcpServers,
        managed.id,
        workspaceRootPath,
        'source auth',
        managed.poolServer?.url,
      )
    }

    // Send the result as a new message to resume conversation
    // Use empty arrays for attachments since this is a system-generated message
    await this.sendMessage(sessionId, resultContent, [], [], {})

    sessionLog.info(
      `Auth request completed for ${result.sourceSlug}: ${result.success ? 'success' : 'failed'}`,
    )
  }

  /**
   * Handle credential input from the UI (for non-OAuth auth)
   * Called when user submits credentials via the inline form
   */
  async handleCredentialInput(
    sessionId: string,
    requestId: string,
    response: import('@craft-agent/shared/protocol').CredentialResponse,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.pendingAuthRequest) {
      sessionLog.warn(
        `Cannot handle credential input - no pending auth request for session ${sessionId}`,
      )
      return
    }

    const request = managed.pendingAuthRequest as CredentialAuthRequest
    if (request.requestId !== requestId) {
      sessionLog.warn(
        `Credential request ID mismatch: expected ${request.requestId}, got ${requestId}`,
      )
      return
    }

    if (response.cancelled) {
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        cancelled: true,
      })
      return
    }

    try {
      // Store credentials using existing workspace ID extraction pattern
      const credManager = getCredentialManager()
      // Extract workspace ID from root path (last segment of path)
      const wsId = basename(managed.workspace.rootPath) || managed.workspace.id

      if (request.mode === 'basic') {
        // Store value as JSON string {username, password} - credential-manager.ts parses it for basic auth
        await credManager.set(
          {
            type: 'source_basic',
            workspaceId: wsId,
            sourceId: request.sourceSlug,
          },
          {
            value: JSON.stringify({
              username: response.username,
              password: response.password,
            }),
          },
        )
      } else if (request.mode === 'bearer') {
        await credManager.set(
          {
            type: 'source_bearer',
            workspaceId: wsId,
            sourceId: request.sourceSlug,
          },
          { value: response.value! },
        )
      } else if (request.mode === 'multi-header') {
        // Store multi-header credentials as JSON { "DD-API-KEY": "...", "DD-APPLICATION-KEY": "..." }
        await credManager.set(
          {
            type: 'source_apikey',
            workspaceId: wsId,
            sourceId: request.sourceSlug,
          },
          { value: JSON.stringify(response.headers) },
        )
      } else {
        // header or query - both use API key storage
        await credManager.set(
          {
            type: 'source_apikey',
            workspaceId: wsId,
            sourceId: request.sourceSlug,
          },
          { value: response.value! },
        )
      }

      // Update source config to mark as authenticated
      const { markSourceAuthenticated } = await import(
        '@craft-agent/shared/sources'
      )
      markSourceAuthenticated(managed.workspace.rootPath, request.sourceSlug)

      // Mark source as unseen so fresh guide is injected on next message
      if (managed.agent) {
        managed.agent.markSourceUnseen(request.sourceSlug)
      }

      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: true,
      })
    } catch (error) {
      sessionLog.error(
        `Failed to save credentials for ${request.sourceSlug}:`,
        error,
      )
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to save credentials',
      })
    }
  }

  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }

  getWorkspacesInfo(): WorkspaceInfo[] {
    return getWorkspaces().map(
      ({ rootPath: _rootPath, createdAt: _createdAt, ...info }) => info,
    )
  }

  getActiveSessionCount(workspaceId?: string): number {
    let count = 0
    for (const managed of this.sessions.values()) {
      if (workspaceId && managed.workspace.id !== workspaceId) continue
      if (managed.isProcessing) count++
    }
    return count
  }

  getWorkspaceAutomationSummary(workspaceId: string): {
    automationCount: number
    schedulerRunning: boolean
  } {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { automationCount: 0, schedulerRunning: false }

    const automationSystem = this.automationSystems.get(workspace.rootPath)
    if (!automationSystem)
      return { automationCount: 0, schedulerRunning: false }

    const config = automationSystem.getConfig()
    let automationCount = 0
    if (config) {
      for (const matchers of Object.values(config.automations)) {
        automationCount += matchers?.length ?? 0
      }
    }

    return {
      automationCount,
      // SchedulerService is running if the system was created with enableScheduler
      schedulerRunning: !automationSystem.isDisposed(),
    }
  }

  getActiveSessionsInfo(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = []
    for (const managed of this.sessions.values()) {
      if (!managed.isProcessing) continue

      let status: SessionProcessingStatus = 'processing'
      if (managed.stopRequested) status = 'idle'

      result.push({
        sessionId: managed.id,
        workspaceId: managed.workspace.id,
        workspaceName: managed.workspace.name,
        title: managed.name || undefined,
        status,
        triggeredBy: managed.triggeredBy
          ? {
              automationName: managed.triggeredBy.automationName ?? 'Unknown',
              timestamp: managed.triggeredBy.timestamp ?? 0,
            }
          : undefined,
        createdAt: managed.lastMessageAt,
      })
    }
    return result
  }

  /**
   * Reload all sessions from disk.
   * Used after importing sessions to refresh the in-memory session list.
   */
  reloadSessions(): void {
    this.loadSessionsFromDisk()
  }

  getSessions(workspaceId?: string): Session[] {
    // Returns session metadata only - messages are NOT included to save memory
    // Use getSession(id) to load messages for a specific session
    let sessions = Array.from(this.sessions.values())

    // Filter by workspace if specified (used when switching workspaces)
    if (workspaceId) {
      sessions = sessions.filter((m) => m.workspace.id === workspaceId)
    }

    return sessions
      .filter((m) => !this.isUnresolvedQwenCanonicalMirror(m))
      .sort(compareManagedSessionsByActivityDesc)
      .map((m) => managedToSession(m))
  }

  /**
   * Aggregate unread state across all workspaces.
   * Excludes hidden and archived sessions from counts/indicators.
   */
  getUnreadSummary(): UnreadSummary {
    const byWorkspace: Record<string, number> = {}
    const hasUnreadByWorkspace: Record<string, boolean> = {}

    for (const workspace of getWorkspaces()) {
      byWorkspace[workspace.id] = 0
      hasUnreadByWorkspace[workspace.id] = false
    }

    for (const session of this.sessions.values()) {
      if (session.hidden || session.isArchived) continue
      if (!session.hasUnread) continue

      const workspaceId = session.workspace.id
      byWorkspace[workspaceId] = (byWorkspace[workspaceId] ?? 0) + 1
      hasUnreadByWorkspace[workspaceId] = true
    }

    const totalUnreadSessions = Object.values(byWorkspace).reduce(
      (sum, count) => sum + count,
      0,
    )

    return {
      totalUnreadSessions,
      byWorkspace,
      hasUnreadByWorkspace,
    }
  }

  /**
   * Refresh badge count from current unread state.
   * Called by renderer on mount — ensures badge is set even if the initial
   * emitUnreadSummaryChanged() fired before the renderer was ready.
   */
  refreshBadge(): void {
    const summary = this.getUnreadSummary()
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions)
  }

  /**
   * Broadcast global unread summary to all workspace windows.
   */
  private emitUnreadSummaryChanged(): void {
    const summary = this.getUnreadSummary()

    // Update badge via runtime hook — host decides whether/how to render badges
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions)

    if (!this.eventSink) return

    // Broadcast to renderers for UI updates (session list dots, etc.)
    this.eventSink(
      RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED,
      { to: 'all' },
      summary,
    )
  }

  private emitSessionListChanged(workspaceId: string): void {
    if (!this.eventSink) return

    this.eventSink(
      RPC_CHANNELS.sessions.LIST_CHANGED,
      { to: 'all' },
      workspaceId,
    )
  }

  private emitSessionListRefreshStateChanged(
    workspaceId: string,
    isRefreshing: boolean,
  ): void {
    if (!this.eventSink) return

    this.eventSink(
      RPC_CHANNELS.sessions.LIST_REFRESH_STATE_CHANGED,
      { to: 'all' },
      workspaceId,
      isRefreshing,
    )
  }

  /**
   * Get a single session by ID with all messages loaded.
   * Used for lazy loading session messages when session is selected.
   * Messages are loaded from disk on first access to reduce memory usage.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const m = this.sessions.get(sessionId)
    if (!m) return null

    // Lazy-load messages from disk if not yet loaded
    await this.ensureMessagesLoaded(m)

    return managedToSession(m, { messages: m.messages })
  }

  /**
   * Ensure messages are loaded for a managed session.
   * Uses promise deduplication to prevent race conditions when multiple
   * concurrent calls (e.g., rapid session switches + message send) try
   * to load messages simultaneously.
   */
  private async ensureMessagesLoaded(managed: ManagedSession): Promise<void> {
    if (
      managed.messagesLoaded &&
      !this.shouldAttemptExternalMessageLoad(managed)
    )
      return

    // Deduplicate concurrent loads - return existing promise if already loading
    const existingPromise = this.messageLoadingPromises.get(managed.id)
    if (existingPromise) {
      return existingPromise
    }

    const loadPromise = managed.messagesLoaded
      ? this.loadExternalMessagesForEmptyLoadedSession(managed)
      : this.loadMessagesFromDisk(managed)
    this.messageLoadingPromises.set(managed.id, loadPromise)

    try {
      await loadPromise
    } finally {
      this.messageLoadingPromises.delete(managed.id)
    }
  }

  /**
   * Internal: Load messages from disk storage into the managed session.
   */
  private async loadMessagesFromDisk(managed: ManagedSession): Promise<void> {
    let loadedExternalMessages = false
    const storedSession = loadStoredSession(
      managed.workspace.rootPath,
      managed.id,
    )
    if (storedSession) {
      const storedMessages = (storedSession.messages || []).map(
        storedToMessage,
      )
      managed.tokenUsage = storedSession.tokenUsage
      managed.lastReadMessageId = storedSession.lastReadMessageId
      managed.hasUnread = storedSession.hasUnread // Explicit unread flag for NEW badge state machine
      managed.enabledSourceSlugs = storedSession.enabledSourceSlugs
      managed.sharedUrl = storedSession.sharedUrl
      managed.sharedId = storedSession.sharedId
      // Restore LLM connection state - ensures correct provider on resume
      if (storedSession.llmConnection) {
        managed.llmConnection = storedSession.llmConnection
      }
      if (storedSession.connectionLocked) {
        managed.connectionLocked = storedSession.connectionLocked
      }
      if (storedSession.sdkSessionId) {
        managed.sdkSessionId = storedSession.sdkSessionId
      }
      if (storedSession.sdkCwd) {
        managed.sdkCwd = storedSession.sdkCwd
      }
      if (storedSession.workingDirectory) {
        managed.workingDirectory = storedSession.workingDirectory
      }
      if (storedSession.model !== undefined) {
        managed.model = storedSession.model
      }
      if (storedSession.thinkingLevel) {
        managed.thinkingLevel = storedSession.thinkingLevel
      }
      // Sync name from disk - ensures title persistence across lazy loading.
      // Qwen canonical mirrors omit provider titles locally, so missing disk
      // names must not clear the in-memory provider title.
      if (
        storedSession.name !== undefined ||
        !this.isQwenCanonicalMessageSession(managed)
      ) {
        managed.name = storedSession.name
      }
      // Sync transferred session summary state from disk
      managed.transferredSessionSummary =
        storedSession.transferredSessionSummary
      managed.transferredSessionSummaryApplied =
        storedSession.transferredSessionSummaryApplied
      const usesQwenCanonicalMessages =
        this.isQwenCanonicalMessageSession(managed)
      managed.messages = usesQwenCanonicalMessages
        ? qwenCanonicalLocalVisualMessages(storedMessages)
        : storedMessages
      if (usesQwenCanonicalMessages) {
        delete managed.messageCount
      }
      sessionLog.debug(
        `Lazy-loaded ${managed.messages.length} messages for session ${managed.id}`,
      )

      // Queue recovery: find orphaned queued messages from crash/restart and re-queue them
      const orphanedQueued = usesQwenCanonicalMessages
        ? []
        : managed.messages.filter(
            (m) => m.role === 'user' && m.isQueued === true,
          )
      if (orphanedQueued.length > 0) {
        sessionLog.info(
          `Recovering ${orphanedQueued.length} queued message(s) for session ${managed.id}`,
        )
        for (const msg of orphanedQueued) {
          managed.messageQueue.push({
            message: msg.content,
            messageId: msg.id,
            attachments: undefined, // Attachments already stored on disk
            storedAttachments: msg.attachments,
            options: undefined,
          })
        }
        // Process queue when session becomes active (will be triggered by first message or interaction)
        // Use setImmediate to avoid blocking the load and allow session state to settle
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
          setImmediate(() => {
            this.processNextQueuedMessage(managed.id)
          })
        }
      }
    }
    if (this.shouldAttemptExternalMessageLoad(managed)) {
      const externalLoadResult =
        await this.loadExternalSessionMessages(managed)
      loadedExternalMessages = externalLoadResult === 'loaded'
      managed.externalMessagesLoadAttempted =
        externalLoadResult !== 'unavailable'
      if (externalLoadResult === 'loaded' || externalLoadResult === 'empty') {
        this.markExternalMessagesLoadedThrough(managed)
      }
    }
    managed.messagesLoaded = true
    if (loadedExternalMessages) {
      this.persistSession(managed)
      await this.flushSession(managed.id)
    }
  }

  private shouldAttemptExternalMessageLoad(managed: ManagedSession): boolean {
    if (this.isQwenCanonicalMessageSession(managed)) {
      if (managed.isProcessing) return false

      const externalUpdatedAt =
        managed.lastMessageAt ?? managed.lastUsedAt ?? managed.createdAt ?? 0
      const loadedThroughAt = managed.externalMessagesLoadedThroughAt ?? 0
      if (
        managed.messages.length === 0 &&
        managed.externalMessagesLoadedThroughAt == null
      )
        return true
      return externalUpdatedAt > loadedThroughAt
    }

    return (
      !!managed.sdkSessionId &&
      managed.messages.length === 0 &&
      !managed.externalMessagesLoadAttempted
    )
  }

  private async loadExternalMessagesForEmptyLoadedSession(
    managed: ManagedSession,
  ): Promise<void> {
    if (!this.shouldAttemptExternalMessageLoad(managed)) return

    const externalLoadResult = await this.loadExternalSessionMessages(managed)
    managed.externalMessagesLoadAttempted =
      externalLoadResult !== 'unavailable'
    if (externalLoadResult === 'loaded' || externalLoadResult === 'empty') {
      this.markExternalMessagesLoadedThrough(managed)
    }
    if (externalLoadResult === 'loaded') {
      this.persistSession(managed)
      await this.flushSession(managed.id)
    }
  }

  private markExternalMessagesLoadedThrough(managed: ManagedSession): void {
    managed.externalMessagesLoadedThroughAt = Math.max(
      managed.externalMessagesLoadedThroughAt ?? 0,
      managed.lastMessageAt ?? 0,
      managed.lastUsedAt ?? 0,
    )
  }

  private findMessageForContentUpdate(
    managed: ManagedSession,
    messageId: string,
  ): { message: Message; index: number } | undefined {
    const exactIndex = managed.messages.findIndex((m) => m.id === messageId)
    if (exactIndex >= 0) {
      return { message: managed.messages[exactIndex], index: exactIndex }
    }

    if (
      this.isQwenCanonicalMessageSession(managed) &&
      isQwenNativeHistoryMessageId(messageId, managed.sdkSessionId)
    ) {
      const latestUserIndex = managed.messages.findLastIndex(
        (m) => m.role === 'user',
      )
      if (latestUserIndex >= 0) {
        sessionLog.info(
          `Mapped stale Qwen history message id ${messageId} to latest user message ${managed.messages[latestUserIndex].id} in session ${managed.id}`,
        )
        return {
          message: managed.messages[latestUserIndex],
          index: latestUserIndex,
        }
      }
    }

    return undefined
  }

  private async loadExternalSessionMessages(
    managed: ManagedSession,
  ): Promise<ExternalMessageLoadResult> {
    if (!managed.sdkSessionId) return 'unavailable'

    try {
      const result = normalizeBackendSessionMessages(
        await this.withExternalSessionAgent(managed, async (agent) => {
          if (!agent.loadSessionMessages) return undefined
          return agent.loadSessionMessages(managed.sdkSessionId!, {
            cwd: this.resolveQwenCanonicalCwd(managed),
          })
        }),
      )

      if (!result) {
        sessionLog.debug(
          `Provider-native message loader unavailable for session ${managed.id} (connection=${managed.llmConnection ?? 'unset'}, sdkSessionId=${managed.sdkSessionId})`,
        )
        return 'unavailable'
      }
      this.applyAvailableCommandsFromMessagesResult(
        managed,
        result,
        'provider-native message load',
      )
      this.applyTokenUsageFromMessagesResult(managed, result)

      const messages = result.messages
      if (messages.length === 0) {
        sessionLog.debug(
          `Provider-native message loader returned 0 messages for session ${managed.id} (sdkSessionId=${managed.sdkSessionId})`,
        )
        return 'empty'
      }

      this.applyLoadedExternalMessages(managed, messages)

      sessionLog.info(
        `Loaded ${messages.length} provider-native message(s) for session ${managed.id}`,
      )
      return 'loaded'
    } catch (error) {
      sessionLog.warn(
        `Failed to load provider-native messages for session ${managed.id}:`,
        error,
      )
      return 'failed'
    }
  }

  /**
   * Get the filesystem path to a session's folder
   */
  getSessionPath(sessionId: string): string | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getSessionStoragePath(managed.workspace.rootPath, sessionId)
  }

  async createSession(
    workspaceId: string,
    options?: import('@craft-agent/shared/protocol').CreateSessionOptions,
  ): Promise<Session> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    // Permission mode is app-wide. A caller-provided mode becomes the new
    // global mode before the session is created.
    const workspaceRootPath = workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)

    if (options?.permissionMode) {
      await this.setGlobalPermissionMode(options.permissionMode)
    }
    const defaultPermissionMode = this.currentGlobalPermissionMode

    const userDefaultWorkingDir =
      wsConfig?.defaults?.workingDirectory || undefined
    // Resolve thinking level with caller-first precedence, matching permissionMode above:
    //   caller override → workspace default → global default.
    // normalizeThinkingLevel() tolerates undefined/unknown inputs.
    const defaultThinkingLevel =
      normalizeThinkingLevel(options?.thinkingLevel) ??
      normalizeThinkingLevel(wsConfig?.defaults?.thinkingLevel) ??
      getDefaultThinkingLevel()
    // Get default model from workspace config (used when no session-specific model is set)
    const defaultModel = wsConfig?.defaults?.model
    // Get default enabled sources from workspace config
    const defaultEnabledSourceSlugs =
      options?.enabledSourceSlugs ?? wsConfig?.defaults?.enabledSourceSlugs

    // Resolve model tier hints ('fast' / 'default') to actual model IDs.
    // EditPopover uses tier hints so the right Qwen model is selected.
    let resolvedModelOption = options?.model || defaultModel
    if (resolvedModelOption === 'fast' || resolvedModelOption === 'default') {
      const tierConnection = resolveSessionConnection(
        options?.llmConnection,
        wsConfig?.defaults?.defaultLlmConnection,
      )
      if (tierConnection) {
        resolvedModelOption =
          resolvedModelOption === 'fast'
            ? (getMiniModel(tierConnection) ??
              tierConnection.defaultModel ??
              defaultModel)
            : (tierConnection.defaultModel ?? defaultModel)
      } else {
        resolvedModelOption = defaultModel
      }
    }

    // Resolve backend target early for branching policy checks.
    const targetBackendContext = resolveBackendContext({
      sessionConnectionSlug: options?.llmConnection,
      workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection,
      managedModel: resolvedModelOption,
    })
    const targetProviderType =
      targetBackendContext.connection?.providerType ?? 'qwen'
    const sessionPermissionMode = defaultPermissionMode

    // Resolve working directory from options:
    // - 'user_default' or undefined: Use workspace's configured default
    // - 'none': No working directory (empty string means session folder only)
    // - Absolute path: Use as-is
    let resolvedWorkingDir: string | undefined
    if (options?.workingDirectory === 'none') {
      resolvedWorkingDir = undefined // No working directory
    } else if (
      options?.workingDirectory === 'user_default' ||
      options?.workingDirectory === undefined
    ) {
      resolvedWorkingDir = userDefaultWorkingDir
    } else {
      resolvedWorkingDir = options.workingDirectory
    }

    // Validate branch request up-front so branch metadata is only set for valid branches.
    // This prevents creating sessions that claim to be branched but don't have copied history.
    let validatedBranch:
      | {
          sourceSessionId: string
          sourceMessageId: string
          sourceSession: StoredSession
          branchIdx: number
          branchContextStrategy: 'sdk-fork' | 'seeded-fresh-session'
          branchFromSdkSessionId?: string
          branchFromSessionPath?: string
          branchFromSdkCwd?: string
          branchFromSdkTurnId?: string
        }
      | undefined

    if (options?.branchFromSessionId || options?.branchFromMessageId) {
      if (!options.branchFromSessionId || !options.branchFromMessageId) {
        sessionLog.warn(
          'Branch validation failed: missing branchFromSessionId or branchFromMessageId',
          {
            workspaceId,
            branchFromSessionId: options.branchFromSessionId,
            branchFromMessageId: options.branchFromMessageId,
          },
        )
        throw new Error(
          'Invalid branch request: both branchFromSessionId and branchFromMessageId are required',
        )
      }

      const sourceManaged = this.sessions.get(options.branchFromSessionId)
      if (sourceManaged) {
        if (sourceManaged.workspace.rootPath !== workspaceRootPath) {
          sessionLog.warn(
            'Branch validation failed: source session belongs to different workspace',
            {
              workspaceId,
              targetWorkspaceRootPath: workspaceRootPath,
              sourceWorkspaceRootPath: sourceManaged.workspace.rootPath,
              branchFromSessionId: options.branchFromSessionId,
            },
          )
          throw new Error(
            'Invalid branch request: source session belongs to a different workspace',
          )
        }

        // Flush source session to disk to ensure latest message list is available for branch copy.
        this.persistSession(sourceManaged)
        await sessionPersistenceQueue.flush(sourceManaged.id)
      }

      const sourceSession = loadStoredSession(
        workspaceRootPath,
        options.branchFromSessionId,
      )
      if (!sourceSession) {
        sessionLog.warn(
          'Branch validation failed: source session not found on disk',
          {
            workspaceId,
            branchFromSessionId: options.branchFromSessionId,
          },
        )
        throw new Error(
          `Invalid branch request: source session ${options.branchFromSessionId} not found`,
        )
      }

      const sourceBackendContext = resolveBackendContext({
        sessionConnectionSlug:
          sourceManaged?.llmConnection || sourceSession.llmConnection,
        workspaceDefaultConnectionSlug:
          wsConfig?.defaults?.defaultLlmConnection,
        managedModel: sourceManaged?.model || sourceSession.model,
      })
      const sourceProviderType =
        sourceBackendContext.connection?.providerType ?? 'qwen'

      const providerMismatch =
        sourceBackendContext.provider !== targetBackendContext.provider
      const providerTypeMismatch = sourceProviderType !== targetProviderType

      if (providerMismatch || providerTypeMismatch) {
        sessionLog.warn(
          'Branch validation failed: source and target providers are incompatible',
          {
            workspaceId,
            branchFromSessionId: options.branchFromSessionId,
            sourceProvider: sourceBackendContext.provider,
            sourceProviderType,
            targetProvider: targetBackendContext.provider,
            targetProviderType,
          },
        )
        throw new Error(
          'Branching is only supported within the same provider/backend. Switch this panel connection and try again.',
        )
      }

      const branchIdx = sourceSession.messages.findIndex(
        (m) => m.id === options.branchFromMessageId,
      )
      if (branchIdx === -1) {
        sessionLog.warn(
          'Branch validation failed: message not found in source session',
          {
            workspaceId,
            branchFromSessionId: options.branchFromSessionId,
            branchFromMessageId: options.branchFromMessageId,
          },
        )
        throw new Error(
          `Invalid branch request: message ${options.branchFromMessageId} not found in source session`,
        )
      }

      // New branches always use strict provider-level SDK fork semantics.
      // Seeded mode remains only for legacy sessions created before strict fork was enforced.
      const branchContextStrategy: 'sdk-fork' | 'seeded-fresh-session' =
        'sdk-fork'

      const branchFromSdkSessionId =
        branchContextStrategy === 'sdk-fork'
          ? sourceManaged?.sdkSessionId || sourceSession.sdkSessionId
          : undefined
      const branchFromSessionPath =
        branchContextStrategy === 'sdk-fork'
          ? getSessionStoragePath(
              workspaceRootPath,
              options.branchFromSessionId,
            )
          : undefined
      // Capture parent's sdkCwd so the child backend can find the parent's session file.
      const branchFromSdkCwd =
        branchContextStrategy === 'sdk-fork'
          ? sourceManaged?.sdkCwd || sourceSession.sdkCwd
          : undefined

      const branchMessage = sourceSession.messages[branchIdx]
      let branchFromSdkTurnId: string | undefined
      if (branchContextStrategy === 'sdk-fork') {
        branchFromSdkTurnId = branchMessage?.turnId
      }

      if (branchContextStrategy === 'sdk-fork' && !branchFromSdkSessionId) {
        sessionLog.warn(
          'Branch validation failed: sdk-fork requires parent SDK session ID',
          {
            workspaceId,
            branchFromSessionId: options.branchFromSessionId,
            sourceProvider: sourceBackendContext.provider,
            targetProvider: targetBackendContext.provider,
          },
        )
        throw new Error(
          'Cannot create branch yet: parent session SDK context is not initialized. Send one message in the parent session and try again.',
        )
      }

      validatedBranch = {
        sourceSessionId: options.branchFromSessionId,
        sourceMessageId: options.branchFromMessageId,
        sourceSession,
        branchIdx,
        branchContextStrategy,
        branchFromSdkSessionId,
        branchFromSessionPath,
        branchFromSdkCwd,
        branchFromSdkTurnId,
      }

      sessionLog.info('Branch validation succeeded', {
        workspaceId,
        branchFromSessionId: validatedBranch.sourceSessionId,
        branchFromMessageId: validatedBranch.sourceMessageId,
        branchContextStrategy: validatedBranch.branchContextStrategy,
        branchFromSdkSessionId: !!validatedBranch.branchFromSdkSessionId,
        copiedMessageCount: validatedBranch.branchIdx + 1,
      })
    }

    // Use storage layer to create and persist the session
    const storedSession = await createStoredSession(workspaceRootPath, {
      name: options?.name,
      slugHint: options?.slugHint,
      workingDirectory: resolvedWorkingDir,
      hidden: options?.hidden,
      sessionStatus: options?.sessionStatus,
      labels: options?.labels,
      isFlagged: options?.isFlagged,
    })

    // Branch: copy messages from source session up to and including the branch point
    if (validatedBranch) {
      const branchedStored = loadStoredSession(
        workspaceRootPath,
        storedSession.id,
      )
      if (!branchedStored) {
        throw new Error(
          `Failed to load newly created session ${storedSession.id} for branch copy`,
        )
      }

      const sourceMessages = validatedBranch.sourceSession.messages.slice(
        0,
        validatedBranch.branchIdx + 1,
      )

      // Re-map embedded paths: source messages were loaded with expandSessionPath(sourceDir),
      // so they contain absolute paths to the *source* session directory. When saved to the
      // branch session, makeSessionPathPortable uses the *branch* dir — which won't match.
      // Fix: replace source dir paths with branch dir paths so tokenization works on save.
      const sourceDir = normalizePath(
        getSessionStoragePath(
          workspaceRootPath,
          validatedBranch.sourceSessionId,
        ),
      )
      const branchDir = normalizePath(
        getSessionStoragePath(workspaceRootPath, storedSession.id),
      )
      if (sourceDir !== branchDir) {
        branchedStored.messages = sourceMessages.map((m) => {
          const json = JSON.stringify(m)
          if (!json.includes(sourceDir)) return m
          return JSON.parse(
            json.replaceAll(sourceDir, branchDir),
          ) as StoredMessage
        })
      } else {
        branchedStored.messages = sourceMessages
      }

      branchedStored.branchFromMessageId = validatedBranch.sourceMessageId
      if (validatedBranch.branchContextStrategy === 'sdk-fork') {
        branchedStored.branchFromSdkSessionId =
          validatedBranch.branchFromSdkSessionId
        branchedStored.branchFromSessionPath =
          validatedBranch.branchFromSessionPath
        branchedStored.branchFromSdkCwd = validatedBranch.branchFromSdkCwd
        branchedStored.branchFromSdkTurnId =
          validatedBranch.branchFromSdkTurnId
      } else {
        delete branchedStored.branchFromSdkSessionId
        delete branchedStored.branchFromSessionPath
        delete branchedStored.branchFromSdkCwd
        delete branchedStored.branchFromSdkTurnId
      }
      await saveStoredSession(branchedStored)
    }

    // Resolve connection/provider/auth/model using the provider-agnostic backend resolver.
    // Reuse precomputed target context so branch validation and session construction share the same target identity.
    const resolvedContext = targetBackendContext
    const resolvedModel = resolvedContext.resolvedModel

    // Log mini agent session creation
    if (options?.systemPromptPreset === 'mini' || options?.model) {
      sessionLog.info(
        `🤖 Creating mini agent session: model=${resolvedModel}, systemPromptPreset=${options?.systemPromptPreset}`,
      )
    }

    const isBranch = !!validatedBranch

    const managed = createManagedSession(storedSession, workspace, {
      permissionMode: sessionPermissionMode,
      workingDirectory: resolvedWorkingDir,
      model: resolvedModel || undefined,
      llmConnection: options?.llmConnection,
      thinkingLevel: defaultThinkingLevel,
      systemPromptPreset: options?.systemPromptPreset,
      enabledSourceSlugs: defaultEnabledSourceSlugs,
      branchFromMessageId: validatedBranch?.sourceMessageId,
      branchContextStrategy: validatedBranch?.branchContextStrategy,
      branchFromSdkSessionId: validatedBranch?.branchFromSdkSessionId,
      branchFromSessionPath: validatedBranch?.branchFromSessionPath,
      branchFromSdkCwd: validatedBranch?.branchFromSdkCwd,
      branchFromSdkTurnId: validatedBranch?.branchFromSdkTurnId,
      branchSeedApplied: validatedBranch
        ? validatedBranch.branchContextStrategy === 'sdk-fork'
        : undefined,
      messagesLoaded: !isBranch, // Branched sessions: lazy-load messages from JSONL
    })

    // Eagerly load messages for branched sessions so the renderer gets the full
    // conversation immediately (needed for scroll-to-bottom on panel open)
    if (isBranch) {
      await this.ensureMessagesLoaded(managed)

      const requiresBranchPreflight =
        managed.branchContextStrategy === 'sdk-fork'
      if (requiresBranchPreflight) {
        // Enforce branch correctness at creation time.
        // A branch is only valid if backend context can be established now,
        // not deferred to the first user message.
        try {
          await this.getOrCreateAgent(managed)
          await managed.agent!.ensureBranchReady()
        } catch (error) {
          sessionLog.warn(
            'Branch creation failed during backend preflight handshake',
            {
              workspaceId,
              sessionId: storedSession.id,
              branchFromSessionId: validatedBranch?.sourceSessionId,
              branchFromMessageId: validatedBranch?.sourceMessageId,
              branchContextStrategy: managed.branchContextStrategy,
              error: error instanceof Error ? error.message : String(error),
            },
          )

          await rollbackFailedBranchCreation({
            managed,
            workspaceRootPath,
            sessionId: storedSession.id,
            deleteFromRuntimeSessions: (id) => {
              this.sessions.delete(id)
            },
            deleteStoredSession,
          })

          throw new Error(
            `Could not create branch: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    // Initialize mode-manager state immediately to avoid UI/enforcement races
    // before the agent instance is lazily created.
    setPermissionMode(storedSession.id, managed.permissionMode ?? 'ask', {
      changedBy: 'restore',
    })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(
        storedSession.id,
        managed.previousPermissionMode,
      )
    }

    this.sessions.set(storedSession.id, managed)

    // Initialize session metadata in AutomationSystem for diffing
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(storedSession.id, {
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        sessionStatus: storedSession.sessionStatus,
        sessionName: managed.name,
      })
    }

    return managedToSession(
      managed,
      isBranch ? { messages: managed.messages } : undefined,
    )
  }

  /**
   * Get or create agent for a session (lazy loading)
   * Creates the appropriate backend agent based on LLM connection.
   *
   * Provider resolution order:
   * 1. session.llmConnection (locked after first message)
   * 2. workspace.defaults.defaultLlmConnection
   * 3. global defaultLlmConnection
   * 4. fallback: no connection configured
   */
  private async getOrCreateAgent(
    managed: ManagedSession,
  ): Promise<AgentInstance> {
    if (managed.agent) return managed.agent

    if (managed.agentCreatePromise) {
      sessionLog.debug(
        `Waiting for in-flight agent creation for session ${managed.id}`,
      )
      return managed.agentCreatePromise
    }

    managed.agentCreatePromise = this.createAgentForManagedSession(managed)
    try {
      return await managed.agentCreatePromise
    } finally {
      managed.agentCreatePromise = undefined
    }
  }

  private async createAgentForManagedSession(
    managed: ManagedSession,
  ): Promise<AgentInstance> {
    if (!managed.agent) {
      const end = perf.start('agent.create', { sessionId: managed.id })

      const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
      const backendContext = resolveBackendContext({
        sessionConnectionSlug: managed.llmConnection,
        workspaceDefaultConnectionSlug:
          workspaceConfig?.defaults?.defaultLlmConnection,
        managedModel: managed.model,
      })
      const connection = backendContext.connection

      // Lock the connection after first resolution
      // This ensures the session always uses the same provider
      if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection.slug
        managed.connectionLocked = true
        sessionLog.info(
          `Locked session ${managed.id} to connection "${connection.slug}"`,
        )
        this.persistSession(managed)

        // Keep renderer session capabilities in sync when auto-locking the connection.
        this.sendEvent(
          {
            type: 'connection_changed',
            sessionId: managed.id,
            connectionSlug: connection.slug,
            supportsBranching: resolveSupportsBranching(managed),
          },
          managed.workspace.id,
        )
      }

      const provider = backendContext.provider
      if (connection) {
        sessionLog.info(
          `Using LLM connection "${connection.slug}" (${connection.providerType}) for session ${managed.id}`,
        )
      } else {
        sessionLog.warn(
          `No LLM connection found for session ${managed.id}, using Qwen Code fallback`,
        )
      }

      // Set session directory for tool metadata cross-process sharing.
      // The SDK subprocess reads CRAFT_SESSION_DIR to write tool-metadata.json
      // the main process reads it via toolMetadataStore.setSessionDir().
      const sessionDirForMetadata = getSessionStoragePath(
        managed.workspace.rootPath,
        managed.id,
      )
      process.env.CRAFT_SESSION_DIR = sessionDirForMetadata
      toolMetadataStore.setSessionDir(sessionDirForMetadata)

      // Set up agentReady promise so title generation can await agent creation
      managed.agentReady = new Promise<void>((r) => {
        managed.agentReadyResolve = r
      })

      // ============================================================
      // Common setup: sources, MCP pool, session config
      // ============================================================

      const sessionPath = getSessionStoragePath(
        managed.workspace.rootPath,
        managed.id,
      )
      const enabledSlugs = managed.enabledSourceSlugs || []
      const allSources = loadAllSources(managed.workspace.rootPath)
      const enabledSources = allSources.filter(
        (s) => enabledSlugs.includes(s.config.slug) && isSourceUsable(s),
      )

      // Build server configs for enabled sources
      const { mcpServers, apiServers } = await buildServersFromSources(
        enabledSources,
        sessionPath,
        managed.tokenRefreshManager,
      )

      // Create centralized MCP client pool (all backends use it)
      managed.mcpPool = new McpClientPool({
        debug: (msg) => sessionLog.debug(msg),
        workspaceRootPath: managed.workspace.rootPath,
        sessionPath,
      })

      // Backends that run as external subprocesses need an HTTP pool server
      let poolServerUrl: string | undefined
      if (backendContext.capabilities.needsHttpPoolServer) {
        managed.poolServer = new McpPoolServer(managed.mcpPool, {
          debug: (msg) => sessionLog.debug(msg),
        })
        managed.mcpPool.onToolsChanged = () =>
          managed.poolServer?.notifyToolsChanged()
        poolServerUrl = await managed.poolServer.start()
        await managed.mcpPool.sync(mcpServers) // Ensure pool has tools before SDK connects
      }

      // Per-session env overrides
      const miniModel = connection
        ? (getMiniModel(connection) ?? connection.defaultModel)
        : undefined
      const envOverrides: Record<string, string> = {
        CRAFT_WORKSPACE_PATH: managed.workspace.rootPath,
      }
      managed.envOverrides = envOverrides

      // ============================================================
      // Common session + callback config (identical for all backends)
      // ============================================================

      const sessionConfig = {
        id: managed.id,
        workspaceRootPath: managed.workspace.rootPath,
        sdkSessionId: managed.sdkSessionId,
        branchFromSdkSessionId:
          managed.branchContextStrategy === 'sdk-fork'
            ? managed.branchFromSdkSessionId
            : undefined,
        branchFromSessionPath:
          managed.branchContextStrategy === 'sdk-fork'
            ? managed.branchFromSessionPath
            : undefined,
        branchFromSdkCwd:
          managed.branchContextStrategy === 'sdk-fork'
            ? managed.branchFromSdkCwd
            : undefined,
        branchFromSdkTurnId:
          managed.branchContextStrategy === 'sdk-fork'
            ? managed.branchFromSdkTurnId
            : undefined,
        branchFromMessageId: managed.branchFromMessageId,
        createdAt: managed.lastMessageAt,
        lastUsedAt: managed.lastMessageAt,
        workingDirectory: managed.workingDirectory,
        sdkCwd: managed.sdkCwd,
        model: managed.model,
        llmConnection: managed.llmConnection,
        permissionMode: managed.permissionMode,
        previousPermissionMode: managed.previousPermissionMode,
      }

      const onSdkSessionIdUpdate = (sdkSessionId: string) => {
        managed.sdkSessionId = sdkSessionId
        // Retire branch-only fork metadata now that child session is established
        if (managed.branchFromSdkSessionId) {
          sessionLog.info(
            `Branch fork established for ${managed.id}: child=${sdkSessionId}, retiring parent fork metadata (parent=${managed.branchFromSdkSessionId})`,
          )
          managed.branchFromSdkSessionId = undefined
          managed.branchFromSdkCwd = undefined
          managed.branchFromSdkTurnId = undefined
        } else {
          sessionLog.info(
            `SDK session ID captured for ${managed.id}: ${sdkSessionId}`,
          )
        }
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
        // Provider-native mirrors already get their title from Qwen; only push
        // Craft-owned session names back into Qwen when a child SDK id appears.
        if (managed.name && managed.id !== sdkSessionId) {
          void this.syncExternalBackendTitleIfSupported(managed, managed.name)
        }
      }

      const onSdkSessionIdCleared = () => {
        managed.sdkSessionId = undefined
        sessionLog.info(
          `SDK session ID cleared for ${managed.id} (resume recovery)`,
        )
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const getRecoveryMessages = () => {
        const relevantMessages = managed.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .filter((m) => !m.isIntermediate)
          .slice(-6)
        return relevantMessages.map((m) => ({
          type: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      }

      const getBranchFallbackMessages = () => {
        if (!managed.branchFromMessageId) return []
        return managed.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .filter((m) => !m.isIntermediate)
          .map((m) => ({
            type: m.role as 'user' | 'assistant',
            content: m.content,
          }))
      }

      const getBranchSeedMessages = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return []
        if (managed.branchSeedApplied) return []

        const seedMessages = managed.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .filter((m) => !m.isIntermediate)

        return seedMessages.map((m) => ({
          type: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      }

      const markBranchSeedApplied = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return
        if (managed.branchSeedApplied) return
        managed.branchSeedApplied = true
        sessionLog.info('Branch seed context applied', {
          sessionId: managed.id,
          strategy: managed.branchContextStrategy,
        })
      }

      const getTransferredSessionSummary = () => {
        const summary = managed.transferredSessionSummaryApplied
          ? null
          : (managed.transferredSessionSummary ?? null)
        sessionLog.info(
          `[transfer-context] getTransferredSessionSummary for ${managed.id}: applied=${managed.transferredSessionSummaryApplied}, has_summary=${!!managed.transferredSessionSummary}, returning=${summary ? `${summary.length} chars` : 'null'}`,
        )
        return summary
      }

      const markTransferredSessionSummaryApplied = () => {
        if (
          managed.transferredSessionSummaryApplied ||
          !managed.transferredSessionSummary
        )
          return
        managed.transferredSessionSummaryApplied = true
        this.persistSession(managed)
        sessionLog.info('Transferred session summary applied', {
          sessionId: managed.id,
        })
      }

      const onMidTurnMessagesDrained = (messages: string[]) => {
        const drainedEntries: Array<{
          messageId?: string
          optimisticMessageId?: string
        }> = []
        for (const message of messages) {
          const index = managed.messageQueue.findIndex(
            (entry) => entry.midTurnPending && entry.message === message,
          )
          if (index >= 0) {
            const [entry] = managed.messageQueue.splice(index, 1)
            drainedEntries.push({
              messageId: entry.messageId,
              optimisticMessageId: entry.optimisticMessageId,
            })
          }
        }
        if (drainedEntries.length > 0) {
          sessionLog.info(
            `Acknowledged ${drainedEntries.length} mid-turn queued message(s) for session ${managed.id}`,
          )
          for (const entry of drainedEntries) {
            if (!entry.messageId) continue
            const existingMessage = managed.messages.find(
              (m) => m.id === entry.messageId,
            )
            if (!existingMessage) continue
            existingMessage.isQueued = false
            this.sendEvent(
              {
                type: 'user_message',
                sessionId: managed.id,
                message: existingMessage,
                status: 'accepted',
                optimisticMessageId: entry.optimisticMessageId,
              },
              managed.workspace.id,
            )
          }
          this.persistSession(managed)
        }
      }

      // ============================================================
      // Construct backend via factory
      // ============================================================

      managed.agent = createBackendFromResolvedContext({
        context: backendContext,
        hostRuntime: buildBackendHostRuntimeContext(),
        coreConfig: {
          workspace: managed.workspace,
          miniModel,
          thinkingLevel: managed.thinkingLevel,
          session: sessionConfig,
          onSdkSessionIdUpdate,
          onSdkSessionIdCleared,
          onMidTurnMessagesDrained,
          onAvailableModelsUpdate:
            connection?.providerType === 'qwen'
              ? (models, currentModelId) =>
                  this.updateQwenConnectionModels(
                    connection.slug,
                    models,
                    currentModelId,
                  )
              : undefined,
          getRecoveryMessages,
          getBranchFallbackMessages,
          getBranchSeedMessages,
          markBranchSeedApplied,
          getTransferredSessionSummary,
          markTransferredSessionSummaryApplied,
          mcpPool: managed.mcpPool,
          poolServerUrl,
          envOverrides,
          isHeadless: !AGENT_FLAGS.defaultModesEnabled,
          skipConfigWatcher: true, // Server owns workspace-level ConfigWatcher — don't duplicate in agents
          automationSystem: this.automationSystems.get(
            managed.workspace.rootPath,
          ),
          systemPromptPreset: managed.systemPromptPreset,
          debugMode: _platform?.isDebugMode
            ? { enabled: true, logFilePath: _platform.getLogFilePath?.() }
            : undefined,
          enable1MContext: await (async () => {
            const { getEnable1MContext } = await import(
              '@craft-agent/shared/config/storage'
            )
            return getEnable1MContext()
          })(),
          // Image resize callback — prevents oversized images from entering conversation history
          onImageResize: async (
            filePath: string,
            maxSizeBytes: number,
          ): Promise<string | null> => {
            try {
              const buffer = await readFile(filePath)
              const result = await resizeImageForAPI(buffer, { maxSizeBytes })
              if (!result) return null

              // Write to session tmp directory (cleaned up with session)
              const sessionTmpDir = join(sessionPath, 'tmp')
              await mkdir(sessionTmpDir, { recursive: true })
              const ext = result.format === 'jpeg' ? 'jpg' : 'png'
              const outPath = join(
                sessionTmpDir,
                `resized-${randomUUID()}.${ext}`,
              )
              await writeFile(outPath, result.buffer)

              sessionLog.info(
                `Image resized for Read: ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${(result.buffer.length / 1024 / 1024).toFixed(1)}MB (→ ${result.width}×${result.height})`,
              )
              return outPath
            } catch (err) {
              sessionLog.error('Image resize failed:', err)
              return null
            }
          },
          // Source configs for postInit() — backends set up their own bridge/config
          initialSources: {
            enabledSources,
            mcpServers,
            apiServers,
            enabledSlugs,
          },
        },
      }) as AgentInstance

      sessionLog.info(
        `Created ${provider} agent for session ${managed.id} (model: ${backendContext.resolvedModel})${managed.sdkSessionId ? ' (resuming)' : ''}`,
      )

      // ============================================================
      // Post-construction: debug callback, auth callback, postInit()
      // ============================================================

      managed.agent.onDebug = (msg: string) => {
        const marker = '__PERMISSION_BLOCK__'
        if (msg.includes(marker)) {
          const idx = msg.indexOf(marker)
          const payloadRaw = msg.slice(idx + marker.length)
          try {
            const payload = JSON.parse(payloadRaw) as {
              sessionId: string
              toolName: string
              effectiveMode: string
              modeVersion: number
              changedBy: string
              changedAt: string
              reason: string
            }
            sessionLog.info('Tool blocked by permission mode', payload)
            return
          } catch {
            // fall through to plain logging when payload parsing fails
          }
        }

        sessionLog.info(msg)
      }

      // Unified auth callback for backend-managed authentication.
      managed.agent.onBackendAuthRequired = (reason: string) => {
        sessionLog.warn(
          `Backend auth required for session ${managed.id}: ${reason}`,
        )
        this.sendEvent(
          {
            type: 'info',
            sessionId: managed.id,
            message: `Authentication required: ${reason}`,
            level: 'error',
          },
          managed.workspace.id,
        )
      }

      // Run post-init (auth injection) — each backend handles its own
      const postInitResult = await managed.agent.postInit()
      if (postInitResult.authWarning) {
        sessionLog.warn(
          `Auth warning for session ${managed.id}: ${postInitResult.authWarning}`,
        )
        this.sendEvent(
          {
            type: 'info',
            sessionId: managed.id,
            message: postInitResult.authWarning,
            level: postInitResult.authWarningLevel || 'error',
          },
          managed.workspace.id,
        )
      }

      // Wire up large response handling in the MCP pool (all backends)
      if (managed.mcpPool && managed.agent) {
        managed.mcpPool.setSummarizeCallback(
          managed.agent.getSummarizeCallback(),
        )
      }

      // Wire up browser pane tools — merge BrowserPaneFns into session callbacks
      // so browser_* tools can delegate to BrowserPaneManager
      if (this.browserPaneManager) {
        const bpm = this.browserPaneManager
        const sid = managed.id

        const resolveSessionBrowserInstance = (
          toolName: string,
          options?: { show?: boolean },
        ): string => {
          const instanceId = bpm.createForSession(sid, {
            show: options?.show ?? false,
          })
          const info = bpm.getInstance(instanceId)
          sessionLog.info(
            `[browser-pane] tool target resolved: ${toolName} session=${sid} instance=${instanceId} ownerType=${info?.ownerType ?? 'unknown'} ownerSessionId=${info?.ownerSessionId ?? 'none'} visible=${info?.isVisible ?? false}`,
          )
          return instanceId
        }

        const resolveLifecycleWindowTarget = (
          command: 'release' | 'close' | 'hide',
          requestedInstanceId?: string,
        ) => {
          const windows = bpm.listInstances()

          if (windows.length === 0) {
            return {
              windows,
              reason: 'No browser windows are available. Use "open" first.',
            }
          }

          const validateTarget = (
            target: (typeof windows)[number] | undefined,
          ) => {
            if (!target) {
              return {
                ok: false as const,
                reason: `Browser window "${requestedInstanceId}" not found. Use "windows" to list available windows.`,
              }
            }

            if (target.boundSessionId && target.boundSessionId !== sid) {
              return {
                ok: false as const,
                reason: `Browser window "${target.id}" is locked to session ${target.boundSessionId}.`,
              }
            }

            if (
              !target.boundSessionId &&
              target.ownerSessionId &&
              target.ownerSessionId !== sid
            ) {
              return {
                ok: false as const,
                reason: `Browser window "${target.id}" is currently owned by session ${target.ownerSessionId}.`,
              }
            }

            return { ok: true as const, target }
          }

          if (requestedInstanceId) {
            const validated = validateTarget(
              windows.find((w) => w.id === requestedInstanceId),
            )
            if (!validated.ok) {
              return { windows, reason: validated.reason }
            }
            return { windows, target: validated.target }
          }

          const fallbackTarget =
            windows.find((w) => w.boundSessionId === sid) ??
            windows.find((w) => w.ownerSessionId === sid)

          if (!fallbackTarget) {
            return {
              windows,
              reason: `No ${command} target is currently associated with this session. Use "windows", then "${command} <id>".`,
            }
          }

          const validated = validateTarget(fallbackTarget)
          if (!validated.ok) {
            return { windows, reason: validated.reason }
          }

          return { windows, target: validated.target }
        }

        mergeSessionScopedToolCallbacks(sid, {
          browserPaneFns: {
            openPanel: async (options) => {
              const instanceId = options?.background
                ? bpm.createForSession(sid, { show: false })
                : bpm.focusBoundForSession(sid)
              const info = bpm.getInstance(instanceId)
              sessionLog.info(
                `[browser-pane] route decision: browser_open session=${sid} instance=${instanceId} background=${options?.background ?? false} ownerType=${info?.ownerType ?? 'unknown'} ownerSessionId=${info?.ownerSessionId ?? 'none'} visible=${info?.isVisible ?? false}`,
              )
              return { instanceId }
            },
            navigate: (url) => {
              const instanceId =
                resolveSessionBrowserInstance('browser_navigate')
              return bpm.navigate(instanceId, url)
            },
            snapshot: () => {
              const instanceId =
                resolveSessionBrowserInstance('browser_snapshot')
              return bpm.getAccessibilitySnapshot(instanceId)
            },
            click: (ref, options) => {
              const instanceId = resolveSessionBrowserInstance('browser_click')
              return bpm.clickElement(instanceId, ref, options)
            },
            clickAt: (x, y) => {
              const instanceId =
                resolveSessionBrowserInstance('browser_click_at')
              return bpm.clickAtCoordinates(instanceId, x, y)
            },
            drag: (x1, y1, x2, y2) => {
              const instanceId = resolveSessionBrowserInstance('browser_drag')
              return bpm.drag(instanceId, x1, y1, x2, y2)
            },
            fill: (ref, value) => {
              const instanceId = resolveSessionBrowserInstance('browser_fill')
              return bpm.fillElement(instanceId, ref, value)
            },
            type: (text) => {
              const instanceId = resolveSessionBrowserInstance('browser_type')
              return bpm.typeText(instanceId, text)
            },
            select: (ref, value) => {
              const instanceId =
                resolveSessionBrowserInstance('browser_select')
              return bpm.selectOption(instanceId, ref, value)
            },
            setClipboard: (text) => {
              const instanceId = resolveSessionBrowserInstance(
                'browser_set_clipboard',
              )
              return bpm.setClipboard(instanceId, text)
            },
            getClipboard: () => {
              const instanceId = resolveSessionBrowserInstance(
                'browser_get_clipboard',
              )
              return bpm.getClipboard(instanceId)
            },
            screenshot: (options) => {
              const instanceId =
                resolveSessionBrowserInstance('browser_screenshot')
              return bpm.screenshot(instanceId, options)
            },
            screenshotRegion: (options) => {
              const instanceId = resolveSessionBrowserInstance(
                'browser_screenshot_region',
              )
              return bpm.screenshotRegion(instanceId, options)
            },
            getConsoleLogs: (options) => {
              const instanceId =
                resolveSessionBrowserInstance('browser_console')
              return Promise.resolve(bpm.getConsoleLogs(instanceId, options))
            },
            windowResize: (options) => {
              const instanceId = resolveSessionBrowserInstance(
                'browser_window_resize',
              )
              return Promise.resolve(
                bpm.windowResize(instanceId, options.width, options.height),
              )
            },
            getNetworkLogs: (options) => {
              const instanceId =
                resolveSessionBrowserInstance('browser_network')
              return Promise.resolve(bpm.getNetworkLogs(instanceId, options))
            },
            waitFor: (options) => {
              const instanceId = resolveSessionBrowserInstance('browser_wait')
              return bpm.waitFor(instanceId, options)
            },
            sendKey: (options) => {
              const instanceId = resolveSessionBrowserInstance('browser_key')
              return bpm.sendKey(instanceId, options)
            },
            getDownloads: (options) => {
              const instanceId =
                resolveSessionBrowserInstance('browser_downloads')
              return bpm.getDownloads(instanceId, options)
            },
            upload: (ref, filePaths) => {
              const instanceId =
                resolveSessionBrowserInstance('browser_upload')
              return bpm.uploadFile(instanceId, ref, filePaths).then(() => {})
            },
            scroll: (direction, amount) => {
              const instanceId =
                resolveSessionBrowserInstance('browser_scroll')
              return bpm.scroll(instanceId, direction, amount)
            },
            goBack: () => {
              const instanceId = resolveSessionBrowserInstance('browser_back')
              return bpm.goBack(instanceId)
            },
            goForward: () => {
              const instanceId =
                resolveSessionBrowserInstance('browser_forward')
              return bpm.goForward(instanceId)
            },
            evaluate: (expression) => {
              const instanceId =
                resolveSessionBrowserInstance('browser_evaluate')
              return bpm.evaluate(instanceId, expression)
            },
            focusWindow: async (targetInstanceId) => {
              const windows = bpm.listInstances()
              if (windows.length === 0) {
                throw new Error(
                  'No browser windows available to focus. Use "open" first.',
                )
              }

              const target = targetInstanceId
                ? windows.find((w) => w.id === targetInstanceId)
                : windows.find(
                    (w) => w.boundSessionId === sid || w.ownerSessionId === sid,
                  )

              if (!target) {
                if (targetInstanceId) {
                  throw new Error(
                    `Browser window "${targetInstanceId}" not found. Use "windows" to list available windows.`,
                  )
                }
                throw new Error(
                  'No browser window is currently bound to this session. Use "open --foreground" to create or reuse one.',
                )
              }

              const availableToSession =
                !target.boundSessionId || target.boundSessionId === sid
              if (!availableToSession) {
                throw new Error(
                  `Browser window "${target.id}" is locked to session ${target.boundSessionId}.`,
                )
              }

              if (!target.boundSessionId) {
                bpm.bindSession(target.id, sid)
              }

              bpm.focus(target.id)
              const focused = bpm.getInstance(target.id)
              return {
                instanceId: target.id,
                title: focused?.title ?? target.title,
                url: focused?.currentUrl ?? target.url,
              }
            },
            releaseControl: async (requestedInstanceId) => {
              if (requestedInstanceId === 'all') {
                const before = bpm.listInstances()
                const beforeActive = before.filter(
                  (w) => !!w.agentControlActive,
                ).length
                bpm.clearAgentControl(sid)
                const after = bpm.listInstances()
                const afterActive = after.filter(
                  (w) => !!w.agentControlActive,
                ).length
                const released = afterActive < beforeActive

                sessionLog.info(
                  `[browser-pane] lifecycle release-all session=${sid} overlays=${beforeActive}->${afterActive}`,
                )

                return {
                  action: released ? 'released' : 'noop',
                  requestedInstanceId,
                  affectedIds: released
                    ? before
                        .filter((w) => !!w.agentControlActive)
                        .map((w) => w.id)
                    : [],
                  reason: released
                    ? undefined
                    : 'No active overlay was found for this session.',
                }
              }

              const resolution = resolveLifecycleWindowTarget(
                'release',
                requestedInstanceId,
              )
              if (!resolution.target) {
                sessionLog.info(
                  `[browser-pane] lifecycle release session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`,
                )
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              const result = bpm.clearAgentControlForInstance(
                resolution.target.id,
                sid,
              )
              const action = result.released ? 'released' : 'noop'
              sessionLog.info(
                `[browser-pane] lifecycle release session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=${action} reason=${result.reason ?? 'none'}`,
              )

              return {
                action,
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: result.released ? [resolution.target.id] : [],
                reason: result.reason,
              }
            },
            closeWindow: async (requestedInstanceId) => {
              const resolution = resolveLifecycleWindowTarget(
                'close',
                requestedInstanceId,
              )
              if (!resolution.target) {
                sessionLog.info(
                  `[browser-pane] lifecycle close session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`,
                )
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              bpm.destroyInstance(resolution.target.id)
              sessionLog.info(
                `[browser-pane] lifecycle close session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=closed`,
              )

              return {
                action: 'closed',
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: [resolution.target.id],
              }
            },
            hideWindow: async (requestedInstanceId) => {
              const resolution = resolveLifecycleWindowTarget(
                'hide',
                requestedInstanceId,
              )
              if (!resolution.target) {
                sessionLog.info(
                  `[browser-pane] lifecycle hide session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`,
                )
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              bpm.hide(resolution.target.id)
              sessionLog.info(
                `[browser-pane] lifecycle hide session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=hidden`,
              )

              return {
                action: 'hidden',
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: [resolution.target.id],
              }
            },
            listWindows: async () => bpm.listInstances(),
            detectChallenge: async () => {
              const instanceId = resolveSessionBrowserInstance(
                'browser_detect_challenge',
              )
              return bpm.detectSecurityChallenge(instanceId)
            },
          } satisfies BrowserPaneFns,
        })
      }

      // Signal that the agent instance is ready (unblocks title generation)
      managed.agentReadyResolve?.()

      // Set up permission handler to forward requests to renderer
      managed.agent.onPermissionRequest = (request: {
        requestId: string
        toolName: string
        command?: string
        description: string
        type?:
          | 'bash'
          | 'file_write'
          | 'mcp_mutation'
          | 'api_mutation'
          | 'admin_approval'
          | 'ask_user_question'
        appName?: string
        reason?: string
        impact?: string
        requiresSystemPrompt?: boolean
        rememberForMinutes?: number
        commandHash?: string
        approvalTtlSeconds?: number
        questions?: Array<
          import('@craft-agent/core/types').AskUserQuestionItem
        >
        metadata?: {
          source?: string
        }
      }) => {
        sessionLog.info(
          `Permission request for session ${managed.id}:`,
          request.command,
        )
        let brokerMetadata: {
          commandHash?: string
          approvalTtlSeconds?: number
        } = {}

        if (request.type === 'admin_approval' && request.command) {
          const brokerRequest = this.privilegedExecutionBroker.createRequest({
            requestId: request.requestId,
            sessionId: managed.id,
            command: request.command,
            reason: request.reason,
            impact: request.impact,
            approvalTtlSeconds: request.approvalTtlSeconds,
          })

          brokerMetadata = {
            commandHash: brokerRequest.commandHash,
            approvalTtlSeconds: brokerRequest.approvalTtlSeconds,
          }
        }

        const effectiveCommandHash =
          brokerMetadata.commandHash ?? request.commandHash

        this.pendingPermissionRequests.set(request.requestId, {
          sessionId: managed.id,
          type: request.type,
          commandHash: effectiveCommandHash,
        })

        if (
          request.type === 'admin_approval' &&
          effectiveCommandHash &&
          this.hasActiveAdminRememberApproval(managed.id, effectiveCommandHash)
        ) {
          const brokerResult = this.privilegedExecutionBroker.resolveApproval(
            request.requestId,
            true,
            {
              expectedCommandHash: effectiveCommandHash,
            },
          )

          this.pendingPermissionRequests.delete(request.requestId)

          if (brokerResult.ok) {
            this.privilegedExecutionBroker.auditEvent(
              'privileged_auto_approved_remember_window',
              {
                sessionId: managed.id,
                requestId: request.requestId,
                commandHash: effectiveCommandHash,
              },
            )
            const liveAgent = managed.agent
            if (liveAgent) {
              liveAgent.respondToPermission(request.requestId, true, false)
              return
            }
          }

          sessionLog.warn(
            `Remember-window auto-approval skipped for ${request.requestId}: ${brokerResult.reason}`,
          )
        }

        this.sendEvent(
          {
            type: 'permission_request',
            sessionId: managed.id,
            request: {
              ...request,
              ...brokerMetadata,
              sessionId: managed.id,
            },
          },
          managed.workspace.id,
        )
      }

      // Note: Credential requests now flow through onAuthRequest (unified auth flow)
      // The legacy onCredentialRequest callback has been removed from CraftAgent
      // Auth refresh for mid-session token expiry is handled by the error handler in sendMessage
      // which destroys/recreates the agent to get fresh credentials

      // Set up mode change handlers
      managed.agent.onPermissionModeChange = (mode) => {
        if (
          managed.permissionMode === mode &&
          this.currentGlobalPermissionMode === mode
        ) {
          return
        }

        void this.setGlobalPermissionMode(mode, {
          preferredSessionId: managed.id,
        }).catch((error) => {
          sessionLog.warn('Failed to apply agent permission mode globally', {
            sessionId: managed.id,
            permissionMode: mode,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }

      // Wire up onPlanSubmitted to add plan message to conversation
      managed.agent.onPlanSubmitted = async (planPath) => {
        sessionLog.info(`Plan submitted for session ${managed.id}:`, planPath)
        try {
          // Read the plan file content
          const planContent = await readFile(planPath, 'utf-8')

          // Mark the SubmitPlan tool message as completed (it won't get a tool_result due to forceAbort)
          const submitPlanMsg = managed.messages.find(
            (m) =>
              m.toolName?.includes('SubmitPlan') &&
              m.toolStatus === 'executing',
          )
          if (submitPlanMsg) {
            submitPlanMsg.toolStatus = 'completed'
            submitPlanMsg.content = 'Plan submitted for review'
            submitPlanMsg.toolResult = 'Plan submitted for review'
          }

          // Create a plan message
          const planMessage = {
            id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'plan' as const,
            content: planContent,
            timestamp: this.monotonic(),
            planPath,
          }

          // Add to session messages
          managed.messages.push(planMessage)

          // Update lastMessageRole for badge display
          managed.lastMessageRole = 'plan'

          // Send event to renderer
          this.sendEvent(
            {
              type: 'plan_submitted',
              sessionId: managed.id,
              message: planMessage,
            },
            managed.workspace.id,
          )

          // Interrupt execution - plan presentation is a stopping point
          // The user needs to review and respond before continuing
          if (managed.isProcessing && managed.agent) {
            sessionLog.info(
              `Interrupting for plan submission in session ${managed.id}`,
            )
            managed.agent.interruptForHandoff(AbortReason.PlanSubmitted)
            this.setProcessing(managed, false)

            // Release browser overlay + session binding because the agent is no longer running.
            // Plan submission pauses execution until user review, so browser ownership should not remain locked.
            await releaseBrowserOwnershipOnForcedStop(
              this.browserPaneManager,
              managed.id,
            )

            // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
            this.sendEvent(
              {
                type: 'complete',
                sessionId: managed.id,
                tokenUsage: managed.tokenUsage,
              },
              managed.workspace.id,
            )

            // Persist session state
            this.persistSession(managed)
          }
        } catch (error) {
          sessionLog.error(`Failed to read plan file:`, error)
        }
      }

      // Wire up onAuthRequest to add auth message to conversation and pause execution
      managed.agent.onAuthRequest = (request) => {
        sessionLog.info(
          `Auth request for session ${managed.id}:`,
          request.type,
          request.sourceSlug,
        )

        // Create auth-request message
        const authMessage: Message = {
          id: generateMessageId(),
          role: 'auth-request',
          content: this.getAuthRequestDescription(request),
          timestamp: this.monotonic(),
          authRequestId: request.requestId,
          authRequestType: request.type,
          authSourceSlug: request.sourceSlug,
          authSourceName: request.sourceName,
          authStatus: 'pending',
          // Copy type-specific fields for credentials
          ...(request.type === 'credential' && {
            authCredentialMode: request.mode,
            authLabels: request.labels,
            authDescription: request.description,
            authHint: request.hint,
            authHeaderName: request.headerName,
            authHeaderNames: request.headerNames,
            authSourceUrl: request.sourceUrl,
            authPasswordRequired: request.passwordRequired,
          }),
        }

        // Add to session messages
        managed.messages.push(authMessage)

        // Store pending auth request for later resolution
        managed.pendingAuthRequestId = request.requestId
        managed.pendingAuthRequest = request

        // Interrupt execution (like SubmitPlan)
        if (managed.isProcessing && managed.agent) {
          sessionLog.info(
            `Interrupting for auth request in session ${managed.id}`,
          )
          managed.agent.interruptForHandoff(AbortReason.AuthRequest)
          this.setProcessing(managed, false)

          // Release browser overlay + session binding because the agent is paused awaiting user auth.
          void releaseBrowserOwnershipOnForcedStop(
            this.browserPaneManager,
            managed.id,
          )

          // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
          this.sendEvent(
            {
              type: 'complete',
              sessionId: managed.id,
              tokenUsage: managed.tokenUsage,
            },
            managed.workspace.id,
          )
        }

        // Emit auth_request event to renderer
        this.sendEvent(
          {
            type: 'auth_request',
            sessionId: managed.id,
            message: authMessage,
            request,
          },
          managed.workspace.id,
        )

        // Persist session state
        this.persistSession(managed)

        // OAuth flow is client-driven via performOAuth() (preload).
        // The UI calls window.electronAPI.performOAuth() when user clicks "Sign in".
      }

      // Wire up onSpawnSession to create independent sessions from agent tool calls
      managed.agent.onSpawnSession = async (request) => {
        sessionLog.info(
          `Spawn session request from session ${managed.id}:`,
          request.name || '(unnamed)',
        )

        const session = await this.createSession(managed.workspace.id, {
          name: request.name,
          slugHint: request.name ?? request.prompt,
          llmConnection: request.llmConnection ?? managed.llmConnection,
          model: request.model ?? managed.model,
          enabledSourceSlugs:
            request.enabledSourceSlugs ?? managed.enabledSourceSlugs,
          permissionMode: request.permissionMode ?? managed.permissionMode,
          thinkingLevel: request.thinkingLevel ?? managed.thinkingLevel,
          labels: request.labels ?? managed.labels,
          workingDirectory: request.workingDirectory,
        })

        // Build FileAttachment[] from paths (if any)
        let fileAttachments: FileAttachment[] | undefined
        if (request.attachments?.length) {
          const attachments: FileAttachment[] = []
          for (const a of request.attachments) {
            try {
              const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
              if (request.workingDirectory)
                extraDirs.push(request.workingDirectory)
              const safePath = await validateFilePath(a.path, extraDirs)
              const attachment = readFileAttachment(safePath)
              if (attachment) {
                if (a.name) attachment.name = a.name
                attachments.push(attachment)
              } else {
                sessionLog.warn(
                  `Spawn session: attachment not found: ${a.path}`,
                )
              }
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error)
              sessionLog.warn(
                `Spawn session: blocked attachment path ${a.path}: ${message}`,
              )
            }
          }
          if (attachments.length > 0) fileAttachments = attachments
        }

        // Notify renderer to hydrate full session metadata (including name)
        // before streaming events arrive. Without this, the renderer creates
        // a synthetic empty session and shows "New Chat" in the sidebar.
        this.sendEvent(
          { type: 'session_created', sessionId: session.id },
          managed.workspace.id,
        )

        // Fire and forget — send the message but don't await completion
        this.sendMessage(session.id, request.prompt, fileAttachments).catch(
          (err) => {
            sessionLog.error(
              `Failed to send message to spawned session ${session.id}:`,
              err,
            )
          },
        )

        return {
          sessionId: session.id,
          name: session.name || request.name || session.id,
          status: 'started' as const,
          connection: session.llmConnection,
          model: session.model,
        }
      }

      // Wire up session self-management tools (set_session_labels, set_session_status, etc.)
      mergeSessionScopedToolCallbacks(managed.id, {
        setSessionLabelsFn: (
          sessionId: string | undefined,
          labels: string[],
        ) => {
          this.setSessionLabels(sessionId ?? managed.id, labels)
        },
        setSessionStatusFn: async (
          sessionId: string | undefined,
          status: string,
        ) => {
          await this.setSessionStatus(
            sessionId ?? managed.id,
            status as SessionStatus,
          )
        },
        getSessionInfoFn: (sessionId?: string) => {
          const targetId = sessionId ?? managed.id
          const session = this.sessions.get(targetId)
          if (!session) return null
          return {
            id: session.id,
            name: session.name ?? session.id,
            labels: session.labels ?? [],
            status: session.sessionStatus ?? 'todo',
            permissionMode: session.permissionMode ?? 'ask',
            createdAt: session.createdAt ?? 0,
            workingDirectory: session.workingDirectory,
            llmConnection: session.llmConnection,
            model: session.model,
            isActive: session.agent != null,
          }
        },
        listSessionsFn: (options) => {
          const DEFAULT_LIMIT = 20
          const MAX_LIMIT = 100
          const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
          const offset = options?.offset ?? 0

          let sessions = this.getSessions(managed.workspace.id)

          // Filter
          if (options?.status) {
            sessions = sessions.filter(
              (s) => s.sessionStatus === options.status,
            )
          }
          if (options?.label) {
            sessions = sessions.filter((s) =>
              s.labels?.includes(options.label!),
            )
          }
          if (options?.search) {
            const needle = options.search.toLowerCase()
            sessions = sessions.filter((s) =>
              s.name?.toLowerCase().includes(needle),
            )
          }

          // Sort
          const sortBy = options?.sortBy ?? 'recent'
          if (sortBy === 'recent') {
            sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          } else if (sortBy === 'name') {
            sessions.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
          } else if (sortBy === 'status') {
            sessions.sort((a, b) =>
              (a.sessionStatus ?? '').localeCompare(b.sessionStatus ?? ''),
            )
          }

          const total = sessions.length

          // Paginate
          const page = sessions.slice(offset, offset + limit)

          return {
            total,
            returned: page.length,
            sessions: page.map((s) => ({
              id: s.id,
              name: s.name ?? s.id,
              labels: s.labels ?? [],
              status: s.sessionStatus ?? 'todo',
              createdAt: s.createdAt ?? 0,
            })),
          }
        },
        resolveLabelsFn: (labels: string[]) => {
          const labelConfig = loadLabelConfig(managed.workspace.rootPath)
          return resolveSessionLabels(labels, labelConfig.labels)
        },
        resolveStatusFn: (status: string) => {
          const statusConfig = loadStatusConfig(managed.workspace.rootPath)
          const allStatuses = statusConfig.statuses
          const available = allStatuses.map((s) => s.id)

          // Exact ID match
          const byId = allStatuses.find((s) => s.id === status)
          if (byId) return { resolved: byId.id, available }
          // Case-insensitive label → ID
          const byLabel = allStatuses.find(
            (s) => s.label.toLowerCase() === status.toLowerCase(),
          )
          if (byLabel) return { resolved: byLabel.id, available }

          return { resolved: null, available }
        },
        sendAgentMessageFn: async (
          sessionId: string,
          message: string,
          attachments?: Array<{ path: string; name?: string }>,
        ) => {
          // Build FileAttachment[] from paths (same pattern as spawn_session)
          let fileAttachments: FileAttachment[] | undefined
          if (attachments?.length) {
            const builtAttachments: FileAttachment[] = []
            for (const a of attachments) {
              try {
                const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
                const safePath = await validateFilePath(a.path, extraDirs)
                const attachment = readFileAttachment(safePath)
                if (attachment) {
                  if (a.name) attachment.name = a.name
                  builtAttachments.push(attachment)
                }
              } catch (error) {
                const msg =
                  error instanceof Error ? error.message : String(error)
                sessionLog.warn(
                  `send_agent_message: blocked attachment path ${a.path}: ${msg}`,
                )
              }
            }
            if (builtAttachments.length > 0) fileAttachments = builtAttachments
          }

          await this.sendMessage(sessionId, message, fileAttachments)
        },
        activateSourceInSessionFn: async (sourceSlug: string) => {
          const cb = managed.agent?.onSourceActivationRequest
          if (!cb) {
            return {
              ok: false,
              reason: 'Agent has no activation callback wired',
            }
          }
          const ok = await cb(sourceSlug)
          if (!ok) {
            return {
              ok: false,
              reason:
                'Activation failed — source may be unusable (disabled/unauthenticated) or server build failed. Check session logs.',
            }
          }
          // The current turn must end before newly activated tools are visible.
          // Mark a pending restart on the agent so it can emit source_activated
          // after the next tool_result and forceAbort. The renderer's
          // auto_retry effect then resends the original user message with a
          // "[{slug} activated]" suffix — landing in a fresh turn with tools live.
          // Same machinery as the tool-call-error auto-retry path.
          const userMessage =
            managed.agent?.getCurrentTurnUserMessage?.() ?? ''
          if (userMessage) {
            managed.agent?.setPendingSourceActivationRestart({
              sourceSlug,
              userMessage,
            })
          }
          return { ok: true, availability: 'next-turn' as const }
        },
      })

      // Wire up onSourceActivationRequest to auto-enable sources when agent tries to use them
      managed.agent.onSourceActivationRequest = async (
        sourceSlug: string,
      ): Promise<boolean> => {
        sessionLog.info(
          `Source activation request for session ${managed.id}:`,
          sourceSlug,
        )

        const workspaceRootPath = managed.workspace.rootPath

        // Check if source is already enabled
        if (managed.enabledSourceSlugs?.includes(sourceSlug)) {
          sessionLog.info(
            `Source ${sourceSlug} already in enabledSourceSlugs, checking server status`,
          )
          // Source is in the list but server might not be active (e.g., build failed previously)
        }

        // Load the source to check if it exists and is ready
        const sources = getSourcesBySlugs(workspaceRootPath, [sourceSlug])
        if (sources.length === 0) {
          sessionLog.warn(`Source ${sourceSlug} not found in workspace`)
          return false
        }

        const source = sources[0]

        // Check if source is usable (enabled and authenticated if auth is required)
        if (!isSourceUsable(source)) {
          sessionLog.warn(
            `Source ${sourceSlug} is not usable (disabled or requires authentication)`,
          )
          return false
        }

        // Track whether we added this slug (for rollback on failure)
        const slugSet = new Set(managed.enabledSourceSlugs || [])
        const wasAlreadyEnabled = slugSet.has(sourceSlug)

        // Add to enabled sources if not already there
        if (!wasAlreadyEnabled) {
          slugSet.add(sourceSlug)
          managed.enabledSourceSlugs = Array.from(slugSet)
          sessionLog.info(
            `Added source ${sourceSlug} to session enabled sources`,
          )
        }

        // Build server configs for all enabled sources
        const allEnabledSources = getSourcesBySlugs(
          workspaceRootPath,
          managed.enabledSourceSlugs || [],
        )
        // Pass session path so large API responses can be saved to session folder
        const sessionPath = getSessionStoragePath(
          workspaceRootPath,
          managed.id,
        )
        const { mcpServers, apiServers, errors } =
          await buildServersFromSources(
            allEnabledSources,
            sessionPath,
            managed.tokenRefreshManager,
            managed.agent?.getSummarizeCallback(),
          )

        if (errors.length > 0) {
          sessionLog.warn(`Source build errors during auto-enable:`, errors)
        }

        // Check if our target source was built successfully
        const sourceBuilt =
          sourceSlug in mcpServers || sourceSlug in apiServers
        if (!sourceBuilt) {
          sessionLog.warn(`Source ${sourceSlug} failed to build`)
          // Only remove if WE added it (not if it was already there)
          if (!wasAlreadyEnabled) {
            slugSet.delete(sourceSlug)
            managed.enabledSourceSlugs = Array.from(slugSet)
          }
          return false
        }

        // Apply source servers to the agent
        const intendedSlugs = allEnabledSources
          .filter(isSourceUsable)
          .map((s) => s.config.slug)

        // Update bridge-mcp-server config/credentials for backends that need it
        await applyBridgeUpdates(
          managed.agent!,
          sessionPath,
          allEnabledSources,
          mcpServers,
          managed.id,
          workspaceRootPath,
          'source enable',
          managed.poolServer?.url,
        )

        await managed.agent!.setSourceServers(
          mcpServers,
          apiServers,
          intendedSlugs,
        )

        sessionLog.info(
          `Auto-enabled source ${sourceSlug} for session ${managed.id}`,
        )

        // Persist session with updated enabled sources
        this.persistSession(managed)

        // Notify renderer of source change
        this.sendEvent(
          {
            type: 'sources_changed',
            sessionId: managed.id,
            enabledSourceSlugs: managed.enabledSourceSlugs || [],
          },
          managed.workspace.id,
        )

        return true
      }

      // NOTE: Source reloading is now handled by ConfigWatcher callbacks
      // which detect filesystem changes and update all affected sessions.
      // See setupConfigWatcher() for the full reload logic.

      // Apply app-wide permission mode to the newly created agent.
      managed.permissionMode = this.currentGlobalPermissionMode
      if (managed.permissionMode) {
        setPermissionMode(managed.id, managed.permissionMode, {
          changedBy: 'restore',
        })
        if (managed.previousPermissionMode) {
          hydratePreviousPermissionMode(
            managed.id,
            managed.previousPermissionMode,
          )
        }
        managed.agent!.setPermissionMode(managed.permissionMode)
        void this.persistQwenApprovalMode(managed.permissionMode, managed.id)
        const diagnostics = getPermissionModeDiagnostics(managed.id)
        sessionLog.info('Applied permission mode to agent', {
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
        })
      }
      end()
    }
    return managed.agent
  }

  async flagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = true
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent(
        { type: 'session_flagged', sessionId },
        managed.workspace.id,
      )
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async unflagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = false
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent(
        { type: 'session_unflagged', sessionId },
        managed.workspace.id,
      )
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isArchived = true
      managed.archivedAt = Date.now()
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent(
        { type: 'session_archived', sessionId },
        managed.workspace.id,
      )
      this.emitUnreadSummaryChanged()
    }
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isArchived = false
      managed.archivedAt = undefined
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent(
        { type: 'session_unarchived', sessionId },
        managed.workspace.id,
      )
      this.emitUnreadSummaryChanged()
    }
  }

  async setSessionStatus(
    sessionId: string,
    sessionStatus: SessionStatus,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.sessionStatus = sessionStatus
      // Guard: suppress external metadata revert from fs.watch during atomic write
      managed._metadataWriteGuardUntil = Date.now() + 5000
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent(
        { type: 'session_status_changed', sessionId, sessionStatus },
        managed.workspace.id,
      )
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Set the LLM connection for a session.
   * Can only be changed before the first message is sent (connection is locked after).
   * This determines which LLM provider/backend will be used for this session.
   */
  async setSessionConnection(
    sessionId: string,
    connectionSlug: string,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`setSessionConnection: session ${sessionId} not found`)
      throw new Error(`Session ${sessionId} not found`)
    }

    // Only allow changing connection before first message (session hasn't started)
    if (managed.messages && managed.messages.length > 0) {
      sessionLog.warn(
        `setSessionConnection: cannot change connection after session has started (${sessionId})`,
      )
      throw new Error('Cannot change connection after session has started')
    }

    // Validate connection exists
    const { getLlmConnection } = await import(
      '@craft-agent/shared/config/storage'
    )
    const connection = getLlmConnection(connectionSlug)
    if (!connection) {
      sessionLog.warn(
        `setSessionConnection: connection "${connectionSlug}" not found`,
      )
      throw new Error(`LLM connection "${connectionSlug}" not found`)
    }

    managed.llmConnection = connectionSlug
    // Persist in-memory state directly to avoid race with pending queue writes
    this.persistSession(managed)
    await this.flushSession(managed.id)
    sessionLog.info(
      `Set LLM connection for session ${sessionId} to ${connectionSlug}`,
    )

    // Notify UI that connection changed (triggers capabilities refresh)
    this.sendEvent(
      {
        type: 'connection_changed',
        sessionId,
        connectionSlug,
        supportsBranching: resolveSupportsBranching(managed),
      },
      managed.workspace.id,
    )
  }

  // ============================================
  // Pending Plan Execution (Accept & Compact)
  // ============================================

  /**
   * Set pending plan execution state.
   * Called when user clicks "Accept & Compact" to persist the plan path
   * so execution can resume after compaction (even if page reloads).
   */
  async setPendingPlanExecution(
    sessionId: string,
    planPath: string,
    draftInputSnapshot?: string,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await setStoredPendingPlanExecution(
        managed.workspace.rootPath,
        sessionId,
        planPath,
        draftInputSnapshot,
      )
      sessionLog.info(
        `Session ${sessionId}: set pending plan execution for ${planPath}`,
      )
    }
  }

  /**
   * Mark compaction as complete for pending plan execution.
   * Called when compaction_complete event fires - allows reload recovery
   * to know that compaction finished and plan can be executed.
   */
  async markCompactionComplete(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
      sessionLog.info(
        `Session ${sessionId}: compaction marked complete for pending plan`,
      )
    }
  }

  /**
   * Mark pending plan execution as already dispatched from the UI.
   * This prevents reload recovery from double-submitting the same plan if
   * sending succeeded but cleanup failed due a reconnect/disconnect.
   */
  async markPendingPlanExecutionDispatched(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredPendingPlanExecutionDispatched(
        managed.workspace.rootPath,
        sessionId,
      )
      sessionLog.info(
        `Session ${sessionId}: marked pending plan execution as dispatched`,
      )
    }
  }

  /**
   * Clear pending plan execution state.
   * Called after plan execution is triggered, on new user message,
   * or when the pending execution is no longer relevant.
   */
  async clearPendingPlanExecution(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await clearStoredPendingPlanExecution(
        managed.workspace.rootPath,
        sessionId,
      )
      sessionLog.info(`Session ${sessionId}: cleared pending plan execution`)
    }
  }

  /**
   * Get pending plan execution state for a session.
   * Used on reload/init to check if we need to resume plan execution.
   */
  getPendingPlanExecution(sessionId: string): {
    planPath: string
    draftInputSnapshot?: string
    awaitingCompaction: boolean
    executionDispatched: boolean
  } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
  }

  /**
   * Dispatch a plan approval for a session, equivalent to the desktop
   * "Accept plan" button. Switches the session out of Plan mode (safe)
   * into allow-all if needed so the plan can execute without per-tool
   * prompts, then sends the approval message through the normal sendMessage
   * path.
   */
  async acceptPlan(sessionId: string, _planPath?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`acceptPlan: session ${sessionId} not found`)
      return
    }

    if (managed.permissionMode === 'safe') {
      await this.setSessionPermissionMode(sessionId, 'allow-all')
    }

    await this.sendMessage(sessionId, PLAN_APPROVAL_MESSAGE)
  }

  // ============================================
  // Session Sharing
  // ============================================

  /**
   * Share session to the web viewer
   * Uploads session data and returns shareable URL
   */
  async shareToViewer(
    sessionId: string,
  ): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent(
      { type: 'async_operation', sessionId, isOngoing: true },
      managed.workspace.id,
    )

    try {
      // Load session directly from disk (already in correct format)
      const storedSession = loadStoredSession(
        managed.workspace.rootPath,
        sessionId,
      )
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession),
      })

      if (!response.ok) {
        sessionLog.error(`Share failed with status ${response.status}`)
        if (response.status === 413) {
          return {
            success: false,
            error: 'Session file is too large to share',
          }
        }
        return { success: false, error: 'Failed to upload session' }
      }

      const data = (await response.json()) as { id: string; url: string }

      // Store shared info in session
      managed.sharedUrl = data.url
      managed.sharedId = data.id
      await this.persistSessionMetadataUpdate(managed, {
        sharedUrl: data.url,
        sharedId: data.id,
      })

      sessionLog.info(`Session ${sessionId} shared at ${data.url}`)
      // Notify all windows for this workspace
      this.sendEvent(
        { type: 'session_shared', sessionId, sharedUrl: data.url },
        managed.workspace.id,
      )
      return { success: true, url: data.url }
    } catch (error) {
      sessionLog.error('Share error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent(
        { type: 'async_operation', sessionId, isOngoing: false },
        managed.workspace.id,
      )
    }
  }

  /**
   * Update an existing shared session
   * Re-uploads session data to the same URL
   */
  async updateShare(
    sessionId: string,
  ): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent(
      { type: 'async_operation', sessionId, isOngoing: true },
      managed.workspace.id,
    )

    try {
      // Load session directly from disk (already in correct format)
      const storedSession = loadStoredSession(
        managed.workspace.rootPath,
        sessionId,
      )
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api/${managed.sharedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession),
      })

      if (!response.ok) {
        sessionLog.error(`Update share failed with status ${response.status}`)
        if (response.status === 413) {
          return {
            success: false,
            error: 'Session file is too large to share',
          }
        }
        return { success: false, error: 'Failed to update shared session' }
      }

      sessionLog.info(
        `Session ${sessionId} share updated at ${managed.sharedUrl}`,
      )
      return { success: true, url: managed.sharedUrl }
    } catch (error) {
      sessionLog.error('Update share error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent(
        { type: 'async_operation', sessionId, isOngoing: false },
        managed.workspace.id,
      )
    }
  }

  /**
   * Revoke a shared session
   * Deletes from viewer and clears local shared state
   */
  async revokeShare(
    sessionId: string,
  ): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent(
      { type: 'async_operation', sessionId, isOngoing: true },
      managed.workspace.id,
    )

    try {
      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api/${managed.sharedId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        sessionLog.error(`Revoke failed with status ${response.status}`)
        return { success: false, error: 'Failed to revoke share' }
      }

      // Clear shared info
      delete managed.sharedUrl
      delete managed.sharedId
      await this.persistSessionMetadataUpdate(managed, {
        sharedUrl: undefined,
        sharedId: undefined,
      })

      sessionLog.info(`Session ${sessionId} share revoked`)
      // Notify all windows for this workspace
      this.sendEvent(
        { type: 'session_unshared', sessionId },
        managed.workspace.id,
      )
      return { success: true }
    } catch (error) {
      sessionLog.error('Revoke error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent(
        { type: 'async_operation', sessionId, isOngoing: false },
        managed.workspace.id,
      )
    }
  }

  // ============================================
  // Session Sources
  // ============================================

  /**
   * Update session's enabled sources
   * If agent exists, builds and applies servers immediately.
   * Otherwise, servers will be built fresh on next message.
   */
  async setSessionSources(
    sessionId: string,
    sourceSlugs: string[],
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Setting sources for session ${sessionId}:`, sourceSlugs)

    // Clean up credential cache for sources being disabled (security)
    // This removes decrypted tokens from disk when sources are no longer active
    const previousSlugs = new Set(managed.enabledSourceSlugs || [])
    const newSlugs = new Set(sourceSlugs)
    const disabledSlugs = [...previousSlugs].filter(
      (prevSlug) => !newSlugs.has(prevSlug),
    )
    if (disabledSlugs.length > 0) {
      try {
        await cleanupSourceRuntimeArtifacts()
      } catch (err) {
        sessionLog.warn(`Failed to clean up source runtime artifacts: ${err}`)
      }
    }

    // Store the selection
    managed.enabledSourceSlugs = sourceSlugs

    // If agent exists, build and apply servers immediately
    if (managed.agent) {
      const sources = getSourcesBySlugs(workspaceRootPath, sourceSlugs)
      // Pass session path so large API responses can be saved to session folder
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      const { mcpServers, apiServers, errors } = await buildServersFromSources(
        sources,
        sessionPath,
        managed.tokenRefreshManager,
        managed.agent.getSummarizeCallback(),
      )
      if (errors.length > 0) {
        sessionLog.warn(`Source build errors:`, errors)
      }

      // Set all sources for context (agent sees full list with descriptions, including built-ins)
      const allSources = loadAllSources(workspaceRootPath)
      managed.agent.setAllSources(allSources)

      // Set active source servers (tools are only available from these)
      const intendedSlugs = sources
        .filter(isSourceUsable)
        .map((s) => s.config.slug)

      // Update bridge-mcp-server config/credentials for backends that need it
      const usableSources = sources.filter(isSourceUsable)
      await applyBridgeUpdates(
        managed.agent,
        sessionPath,
        usableSources,
        mcpServers,
        managed.id,
        workspaceRootPath,
        'source config change',
        managed.poolServer?.url,
      )

      await managed.agent.setSourceServers(
        mcpServers,
        apiServers,
        intendedSlugs,
      )

      sessionLog.info(
        `Applied ${Object.keys(mcpServers).length} MCP + ${Object.keys(apiServers).length} API sources to active agent (${allSources.length} total)`,
      )
    }

    // Persist the session with updated sources
    this.persistSession(managed)

    // Notify renderer of the source change
    this.sendEvent(
      {
        type: 'sources_changed',
        sessionId,
        enabledSourceSlugs: sourceSlugs,
      },
      managed.workspace.id,
    )

    sessionLog.info(
      `Session ${sessionId} sources updated: ${sourceSlugs.length} sources`,
    )
  }

  /**
   * Get the enabled source slugs for a session
   */
  getSessionSources(sessionId: string): string[] {
    const managed = this.sessions.get(sessionId)
    return managed?.enabledSourceSlugs ?? []
  }

  /**
   * Get the last final assistant message ID from a list of messages
   * A "final" message is one where:
   * - role === 'assistant' AND
   * - isIntermediate !== true (not commentary between tool calls)
   * Returns undefined if no final assistant message exists
   */
  private getLastFinalAssistantMessageId(
    messages: Message[],
  ): string | undefined {
    // Iterate backwards to find the most recent final assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && !msg.isIntermediate) {
        return msg.id
      }
    }
    return undefined
  }

  /**
   * Set which session the user is actively viewing.
   * Called when user navigates to a session. Used to determine whether to mark
   * new messages as unread - if user is viewing, don't mark unread.
   */
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void {
    if (sessionId) {
      this.activeViewingSession.set(workspaceId, sessionId)
      // When user starts viewing a session that's not processing, clear unread
      const managed = this.sessions.get(sessionId)
      if (managed && !managed.isProcessing && managed.hasUnread) {
        this.markSessionRead(sessionId)
      }
    } else {
      this.activeViewingSession.delete(workspaceId)
    }
  }

  /**
   * Clear active viewing session for a workspace.
   * Called when all windows leave a workspace to ensure read/unread state is correct.
   */
  clearActiveViewingSession(workspaceId: string): void {
    this.activeViewingSession.delete(workspaceId)
  }

  /**
   * Check if a session is currently being viewed by the user
   */
  private isSessionBeingViewed(
    sessionId: string,
    workspaceId: string,
  ): boolean {
    return this.activeViewingSession.get(workspaceId) === sessionId
  }

  /**
   * Mark a session as read by setting lastReadMessageId and clearing hasUnread.
   * Called when user navigates to a session (and it's not processing).
   */
  async markSessionRead(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    // Only mark as read if not currently processing
    // (user is viewing but we want to wait for processing to complete)
    if (managed.isProcessing) return

    let needsPersist = false
    const updates: { lastReadMessageId?: string; hasUnread?: boolean } = {}

    // Update lastReadMessageId for legacy/manual unread functionality
    if (managed.messages.length > 0) {
      const lastFinalId = this.getLastFinalAssistantMessageId(managed.messages)
      if (lastFinalId && managed.lastReadMessageId !== lastFinalId) {
        managed.lastReadMessageId = lastFinalId
        updates.lastReadMessageId = lastFinalId
        needsPersist = true
      }
    }

    // Clear hasUnread flag (primary source of truth for NEW badge)
    if (managed.hasUnread) {
      managed.hasUnread = false
      updates.hasUnread = false
      needsPersist = true
    }

    // Persist changes
    if (needsPersist) {
      await this.persistSessionMetadataUpdate(managed, updates)
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark a session as unread by setting hasUnread flag.
   * Called when user manually marks a session as unread via context menu.
   */
  async markSessionUnread(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.hasUnread = true
      managed.lastReadMessageId = undefined
      // Persist to disk
      await this.persistSessionMetadataUpdate(managed, {
        hasUnread: true,
        lastReadMessageId: undefined,
      })
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark all non-hidden, non-archived sessions in a workspace as read.
   * Called from "Mark All Read" context menu on "All Sessions".
   */
  async markAllSessionsRead(workspaceId: string): Promise<void> {
    const updates: Array<Promise<void>> = []
    for (const managed of this.sessions.values()) {
      if (managed.workspace.id !== workspaceId) continue
      if (managed.hidden || managed.isArchived) continue
      if (managed.isProcessing) continue
      if (!managed.hasUnread) continue
      managed.hasUnread = false
      updates.push(
        this.persistSessionMetadataUpdate(managed, { hasUnread: false }),
      )
    }
    if (updates.length > 0) {
      await Promise.all(updates)
      this.emitUnreadSummaryChanged()
    }
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      const truncatedName = truncateTitle(name)
      await this.syncExternalBackendTitleIfSupported(managed, truncatedName)
      managed.name = truncatedName
      this.persistSession(managed)
      // Notify renderer of the name change
      this.sendEvent(
        { type: 'title_generated', sessionId, title: truncatedName },
        managed.workspace.id,
      )
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Regenerate the session title based on recent messages.
   * Uses the last few user messages to capture what the session has evolved into.
   * Automatically uses the same provider as the session.
   */
  async refreshTitle(
    sessionId: string,
  ): Promise<{ success: boolean; title?: string; error?: string }> {
    sessionLog.info(`refreshTitle called for session ${sessionId}`)
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`refreshTitle: Session ${sessionId} not found`)
      return { success: false, error: 'Session not found' }
    }

    // Ensure messages are loaded from disk (lazy loading support)
    await this.ensureMessagesLoaded(managed)

    // Select a spread of user messages (first, middle, last) to capture the session's purpose
    const allUserContents = managed.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
    const userMessages = selectSpreadMessages(allUserContents)

    sessionLog.info(
      `refreshTitle: Selected ${userMessages.length} spread messages from ${allUserContents.length} total`,
    )

    if (userMessages.length === 0) {
      sessionLog.warn(`refreshTitle: No user messages found`)
      return {
        success: false,
        error: 'No user messages to generate title from',
      }
    }

    // Get the most recent assistant response
    const lastAssistantMsg = managed.messages
      .filter((m) => m.role === 'assistant' && !m.isIntermediate)
      .slice(-1)[0]

    const assistantResponse = lastAssistantMsg?.content ?? ''

    // Derive language from app's i18n setting for language-aware title generation
    const titleLangCode = (i18n.resolvedLanguage ?? 'en') as LanguageCode
    const titleLangEntry = LOCALE_REGISTRY[titleLangCode]
    const titleOptions = { language: titleLangEntry?.nativeName }

    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    if (!agent && managed.llmConnection) {
      try {
        const connection = getLlmConnection(managed.llmConnection)
        const resolvedMiniModel = connection
          ? (getMiniModel(connection) ?? connection.defaultModel)
          : undefined

        agent = createBackendFromConnection(
          managed.llmConnection,
          {
            workspace: managed.workspace,
            miniModel: resolvedMiniModel,
            session: {
              id: `title-${managed.id}`,
              workspaceRootPath: managed.workspace.rootPath,
              llmConnection: managed.llmConnection,
              createdAt: Date.now(),
              lastUsedAt: Date.now(),
            },
            isHeadless: true,
          },
          buildBackendHostRuntimeContext(),
        ) as AgentInstance
        await agent.postInit()
        isTemporary = true
        sessionLog.info(
          `refreshTitle: Created temporary agent for session ${sessionId}`,
        )
      } catch (error) {
        sessionLog.error(
          `refreshTitle: Failed to create temporary agent:`,
          error,
        )
        return {
          success: false,
          error: 'Failed to create agent for title generation',
        }
      }
    }

    if (!agent) {
      sessionLog.warn(
        `refreshTitle: No agent and no connection for session ${sessionId}`,
      )
      return { success: false, error: 'No agent available' }
    }

    sessionLog.info(`refreshTitle: Calling agent.regenerateTitle...`)

    // Notify renderer that title regeneration has started (for shimmer effect)
    managed.isAsyncOperationOngoing = true
    this.sendEvent(
      { type: 'async_operation', sessionId, isOngoing: true },
      managed.workspace.id,
    )
    // Keep legacy event for backward compatibility
    this.sendEvent(
      { type: 'title_regenerating', sessionId, isRegenerating: true },
      managed.workspace.id,
    )

    try {
      const title = await agent.regenerateTitle(
        userMessages,
        assistantResponse,
        titleOptions,
      )
      sessionLog.info(
        `refreshTitle: regenerateTitle returned: ${title ? `"${title}"` : 'null'}`,
      )
      if (title) {
        await this.syncExternalBackendTitleIfSupported(managed, title)
        managed.name = title
        this.persistSession(managed)
        // title_generated will also clear isRegeneratingTitle via the event handler
        this.sendEvent(
          { type: 'title_generated', sessionId, title },
          managed.workspace.id,
        )
        sessionLog.info(`Refreshed title for session ${sessionId}: "${title}"`)
        return { success: true, title }
      }
      // Failed to generate - clear regenerating state
      this.sendEvent(
        { type: 'title_regenerating', sessionId, isRegenerating: false },
        managed.workspace.id,
      )
      return { success: false, error: 'Failed to generate title' }
    } catch (error) {
      // Error occurred - clear regenerating state
      this.sendEvent(
        { type: 'title_regenerating', sessionId, isRegenerating: false },
        managed.workspace.id,
      )
      const message = error instanceof Error ? error.message : 'Unknown error'
      sessionLog.error(
        `Failed to refresh title for session ${sessionId}:`,
        error,
      )
      return { success: false, error: message }
    } finally {
      // Clean up temporary agent
      if (isTemporary && agent) {
        agent.destroy()
      }
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent(
        { type: 'async_operation', sessionId, isOngoing: false },
        managed.workspace.id,
      )
    }
  }

  /**
   * Update the working directory for a session.
   *
   * If no messages have been sent yet (no SDK interaction), also updates sdkCwd
   * so the SDK will use the new path for transcript storage. This prevents the
   * confusing "bash shell runs from a different directory" warning when the user
   * changes the working directory before their first message.
   */
  updateWorkingDirectory(sessionId: string, path: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      const validation = isValidWorkingDirectory(path)
      if (!validation.valid) {
        sessionLog.warn(
          `Session ${sessionId}: rejected working directory "${path}" — ${validation.reason}`,
        )
        this.sendEvent(
          {
            type: 'working_directory_error',
            sessionId,
            error: validation.reason!,
          },
          managed.workspace.id,
        )
        return
      }

      managed.workingDirectory = path

      // Invalidate filesystem caches that depend on working directory
      invalidateContextFileCache(path)
      invalidateSkillsCache()

      // Check if we can also update sdkCwd (safe if no SDK interaction yet)
      // Conditions: no messages sent AND no agent created yet (no SDK session)
      const shouldUpdateSdkCwd =
        managed.messages.length === 0 &&
        !managed.sdkSessionId &&
        !managed.agent

      if (shouldUpdateSdkCwd) {
        managed.sdkCwd = path
        sessionLog.info(
          `Session ${sessionId}: sdkCwd updated to ${path} (no prior interaction)`,
        )
      }

      // Also update the agent's session config if agent exists
      if (managed.agent) {
        managed.agent.updateWorkingDirectory(path)
        // If agent exists but conditions still allow sdkCwd update (edge case),
        // update the agent's sdkCwd as well
        if (shouldUpdateSdkCwd) {
          managed.agent.updateSdkCwd(path)
        }
      }

      this.persistSession(managed)
      // Notify renderer of the working directory change
      this.sendEvent(
        {
          type: 'working_directory_changed',
          sessionId,
          workingDirectory: path,
        },
        managed.workspace.id,
      )
    }
  }

  /**
   * Update the model for a session
   * Pass null to clear the session-specific model (will use global config)
   * @param connection - Optional LLM connection slug (only applied if not already locked)
   */
  async updateSessionModel(
    sessionId: string,
    workspaceId: string,
    model: string | null,
    connection?: string,
  ): Promise<void> {
    sessionLog.info(
      `[updateSessionModel] sessionId=${sessionId}, model=${model}, connection=${connection}`,
    )
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      if (sessionId === '__new_session_draft__' && model) {
        await this.persistDraftModelSelection(workspaceId, model, connection)
        return
      }
      sessionLog.warn(`[updateSessionModel] session ${sessionId} not found`)
      return
    }

    const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const nextConnectionSlug =
      connection && !managed.connectionLocked
        ? connection
        : managed.llmConnection
    const sessionConn = resolveSessionConnection(
      nextConnectionSlug,
      wsConfig?.defaults?.defaultLlmConnection,
    )
    const provider = sessionConn
      ? providerTypeToAgentProvider(sessionConn.providerType)
      : 'qwen'
    const resolveModel = (candidate: string | undefined) =>
      resolveModelForProvider(provider, candidate, sessionConn)
    const persistedModel =
      model === null ? undefined : resolveModel(model) || undefined

    managed.model = persistedModel
    if (sessionConn?.providerType === 'qwen' && persistedModel) {
      this.updateQwenConnectionDefault(sessionConn.slug, persistedModel)
    }
    // Also update connection if provided and not already locked
    if (connection && !managed.connectionLocked) {
      managed.llmConnection = connection
    }
    // Persist to disk. Connection selection is runtime-only in the Qwen-only app.
    const updates: { model?: string } = { model: persistedModel }
    await this.persistSessionMetadataUpdate(managed, updates)
    // Notify renderer immediately. Provider refreshes below may involve ACP I/O and
    // should not block the visible model selection from updating.
    this.sendEvent(
      {
        type: 'session_model_changed',
        sessionId,
        model: persistedModel ?? null,
      },
      managed.workspace.id,
    )
    // Update agent model if it already exists (takes effect on next query)
    if (managed.agent) {
      // Fallback chain: session model > workspace default > connection default
      const effectiveModel = resolveModel(
        persistedModel ??
          wsConfig?.defaults?.model ??
          sessionConn?.defaultModel,
      )
      sessionLog.info(
        `[updateSessionModel] Calling agent.setModel(${effectiveModel}) [agent exists=${!!managed.agent}, connectionLocked=${managed.connectionLocked}]`,
      )
      if (effectiveModel) {
        managed.agent.setModel(effectiveModel)
        if (sessionConn?.providerType === 'qwen') {
          const agent = managed.agent
          void (async () => {
            try {
              await agent.refreshAvailableCommands?.()
              await this.refreshQwenConnectionDefault(
                sessionConn.slug,
                'session model update',
              )
            } catch (error) {
              sessionLog.warn(
                `Qwen model follow-up refresh failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          })()
        }
      }
    } else {
      sessionLog.info(
        `[updateSessionModel] No agent yet, model will apply on next agent creation`,
      )
    }
    sessionLog.info(
      `Session ${sessionId} model updated to: ${persistedModel ?? '(global config)'}`,
    )
  }

  private async createDraftAgent(args: {
    workspace: Workspace
    workspaceConfig: ReturnType<typeof loadWorkspaceConfig>
    backendContext: ReturnType<typeof resolveBackendContext>
    connectionSlug?: string
    workingDirectory?: string
    model?: string
    permissionMode?: PermissionMode
    thinkingLevel?: ThinkingLevel
    enabledSourceSlugs?: string[]
    debugPrefix: string
  }): Promise<AgentInstance> {
    const connection = args.backendContext.connection
    const miniModel = connection
      ? (getMiniModel(connection) ?? connection.defaultModel)
      : undefined
    const now = Date.now()
    const draftSession: SessionConfig = {
      id: `draft-${randomUUID()}`,
      workspaceRootPath: args.workspace.rootPath,
      createdAt: now,
      lastUsedAt: now,
      lastMessageAt: now,
      workingDirectory: args.workingDirectory,
      model: args.model,
      llmConnection: args.connectionSlug,
      permissionMode: args.permissionMode,
      thinkingLevel: args.thinkingLevel,
      enabledSourceSlugs: args.enabledSourceSlugs,
    }
    const agent = createBackendFromResolvedContext({
      context: args.backendContext,
      hostRuntime: buildBackendHostRuntimeContext(),
      coreConfig: {
        workspace: args.workspace,
        miniModel,
        thinkingLevel: args.thinkingLevel,
        session: draftSession,
        onAvailableModelsUpdate:
          connection?.providerType === 'qwen'
            ? (models, currentModelId) =>
                this.updateQwenConnectionModels(
                  connection.slug,
                  models,
                  currentModelId,
                )
            : undefined,
        envOverrides: {
          CRAFT_WORKSPACE_PATH: args.workspace.rootPath,
        },
        isHeadless: !AGENT_FLAGS.defaultModesEnabled,
        skipConfigWatcher: true,
        initialSources: {
          enabledSources: [],
          mcpServers: {},
          apiServers: {},
          enabledSlugs: [],
        },
      },
    }) as AgentInstance

    agent.onDebug = (message: string) => {
      sessionLog.info(`[${args.debugPrefix}] ${message}`)
    }
    agent.onBackendAuthRequired = (reason: string) => {
      sessionLog.warn(`Draft agent auth required: ${reason}`)
    }
    if (args.model) agent.setModel(args.model)
    if (args.permissionMode) agent.setPermissionMode(args.permissionMode)

    const postInitResult = await agent.postInit()
    if (postInitResult.authWarning) {
      sessionLog.warn(
        `Draft agent auth warning: ${postInitResult.authWarning}`,
      )
    }

    return agent
  }

  private async cleanupDraftAgent(
    agent: AgentInstance,
    workspace: Workspace,
    workingDirectory: string | undefined,
    reason: string,
  ): Promise<void> {
    const nativeSessionId = agent.getSessionId()
    if (nativeSessionId && agent.deleteBackendSession) {
      try {
        await agent.deleteBackendSession(nativeSessionId, {
          cwd: workingDirectory ?? workspace.rootPath,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sessionLog.warn(
          `Draft agent cleanup failed for ${nativeSessionId}: ${message}`,
        )
      }
    }

    agent.destroy()
    sessionLog.info(`Destroyed draft agent (${reason})`)
  }

  private async persistDraftModelSelection(
    workspaceId: string,
    model: string,
    connection?: string,
  ): Promise<void> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      sessionLog.warn(
        `[persistDraftModelSelection] workspace ${workspaceId} not found`,
      )
      return
    }

    const workspaceConfig = loadWorkspaceConfig(workspace.rootPath)
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: connection,
      workspaceDefaultConnectionSlug:
        workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: model,
    })
    const sessionConnection = backendContext.connection
    const provider = sessionConnection
      ? providerTypeToAgentProvider(sessionConnection.providerType)
      : 'qwen'
    if (provider !== 'qwen') {
      sessionLog.info(
        `[persistDraftModelSelection] provider ${provider} does not support ACP model persistence`,
      )
      return
    }

    const resolvedModel = backendContext.resolvedModel || model
    let agent: AgentInstance | undefined
    try {
      agent = await this.createDraftAgent({
        workspace,
        workspaceConfig,
        backendContext,
        connectionSlug: connection,
        workingDirectory: workspaceConfig?.defaults?.workingDirectory,
        model: resolvedModel,
        debugPrefix: 'draft model',
      })
      await agent.refreshAvailableCommands?.()
      if (sessionConnection?.slug) {
        await this.refreshQwenConnectionDefault(
          sessionConnection.slug,
          'draft model selection',
        )
      }
      sessionLog.info(
        `[persistDraftModelSelection] persisted draft model via ACP: ${resolvedModel}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(`Draft model persistence failed: ${message}`)
    } finally {
      if (agent) {
        await this.cleanupDraftAgent(
          agent,
          workspace,
          workspaceConfig?.defaults?.workingDirectory,
          'draft model complete',
        )
      }
    }
  }

  private async refreshQwenConnectionDefault(
    slug: string,
    reason: string,
  ): Promise<void> {
    try {
      await getModelRefreshService().refreshNow(slug)
      this.broadcastLlmConnectionsChanged()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(
        `Failed to refresh Qwen ACP model default after ${reason}: ${message}`,
      )
    }
  }

  /**
   * Edit the latest user message, rewind provider history, and rerun the turn.
   */
  async updateMessageContent(
    sessionId: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot update message: session ${sessionId} not found`)
      throw new Error(`Session ${sessionId} not found`)
    }

    await this.ensureMessagesLoaded(managed)

    if (managed.isProcessing) {
      sessionLog.warn(
        `Cannot update message: session ${sessionId} is processing`,
      )
      throw new Error('Cannot edit a message while the session is processing')
    }

    const resolvedMessage = this.findMessageForContentUpdate(
      managed,
      messageId,
    )
    if (!resolvedMessage) {
      sessionLog.warn(
        `Cannot update message: message ${messageId} not found in session ${sessionId}`,
      )
      throw new Error(`Message ${messageId} not found`)
    }
    const { message, index: messageIndex } = resolvedMessage

    if (message.role !== 'user') {
      sessionLog.warn(
        `Cannot update message: message ${messageId} is not a user message`,
      )
      throw new Error('Only user messages can be edited')
    }

    const lastUserMessage = managed.messages.findLast((m) => m.role === 'user')
    if (lastUserMessage !== message) {
      sessionLog.warn(
        `Cannot update message: message ${messageId} is not the latest user message`,
      )
      throw new Error('Only the latest sent message can be edited')
    }

    const nextContent = content.trim()
    if (!nextContent) {
      throw new Error('Message content cannot be empty')
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canRewindToUserTurn(agent)) {
      throw new Error(
        'This session backend does not support editing sent messages',
      )
    }

    const targetTurnIndex = managed.messages
      .slice(0, messageIndex)
      .filter((m) => m.role === 'user').length

    await agent.rewindToUserTurn(targetTurnIndex)

    const rerunTimestamp = this.monotonic()
    message.content = nextContent
    message.timestamp = rerunTimestamp
    if (message.textElements && message.textElements.length > 0) {
      delete message.textElements
    }

    const storedAttachments = message.attachments
    const attachments = this.rehydrateStoredAttachments(storedAttachments)
    const truncatedCount = managed.messages.length - messageIndex - 1
    managed.messages = managed.messages.slice(0, messageIndex + 1)
    managed.lastMessageRole = 'user'
    managed.lastFinalMessageId = this.getLastFinalAssistantMessageId(
      managed.messages,
    )
    managed.lastMessageAt = rerunTimestamp
    if (this.isQwenCanonicalMessageSession(managed)) {
      this.markExternalMessagesLoadedThrough(managed)
    }

    this.persistSession(managed)
    this.sendEvent(
      {
        type: 'message_content_updated',
        sessionId,
        message,
        truncateAfterMessageId: message.id,
      },
      managed.workspace.id,
    )

    this.sendMessage(
      sessionId,
      nextContent,
      attachments,
      storedAttachments,
      undefined,
      message.id,
    ).catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      sessionLog.warn(
        `Failed to rerun edited message ${messageId} in session ${sessionId}: ${errorMessage}`,
      )
      this.sendEvent(
        {
          type: 'error',
          sessionId,
          error: errorMessage,
          timestamp: this.monotonic(),
        },
        managed.workspace.id,
      )
      if (managed.isProcessing) {
        this.setProcessing(managed, false)
        this.persistSession(managed)
      }
    })

    sessionLog.info(
      `Updated message ${messageId} content in session ${sessionId}; truncated ${truncatedCount} stale messages and reran`,
    )
  }

  private rehydrateStoredAttachments(
    storedAttachments?: StoredAttachment[],
  ): FileAttachment[] | undefined {
    if (!storedAttachments?.length) return undefined

    const attachments: FileAttachment[] = []
    for (const stored of storedAttachments) {
      const attachment = readFileAttachment(stored.storedPath)
      if (!attachment) {
        sessionLog.warn(
          `Could not rehydrate stored attachment for edited message: ${stored.storedPath}`,
        )
        continue
      }

      attachment.type = stored.type
      attachment.name = stored.name
      attachment.mimeType = stored.mimeType
      attachment.size = stored.size
      attachment.storedPath = stored.storedPath
      attachment.markdownPath = stored.markdownPath
      if (stored.resizedBase64 && stored.mimeType.startsWith('image/')) {
        attachment.base64 = stored.resizedBase64
      }
      attachments.push(attachment)
    }

    return attachments.length > 0 ? attachments : undefined
  }

  /**
   * Add an annotation to a message and persist the session.
   */
  addMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotation: NonNullable<Message['annotations']>[number],
  ): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot add annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find((m) => m.id === messageId)
    if (!message) {
      sessionLog.warn(
        `Cannot add annotation: message ${messageId} not found in session ${sessionId}`,
      )
      return
    }

    if (!annotation?.id || !annotation?.target?.selectors?.length) {
      sessionLog.warn(
        `Cannot add annotation: invalid annotation payload for message ${messageId}`,
      )
      return
    }

    if (annotation.target.source.messageId !== messageId) {
      sessionLog.warn(
        `Cannot add annotation: target source.messageId mismatch (${annotation.target.source.messageId} !== ${messageId})`,
      )
      return
    }

    const safeAnnotation: NonNullable<Message['annotations']>[number] = {
      ...annotation,
      schemaVersion: 1,
      target: {
        ...annotation.target,
        source: {
          ...annotation.target.source,
          sessionId,
          messageId,
        },
      },
    }

    const annotationBytes = Buffer.byteLength(
      JSON.stringify(safeAnnotation),
      'utf8',
    )
    if (annotationBytes > MAX_ANNOTATION_JSON_BYTES) {
      sessionLog.warn(
        `Cannot add annotation: payload too large (${annotationBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) on message ${messageId}`,
      )
      return
    }

    const existing = message.annotations ?? []
    if (existing.some((a) => a.id === safeAnnotation.id)) {
      sessionLog.warn(
        `Cannot add annotation: duplicate annotation id ${safeAnnotation.id} on message ${messageId}`,
      )
      return
    }

    if (existing.length >= MAX_ANNOTATIONS_PER_MESSAGE) {
      sessionLog.warn(
        `Cannot add annotation: per-message limit reached (${MAX_ANNOTATIONS_PER_MESSAGE}) on message ${messageId}`,
      )
      return
    }

    message.annotations = [...existing, safeAnnotation]
    this.persistSession(managed)
    this.sendEvent(
      {
        type: 'message_annotations_updated',
        sessionId,
        messageId,
        annotations: message.annotations,
      },
      managed.workspace.id,
    )
  }

  /**
   * Patch an existing annotation on a message.
   */
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<NonNullable<Message['annotations']>[number]>,
  ): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(
        `Cannot update annotation: session ${sessionId} not found`,
      )
      return
    }

    const message = managed.messages.find((m) => m.id === messageId)
    if (!message) {
      sessionLog.warn(
        `Cannot update annotation: message ${messageId} not found in session ${sessionId}`,
      )
      return
    }

    const existing = message.annotations ?? []
    const idx = existing.findIndex((a) => a.id === annotationId)
    if (idx === -1) {
      sessionLog.warn(
        `Cannot update annotation: annotation ${annotationId} not found on message ${messageId}`,
      )
      return
    }

    if (
      patch.target?.source?.messageId &&
      patch.target.source.messageId !== messageId
    ) {
      sessionLog.warn(
        `Cannot update annotation: target source.messageId mismatch in patch (${patch.target.source.messageId} !== ${messageId})`,
      )
      return
    }

    if (patch.target?.selectors && patch.target.selectors.length === 0) {
      sessionLog.warn(
        `Cannot update annotation: empty selectors patch for annotation ${annotationId} on message ${messageId}`,
      )
      return
    }

    const current = existing[idx]!
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      schemaVersion: current.schemaVersion,
      target: patch.target
        ? {
            ...current.target,
            ...patch.target,
            source: {
              ...current.target.source,
              ...(patch.target.source ?? {}),
              sessionId,
              messageId,
            },
          }
        : {
            ...current.target,
            source: {
              ...current.target.source,
              sessionId,
              messageId,
            },
          },
      updatedAt: Date.now(),
    }

    const updatedBytes = Buffer.byteLength(JSON.stringify(updated), 'utf8')
    if (updatedBytes > MAX_ANNOTATION_JSON_BYTES) {
      sessionLog.warn(
        `Cannot update annotation: payload too large (${updatedBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) for annotation ${annotationId} on message ${messageId}`,
      )
      return
    }

    const next = [...existing]
    next[idx] = updated
    message.annotations = next
    this.persistSession(managed)
    this.sendEvent(
      {
        type: 'message_annotations_updated',
        sessionId,
        messageId,
        annotations: message.annotations,
      },
      managed.workspace.id,
    )
  }

  /**
   * Remove an annotation from a message and persist the session.
   */
  removeMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
  ): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(
        `Cannot remove annotation: session ${sessionId} not found`,
      )
      return
    }

    const message = managed.messages.find((m) => m.id === messageId)
    if (!message) {
      sessionLog.warn(
        `Cannot remove annotation: message ${messageId} not found in session ${sessionId}`,
      )
      return
    }

    const existing = message.annotations ?? []
    if (!existing.some((a) => a.id === annotationId)) {
      sessionLog.warn(
        `Cannot remove annotation: annotation ${annotationId} not found on message ${messageId}`,
      )
      return
    }

    message.annotations = existing.filter((a) => a.id !== annotationId)
    this.persistSession(managed)
    this.sendEvent(
      {
        type: 'message_annotations_updated',
        sessionId,
        messageId,
        annotations: message.annotations,
      },
      managed.workspace.id,
    )
  }

  async deleteSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot delete session: ${sessionId} not found`)
      return
    }

    // Get workspace slug before deleting
    const workspaceRootPath = managed.workspace.rootPath

    // If processing is in progress, force-abort via Query.close() and wait for cleanup
    if (managed.isProcessing && managed.agent) {
      managed.agent.forceAbort(AbortReason.UserStop)
      // Brief wait for the query to finish tearing down before we delete session files.
      // Prevents file corruption from overlapping writes during rapid delete operations.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const externalDeleteKey = this.externalSessionDeleteKeyForManaged(managed)
    if (externalDeleteKey) {
      this.pendingExternalSessionDeletes.add(externalDeleteKey)
      void this.deleteExternalBackendSessionIfSupported(managed).finally(() => {
        this.pendingExternalSessionDeletes.delete(externalDeleteKey)
      })
    }

    // Revoke share if session was shared (prevent orphaned viewer copies)
    if (managed.sharedId) {
      try {
        const { VIEWER_URL } = await import('@craft-agent/shared/branding')
        const response = await fetch(
          `${VIEWER_URL}/s/api/${managed.sharedId}`,
          { method: 'DELETE', signal: AbortSignal.timeout(5000) },
        )
        if (!response.ok) {
          sessionLog.warn(
            `Failed to revoke share for ${sessionId}: HTTP ${response.status}`,
          )
        } else {
          sessionLog.info(`Revoked share for deleted session ${sessionId}`)
        }
      } catch (error) {
        sessionLog.warn(`Failed to revoke share for ${sessionId}:`, error)
      }
    }

    // Clean up delta flush timers to prevent orphaned timers
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }
    this.pendingDeltas.delete(sessionId)
    this.clearAdminRememberApprovalsForSession(sessionId)
    this.clearPendingPermissionRequestsForSession(sessionId)

    // Cancel any pending persistence write (session is being deleted, no need to save)
    sessionPersistenceQueue.cancel(sessionId)

    // Clean up session-scoped tool callbacks to prevent memory accumulation
    unregisterSessionScopedToolCallbacks(sessionId)

    // Destroy browser instances bound to this session
    if (this.browserPaneManager) {
      this.browserPaneManager.destroyForSession(sessionId)
    }

    // Dispose agent to clean up ConfigWatchers, event listeners, MCP connections
    if (managed.agent) {
      managed.agent.dispose()
    }

    // Stop pool server (HTTP MCP server for external SDK subprocesses)
    if (managed.poolServer) {
      managed.poolServer.stop().catch((err) => {
        sessionLog.warn(
          `Failed to stop pool server for ${sessionId}: ${err instanceof Error ? err.message : err}`,
        )
      })
    }

    this.sessions.delete(sessionId)

    // Clean up session metadata in AutomationSystem (prevents memory leak)
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.removeSessionMetadata(sessionId)
    }

    // Delete from disk too
    deleteStoredSession(workspaceRootPath, sessionId)

    // Notify all windows for this workspace that the session was deleted
    this.sendEvent(
      { type: 'session_deleted', sessionId },
      managed.workspace.id,
    )
    this.emitUnreadSummaryChanged()

    // Clean up attachments directory (handled by deleteStoredSession for workspace-scoped storage)
    sessionLog.info(`Deleted session ${sessionId}`)
  }

  async sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    eventClientId?: string,
    _isAuthRetry?: boolean,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // Clear any pending plan execution state when a new user message is sent.
    // This acts as a safety valve - if the user moves on, we don't want to
    // auto-execute an old plan later.
    await clearStoredPendingPlanExecution(
      managed.workspace.rootPath,
      sessionId,
    )

    // Ensure messages are loaded before we try to add new ones
    await this.ensureMessagesLoaded(managed)

    // If currently processing, prefer a non-interrupting mid-turn queue. ACP
    // backends can drain these messages alongside the next tool-result payload
    // so the model sees them before the whole turn finishes. If no safe
    // injection point is available, keep the message queued for the next turn.
    if (managed.isProcessing) {
      const agent = managed.agent
      const canInjectMidTurn =
        !attachments?.length &&
        !storedAttachments?.length &&
        (agent?.enqueueMidTurnMessage?.(message) ?? false)

      sessionLog.info(
        `Session ${sessionId} ${canInjectMidTurn ? 'queued message for mid-turn injection' : 'queued message for next turn'}`,
      )

      // Create user message for UI
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: this.monotonic(),
        attachments: storedAttachments,
        textElements: options?.textElements,
        isQueued: true,
      }
      managed.messages.push(userMessage)

      // Always show the message as queued while the current turn is still
      // running. Mid-turn candidates flip to accepted only once ACP actually
      // drains them at a tool-result boundary.
      this.sendEvent(
        {
          type: 'user_message',
          sessionId,
          message: userMessage,
          status: 'queued',
          optimisticMessageId: options?.optimisticMessageId,
        },
        managed.workspace.id,
      )

      managed.messageQueue.push({
        message,
        attachments,
        storedAttachments,
        options,
        messageId: userMessage.id,
        optimisticMessageId: options?.optimisticMessageId,
        eventClientId,
        midTurnPending: canInjectMidTurn,
      })

      this.persistSession(managed)
      if (
        this.isQwenCanonicalMessageSession(managed) &&
        hasQwenCanonicalLocalVisualState(userMessage)
      ) {
        await this.flushSession(managed.id)
      }
      return
    }

    if (eventClientId) {
      this.sessionEventClientIds.set(sessionId, eventClientId)
    }

    // Add user message with stored attachments for persistence. Queued replay
    // normally reuses the message created when the user typed it, but provider-
    // native history reloads can clear local messages while the runtime queue
    // still has the replay entry. In that case, recreate the message with the
    // queued ID instead of failing the send.
    let userMessage: Message
    if (existingMessageId) {
      // Find existing message (already added when queued)
      const existingMessage = managed.messages.find(
        (m) => m.id === existingMessageId,
      )
      if (existingMessage) {
        userMessage = existingMessage
      } else {
        sessionLog.warn(
          `Queued message ${existingMessageId} missing from session ${sessionId}; recreating before replay`,
        )
        userMessage = {
          id: existingMessageId,
          role: 'user',
          content: message,
          timestamp: this.monotonic(),
          attachments: storedAttachments,
          textElements: options?.textElements,
          isQueued: false,
        }
        managed.messages.push(userMessage)
        managed.lastMessageRole = 'user'

        this.sendEvent(
          {
            type: 'user_message',
            sessionId,
            message: userMessage,
            status: 'accepted',
            optimisticMessageId: options?.optimisticMessageId,
          },
          managed.workspace.id,
        )
      }
    } else {
      // Create new message
      userMessage = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: this.monotonic(),
        attachments: storedAttachments, // Include for persistence (has thumbnailBase64)
        textElements: options?.textElements,
      }
      managed.messages.push(userMessage)

      // Update lastMessageRole for badge display
      managed.lastMessageRole = 'user'

      // Emit user_message event so UI can confirm the optimistic message
      this.sendEvent(
        {
          type: 'user_message',
          sessionId,
          message: userMessage,
          status: 'accepted',
          optimisticMessageId: options?.optimisticMessageId,
        },
        managed.workspace.id,
      )

      // If this is the first user message and no title exists, set one immediately
      // AI generation will enhance it later, but we always have a title from the start
      // Automation sessions (triggeredBy set) already have a title and skip AI generation entirely
      const isFirstUserMessage =
        managed.messages.filter((m) => m.role === 'user').length === 1
      if (isFirstUserMessage && !managed.name && !managed.triggeredBy) {
        // Replace bracket mentions with their display labels (e.g. [skill:ws:commit] -> "Commit")
        // so titles show human-readable names instead of raw IDs
        let titleSource = message
        const displayBadges = textElementsToContentBadges(
          message,
          options?.textElements,
        )
        if (displayBadges) {
          for (const badge of displayBadges) {
            if (badge.rawText && badge.label) {
              titleSource = titleSource.replace(badge.rawText, badge.label)
            }
          }
        }
        // Sanitize: strip any remaining bracket mentions, XML blocks, tags
        const sanitized = sanitizeForTitle(titleSource)
        const initialTitle = truncateTitle(sanitized)
        managed.name = initialTitle
        this.persistSession(managed)
        // Flush immediately so disk is authoritative before notifying renderer
        await this.flushSession(managed.id)
        this.sendEvent(
          {
            type: 'title_generated',
            sessionId,
            title: initialTitle,
          },
          managed.workspace.id,
        )
        void this.syncExternalBackendTitleIfSupported(managed, initialTitle)

        // Generate AI title asynchronously using agent's SDK
        // (waits briefly for agent creation if needed)
        this.generateTitle(managed, message)
      }
    }

    if (
      this.isQwenCanonicalMessageSession(managed) &&
      hasQwenCanonicalLocalVisualState(userMessage)
    ) {
      this.persistSession(managed)
      await this.flushSession(managed.id)
    }

    // Evaluate auto-label rules against the user message (common path for both
    // fresh and queued messages). Scans regex patterns configured on labels,
    // then merges any new matches into the session's label array.
    try {
      const labelTree = listLabels(managed.workspace.rootPath)
      const autoMatches = evaluateAutoLabels(message, labelTree)

      if (autoMatches.length > 0) {
        const existingLabels = managed.labels ?? []
        const newEntries = autoMatches
          .map((m) => `${m.labelId}::${m.value}`)
          .filter((entry) => !existingLabels.includes(entry))

        if (newEntries.length > 0) {
          managed.labels = [...existingLabels, ...newEntries]
          this.persistSession(managed)
          this.sendEvent(
            {
              type: 'labels_changed',
              sessionId,
              labels: managed.labels,
            },
            managed.workspace.id,
          )
        }
      }
    } catch (e) {
      sessionLog.warn(
        `Auto-label evaluation failed for session ${sessionId}:`,
        e,
      )
    }

    managed.lastMessageAt = Date.now()
    this.setProcessing(managed, true)
    managed.streamingText = ''
    managed.processingGeneration++
    managed.turnStartFinalMessageId = this.getLastFinalAssistantMessageId(
      managed.messages,
    )

    // Reset auth retry flag for this new message (allows one retry per message)
    // IMPORTANT: Skip reset if this is an auth retry call - the flag is already true
    // and resetting it would allow infinite retry loops
    // Note: authRetryInProgress is NOT reset here - it's managed by the retry logic
    if (!_isAuthRetry) {
      managed.authRetryAttempted = false
    }

    // Store message/attachments for potential retry after auth refresh
    // (SDK subprocess caches token at startup, so if it expires mid-session,
    // we need to recreate the agent and retry the message)
    managed.lastSentMessage = message
    managed.lastSentAttachments = attachments
    managed.lastSentStoredAttachments = storedAttachments
    managed.lastSentOptions = options

    // Capture the generation to detect if a new request supersedes this one.
    // This prevents the finally block from clobbering state when a follow-up message arrives.
    const myGeneration = managed.processingGeneration

    const invokedSkillSlugs = options?.skillSlugs ?? []
    const shouldPreEnableLocalSkillSources = (() => {
      if (invokedSkillSlugs.length === 0) return false

      const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
      const backendContext = resolveBackendContext({
        sessionConnectionSlug: managed.llmConnection,
        workspaceDefaultConnectionSlug:
          workspaceConfig?.defaults?.defaultLlmConnection,
        managedModel: managed.model,
      })

      if (backendContext.connection?.providerType === 'qwen') {
        sessionLog.info(
          `Skipping local skill source pre-enable for Qwen ACP session: ${invokedSkillSlugs.join(', ')}`,
        )
        return false
      }

      return true
    })()

    // Pre-enable sources required by invoked skills (Issue #249)
    // This eliminates the two-turn penalty where the agent discovers missing sources at runtime.
    // Uses targeted loadSkillBySlug() instead of loadAllSkills() to avoid O(N) filesystem scans.
    if (shouldPreEnableLocalSkillSources) {
      try {
        const workspaceRoot = managed.workspace.rootPath

        const requiredSources = new Set<string>()
        for (const slug of invokedSkillSlugs) {
          const skill = loadSkillBySlug(
            workspaceRoot,
            slug,
            managed.workingDirectory,
          )
          if (skill?.metadata.requiredSources) {
            for (const src of skill.metadata.requiredSources) {
              requiredSources.add(src)
            }
          }
        }

        if (requiredSources.size > 0) {
          const currentSlugs = new Set(managed.enabledSourceSlugs || [])
          const toEnable: string[] = []
          const skipped: string[] = []
          const candidateSlugs = Array.from(requiredSources)
          const loadedSources = getSourcesBySlugs(
            workspaceRoot,
            candidateSlugs,
          )
          const usableSources = new Set(
            loadedSources
              .filter(isSourceUsable)
              .map((source) => source.config.slug),
          )

          for (const srcSlug of candidateSlugs) {
            if (currentSlugs.has(srcSlug)) continue
            if (usableSources.has(srcSlug)) {
              toEnable.push(srcSlug)
            } else {
              skipped.push(srcSlug)
            }
          }

          if (skipped.length > 0) {
            sessionLog.warn(
              `Skill requires sources that are not usable (missing or unauthenticated): ${skipped.join(', ')}`,
            )
          }

          if (toEnable.length > 0) {
            managed.enabledSourceSlugs = [
              ...(managed.enabledSourceSlugs || []),
              ...toEnable,
            ]
            sessionLog.info(
              `Pre-enabled sources for skill invocation: ${toEnable.join(', ')}`,
            )
            this.persistSession(managed)
            this.sendEvent(
              {
                type: 'sources_changed',
                sessionId,
                enabledSourceSlugs: managed.enabledSourceSlugs,
              },
              managed.workspace.id,
            )
          }
        }
      } catch (e) {
        sessionLog.warn(
          `Failed to pre-enable skill sources for session ${sessionId}:`,
          e,
        )
      }
    }

    // Start perf span for entire sendMessage flow
    const sendSpan = perf.span('session.sendMessage', { sessionId })

    // Get or create the agent (lazy loading)
    const agent = await this.getOrCreateAgent(managed)
    sendSpan.mark('agent.ready')

    // Always set all sources for context (even if none are enabled), including built-ins
    const workspaceRootPath = managed.workspace.rootPath
    const allSources = loadAllSources(workspaceRootPath)
    agent.setAllSources(allSources)
    sendSpan.mark('sources.loaded')

    // Apply source servers if any are enabled
    if (managed.enabledSourceSlugs?.length) {
      // Always build server configs fresh (no caching - single source of truth)
      const sources = getSourcesBySlugs(
        workspaceRootPath,
        managed.enabledSourceSlugs,
      )
      // Pass session path so large API responses can be saved to session folder
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      const { mcpServers, apiServers, errors } = await buildServersFromSources(
        sources,
        sessionPath,
        managed.tokenRefreshManager,
        agent.getSummarizeCallback(),
      )
      if (errors.length > 0) {
        sessionLog.warn(`Source build errors:`, errors)
      }

      // Proactive OAuth token refresh before applying servers to agent.
      // This ensures tokens are fresh BEFORE the agent sees source state, avoiding a race
      // where the agent receives a stale "needs_auth" status and triggers unnecessary re-auth
      // even though the refresh succeeds moments later.
      let tokensRefreshed = false
      if (managed.tokenRefreshManager) {
        const refreshResult = await refreshOAuthTokensIfNeeded(
          agent,
          sources,
          sessionPath,
          managed.tokenRefreshManager,
          {
            sessionId,
            workspaceRootPath,
            poolServerUrl: managed.poolServer?.url,
          },
        )
        if (refreshResult.failedSources.length > 0) {
          sessionLog.warn(
            '[OAuth] Some sources failed token refresh:',
            refreshResult.failedSources.map((f) => f.slug),
          )
        }
        if (refreshResult.tokensRefreshed) {
          tokensRefreshed = true
          sendSpan.mark('oauth.refreshed')
        }
      }

      // Apply source servers to the agent.
      // If tokens were refreshed, refreshOAuthTokensIfNeeded already rebuilt servers and
      // called setSourceServers with fresh credentials — skip the duplicate call to avoid
      // overwriting the post-refresh state with stale build results.
      if (!tokensRefreshed) {
        const mcpCount = Object.keys(mcpServers).length
        const apiCount = Object.keys(apiServers).length
        if (
          mcpCount > 0 ||
          apiCount > 0 ||
          managed.enabledSourceSlugs.length > 0
        ) {
          const intendedSlugs = sources
            .filter(isSourceUsable)
            .map((s) => s.config.slug)
          const usableSources = sources.filter(isSourceUsable)
          await agent.setSourceServers(mcpServers, apiServers, intendedSlugs)
          await applyBridgeUpdates(
            agent,
            sessionPath,
            usableSources,
            mcpServers,
            sessionId,
            workspaceRootPath,
            'send message',
            managed.poolServer?.url,
          )
          sessionLog.info(
            `Applied ${mcpCount} MCP + ${apiCount} API sources to session ${sessionId} (${allSources.length} total)`,
          )
        }
      }
      sendSpan.mark('servers.applied')
    }

    try {
      sessionLog.info('Starting chat for session:', sessionId)
      sessionLog.info('Workspace:', JSON.stringify(managed.workspace, null, 2))
      sessionLog.info('Message:', message)
      sessionLog.info('Agent model:', agent.getModel())
      sessionLog.info('process.cwd():', process.cwd())

      // Process the message through the agent
      sessionLog.info('Calling agent.chat()...')
      if (attachments?.length) {
        sessionLog.info('Attachments:', attachments.length)
      }

      // Skills mentioned via @mentions are handled by the SDK's Skill tool.
      // The UI layer (extractBadges in mentions.ts) injects fully-qualified names
      // in the rawText, and canUseTool in craft-agent.ts provides a fallback
      // to qualify short names. No transformation needed here.

      // Ensure main process reads tool metadata from the correct session directory.
      // This must be set before each chat() call since multiple sessions share the process.
      const chatSessionDir = getSessionStoragePath(
        workspaceRootPath,
        sessionId,
      )
      toolMetadataStore.setSessionDir(chatSessionDir)

      // Inject interruption context so the LLM knows the previous turn was cut short.
      // Uses <system-reminder> tags so the LLM treats it as transient system guidance
      // rather than part of the user's message content. The original message is stored
      // in session JSONL (line ~3952); this only affects the SDK's in-process context.
      let effectiveMessage = message
      if (managed.wasInterrupted) {
        if (!isSlashCommandMessage(message)) {
          effectiveMessage = `${message}\n\n<system-reminder>The previous assistant response was interrupted by the user and may be incomplete. Do not repeat or continue the interrupted response unless asked. Focus on the new message above.</system-reminder>`
        }
        managed.wasInterrupted = false
      }

      sendSpan.mark('chat.starting')
      const chatIterator = agent.chat(effectiveMessage, attachments, {
        textElements: options?.textElements,
      })
      sessionLog.info('Got chat iterator, starting iteration...')

      for await (const event of chatIterator) {
        // Log events (skip noisy text_delta)
        if (event.type !== 'text_delta') {
          if (event.type === 'tool_start') {
            sessionLog.info(
              `tool_start: ${event.toolName} (${event.toolUseId})`,
            )
          } else if (event.type === 'tool_result') {
            sessionLog.info(
              `tool_result: ${event.toolUseId} isError=${event.isError}`,
            )
          } else {
            sessionLog.info('Got event:', event.type)
          }
        }

        // Process the event first
        await this.processEvent(managed, event)

        // Fallback: Capture SDK session ID if the onSdkSessionIdUpdate callback didn't fire.
        // Primary capture happens in getOrCreateAgent() via onSdkSessionIdUpdate callback,
        // which immediately flushes to disk. This fallback handles edge cases where the
        // callback might not fire (e.g., SDK version mismatch, callback not supported).
        if (!managed.sdkSessionId) {
          const sdkId = agent.getSessionId()
          if (sdkId) {
            managed.sdkSessionId = sdkId
            sessionLog.info(`Captured SDK session ID via fallback: ${sdkId}`)
            // Also flush here since we're in fallback mode
            this.persistSession(managed)
            sessionPersistenceQueue.flush(managed.id)
            if (managed.name && managed.id !== sdkId) {
              void this.syncExternalBackendTitleIfSupported(
                managed,
                managed.name,
              )
            }
          }
        }

        // Handle complete event - SDK always sends this (even after interrupt)
        // This is the central place where processing ends
        if (event.type === 'complete') {
          // Skip normal completion handling if auth retry is in progress
          // The retry will handle its own completion
          if (managed.authRetryInProgress) {
            sessionLog.info(
              'Chat completed but auth retry is in progress, skipping normal completion handling',
            )
            sendSpan.mark('chat.complete.auth_retry_pending')
            sendSpan.end()
            return // Exit function - retry will handle completion
          }

          // Auth/plan handoff paths already stopped processing and emitted a complete
          // event to the renderer. Ignore the backend's trailing complete to avoid
          // double cleanup and duplicate UI completion events.
          if (!managed.isProcessing) {
            sessionLog.info(
              'Chat completed after explicit handoff/stop; skipping normal completion handling',
            )
            sendSpan.mark('chat.complete.already_stopped')
            sendSpan.end()
            return
          }

          sessionLog.info('Chat completed via complete event')

          // Check if we got an assistant response in this turn
          // If not, the SDK may have hit context limits or other issues
          const lastAssistantMsg = [...managed.messages]
            .reverse()
            .find((m) => m.role === 'assistant' && !m.isIntermediate)
          const lastUserMsg = [...managed.messages]
            .reverse()
            .find((m) => m.role === 'user')

          // If the last user message is newer than any assistant response, we got no reply
          // This can happen due to context overflow or API issues
          if (
            lastUserMsg &&
            (!lastAssistantMsg ||
              lastUserMsg.timestamp > lastAssistantMsg.timestamp)
          ) {
            sessionLog.warn(
              `Session ${sessionId} completed without assistant response - possible context overflow or API issue`,
            )

            // Check if there's a captured API error that explains the silent failure.
            // Pass explicit session path to avoid reading from the wrong session
            // (_sessionDir singleton can be clobbered by concurrent sessions).
            const sessionErrorPath = getSessionStoragePath(
              managed.workspace.rootPath,
              managed.id,
            )
            const apiError = getLastApiError(sessionErrorPath)

            if (apiError && apiError.status === 400) {
              const isImageError = apiError.message?.includes('image exceeds')

              const errorMessage: Message = {
                id: generateMessageId(),
                role: 'error',
                content: isImageError
                  ? `Image Too Large: ${apiError.message}`
                  : `Request Error: ${apiError.message}`,
                timestamp: this.monotonic(),
                errorCode: isImageError ? 'image_too_large' : 'invalid_request',
                errorTitle: isImageError
                  ? 'Image Too Large'
                  : 'Invalid Request',
                errorDetails: isImageError
                  ? [
                      'An image in the conversation exceeds the 5 MB API limit.',
                      'This session cannot recover — the image is embedded in the history.',
                      'Please start a new session to continue.',
                    ]
                  : [apiError.message],
                errorCanRetry: false,
              }
              managed.messages.push(errorMessage)
              this.sendEvent(
                {
                  type: 'typed_error',
                  sessionId,
                  error: {
                    code: isImageError
                      ? ('image_too_large' as const)
                      : ('invalid_request' as const),
                    title: errorMessage.errorTitle!,
                    message: apiError.message,
                    actions: [],
                    canRetry: false,
                    details: errorMessage.errorDetails,
                  },
                },
                managed.workspace.id,
              )
            }
          }

          sendSpan.mark('chat.complete')
          sendSpan.end()
          this.onProcessingStopped(sessionId, 'complete')
          return // Exit function, skip finally block (onProcessingStopped handles cleanup)
        }

        // NOTE: We no longer break early on !isProcessing or stopRequested.
        // After soft interrupt (forceAbort), the backend sets turnComplete=true which causes
        // the generator to yield remaining queued events and then complete naturally.
        // This ensures we don't lose in-flight messages.
      }

      // Loop exited - either via complete event (normal) or generator ended after soft interrupt
      if (!managed.isProcessing) {
        sessionLog.info('Chat loop exited after explicit handoff/stop')
        sendSpan.mark('chat.exit.already_stopped')
        sendSpan.end()
      } else if (managed.stopRequested) {
        sessionLog.info(
          'Chat loop completed after stop request - events drained successfully',
        )
        this.onProcessingStopped(sessionId, 'interrupted')
      } else {
        sessionLog.info('Chat loop exited unexpectedly')
      }
    } catch (error) {
      // Check if this is an abort error (expected when interrupted)
      const isAbortError =
        error instanceof Error &&
        (error.name === 'AbortError' ||
          error.message === 'Request was aborted.' ||
          error.message.includes('aborted'))

      if (isAbortError) {
        // Extract abort reason if available (safety net for unexpected abort propagation)
        const reason = (error as DOMException).cause as AbortReason | undefined

        sessionLog.info(`Chat aborted (reason: ${reason || 'unknown'})`)
        sendSpan.mark('chat.aborted')
        sendSpan.setMetadata('abort_reason', reason || 'unknown')
        sendSpan.end()

        // UI handoff paths (plan submission, auth request) handle their own cleanup
        // by setting isProcessing = false directly. All other abort reasons route
        // through onProcessingStopped for queue draining.
        if (
          reason === AbortReason.UserStop ||
          reason === AbortReason.Redirect ||
          reason === undefined
        ) {
          this.onProcessingStopped(sessionId, 'interrupted')
        }
      } else {
        sessionLog.error('Error in chat:', error)
        sessionLog.error(
          'Error message:',
          error instanceof Error ? error.message : String(error),
        )
        sessionLog.error(
          'Error stack:',
          error instanceof Error ? error.stack : 'No stack',
        )

        // Report chat/SDK errors via runtime hooks (Electron can forward to Sentry)
        sessionRuntimeHooks.captureException(error, {
          errorSource: 'chat',
          sessionId,
        })

        sendSpan.mark('chat.error')
        sendSpan.setMetadata(
          'error',
          error instanceof Error ? error.message : String(error),
        )
        sendSpan.end()
        this.sendEvent(
          {
            type: 'error',
            sessionId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          managed.workspace.id,
        )
        // Handle error via centralized handler
        this.onProcessingStopped(sessionId, 'error')
      }
    } finally {
      // Only handle cleanup for unexpected exits (loop break without complete event)
      // Normal completion returns early after calling onProcessingStopped
      // Errors are handled in catch block
      if (
        managed.isProcessing &&
        managed.processingGeneration === myGeneration
      ) {
        sessionLog.info('Finally block cleanup - unexpected exit')
        sendSpan.mark('chat.unexpected_exit')
        sendSpan.end()
        this.onProcessingStopped(sessionId, 'interrupted')
      }
    }
  }

  async cancelProcessing(sessionId: string, silent = false): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.isProcessing) {
      return // Not processing, nothing to cancel
    }

    sessionLog.info(
      'Cancelling processing for session:',
      sessionId,
      silent ? '(silent)' : '',
    )

    // Collect queued message text for input restoration before clearing
    const queuedTexts = managed.messageQueue.map((q) => q.message)

    // Collect queued message IDs so we can remove them from the messages array
    // (they were added when sendMessage was called during processing)
    const queuedMessageIds = new Set(
      managed.messageQueue
        .map((q) => q.messageId)
        .filter((id): id is string => !!id),
    )

    // Clear queue - user explicitly stopped, don't process queued messages
    managed.messageQueue = []

    // Remove queued user messages from the persisted messages array
    if (queuedMessageIds.size > 0) {
      managed.messages = managed.messages.filter(
        (m) => !queuedMessageIds.has(m.id),
      )
    }

    // Signal intent to stop - let the event loop drain remaining events before clearing isProcessing
    // This prevents losing in-flight messages after soft interrupt
    managed.stopRequested = true

    // Track interruption so the next user message gets a context note
    // telling the LLM the previous response was cut short
    managed.wasInterrupted = true

    // Force-abort via Query.close() - sends soft interrupt to the backend
    if (managed.agent) {
      managed.agent.forceAbort(AbortReason.UserStop)
    }

    // Only show "Response interrupted" message when user explicitly clicked Stop
    // Silent mode is used when redirecting (sending new message while processing)
    if (!silent) {
      const interruptedMessage: Message = {
        id: generateMessageId(),
        role: 'info',
        content: 'Response interrupted',
        timestamp: this.monotonic(),
      }
      managed.messages.push(interruptedMessage)
      this.sendEvent(
        {
          type: 'interrupted',
          sessionId,
          message: interruptedMessage,
          // Include queued texts so the UI can restore them to the input field
          ...(queuedTexts.length > 0 ? { queuedMessages: queuedTexts } : {}),
        },
        managed.workspace.id,
      )
    } else {
      // Still send interrupted event but without the message (for UI state update)
      this.sendEvent(
        {
          type: 'interrupted',
          sessionId,
          // Include queued texts so the UI can restore them to the input field
          ...(queuedTexts.length > 0 ? { queuedMessages: queuedTexts } : {}),
        },
        managed.workspace.id,
      )
    }

    // Safety timeout: if event loop doesn't complete within 5 seconds, force cleanup
    // This handles cases where the generator gets stuck
    setTimeout(() => {
      if (managed.stopRequested && managed.isProcessing) {
        sessionLog.warn(
          'Generator did not complete after stop request, forcing cleanup',
        )
        this.onProcessingStopped(sessionId, 'timeout')
      }
    }, 5000)

    // NOTE: We don't clear isProcessing or send complete event here anymore.
    // The event loop will drain remaining events and call onProcessingStopped when done.
  }

  /**
   * Attempt auth retry: refresh token, destroy agent, resend last message.
   * Shared by both typed_error and plain error auth-retry paths.
   * Returns true if retry was initiated, false if conditions not met.
   */
  private attemptAuthRetry(
    sessionId: string,
    managed: ManagedSession,
    workspaceId: string,
    failureErrorCode?: string,
  ): boolean {
    if (managed.authRetryAttempted || !managed.lastSentMessage) return false

    sessionLog.info(
      `Auth error detected, attempting token refresh and retry for session ${sessionId}`,
    )
    managed.authRetryAttempted = true
    managed.authRetryInProgress = true

    // Emit lightweight info so the user sees progress instead of a scary red error
    this.sendEvent(
      {
        type: 'info',
        sessionId,
        message: 'Token expired, refreshing session…',
        timestamp: this.monotonic(),
      },
      workspaceId,
    )

    setImmediate(async () => {
      try {
        // 1. Reset summarization client so it picks up fresh credentials
        sessionLog.info(
          `[auth-retry] Resetting summarization client for session ${sessionId}`,
        )
        resetSummarizationClient()

        // 2. Destroy the agent — the new agent's postInit() will refresh auth
        sessionLog.info(
          `[auth-retry] Destroying agent for session ${sessionId}`,
        )
        managed.agent = null

        // 3. Retry the message
        const retryMessage = managed.lastSentMessage
        const retryAttachments = managed.lastSentAttachments
        const retryStoredAttachments = managed.lastSentStoredAttachments
        const retryOptions = managed.lastSentOptions

        if (retryMessage) {
          sessionLog.info(
            `[auth-retry] Retrying message for session ${sessionId}`,
          )
          this.setProcessing(managed, false)

          // Remove the user message that was added for this failed attempt
          // so we don't get duplicate messages when retrying
          const lastUserMsgIndex = managed.messages.findLastIndex(
            (m) => m.role === 'user',
          )
          if (lastUserMsgIndex !== -1) {
            managed.messages.splice(lastUserMsgIndex, 1)
          }

          managed.authRetryInProgress = false

          await this.sendMessage(
            sessionId,
            retryMessage,
            retryAttachments,
            retryStoredAttachments,
            retryOptions,
            undefined, // existingMessageId
            undefined, // eventClientId - keep the existing active route
            true, // _isAuthRetry - prevents infinite retry loop
          )
          sessionLog.info(
            `[auth-retry] Retry completed for session ${sessionId}`,
          )
        } else {
          managed.authRetryInProgress = false
        }
      } catch (retryError) {
        managed.authRetryInProgress = false
        sessionLog.error(
          `[auth-retry] Failed to retry after auth refresh for session ${sessionId}:`,
          retryError,
        )
        sessionRuntimeHooks.captureException(retryError, {
          errorSource: 'auth-retry',
          sessionId,
        })
        const failedMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          content: 'Authentication failed. Please check your credentials.',
          timestamp: this.monotonic(),
          errorCode: failureErrorCode,
        }
        managed.messages.push(failedMessage)
        this.sendEvent(
          {
            type: 'error',
            sessionId,
            error: 'Authentication failed. Please check your credentials.',
            timestamp: failedMessage.timestamp,
          },
          workspaceId,
        )
        this.onProcessingStopped(sessionId, 'error')
      }
    })

    return true
  }

  /**
   * Central handler for when processing stops (any reason).
   * Single source of truth for cleanup and queue processing.
   *
   * @param sessionId - The session that stopped processing
   * @param reason - Why processing stopped ('complete' | 'interrupted' | 'error')
   */
  private async onProcessingStopped(
    sessionId: string,
    reason: 'complete' | 'interrupted' | 'error' | 'timeout',
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    sessionLog.info(`Processing stopped for session ${sessionId}: ${reason}`)

    // 1. Cleanup state
    this.setProcessing(managed, false)
    managed.stopRequested = false // Reset for next turn

    if (
      managed.name &&
      managed.sdkSessionId &&
      managed.id !== managed.sdkSessionId
    ) {
      void this.syncExternalBackendTitleIfSupported(managed, managed.name)
    }

    const turnStartFinalMessageId = managed.turnStartFinalMessageId
    managed.turnStartFinalMessageId = undefined

    // Clear agent control overlay between turns. The session keeps browser
    // ownership (boundSessionId) — only the visual overlay is removed.
    // Full unbind happens below when the queue is empty (session truly done).
    if (this.browserPaneManager) {
      await this.browserPaneManager.clearVisualsForSession(sessionId)
    }

    // 2. Handle unread state based on whether user is viewing this session
    //    This is the explicit state machine for NEW badge:
    //    - If user is viewing: mark as read (they saw it complete)
    //    - If user is NOT viewing: mark as unread (they have new content)
    //    IMPORTANT: only apply this when the turn produced a NEW final assistant message.
    const isViewing = this.isSessionBeingViewed(
      sessionId,
      managed.workspace.id,
    )
    const currentFinalMessageId = this.getLastFinalAssistantMessageId(
      managed.messages,
    )
    const didReceiveNewFinalMessage =
      !!currentFinalMessageId &&
      currentFinalMessageId !== turnStartFinalMessageId

    if (reason === 'complete' && didReceiveNewFinalMessage) {
      if (isViewing) {
        // User is watching - mark as read immediately
        await this.markSessionRead(sessionId)
      } else {
        // User is not watching - mark as unread for NEW badge
        if (!managed.hasUnread) {
          managed.hasUnread = true
          await this.persistSessionMetadataUpdate(managed, { hasUnread: true })
          this.emitUnreadSummaryChanged()
        }
      }
    }

    // 3. Auto-complete mini agent sessions to avoid session list clutter
    //    Mini agents are spawned from EditPopovers for quick config edits
    //    and should automatically move to 'done' when finished
    if (
      reason === 'complete' &&
      managed.systemPromptPreset === 'mini' &&
      managed.sessionStatus !== 'done'
    ) {
      sessionLog.info(`Auto-completing mini agent session ${sessionId}`)
      await this.setSessionStatus(sessionId, 'done')
    }

    // 4. Apply deferred external metadata updates captured while processing.
    if (managed.pendingExternalMetadata) {
      const pendingHeader = managed.pendingExternalMetadata
      managed.pendingExternalMetadata = undefined
      sessionLog.info(
        `Applying deferred external metadata for session ${sessionId} after processing stop`,
      )
      this.applyExternalSessionMetadata(managed, pendingHeader)
    }
    if (this.isQwenCanonicalMessageSession(managed)) {
      this.markExternalMessagesLoadedThrough(managed)
    }

    // 5. Check queue and process or complete
    if (managed.messageQueue.length > 0) {
      // Has queued messages - process next
      this.processNextQueuedMessage(sessionId)
    } else {
      // Session is truly done — release browser ownership.
      // The window stays alive (hidden) and becomes reusable by future sessions.
      // On the next turn, getOrCreateForSession() will re-bind it.
      if (this.browserPaneManager) {
        await this.browserPaneManager.clearVisualsForSession(sessionId)
        this.browserPaneManager.unbindAllForSession(sessionId)
      }

      // No queue - emit complete to UI (include tokenUsage and hasUnread for state updates)
      this.sendEvent(
        {
          type: 'complete',
          sessionId,
          tokenUsage: managed.tokenUsage,
          hasUnread: managed.hasUnread, // Propagate unread state to renderer
        },
        managed.workspace.id,
      )
      this.sessionEventClientIds.delete(sessionId)
    }

    // 6. Always persist
    this.persistSession(managed)
  }

  /**
   * Process the next message in the queue.
   * Called by onProcessingStopped when queue has messages.
   */
  private processNextQueuedMessage(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.messageQueue.length === 0) return

    const next = managed.messageQueue.shift()!
    sessionLog.info(`Processing queued message for session ${sessionId}`)

    // Update UI: queued → processing
    if (next.messageId) {
      const existingMessage = managed.messages.find(
        (m) => m.id === next.messageId,
      )
      if (existingMessage) {
        // Clear isQueued flag and persist - prevents re-queueing if crash during processing
        existingMessage.isQueued = false
        this.persistSession(managed)

        this.sendEvent(
          {
            type: 'user_message',
            sessionId,
            message: existingMessage,
            status: 'processing',
            optimisticMessageId: next.optimisticMessageId,
          },
          managed.workspace.id,
        )
      }
    }

    // Process message (use setImmediate to allow current stack to clear)
    setImmediate(() => {
      this.sendMessage(
        sessionId,
        next.message,
        next.attachments,
        next.storedAttachments,
        next.options,
        next.messageId,
        next.eventClientId,
      ).catch((err) => {
        sessionLog.error('Error processing queued message:', err)
        // Report queued message failures via runtime hooks
        sessionRuntimeHooks.captureException(err, {
          errorSource: 'chat-queue',
          sessionId,
        })
        this.sendEvent(
          {
            type: 'error',
            sessionId,
            error: err instanceof Error ? err.message : 'Unknown error',
          },
          managed.workspace.id,
        )
        // Call onProcessingStopped to handle cleanup and check for more queued messages
        this.onProcessingStopped(sessionId, 'error')
      })
    })
  }

  async killShell(
    sessionId: string,
    shellId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    sessionLog.info(`Killing shell ${shellId} for session: ${sessionId}`)

    // Try to kill the actual process using the stored command
    const command = managed.backgroundShellCommands.get(shellId)
    if (command) {
      try {
        // Use pkill to find and kill processes matching the command
        // The -f flag matches against the full command line
        const { exec } = await import('child_process')
        const { promisify } = await import('util')
        const execAsync = promisify(exec)

        // Escape the command for use in pkill pattern
        // We search for the unique command string in process args
        const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

        sessionLog.info(
          `Attempting to kill process with command: ${command.slice(0, 100)}...`,
        )

        // Use pgrep first to find the PID, then kill it
        // This is safer than pkill -f which can match too broadly
        try {
          const { stdout } = await execAsync(`pgrep -f "${escapedCommand}"`)
          const pids = stdout.trim().split('\n').filter(Boolean)

          if (pids.length > 0) {
            sessionLog.info(
              `Found ${pids.length} process(es) to kill: ${pids.join(', ')}`,
            )
            // Kill each process
            for (const pid of pids) {
              try {
                await execAsync(`kill -TERM ${pid}`)
                sessionLog.info(`Sent SIGTERM to process ${pid}`)
              } catch (killErr) {
                // Process may have already exited
                sessionLog.warn(`Failed to kill process ${pid}: ${killErr}`)
              }
            }
          } else {
            sessionLog.info(`No processes found matching command`)
          }
        } catch {
          // pgrep returns exit code 1 when no processes found, which is fine
          sessionLog.info(
            `No matching processes found (pgrep returned no results)`,
          )
        }

        // Clean up the stored command
        managed.backgroundShellCommands.delete(shellId)
      } catch (err) {
        sessionLog.error(`Error killing shell process: ${err}`)
      }
    } else {
      sessionLog.warn(
        `No command stored for shell ${shellId}, cannot kill process`,
      )
    }

    // Always emit shell_killed to remove from UI regardless of process kill success
    this.sendEvent(
      {
        type: 'shell_killed',
        sessionId,
        shellId,
      },
      managed.workspace.id,
    )

    return { success: true }
  }

  /**
   * Get output from a background task
   *
   * Looks up the output file stored when a task_completed event was received,
   * reads its contents, and returns them. Falls back to the SDK-provided summary
   * if the file cannot be read.
   *
   * @param taskId - The task or shell ID
   * @returns Task output content, or null if task not found
   */
  async getTaskOutput(taskId: string): Promise<string | null> {
    // O(1) lookup via taskOutputIndex
    const sessionId = this.taskOutputIndex.get(taskId)
    if (!sessionId) {
      sessionLog.info(
        `No output found for task: ${taskId} (task may still be running)`,
      )
      return null
    }

    const managed = this.sessions.get(sessionId)
    const info = managed?.backgroundTaskOutputs.get(taskId)
    if (!info) {
      // Index out of sync — clean up stale entry
      this.taskOutputIndex.delete(taskId)
      return null
    }

    sessionLog.info(
      `Found output for task ${taskId}: file=${info.outputFile}, status=${info.status}`,
    )
    try {
      const content = await readFile(info.outputFile, 'utf-8')
      // Delete after successful read to prevent memory leak
      managed!.backgroundTaskOutputs.delete(taskId)
      this.taskOutputIndex.delete(taskId)
      return content
    } catch (err) {
      sessionLog.error(
        `Failed to read task output file: ${info.outputFile}`,
        err,
      )
      // Fall back to SDK-provided summary
      return info.summary || null
    }
  }

  /**
   * Respond to a pending permission request
   * Returns true if the response was delivered, false if agent/session is gone
   */
  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('@craft-agent/shared/protocol').PermissionResponseOptions,
  ): boolean {
    const managed = this.sessions.get(sessionId)
    if (managed?.agent) {
      const requestMeta = this.pendingPermissionRequests.get(requestId)
      this.pendingPermissionRequests.delete(requestId)

      if (requestMeta?.type === 'admin_approval') {
        const brokerResult = this.privilegedExecutionBroker.resolveApproval(
          requestId,
          allowed,
          {
            expectedCommandHash: requestMeta.commandHash,
          },
        )
        if (!brokerResult.ok) {
          sessionLog.warn(
            `Admin approval rejected by broker for ${requestId}: ${brokerResult.reason}`,
          )
          // Broker rejection should fail closed.
          managed.agent.respondToPermission(requestId, false, false)
          return false
        }

        if (allowed && requestMeta.commandHash && options?.rememberForMinutes) {
          this.storeAdminRememberApproval(
            sessionId,
            requestMeta.commandHash,
            requestId,
            options.rememberForMinutes,
          )
        }
      }

      sessionLog.info(
        `Permission response for ${requestId}: allowed=${allowed}, alwaysAllow=${alwaysAllow}`,
      )
      managed.agent.respondToPermission(
        requestId,
        allowed,
        alwaysAllow,
        options,
      )
      return true
    } else {
      sessionLog.warn(
        `Cannot respond to permission - no agent for session ${sessionId}`,
      )
      return false
    }
  }

  /**
   * Respond to a pending credential request
   * Returns true if the response was delivered, false if no pending request found
   *
   * Supports both:
   * - New unified auth flow (via handleCredentialInput)
   * - Legacy callback flow (via pendingCredentialResolvers)
   */
  async respondToCredential(
    sessionId: string,
    requestId: string,
    response: import('@craft-agent/shared/protocol').CredentialResponse,
  ): Promise<boolean> {
    // First, check if this is a new unified auth flow request
    const managed = this.sessions.get(sessionId)
    if (
      managed?.pendingAuthRequest &&
      managed.pendingAuthRequest.requestId === requestId
    ) {
      sessionLog.info(
        `Credential response (unified flow) for ${requestId}: cancelled=${response.cancelled}`,
      )
      await this.handleCredentialInput(sessionId, requestId, response)
      return true
    }

    // Fall back to legacy callback flow
    const resolver = this.pendingCredentialResolvers.get(requestId)
    if (resolver) {
      sessionLog.info(
        `Credential response (legacy flow) for ${requestId}: cancelled=${response.cancelled}`,
      )
      resolver(response)
      this.pendingCredentialResolvers.delete(requestId)
      return true
    } else {
      sessionLog.warn(
        `Cannot respond to credential - no pending request for ${requestId}`,
      )
      return false
    }
  }

  async applyGlobalPermissionMode(
    mode: PermissionMode,
    options: {
      changedBy?: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
    } = {},
  ): Promise<void> {
    this.currentGlobalPermissionMode = mode
    const changedBy = options.changedBy ?? 'user'
    let changedCount = 0
    for (const managed of this.sessions.values()) {
      if (
        this.applyPermissionModeToManagedSession(managed, mode, changedBy, {
          suppressLog: true,
        })
      ) {
        changedCount += 1
      }
    }
    if (changedCount > 0 && changedBy !== 'restore') {
      sessionLog.info('Global permission mode applied', {
        permissionMode: mode,
        changedBy,
        changedCount,
      })
    }
  }

  /**
   * Set the app-wide permission mode. Every live session follows this value.
   */
  async setGlobalPermissionMode(
    mode: PermissionMode,
    options: {
      changedBy?: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
      preferredSessionId?: string
    } = {},
  ): Promise<void> {
    await this.applyGlobalPermissionMode(
      mode,
      options.changedBy ? { changedBy: options.changedBy } : {},
    )
    await this.persistQwenApprovalMode(mode, options.preferredSessionId)
  }

  /**
   * Existing session-scoped command entry point. Mode is app-wide now, so this
   * fans out to every session while preserving the old RPC shape.
   */
  async setSessionPermissionMode(
    sessionId: string,
    mode: PermissionMode,
  ): Promise<void> {
    await this.setGlobalPermissionMode(mode, { preferredSessionId: sessionId })
  }

  private applyPermissionModeToManagedSession(
    managed: ManagedSession,
    mode: PermissionMode,
    changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown',
    options: { suppressLog?: boolean } = {},
  ): boolean {
    const sessionId = managed.id
    const previousManagedMode = managed.permissionMode ?? 'ask'
    const diagnosticsBefore = getPermissionModeDiagnostics(sessionId)
    const previousEffectiveMode = diagnosticsBefore.permissionMode

    // No-op only when BOTH managed state and mode-manager state already match.
    // If managed state matches but diagnostics drifted, heal authoritative mode state.
    if (previousManagedMode === mode && previousEffectiveMode === mode) {
      return false
    }

    if (previousManagedMode === mode && previousEffectiveMode !== mode) {
      sessionLog.warn(
        'Permission mode drift detected on same-mode update; reconciling authoritative mode state',
        {
          sessionId,
          managedMode: previousManagedMode,
          diagnosticsMode: previousEffectiveMode,
          targetMode: mode,
          modeVersion: diagnosticsBefore.modeVersion,
          changedBy: diagnosticsBefore.lastChangedBy,
        },
      )
    }

    managed.permissionMode = mode

    if (previousEffectiveMode !== mode) {
      setPermissionMode(sessionId, mode, {
        changedBy: previousManagedMode === mode ? 'restore' : changedBy,
        suppressLog: options.suppressLog,
      })
    }

    const diagnostics = getPermissionModeDiagnostics(sessionId)
    managed.previousPermissionMode = diagnostics.previousPermissionMode
    if (!options.suppressLog) {
      sessionLog.info('Permission mode changed', {
        sessionId,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
      })
    }

    if (managed.agent) {
      managed.agent.setPermissionMode(mode)
    }

    this.sendEvent(
      {
        type: 'permission_mode_changed',
        sessionId: managed.id,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
        previousPermissionMode: diagnostics.previousPermissionMode,
        transitionDisplay: diagnostics.transitionDisplay,
      },
      managed.workspace.id,
    )
    return true
  }

  private async persistQwenApprovalMode(
    mode: PermissionMode,
    preferredSessionId?: string,
  ): Promise<void> {
    const preferred = preferredSessionId
      ? this.sessions.get(preferredSessionId)
      : undefined
    const candidates = [
      ...(preferred ? [preferred] : []),
      ...[...this.sessions.values()].filter((s) => s !== preferred),
    ]

    for (const managed of candidates) {
      const agent = managed.agent
      if (!agent || !canManageQwenSettings(agent)) continue
      try {
        await agent.setCoreSetting(
          'user',
          'tools.approvalMode',
          mapPermissionModeToQwenApprovalMode(mode),
        )
        return
      } catch (error) {
        sessionLog.warn('Failed to persist Qwen approval mode via ACP', {
          sessionId: managed.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async getSessionPermissionSettings(
    sessionId: string,
  ): Promise<QwenPermissionSettings> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManagePermissionSettings(agent)) {
      throw new Error(
        'This session backend does not expose Qwen permission settings',
      )
    }

    return agent.getPermissionSettings()
  }

  async setSessionPermissionRules(
    sessionId: string,
    scope: PermissionSettingsScope,
    ruleType: PermissionRuleType,
    rules: string[],
  ): Promise<QwenPermissionSettings> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManagePermissionSettings(agent)) {
      throw new Error(
        'This session backend does not expose Qwen permission settings',
      )
    }

    return agent.setPermissionRules(scope, ruleType, rules)
  }

  async getSessionQwenCoreSettings(
    sessionId: string,
  ): Promise<QwenCoreSettingsSnapshot> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManageQwenSettings(agent)) {
      throw new Error('This session backend does not expose Qwen settings')
    }

    return agent.getCoreSettings()
  }

  async listSessionQwenProviders(
    sessionId: string,
  ): Promise<QwenProviderCatalog> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManageQwenProviders(agent)) {
      throw new Error('This session backend does not expose Qwen providers')
    }

    return agent.listProviders()
  }

  async connectSessionQwenProvider(
    sessionId: string,
    params: QwenProviderConnectParams,
  ): Promise<QwenProviderConnectResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManageQwenProviders(agent)) {
      throw new Error('This session backend does not expose Qwen providers')
    }

    return agent.connectProvider(params)
  }

  async setSessionQwenCoreSetting(
    sessionId: string,
    scope: QwenSettingsScope,
    key: QwenCoreSettingKey,
    value: QwenSettingValue,
  ): Promise<QwenCoreSettingsSnapshot> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManageQwenSettings(agent)) {
      throw new Error('This session backend does not expose Qwen settings')
    }

    return agent.setCoreSetting(scope, key, value)
  }

  async setSessionQwenMcpServer(
    sessionId: string,
    scope: QwenSettingsScope,
    name: string,
    server: QwenMcpServerConfig,
  ): Promise<QwenCoreSettingsSnapshot> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManageQwenSettings(agent)) {
      throw new Error('This session backend does not expose Qwen settings')
    }

    return agent.setMcpServer(scope, name, server)
  }

  async removeSessionQwenMcpServer(
    sessionId: string,
    scope: QwenSettingsScope,
    name: string,
  ): Promise<QwenCoreSettingsSnapshot> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManageQwenSettings(agent)) {
      throw new Error('This session backend does not expose Qwen settings')
    }

    return agent.removeMcpServer(scope, name)
  }

  async setSessionQwenHook(
    sessionId: string,
    scope: QwenSettingsScope,
    event: QwenHookEvent,
    index: number | undefined,
    hook: QwenHookDefinition,
  ): Promise<QwenCoreSettingsSnapshot> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManageQwenSettings(agent)) {
      throw new Error('This session backend does not expose Qwen settings')
    }

    return agent.setHook(scope, event, index, hook)
  }

  async removeSessionQwenHook(
    sessionId: string,
    scope: QwenSettingsScope,
    event: QwenHookEvent,
    index: number,
  ): Promise<QwenCoreSettingsSnapshot> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManageQwenSettings(agent)) {
      throw new Error('This session backend does not expose Qwen settings')
    }

    return agent.removeHook(scope, event, index)
  }

  async setSessionQwenExtensionSetting(
    sessionId: string,
    extensionId: string,
    settingKey: string,
    scope: QwenSettingsScope,
    value: QwenSettingValue,
  ): Promise<QwenCoreSettingsSnapshot> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const agent = await this.getOrCreateAgent(managed)
    if (!canManageQwenSettings(agent)) {
      throw new Error('This session backend does not expose Qwen settings')
    }

    return agent.setExtensionSetting(extensionId, settingKey, scope, value)
  }

  /**
   * Get authoritative permission mode diagnostics for a session.
   * Used by renderer to reconcile optimistic/stale mode state.
   */
  getSessionPermissionModeState(sessionId: string): {
    permissionMode: PermissionMode
    previousPermissionMode?: PermissionMode
    transitionDisplay?: string
    modeVersion: number
    changedAt: string
    changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
  } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null

    let diagnostics = getPermissionModeDiagnostics(sessionId)

    // Hydrate persisted transition context when mode-manager has been reset (e.g. app restart).
    if (managed.previousPermissionMode && !diagnostics.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    const globalPermissionMode = this.currentGlobalPermissionMode
    if (managed.permissionMode !== globalPermissionMode) {
      managed.permissionMode = globalPermissionMode
    }

    // Heal restore races where mode-manager still has stale session state while
    // the app-wide permission mode is authoritative.
    if (diagnostics.permissionMode !== globalPermissionMode) {
      sessionLog.warn(
        'Permission mode diagnostics mismatch, reconciling to global mode',
        {
          sessionId,
          globalMode: globalPermissionMode,
          diagnosticsMode: diagnostics.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
        },
      )
      setPermissionMode(sessionId, globalPermissionMode, {
        changedBy: 'restore',
      })
      if (managed.previousPermissionMode) {
        hydratePreviousPermissionMode(
          sessionId,
          managed.previousPermissionMode,
        )
      }
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    managed.previousPermissionMode = diagnostics.previousPermissionMode

    return {
      permissionMode: diagnostics.permissionMode,
      previousPermissionMode: diagnostics.previousPermissionMode,
      transitionDisplay: diagnostics.transitionDisplay,
      modeVersion: diagnostics.modeVersion,
      changedAt: diagnostics.lastChangedAt,
      changedBy: diagnostics.lastChangedBy,
    }
  }

  /**
   * Set labels for a session (additive tags, many-per-session).
   * Labels are IDs referencing workspace labels/config.json.
   */
  setSessionLabels(sessionId: string, labels: string[]): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.labels = labels
      // Guard: suppress external metadata revert from fs.watch during atomic write
      managed._metadataWriteGuardUntil = Date.now() + 5000

      this.sendEvent(
        {
          type: 'labels_changed',
          sessionId: managed.id,
          labels: managed.labels,
        },
        managed.workspace.id,
      )
      // Persist to disk
      this.persistSession(managed)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  private async refreshDraftAvailableCommands(
    options: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    availableCommands?: AvailableCommandsSnapshot['availableCommands']
    availableSkills?: string[]
    availableSkillDetails?: AvailableCommandsSnapshot['availableSkillDetails']
    error?: string
  }> {
    if (!options.workspaceId) {
      return {
        success: false,
        error: 'Workspace is required for draft slash command discovery',
      }
    }

    const workspace = getWorkspaceByNameOrId(options.workspaceId)
    if (!workspace) {
      return {
        success: false,
        error: `Workspace ${options.workspaceId} not found`,
      }
    }

    const workspaceConfig = loadWorkspaceConfig(workspace.rootPath)
    const workingDirectory =
      options.workingDirectory ??
      workspaceConfig?.defaults?.workingDirectory ??
      undefined
    const permissionMode =
      options.permissionMode ?? this.currentGlobalPermissionMode
    const thinkingLevel =
      normalizeThinkingLevel(options.thinkingLevel) ??
      normalizeThinkingLevel(workspaceConfig?.defaults?.thinkingLevel) ??
      getDefaultThinkingLevel()
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: options.llmConnection,
      workspaceDefaultConnectionSlug:
        workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: options.model,
    })
    const connection = backendContext.connection

    if (backendContext.provider !== 'qwen') {
      return {
        success: false,
        error: 'Provider does not support slash command discovery',
      }
    }

    sessionLog.info('refreshAvailableCommands: starting draft discovery', {
      workspaceId: workspace.id,
      llmConnection: connection?.slug ?? options.llmConnection,
      workingDirectory,
    })

    let agent: AgentInstance | undefined
    try {
      agent = await this.createDraftAgent({
        workspace,
        workspaceConfig,
        backendContext,
        connectionSlug: options.llmConnection,
        workingDirectory,
        model: options.model,
        permissionMode,
        thinkingLevel,
        enabledSourceSlugs: options.enabledSourceSlugs,
        debugPrefix: 'draft slash',
      })

      if (!agent.refreshAvailableCommands) {
        return {
          success: false,
          error: 'Provider does not support slash command discovery',
        }
      }

      const snapshot = await agent.refreshAvailableCommands()
      if (
        !snapshot ||
        (snapshot.availableCommands.length === 0 &&
          (!snapshot.availableSkills || snapshot.availableSkills.length === 0))
      ) {
        sessionLog.warn(
          'refreshAvailableCommands: draft discovery returned no commands',
          {
            llmConnection: connection?.slug ?? options.llmConnection,
            workingDirectory,
          },
        )
        return {
          success: false,
          error: 'No provider slash commands available',
        }
      }

      sessionLog.info(
        'refreshAvailableCommands: draft discovery received commands',
        {
          sessionId: agent.getSessionId(),
          commandCount: snapshot.availableCommands.length,
          skillCount: snapshot.availableSkills?.length ?? 0,
          skillDetailCount: snapshot.availableSkillDetails?.length ?? 0,
          commandNames: snapshot.availableCommands.map(
            (command) => command.name,
          ),
          skillNames: snapshot.availableSkills ?? [],
        },
      )

      return { success: true, ...snapshot }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(
        `refreshAvailableCommands draft discovery failed: ${message}`,
      )
      return { success: false, error: message }
    } finally {
      if (agent) {
        await this.cleanupDraftAgent(
          agent,
          workspace,
          workingDirectory,
          'draft discovery complete',
        )
      }
    }
  }

  private async installDraftQwenSkill(
    skill: QwenSkillInstallRequest,
    options: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    skill?: QwenSkillInstallResult
    availableCommands?: AvailableCommandsSnapshot['availableCommands']
    availableSkills?: string[]
    availableSkillDetails?: AvailableCommandsSnapshot['availableSkillDetails']
    error?: string
  }> {
    if (!options.workspaceId) {
      return {
        success: false,
        error: 'Workspace is required for draft skill installation',
      }
    }

    const workspace = getWorkspaceByNameOrId(options.workspaceId)
    if (!workspace) {
      return {
        success: false,
        error: `Workspace ${options.workspaceId} not found`,
      }
    }

    const workspaceConfig = loadWorkspaceConfig(workspace.rootPath)
    const workingDirectory =
      options.workingDirectory ??
      workspaceConfig?.defaults?.workingDirectory ??
      undefined
    const permissionMode =
      options.permissionMode ?? this.currentGlobalPermissionMode
    const thinkingLevel =
      normalizeThinkingLevel(options.thinkingLevel) ??
      normalizeThinkingLevel(workspaceConfig?.defaults?.thinkingLevel) ??
      getDefaultThinkingLevel()
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: options.llmConnection,
      workspaceDefaultConnectionSlug:
        workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: options.model,
    })
    const connection = backendContext.connection

    if (backendContext.provider !== 'qwen') {
      return {
        success: false,
        error: 'Provider does not support skill installation',
      }
    }

    sessionLog.info('installQwenSkill: starting draft installation', {
      workspaceId: workspace.id,
      llmConnection: connection?.slug ?? options.llmConnection,
      workingDirectory,
      skillId: skill.id,
      sourceUrl: skill.sourceUrl,
    })

    let agent: AgentInstance | undefined
    try {
      agent = await this.createDraftAgent({
        workspace,
        workspaceConfig,
        backendContext,
        connectionSlug: options.llmConnection,
        workingDirectory,
        model: options.model,
        permissionMode,
        thinkingLevel,
        enabledSourceSlugs: options.enabledSourceSlugs,
        debugPrefix: 'draft skill install',
      })

      if (!agent.installSkill) {
        return {
          success: false,
          error: 'Provider does not support skill installation',
        }
      }

      const installResult = await agent.installSkill(skill)
      let snapshot: AvailableCommandsSnapshot | null = null
      if (agent.refreshAvailableCommands) {
        try {
          snapshot = await agent.refreshAvailableCommands()
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error)
          sessionLog.warn(
            `installQwenSkill: post-install command refresh failed: ${message}`,
          )
        }
      }

      sessionLog.info('installQwenSkill: draft installation complete', {
        workspaceId: workspace.id,
        skillId: skill.id,
        installedSlug: installResult.slug,
        installedPath: installResult.installedPath,
        refreshedSkillCount: snapshot?.availableSkills?.length ?? 0,
      })

      return {
        success: true,
        skill: installResult,
        ...(snapshot ?? {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(`installQwenSkill draft installation failed: ${message}`)
      return { success: false, error: message }
    } finally {
      if (agent) {
        await this.cleanupDraftAgent(
          agent,
          workspace,
          workingDirectory,
          'draft skill installation complete',
        )
      }
    }
  }

  private async deleteDraftQwenSkill(
    skill: QwenSkillDeleteRequest,
    options: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    skill?: QwenSkillDeleteResult
    availableCommands?: AvailableCommandsSnapshot['availableCommands']
    availableSkills?: string[]
    availableSkillDetails?: AvailableCommandsSnapshot['availableSkillDetails']
    error?: string
  }> {
    if (!options.workspaceId) {
      return {
        success: false,
        error: 'Workspace is required for draft skill deletion',
      }
    }

    const workspace = getWorkspaceByNameOrId(options.workspaceId)
    if (!workspace) {
      return {
        success: false,
        error: `Workspace ${options.workspaceId} not found`,
      }
    }

    const workspaceConfig = loadWorkspaceConfig(workspace.rootPath)
    const workingDirectory =
      options.workingDirectory ??
      workspaceConfig?.defaults?.workingDirectory ??
      undefined
    const permissionMode =
      options.permissionMode ?? this.currentGlobalPermissionMode
    const thinkingLevel =
      normalizeThinkingLevel(options.thinkingLevel) ??
      normalizeThinkingLevel(workspaceConfig?.defaults?.thinkingLevel) ??
      getDefaultThinkingLevel()
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: options.llmConnection,
      workspaceDefaultConnectionSlug:
        workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: options.model,
    })

    if (backendContext.provider !== 'qwen') {
      return {
        success: false,
        error: 'Provider does not support skill deletion',
      }
    }

    let agent: AgentInstance | undefined
    try {
      agent = await this.createDraftAgent({
        workspace,
        workspaceConfig,
        backendContext,
        connectionSlug: options.llmConnection,
        workingDirectory,
        model: options.model,
        permissionMode,
        thinkingLevel,
        enabledSourceSlugs: options.enabledSourceSlugs,
        debugPrefix: 'draft skill delete',
      })

      if (!agent.deleteSkill) {
        return {
          success: false,
          error: 'Provider does not support skill deletion',
        }
      }

      const deleteResult = await agent.deleteSkill(skill)
      const snapshot = agent.refreshAvailableCommands
        ? await agent.refreshAvailableCommands().catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error)
            sessionLog.warn(
              `deleteQwenSkill: post-delete command refresh failed: ${message}`,
            )
            return null
          })
        : null

      return {
        success: true,
        skill: deleteResult,
        ...(snapshot ?? {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(`deleteQwenSkill draft deletion failed: ${message}`)
      return { success: false, error: message }
    } finally {
      if (agent) {
        await this.cleanupDraftAgent(
          agent,
          workspace,
          workingDirectory,
          'draft skill deletion complete',
        )
      }
    }
  }

  private async setDraftQwenSkillEnabled(
    skill: QwenSkillSetEnabledRequest,
    options: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    skill?: QwenSkillSetEnabledResult
    availableCommands?: AvailableCommandsSnapshot['availableCommands']
    availableSkills?: string[]
    availableSkillDetails?: AvailableCommandsSnapshot['availableSkillDetails']
    error?: string
  }> {
    if (!options.workspaceId) {
      return {
        success: false,
        error: 'Workspace is required for draft skill updates',
      }
    }

    const workspace = getWorkspaceByNameOrId(options.workspaceId)
    if (!workspace) {
      return {
        success: false,
        error: `Workspace ${options.workspaceId} not found`,
      }
    }

    const workspaceConfig = loadWorkspaceConfig(workspace.rootPath)
    const workingDirectory =
      options.workingDirectory ??
      workspaceConfig?.defaults?.workingDirectory ??
      undefined
    const permissionMode =
      options.permissionMode ?? this.currentGlobalPermissionMode
    const thinkingLevel =
      normalizeThinkingLevel(options.thinkingLevel) ??
      normalizeThinkingLevel(workspaceConfig?.defaults?.thinkingLevel) ??
      getDefaultThinkingLevel()
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: options.llmConnection,
      workspaceDefaultConnectionSlug:
        workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: options.model,
    })

    if (backendContext.provider !== 'qwen') {
      return {
        success: false,
        error: 'Provider does not support skill updates',
      }
    }

    let agent: AgentInstance | undefined
    try {
      agent = await this.createDraftAgent({
        workspace,
        workspaceConfig,
        backendContext,
        connectionSlug: options.llmConnection,
        workingDirectory,
        model: options.model,
        permissionMode,
        thinkingLevel,
        enabledSourceSlugs: options.enabledSourceSlugs,
        debugPrefix: 'draft skill update',
      })

      if (!agent.setSkillEnabled) {
        return {
          success: false,
          error: 'Provider does not support skill updates',
        }
      }

      const updateResult = await agent.setSkillEnabled(skill)
      const snapshot = agent.refreshAvailableCommands
        ? await agent.refreshAvailableCommands().catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error)
            sessionLog.warn(
              `setQwenSkillEnabled: post-update command refresh failed: ${message}`,
            )
            return null
          })
        : null

      return {
        success: true,
        skill: updateResult,
        ...(snapshot ?? {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(`setQwenSkillEnabled draft update failed: ${message}`)
      return { success: false, error: message }
    } finally {
      if (agent) {
        await this.cleanupDraftAgent(
          agent,
          workspace,
          workingDirectory,
          'draft skill update complete',
        )
      }
    }
  }

  async refreshAvailableCommands(
    sessionId: string,
    options?: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    availableCommands?: AvailableCommandsSnapshot['availableCommands']
    availableSkills?: string[]
    availableSkillDetails?: AvailableCommandsSnapshot['availableSkillDetails']
    error?: string
  }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      if (options?.workspaceId) {
        return this.refreshDraftAvailableCommands(options)
      }
      sessionLog.warn(
        `refreshAvailableCommands: session ${sessionId} not found`,
      )
      return { success: false, error: 'Session not found' }
    }
    if (options?.workspaceId && managed.workspace.id !== options.workspaceId) {
      sessionLog.warn('refreshAvailableCommands: session workspace mismatch', {
        sessionId,
        sessionWorkspaceId: managed.workspace.id,
        requestedWorkspaceId: options.workspaceId,
      })
      return this.refreshDraftAvailableCommands(options)
    }

    sessionLog.info('refreshAvailableCommands: starting', {
      sessionId,
      hasAgent: !!managed.agent,
      llmConnection: managed.llmConnection,
      workingDirectory: managed.workingDirectory,
      existingCommandCount: managed.availableCommands?.length ?? 0,
      existingSkillCount: managed.availableSkills?.length ?? 0,
      existingSkillDetailCount: managed.availableSkillDetails?.length ?? 0,
    })

    try {
      const reusedAgent = !!managed.agent
      const agent = await this.getOrCreateAgent(managed)
      sessionLog.info('refreshAvailableCommands: agent ready', {
        sessionId,
        reusedAgent,
        sdkSessionId: managed.sdkSessionId ?? null,
      })
      if (!agent.refreshAvailableCommands) {
        sessionLog.info(
          'refreshAvailableCommands: provider does not support discovery',
          {
            sessionId,
            llmConnection: managed.llmConnection,
          },
        )
        return {
          success: false,
          error: 'Provider does not support slash command discovery',
        }
      }

      const snapshot = await agent.refreshAvailableCommands()
      if (
        !snapshot ||
        (snapshot.availableCommands.length === 0 &&
          (!snapshot.availableSkills || snapshot.availableSkills.length === 0))
      ) {
        sessionLog.warn('refreshAvailableCommands: no commands returned', {
          sessionId,
          llmConnection: managed.llmConnection,
        })
        return {
          success: false,
          error: 'No provider slash commands available',
        }
      }

      sessionLog.info('refreshAvailableCommands: received commands', {
        sessionId,
        commandCount: snapshot.availableCommands.length,
        skillCount: snapshot.availableSkills?.length ?? 0,
        skillDetailCount: snapshot.availableSkillDetails?.length ?? 0,
        commandNames: snapshot.availableCommands.map((command) => command.name),
        skillNames: snapshot.availableSkills ?? [],
      })
      this.applyAvailableCommandsSnapshot(
        managed,
        snapshot,
        'explicit refresh',
      )

      return { success: true, ...snapshot }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(
        `refreshAvailableCommands failed for session ${sessionId}: ${message}`,
      )
      return { success: false, error: message }
    }
  }

  async installQwenSkill(
    sessionId: string,
    skill: QwenSkillInstallRequest,
    options?: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    skill?: QwenSkillInstallResult
    availableCommands?: AvailableCommandsSnapshot['availableCommands']
    availableSkills?: string[]
    availableSkillDetails?: AvailableCommandsSnapshot['availableSkillDetails']
    error?: string
  }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      if (options?.workspaceId) {
        return this.installDraftQwenSkill(skill, options)
      }
      sessionLog.warn(`installQwenSkill: session ${sessionId} not found`)
      return { success: false, error: 'Session not found' }
    }

    sessionLog.info('installQwenSkill: starting', {
      sessionId,
      skillId: skill.id,
      sourceUrl: skill.sourceUrl,
      hasAgent: !!managed.agent,
      llmConnection: managed.llmConnection,
      workingDirectory: managed.workingDirectory,
    })

    try {
      const agent = await this.getOrCreateAgent(managed)
      if (!agent.installSkill) {
        return {
          success: false,
          error: 'Provider does not support skill installation',
        }
      }

      const installResult = await agent.installSkill(skill)
      let snapshot: AvailableCommandsSnapshot | null = null
      if (agent.refreshAvailableCommands) {
        snapshot = await agent.refreshAvailableCommands()
        if (snapshot) {
          this.applyAvailableCommandsSnapshot(
            managed,
            snapshot,
            'skill install refresh',
          )
        }
      }

      return {
        success: true,
        skill: installResult,
        ...(snapshot ?? {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(
        `installQwenSkill failed for session ${sessionId}: ${message}`,
      )
      return { success: false, error: message }
    }
  }

  async deleteQwenSkill(
    sessionId: string,
    skill: QwenSkillDeleteRequest,
    options?: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    skill?: QwenSkillDeleteResult
    availableCommands?: AvailableCommandsSnapshot['availableCommands']
    availableSkills?: string[]
    availableSkillDetails?: AvailableCommandsSnapshot['availableSkillDetails']
    error?: string
  }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      if (options?.workspaceId) {
        return this.deleteDraftQwenSkill(skill, options)
      }
      sessionLog.warn(`deleteQwenSkill: session ${sessionId} not found`)
      return { success: false, error: 'Session not found' }
    }

    try {
      const agent = await this.getOrCreateAgent(managed)
      if (!agent.deleteSkill) {
        return {
          success: false,
          error: 'Provider does not support skill deletion',
        }
      }

      const deleteResult = await agent.deleteSkill(skill)
      let snapshot: AvailableCommandsSnapshot | null = null
      if (agent.refreshAvailableCommands) {
        snapshot = await agent.refreshAvailableCommands()
        if (snapshot) {
          this.applyAvailableCommandsSnapshot(
            managed,
            snapshot,
            'skill delete refresh',
          )
        }
      }

      return {
        success: true,
        skill: deleteResult,
        ...(snapshot ?? {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(
        `deleteQwenSkill failed for session ${sessionId}: ${message}`,
      )
      return { success: false, error: message }
    }
  }

  async setQwenSkillEnabled(
    sessionId: string,
    skill: QwenSkillSetEnabledRequest,
    options?: RefreshAvailableCommandsOptions,
  ): Promise<{
    success: boolean
    skill?: QwenSkillSetEnabledResult
    availableCommands?: AvailableCommandsSnapshot['availableCommands']
    availableSkills?: string[]
    availableSkillDetails?: AvailableCommandsSnapshot['availableSkillDetails']
    error?: string
  }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      if (options?.workspaceId) {
        return this.setDraftQwenSkillEnabled(skill, options)
      }
      sessionLog.warn(`setQwenSkillEnabled: session ${sessionId} not found`)
      return { success: false, error: 'Session not found' }
    }

    try {
      const agent = await this.getOrCreateAgent(managed)
      if (!agent.setSkillEnabled) {
        return {
          success: false,
          error: 'Provider does not support skill updates',
        }
      }

      const updateResult = await agent.setSkillEnabled(skill)
      let snapshot: AvailableCommandsSnapshot | null = null
      if (agent.refreshAvailableCommands) {
        snapshot = await agent.refreshAvailableCommands()
        if (snapshot) {
          this.applyAvailableCommandsSnapshot(
            managed,
            snapshot,
            'skill enabled refresh',
          )
        }
      }

      return {
        success: true,
        skill: updateResult,
        ...(snapshot ?? {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(
        `setQwenSkillEnabled failed for session ${sessionId}: ${message}`,
      )
      return { success: false, error: message }
    }
  }

  /**
   * Set the thinking level for a session. See {@link ThinkingLevel} for valid values.
   * This is sticky and persisted across messages.
   */
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      // Update thinking level in managed session
      managed.thinkingLevel = level

      // Update the agent's thinking level if it exists
      if (managed.agent) {
        managed.agent.setThinkingLevel(level)
      }

      sessionLog.info(`Session ${sessionId}: thinking level set to ${level}`)
      // Persist to disk
      this.persistSession(managed)
    }
  }

  /**
   * Generate an AI title for a session from the user's first message.
   * Uses the agent's generateTitle() method which handles provider-specific SDK calls.
   * If no agent exists, creates a temporary one using the session's connection.
   */
  private async generateTitle(
    managed: ManagedSession,
    userMessage: string,
  ): Promise<void> {
    sessionLog.info(`[generateTitle] Starting for session ${managed.id}`)

    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    // Wait briefly for agent to be created (it's created concurrently)
    if (!agent) {
      let attempts = 0
      while (!managed.agent && attempts < 10) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        attempts++
      }
      agent = managed.agent
    }

    // If still no agent, create a temporary one using the session's connection
    if (!agent && managed.llmConnection) {
      try {
        const connection = getLlmConnection(managed.llmConnection)

        agent = createBackendFromConnection(
          managed.llmConnection,
          {
            workspace: managed.workspace,
            miniModel: connection
              ? (getMiniModel(connection) ?? connection.defaultModel)
              : undefined,
            session: {
              id: `title-${managed.id}`,
              workspaceRootPath: managed.workspace.rootPath,
              llmConnection: managed.llmConnection,
              createdAt: Date.now(),
              lastUsedAt: Date.now(),
            },
            isHeadless: true,
          },
          buildBackendHostRuntimeContext(),
        ) as AgentInstance
        await agent.postInit()
        isTemporary = true
        sessionLog.info(
          `[generateTitle] Created temporary agent for session ${managed.id}`,
        )
      } catch (error) {
        sessionLog.error(
          `[generateTitle] Failed to create temporary agent:`,
          error,
        )
        return
      }
    }

    if (!agent) {
      sessionLog.warn(
        `[generateTitle] No agent and no connection for session ${managed.id}`,
      )
      return
    }

    try {
      const genLangCode = (i18n.resolvedLanguage ?? 'en') as LanguageCode
      const genLangEntry = LOCALE_REGISTRY[genLangCode]
      const title = await agent.generateTitle(userMessage, {
        language: genLangEntry?.nativeName,
      })
      if (title) {
        await this.syncExternalBackendTitleIfSupported(managed, title)
        managed.name = title
        this.persistSession(managed)
        // Flush immediately to ensure disk is up-to-date before notifying renderer.
        // This prevents race condition where lazy loading reads stale disk data
        // (the persistence queue has a 500ms debounce).
        await this.flushSession(managed.id)
        // Now safe to notify renderer - disk is authoritative
        this.sendEvent(
          { type: 'title_generated', sessionId: managed.id, title },
          managed.workspace.id,
        )
        sessionLog.info(
          `Generated title for session ${managed.id}: "${title}"`,
        )
      } else {
        sessionLog.warn(
          `Title generation returned null for session ${managed.id}`,
        )
      }
    } catch (error) {
      sessionLog.error(
        `Failed to generate title for session ${managed.id}:`,
        error,
      )

      // Surface quota/auth errors to the user — these indicate the main chat call will also fail
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (
        errorMsg.includes('quota') ||
        errorMsg.includes('429') ||
        errorMsg.includes('401') ||
        errorMsg.includes('insufficient')
      ) {
        this.sendEvent(
          {
            type: 'typed_error',
            sessionId: managed.id,
            error: {
              code: 'provider_error',
              title: 'API Error',
              message: `API error: ${errorMsg.slice(0, 200)}`,
              actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
              canRetry: true,
            },
          },
          managed.workspace.id,
        )
      }
    } finally {
      // Clean up temporary agent
      if (isTemporary && agent) {
        agent.destroy()
      }
    }
  }

  private async processEvent(
    managed: ManagedSession,
    event: AgentEvent,
  ): Promise<void> {
    const sessionId = managed.id
    const workspaceId = managed.workspace.id

    switch (event.type) {
      case 'text_delta':
        managed.streamingText += event.text
        // Queue delta for batched sending (performance: reduces IPC from 50+/sec to ~20/sec)
        this.queueDelta(sessionId, workspaceId, event.text, event.turnId)
        break

      case 'text_complete': {
        // Flush any pending deltas before sending complete (ensures renderer has all content)
        this.flushDelta(sessionId, workspaceId)

        const assistantMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: event.text,
          timestamp: this.monotonic(),
          isIntermediate: event.isIntermediate,
          intermediateKind: event.intermediateKind,
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
        }
        managed.messages.push(assistantMessage)
        managed.streamingText = ''

        // Update lastMessageRole and lastFinalMessageId for badge/unread display (only for final messages)
        if (!event.isIntermediate) {
          managed.lastMessageRole = 'assistant'
          managed.lastFinalMessageId = assistantMessage.id
        }

        this.sendEvent(
          {
            type: 'text_complete',
            sessionId,
            text: event.text,
            isIntermediate: event.isIntermediate,
            intermediateKind: event.intermediateKind,
            turnId: event.turnId,
            parentToolUseId: event.parentToolUseId,
            timestamp: assistantMessage.timestamp,
            messageId: assistantMessage.id,
          },
          workspaceId,
        )

        // Persist session after complete message to prevent data loss on quit
        this.persistSession(managed)
        break
      }

      case 'tool_start': {
        // Format tool input paths to relative for better readability
        const formattedToolInput = formatToolInputPaths(event.input)

        // Resolve call_llm model for TurnCard badge display.
        // Resolve call_llm model short names to full IDs for display.
        if (
          event.toolName === 'mcp__session__call_llm' &&
          formattedToolInput?.model
        ) {
          const shortName = String(formattedToolInput.model)
          const modelDef =
            MODEL_REGISTRY.find((m) => m.id === shortName) ||
            MODEL_REGISTRY.find(
              (m) => m.shortName.toLowerCase() === shortName.toLowerCase(),
            ) ||
            MODEL_REGISTRY.find(
              (m) => m.name.toLowerCase() === shortName.toLowerCase(),
            )
          if (modelDef) {
            formattedToolInput.model = modelDef.id
          }
        }

        // Resolve tool display metadata (icon, displayName) for skills/sources
        // Only resolve when we have input (second event for SDK dual-event pattern)
        const workspaceRootPath = managed.workspace.rootPath
        let toolDisplayMeta: ToolDisplayMeta | undefined
        if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
          const allSources = loadAllSources(workspaceRootPath)
          toolDisplayMeta = await resolveToolDisplayMeta(
            event.toolName,
            formattedToolInput,
            workspaceRootPath,
            allSources,
          )
        }

        // Check if a message with this toolUseId already exists FIRST
        // SDK sends two events per tool: first from stream_event (empty input),
        // second from assistant message (complete input)
        const existingStartMsg = managed.messages.find(
          (m) => m.toolUseId === event.toolUseId,
        )
        const isDuplicateEvent = !!existingStartMsg

        // Use parentToolUseId directly from the event — CraftAgent resolves this
        // from SDK's parent_tool_use_id (authoritative, handles parallel Tasks correctly).
        // No stack or map needed; the event carries the correct parent from the start.
        const parentToolUseId = event.parentToolUseId

        // Track if we need to send an event to the renderer
        // Send on: first occurrence OR when we have new input data to update
        let shouldSendEvent = !isDuplicateEvent

        if (existingStartMsg) {
          // Update existing message with complete input (second event has full input)
          if (
            formattedToolInput &&
            Object.keys(formattedToolInput).length > 0
          ) {
            const hadInputBefore =
              existingStartMsg.toolInput &&
              Object.keys(existingStartMsg.toolInput).length > 0
            existingStartMsg.toolInput = formattedToolInput
            // Send update event if we're adding input that wasn't there before
            if (!hadInputBefore) {
              shouldSendEvent = true
            }
          }
          // Also set parent if not already set
          if (parentToolUseId && !existingStartMsg.parentToolUseId) {
            existingStartMsg.parentToolUseId = parentToolUseId
          }
          // Set toolDisplayMeta if not already set (has base64 icon for viewer)
          if (toolDisplayMeta && !existingStartMsg.toolDisplayMeta) {
            existingStartMsg.toolDisplayMeta = toolDisplayMeta
          }
          // Update toolIntent if not already set (second event has intent from complete input)
          if (event.intent && !existingStartMsg.toolIntent) {
            existingStartMsg.toolIntent = event.intent
          }
          // Update toolDisplayName if not already set
          if (event.displayName && !existingStartMsg.toolDisplayName) {
            existingStartMsg.toolDisplayName = event.displayName
          }
        } else {
          // Add tool message immediately (will be updated on tool_result)
          // This ensures tool calls are persisted even if they don't complete
          const toolStartMessage: Message = {
            id: generateMessageId(),
            role: 'tool',
            content: `Running ${event.toolName}...`,
            timestamp: this.monotonic(),
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            toolInput: formattedToolInput,
            toolStatus: 'executing',
            toolIntent: event.intent,
            toolDisplayName: event.displayName,
            toolDisplayMeta, // Includes base64 icon for viewer compatibility
            turnId: event.turnId,
            parentToolUseId,
          }
          managed.messages.push(toolStartMessage)
        }

        // Activate browser agent control overlay on actionable browser tool starts.
        // Skip browser_tool help/release commands to avoid pointless overlay flashes.
        const shouldActivateOverlay = shouldActivateBrowserOverlay(
          event.toolName,
          formattedToolInput,
        )

        if (this.browserPaneManager && shouldActivateOverlay) {
          // Ensure first browser action in a turn gets an instance before overlay activation.
          this.browserPaneManager.getOrCreateForSession(sessionId)

          const resolvedDisplayName =
            toolDisplayMeta?.displayName ?? event.displayName ?? event.toolName
          this.browserPaneManager.setAgentControl(sessionId, {
            displayName: resolvedDisplayName,
            intent: event.intent,
          })
        }

        // Send event to renderer on first occurrence OR when input data is updated
        if (shouldSendEvent) {
          const timestamp = existingStartMsg?.timestamp ?? this.monotonic()
          this.sendEvent(
            {
              type: 'tool_start',
              sessionId,
              toolName: event.toolName,
              toolUseId: event.toolUseId,
              toolInput: formattedToolInput ?? {},
              toolIntent: event.intent,
              toolDisplayName: event.displayName,
              toolDisplayMeta, // Includes base64 icon for viewer compatibility
              turnId: event.turnId,
              parentToolUseId,
              timestamp,
            },
            workspaceId,
          )
        }
        break
      }

      case 'tool_result': {
        // toolName comes directly from CraftAgent (resolved via ToolIndex)
        const toolName = event.toolName || 'unknown'

        // Format absolute paths to relative paths for better readability
        const rawFormattedResult = event.result
          ? formatPathsToRelative(event.result)
          : ''

        // Safety net: prevent massive tool results from bloating session JSONL (protects all backends)
        const MAX_PERSISTED_RESULT_CHARS = 200_000 // ~50K tokens
        const formattedResult =
          rawFormattedResult.length > MAX_PERSISTED_RESULT_CHARS
            ? rawFormattedResult.slice(0, MAX_PERSISTED_RESULT_CHARS) +
              `\n\n[Truncated for storage: ${rawFormattedResult.length.toLocaleString()} chars total]`
            : rawFormattedResult

        // Some backends omit explicit isError but still prefix with [ERROR].
        const inferredError =
          event.isError === true ||
          /^\s*(\[ERROR\]|Error:|error:)/.test(formattedResult)

        // Update existing tool message (created on tool_start) instead of creating new one
        const existingToolMsg = managed.messages.find(
          (m) => m.toolUseId === event.toolUseId,
        )
        // Track if already completed to avoid sending duplicate events
        const wasAlreadyComplete = existingToolMsg?.toolStatus === 'completed'

        sessionLog.info(
          `RESULT MATCH: toolUseId=${event.toolUseId}, found=${!!existingToolMsg}, toolName=${existingToolMsg?.toolName || toolName}, wasComplete=${wasAlreadyComplete}`,
        )

        // parentToolUseId comes from CraftAgent (SDK-authoritative) or existing message
        const parentToolUseId =
          existingToolMsg?.parentToolUseId || event.parentToolUseId

        if (existingToolMsg) {
          // Keep lightweight status text in `content` and store full payload in `toolResult` only.
          existingToolMsg.toolResult = formattedResult
          existingToolMsg.toolStatus = inferredError ? 'error' : 'completed'
          existingToolMsg.isError = inferredError
          // If message doesn't have parent set, use event's parentToolUseId
          if (!existingToolMsg.parentToolUseId && event.parentToolUseId) {
            existingToolMsg.parentToolUseId = event.parentToolUseId
          }
        } else {
          // No matching tool_start found — create message from result.
          // This is normal for background subagent child tools where tool_result arrives
          // without a prior tool_start. If tool_start arrives later, findToolMessage will
          // locate this message by toolUseId and update it with input/intent/displayMeta.
          sessionLog.info(
            `RESULT WITHOUT START: toolUseId=${event.toolUseId}, toolName=${toolName} (creating message from result)`,
          )
          const fallbackWorkspaceRootPath = managed.workspace.rootPath
          const fallbackSources = loadAllSources(fallbackWorkspaceRootPath)
          const fallbackToolDisplayMeta = await resolveToolDisplayMeta(
            toolName,
            undefined,
            fallbackWorkspaceRootPath,
            fallbackSources,
          )

          const toolMessage: Message = {
            id: generateMessageId(),
            role: 'tool',
            content: '',
            timestamp: this.monotonic(),
            toolName,
            toolUseId: event.toolUseId,
            toolResult: formattedResult,
            toolStatus: inferredError ? 'error' : 'completed',
            toolDisplayMeta: fallbackToolDisplayMeta,
            parentToolUseId,
            isError: inferredError,
          }
          managed.messages.push(toolMessage)
        }

        // Send event to renderer if: (a) first completion, or (b) result content changed
        // (e.g., safety net auto-completed with empty result, then real result arrived later)
        const resultChanged =
          wasAlreadyComplete &&
          formattedResult &&
          existingToolMsg?.toolResult !== formattedResult
        if (!wasAlreadyComplete || resultChanged) {
          // Use existing tool message timestamp, or fallback message timestamp for ordering
          const toolResultTimestamp =
            existingToolMsg?.timestamp ??
            managed.messages.find((m) => m.toolUseId === event.toolUseId)
              ?.timestamp
          this.sendEvent(
            {
              type: 'tool_result',
              sessionId,
              toolUseId: event.toolUseId,
              toolName,
              result: formattedResult,
              turnId: event.turnId,
              parentToolUseId,
              isError: inferredError,
              timestamp: toolResultTimestamp,
            },
            workspaceId,
          )
        }

        // Safety net: when a parent Task completes, mark all its still-pending child tools as completed.
        // This handles the case where child tool_result events never arrive (e.g., subagent internal tools
        // whose results aren't surfaced through the parent stream).
        if (isParentTaskTool(toolName) || toolName === 'TaskOutput') {
          const pendingChildren = managed.messages.filter(
            (m) =>
              m.parentToolUseId === event.toolUseId &&
              m.toolStatus !== 'completed' &&
              m.toolStatus !== 'error',
          )
          for (const child of pendingChildren) {
            child.toolStatus = 'completed'
            child.toolResult = child.toolResult || ''
            sessionLog.info(
              `CHILD AUTO-COMPLETED: toolUseId=${child.toolUseId}, toolName=${child.toolName} (parent ${toolName} completed)`,
            )
            this.sendEvent(
              {
                type: 'tool_result',
                sessionId,
                toolUseId: child.toolUseId!,
                toolName: child.toolName || 'unknown',
                result: child.toolResult || '',
                turnId: child.turnId,
                parentToolUseId: event.toolUseId,
              },
              workspaceId,
            )
          }
        }

        // Persist session after tool completes to prevent data loss on quit
        this.persistSession(managed)
        break
      }

      case 'status':
        this.sendEvent(
          {
            type: 'status',
            sessionId,
            message: event.message,
            statusType: event.message.includes('Compacting')
              ? 'compacting'
              : undefined,
          },
          workspaceId,
        )
        break

      case 'info': {
        const isCompactionComplete = event.message.startsWith('Compacted')
        const infoTimestamp = this.monotonic()

        // Persist compaction messages so they survive reload
        // Other info messages are transient (just sent to renderer)
        if (isCompactionComplete) {
          const compactionMessage: Message = {
            id: generateMessageId(),
            role: 'info',
            content: event.message,
            timestamp: infoTimestamp,
            statusType: 'compaction_complete',
          }
          managed.messages.push(compactionMessage)

          // Mark compaction complete in the session state.
          // This is done here (backend) rather than in the renderer so it's
          // not affected by CMD+R during compaction. The frontend reload
          // recovery will see awaitingCompaction=false and trigger execution.
          void markStoredCompactionComplete(
            managed.workspace.rootPath,
            sessionId,
          )
          sessionLog.info(
            `Session ${sessionId}: compaction complete, marked pending plan ready`,
          )

          // Emit usage_update so the context count badge refreshes immediately
          // after compaction, without waiting for the next message
          if (managed.tokenUsage) {
            this.sendEvent(
              {
                type: 'usage_update',
                sessionId,
                tokenUsage: {
                  inputTokens: managed.tokenUsage.inputTokens,
                  contextWindow: managed.tokenUsage.contextWindow,
                },
              },
              workspaceId,
            )
          }
        }

        this.sendEvent(
          {
            type: 'info',
            sessionId,
            message: event.message,
            statusType: isCompactionComplete
              ? 'compaction_complete'
              : undefined,
            timestamp: infoTimestamp,
          },
          workspaceId,
        )
        break
      }

      case 'error': {
        // Skip errors after handoff (plan submission, auth request) — the SDK may emit
        // an error from the interrupted query after we've already stopped processing.
        if (!managed.isProcessing) {
          sessionLog.info(
            'Skipping error event after handoff/stop:',
            event.message,
          )
          break
        }

        // Skip abort errors - these are expected when force-aborting via Query.close()
        if (
          event.message.includes('aborted') ||
          event.message.includes('AbortError')
        ) {
          sessionLog.info(
            'Skipping abort error event (expected during interrupt)',
          )
          break
        }

        // Defensive: detect auth-expiry text in plain errors that weren't classified
        // as typed_error.
        const lowerErr = event.message.toLowerCase()
        const isPlainAuthError =
          lowerErr.includes('token is expired') ||
          lowerErr.includes('authentication token is expired') ||
          lowerErr.includes('please try signing in again') ||
          (lowerErr.includes('401') &&
            (lowerErr.includes('unauthorized') || lowerErr.includes('auth')))

        if (
          isPlainAuthError &&
          this.attemptAuthRetry(sessionId, managed, workspaceId)
        ) {
          break
        }

        // AgentEvent uses `message` not `error`
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          content: event.message,
          timestamp: this.monotonic(),
        }
        managed.messages.push(errorMessage)
        this.sendEvent(
          {
            type: 'error',
            sessionId,
            error: event.message,
            timestamp: errorMessage.timestamp,
          },
          workspaceId,
        )
        break
      }

      case 'typed_error': {
        // Skip errors after handoff (plan submission, auth request)
        if (!managed.isProcessing) {
          sessionLog.info(
            'Skipping typed_error event after handoff/stop:',
            event.error.message || event.error.title,
          )
          break
        }

        // Skip abort errors - these are expected when force-aborting via Query.close()
        const typedErrorMsg = event.error.message || event.error.title || ''
        if (
          typedErrorMsg.includes('aborted') ||
          typedErrorMsg.includes('AbortError')
        ) {
          sessionLog.info(
            'Skipping typed abort error event (expected during interrupt)',
          )
          break
        }
        // Typed errors have structured information - send both formats for compatibility
        sessionLog.info('typed_error:', JSON.stringify(event.error, null, 2))

        // Check for auth errors that can be retried by refreshing the token
        // The SDK subprocess caches the token at startup, so if it expires mid-session,
        // we get invalid_api_key errors. We can fix this by:
        // 1. Resetting the summarization client cache
        // 2. Destroying the agent (new agent's postInit() refreshes the token)
        // 3. Retrying the message
        const isAuthError =
          event.error.code === 'invalid_api_key' ||
          event.error.code === 'expired_oauth_token'

        if (
          isAuthError &&
          this.attemptAuthRetry(
            sessionId,
            managed,
            workspaceId,
            event.error.code,
          )
        ) {
          // Don't add error message or send to renderer - we're handling it via retry
          break
        }

        // Build rich error message with all diagnostic fields for persistence and UI display
        const typedErrorMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          // Combine title and message for content display (handles undefined gracefully)
          content:
            [event.error.title, event.error.message]
              .filter(Boolean)
              .join(': ') || 'An error occurred',
          timestamp: this.monotonic(),
          // Rich error fields for diagnostics and retry functionality
          errorCode: event.error.code,
          errorTitle: event.error.title,
          errorDetails: event.error.details,
          errorOriginal: event.error.originalError,
          errorCanRetry: event.error.canRetry,
        }
        managed.messages.push(typedErrorMessage)
        // Send typed_error event with full structure for renderer to handle
        this.sendEvent(
          {
            type: 'typed_error',
            sessionId,
            error: {
              code: event.error.code,
              title: event.error.title,
              message: event.error.message,
              actions: event.error.actions,
              canRetry: event.error.canRetry,
              details: event.error.details,
              originalError: event.error.originalError,
            },
            timestamp: typedErrorMessage.timestamp,
          },
          workspaceId,
        )
        break
      }

      case 'task_backgrounded':
      case 'task_progress':
        // Forward background task events directly to renderer
        this.sendEvent(
          {
            ...event,
            sessionId,
          },
          workspaceId,
        )
        break

      case 'task_completed':
        // Store output for later retrieval via getTaskOutput()
        if (managed) {
          managed.backgroundTaskOutputs.set(event.taskId, {
            outputFile: event.outputFile || '',
            summary: event.summary || '',
            status: event.status,
            completedAt: Date.now(),
          })
          // O(1) index for getTaskOutput() — avoids scanning all sessions
          this.taskOutputIndex.set(event.taskId, sessionId)
          sessionLog.info(
            `Background task ${event.taskId} completed (status=${event.status})`,
          )

          // Evict stale entries older than 1 hour to bound memory growth
          const ONE_HOUR = 3_600_000
          const now = Date.now()
          for (const [tid, info] of managed.backgroundTaskOutputs) {
            if (now - info.completedAt > ONE_HOUR) {
              managed.backgroundTaskOutputs.delete(tid)
              this.taskOutputIndex.delete(tid)
            }
          }
        }
        // Forward to renderer for UI update
        this.sendEvent(
          {
            ...event,
            sessionId,
          },
          workspaceId,
        )
        break

      case 'shell_backgrounded':
        // Store the command for later process killing
        if (event.command && managed) {
          managed.backgroundShellCommands.set(event.shellId, event.command)
          sessionLog.info(
            `Stored command for shell ${event.shellId}: ${event.command.slice(0, 50)}...`,
          )
        }
        // Forward to renderer
        this.sendEvent(
          {
            ...event,
            sessionId,
          },
          workspaceId,
        )
        break

      case 'source_activated':
        // A source was auto-activated mid-turn, forward to renderer for auto-retry
        sessionLog.info(
          `Source "${event.sourceSlug}" activated, notifying renderer for auto-retry`,
        )
        this.sendEvent(
          {
            type: 'source_activated',
            sessionId,
            sourceSlug: event.sourceSlug,
            originalMessage: event.originalMessage,
          },
          workspaceId,
        )
        break

      case 'complete':
        // Complete event from CraftAgent - accumulate usage from this turn
        // Actual 'complete' sent to renderer comes from the finally block in sendMessage
        if (event.usage) {
          // Initialize tokenUsage if not set
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // inputTokens = current context size (full conversation sent this turn), NOT accumulated
          // Each API call sends the full conversation history, so we use the latest value
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          // outputTokens and costUsd are accumulated across all turns (total session usage)
          managed.tokenUsage.outputTokens += event.usage.outputTokens
          managed.tokenUsage.totalTokens =
            managed.tokenUsage.inputTokens + managed.tokenUsage.outputTokens
          managed.tokenUsage.costUsd += event.usage.costUsd ?? 0
          // Cache tokens reflect current state, not accumulated
          managed.tokenUsage.cacheReadTokens = event.usage.cacheReadTokens ?? 0
          managed.tokenUsage.cacheCreationTokens =
            event.usage.cacheCreationTokens ?? 0
          // Update context window (use latest value - may change if model switches)
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }
        }
        break

      case 'usage_update':
        // Real-time usage update for context display during processing
        // Update managed session's tokenUsage with latest context size
        if (event.usage) {
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // Update only inputTokens (current context size) - other fields accumulate on complete
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }

          // Send to renderer for immediate UI update
          this.sendEvent(
            {
              type: 'usage_update',
              sessionId: managed.id,
              tokenUsage: {
                inputTokens: event.usage.inputTokens,
                contextWindow: event.usage.contextWindow,
              },
            },
            workspaceId,
          )
        }
        break

      case 'available_commands_update':
        this.applyAvailableCommandsSnapshot(
          managed,
          {
            availableCommands: event.availableCommands,
            ...(event.availableSkills
              ? { availableSkills: event.availableSkills }
              : {}),
            ...(event.availableSkillDetails
              ? { availableSkillDetails: event.availableSkillDetails }
              : {}),
          },
          'agent event',
        )
        break

      case 'steer_undelivered':
        // Steer message was not delivered (no PreToolUse fired before turn ended).
        // Re-queue it so it's sent as a normal message on the next turn.
        sessionLog.info(
          `Steer message undelivered, re-queuing for session ${sessionId}`,
        )
        managed.messageQueue.push({ message: event.message })
        managed.wasInterrupted = true
        break

      // Note: working_directory_changed is user-initiated only (via updateWorkingDirectory),
      // the agent no longer has a change_working_directory tool
      default:
        break
    }
  }

  private sendEvent(event: SessionEvent, workspaceId?: string): void {
    if (!this.eventSink) {
      sessionLog.warn('Cannot send event - no event sink')
      return
    }

    if (!workspaceId) {
      sessionLog.warn(`Cannot send ${event.type} event - no workspaceId`)
      return
    }

    const eventWithContext: SessionEvent = { ...event, workspaceId }
    const eventClientId = this.sessionEventClientIds.get(event.sessionId)

    if (eventClientId) {
      this.eventSink(
        RPC_CHANNELS.sessions.EVENT,
        { to: 'workspace', workspaceId, exclude: eventClientId },
        eventWithContext,
      )
      this.eventSink(
        RPC_CHANNELS.sessions.EVENT,
        { to: 'client', clientId: eventClientId },
        eventWithContext,
      )
      return
    }

    this.eventSink(
      RPC_CHANNELS.sessions.EVENT,
      { to: 'workspace', workspaceId },
      eventWithContext,
    )
  }

  /**
   * Queue a text delta for batched sending (performance optimization)
   * Instead of sending 50+ IPC events per second, batches deltas and flushes every 50ms
   */
  private queueDelta(
    sessionId: string,
    workspaceId: string,
    delta: string,
    turnId?: string,
  ): void {
    const existing = this.pendingDeltas.get(sessionId)
    if (existing) {
      // Append to existing batch
      existing.delta += delta
      // Keep the latest turnId (should be the same, but just in case)
      if (turnId) existing.turnId = turnId
    } else {
      // Start new batch
      this.pendingDeltas.set(sessionId, { delta, turnId })
    }

    // Schedule flush if not already scheduled
    if (!this.deltaFlushTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.flushDelta(sessionId, workspaceId)
      }, DELTA_BATCH_INTERVAL_MS)
      this.deltaFlushTimers.set(sessionId, timer)
    }
  }

  /**
   * Flush any pending deltas for a session (sends batched IPC event)
   * Called on timer or when streaming ends (text_complete)
   */
  private flushDelta(sessionId: string, workspaceId: string): void {
    // Clear the timer
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }

    // Send batched delta if any
    const pending = this.pendingDeltas.get(sessionId)
    if (pending && pending.delta) {
      this.sendEvent(
        {
          type: 'text_delta',
          sessionId,
          delta: pending.delta,
          turnId: pending.turnId,
        },
        workspaceId,
      )
      this.pendingDeltas.delete(sessionId)
    }
  }

  /**
   * Execute a prompt automation by creating a new session and sending the prompt
   */
  async executePromptAutomation(
    workspaceId: string,
    workspaceRootPath: string,
    prompt: string,
    labels?: string[],
    permissionMode?: PermissionMode,
    mentions?: string[],
    llmConnection?: string,
    model?: string,
    automationName?: string,
  ): Promise<{ sessionId: string }> {
    // Warn if llmConnection was specified but doesn't resolve
    if (llmConnection) {
      const connection = resolveSessionConnection(llmConnection)
      if (!connection) {
        sessionLog.warn(
          `[Automations] llmConnection "${llmConnection}" not found, using default`,
        )
      }
    }

    // Resolve @mentions to source/skill slugs
    const resolved = mentions
      ? this.resolveAutomationMentions(workspaceRootPath, mentions)
      : undefined

    // Ensure labels exist in workspace config before assigning to session
    const resolvedLabels = labels?.length
      ? ensureLabelsExist(workspaceRootPath, labels)
      : labels

    // Use automation name if provided, otherwise fall back to prompt snippet
    const fallback = `Automation: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`
    const sessionName = automationName || fallback

    // Create a new session for this automation
    const session = await this.createSession(workspaceId, {
      name: sessionName,
      slugHint: automationName || prompt,
      labels: resolvedLabels,
      permissionMode: permissionMode || 'safe',
      enabledSourceSlugs: resolved?.sourceSlugs,
      llmConnection,
      model,
    })

    // Populate triggeredBy metadata so title generation is explicitly skipped
    // and the session is identifiable as automation-initiated after reload
    const managed = this.sessions.get(session.id)
    if (managed) {
      managed.triggeredBy = { automationName, timestamp: Date.now() }
      this.persistSession(managed)
    }

    // Notify renderer to hydrate full session metadata (including title)
    // before streaming events arrive. Without this, the renderer may create
    // a synthetic empty session and temporarily show "New chat".
    this.sendEvent(
      { type: 'session_created', sessionId: session.id },
      workspaceId,
    )

    // Send the prompt
    await this.sendMessage(session.id, prompt, undefined, undefined, {
      skillSlugs: resolved?.skillSlugs,
    })

    return { sessionId: session.id }
  }

  /**
   * Resolve @mentions in automation prompts to source and skill slugs
   */
  private resolveAutomationMentions(
    workspaceRootPath: string,
    mentions: string[],
  ): { sourceSlugs: string[]; skillSlugs: string[] } | undefined {
    const sources = loadWorkspaceSources(workspaceRootPath)
    const skills = loadAllSkills(workspaceRootPath)
    const sourceSlugs: string[] = []
    const skillSlugs: string[] = []

    for (const mention of mentions) {
      if (sources.some((s) => s.config.slug === mention)) {
        sourceSlugs.push(mention)
      } else if (skills.some((s) => s.slug === mention)) {
        skillSlugs.push(mention)
      } else {
        sessionLog.warn(`[Automations] Unknown mention: @${mention}`)
      }
    }

    return sourceSlugs.length > 0 || skillSlugs.length > 0
      ? { sourceSlugs, skillSlugs }
      : undefined
  }

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  private async generateRemoteTransferSummary(
    managed: ManagedSession,
  ): Promise<string | null> {
    await this.ensureMessagesLoaded(managed)

    const messages = managed.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => !m.isIntermediate)
      .map((m) => ({
        type: m.role as 'user' | 'assistant',
        content: m.content,
      }))

    if (messages.length === 0) return null

    const workspaceRootPath = managed.workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultModel = wsConfig?.defaults?.model
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model || defaultModel,
    })

    const miniModel = backendContext.connection
      ? (getMiniModel(backendContext.connection) ??
        backendContext.connection.defaultModel ??
        getDefaultSummarizationModel())
      : getDefaultSummarizationModel()

    const envOverrides: Record<string, string> = {
      CRAFT_WORKSPACE_PATH: workspaceRootPath,
    }

    const agent = createBackendFromResolvedContext({
      context: backendContext,
      hostRuntime: buildBackendHostRuntimeContext(),
      coreConfig: {
        workspace: managed.workspace,
        session: {
          id: `${managed.id}-remote-transfer-summary`,
          workspaceRootPath,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          workingDirectory: managed.workingDirectory,
          sdkCwd: managed.sdkCwd,
          model: managed.model,
          llmConnection: managed.llmConnection,
          permissionMode: managed.permissionMode,
          previousPermissionMode: managed.previousPermissionMode,
        },
        miniModel,
        envOverrides,
        isHeadless: true,
      },
      providerOptions: {},
    })

    try {
      return await generateConversationSummary(
        messages,
        agent.runMiniCompletion.bind(agent),
      )
    } finally {
      agent.destroy()
    }
  }

  async exportRemoteSessionTransfer(
    sessionId: string,
    workspaceId: string,
  ): Promise<RemoteSessionTransferPayload | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(
        `[dispatch] Cannot export remote transfer: ${sessionId} not found`,
      )
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      sessionLog.warn(
        `[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`,
      )
      return null
    }

    if (managed.isProcessing) {
      sessionLog.warn(
        `[dispatch] Cannot export remote transfer ${sessionId}: still processing`,
      )
      return null
    }

    this.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const summary = await this.generateRemoteTransferSummary(managed)
    if (!summary) {
      sessionLog.warn(
        `[dispatch] Failed to generate remote transfer summary for ${sessionId}`,
      )
      return null
    }

    return {
      sourceSessionId: managed.id,
      name: managed.name,
      sessionStatus: managed.sessionStatus,
      labels: managed.labels,
      permissionMode: managed.permissionMode,
      summary,
    }
  }

  async importRemoteSessionTransfer(
    workspaceId: string,
    payload: RemoteSessionTransferPayload,
  ): Promise<ImportRemoteSessionTransferResult> {
    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.summary !== 'string' ||
      !payload.summary.trim()
    ) {
      throw new Error('Invalid remote session transfer payload')
    }

    const session = await this.createSession(workspaceId, {
      name: payload.name,
      permissionMode: payload.permissionMode,
      sessionStatus: payload.sessionStatus,
      labels: payload.labels,
    })

    const managed = this.sessions.get(session.id)
    if (!managed) {
      throw new Error(`Transferred session ${session.id} was not created`)
    }

    managed.transferredSessionSummary = payload.summary.trim()
    managed.transferredSessionSummaryApplied = false
    this.persistSession(managed)
    await sessionPersistenceQueue.flush(session.id)

    return { sessionId: session.id }
  }

  /**
   * Export a session as a portable SessionBundle.
   *
   * Steps:
   * 1. Validate session exists and resolve its workspace
   * 2. If session is processing, refuse (caller must stop it first)
   * 3. Flush pending persistence writes
   * 4. Serialize session directory into a bundle
   */
  async exportSession(
    sessionId: string,
    workspaceId: string,
  ): Promise<SessionBundle | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(
        `[dispatch] Cannot export session: ${sessionId} not found`,
      )
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      sessionLog.warn(
        `[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`,
      )
      return null
    }

    if (managed.isProcessing) {
      sessionLog.warn(
        `[dispatch] Cannot export session ${sessionId}: still processing`,
      )
      return null
    }

    // Flush pending writes to ensure JSONL is up to date
    this.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const bundle = serializeSession(managed.workspace.rootPath, sessionId)
    if (!bundle) {
      sessionLog.error(`[dispatch] Failed to serialize session ${sessionId}`)
      return null
    }

    return bundle
  }

  /**
   * Import a session bundle into a target workspace.
   *
   * Steps:
   * 1. Validate bundle structure and target workspace
   * 2. Generate new session ID (fork) or use original (move)
   * 3. Create session directory and write JSONL + files
   * 4. Register session in-memory
   * 5. Emit session_created event
   * 6. Return new session ID and compatibility warnings
   */
  async importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }> {
    sessionLog.info(
      `[import] Starting import: workspaceId=${workspaceId}, mode=${mode}, bundleSessionId=${bundle?.session?.header?.id ?? 'unknown'}, files=${bundle?.files?.length ?? 0}`,
    )

    if (!validateBundle(bundle)) {
      throw new Error('Invalid session bundle')
    }

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    sessionLog.info(
      `[import] Target workspace: "${workspace.name}" at ${workspace.rootPath}`,
    )

    const warnings: string[] = []
    const workspaceRootPath = workspace.rootPath

    // Determine session ID
    const sessionId =
      mode === 'move'
        ? bundle.session.header.id
        : generateSessionId(workspaceRootPath)

    // Check for ID collision on move
    if (mode === 'move' && this.sessions.has(sessionId)) {
      throw new Error(
        `Session ${sessionId} already exists in target workspace`,
      )
    }

    // Create session directory with all subdirectories
    const sessionDir = ensureSessionDir(workspaceRootPath, sessionId)

    // Build the stored session from bundle data
    const header = bundle.session.header
    const storedSession: StoredSession = {
      id: sessionId,
      workspaceRootPath,
      sdkSessionId: header.sdkSessionId, // Preserved initially; fork logic below may clear it
      // Always regenerate sdkCwd for the target workspace.
      // The source sdkCwd points to a path on the originating server
      // which doesn't exist here (cross-server transfer).
      sdkCwd: getSessionStoragePath(workspaceRootPath, sessionId),
      name: header.name,
      createdAt: header.createdAt,
      lastUsedAt: Date.now(),
      lastMessageAt: header.lastMessageAt,
      isFlagged: header.isFlagged,
      sessionStatus: header.sessionStatus,
      labels: header.labels,
      enabledSourceSlugs: header.enabledSourceSlugs,
      workingDirectory: header.workingDirectory,
      llmConnection: header.llmConnection,
      connectionLocked: header.connectionLocked,
      thinkingLevel: header.thinkingLevel,
      hidden: header.hidden,
      transferredSessionSummary: header.transferredSessionSummary,
      transferredSessionSummaryApplied: header.transferredSessionSummaryApplied,
      messages: bundle.session.messages,
      tokenUsage: header.tokenUsage ?? DEFAULT_TOKEN_USAGE,
    }

    // Fork-specific: set up SDK branching if branchInfo provided
    if (mode === 'fork' && bundle.branchInfo) {
      storedSession.branchFromSdkSessionId = bundle.branchInfo.sdkSessionId
      storedSession.branchFromSdkTurnId = bundle.branchInfo.sdkTurnId
      storedSession.branchFromSdkCwd = bundle.branchInfo.sdkCwd
    }

    // Fork-specific: clear sharing state and attempt resume-first strategy
    if (mode === 'fork') {
      storedSession.sharedUrl = undefined
      storedSession.sharedId = undefined

      // Resume-first: try to find a compatible LLM connection on the target workspace.
      // If found and the session has an sdkSessionId, preserve it for API-level resume.
      // If not, clear SDK state and fall back to transferred session summary.
      const sourceProviderType = header.llmConnection
        ? getLlmConnection(header.llmConnection)?.providerType
        : undefined
      const compatibleConnection = sourceProviderType
        ? this.findCompatibleLlmConnection(
            workspaceRootPath,
            sourceProviderType,
          )
        : null

      if (compatibleConnection && storedSession.sdkSessionId) {
        // Resume path: compatible credentials exist — preserve SDK session ID
        sessionLog.info(
          `[import] Fork: compatible ${sourceProviderType} connection "${compatibleConnection}" found — preserving sdkSessionId for resume`,
        )
        storedSession.llmConnection = compatibleConnection
        storedSession.connectionLocked = false
      } else {
        // Summary path: no compatible connection or no SDK session — clear for fresh start
        if (storedSession.llmConnection) {
          sessionLog.info(
            `[import] Fork: no compatible ${sourceProviderType ?? 'unknown'} connection — clearing, will use summary context`,
          )
        }
        storedSession.sdkSessionId = undefined
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      }
      // Clear thinking level so the session inherits the workspace default
      storedSession.thinkingLevel = undefined
      // Clear working directory — the source path won't exist on a different server.
      // The user can set a new cwd after the session is transferred.
      storedSession.workingDirectory = undefined
    }

    // Check source compatibility (before writing JSONL so fixes are persisted)
    if (storedSession.enabledSourceSlugs?.length) {
      const availableSources = loadWorkspaceSources(workspaceRootPath)
      const availableSlugs = new Set(
        availableSources.map((s) => s.config.slug),
      )
      const missingSources = storedSession.enabledSourceSlugs.filter(
        (s) => !availableSlugs.has(s),
      )
      if (missingSources.length > 0) {
        sessionLog.warn(
          `[import] Sources not available: ${missingSources.join(', ')}`,
        )
        warnings.push(
          `Sources not available in target workspace: ${missingSources.join(', ')}`,
        )
      }
    }

    // Check LLM connection compatibility for move mode (fork already cleared above)
    if (mode === 'move' && storedSession.llmConnection) {
      sessionLog.info(
        `[import] Checking LLM connection: "${storedSession.llmConnection}"`,
      )
      const conn = resolveSessionConnection(
        storedSession.llmConnection,
        undefined,
      )
      if (!conn) {
        sessionLog.warn(
          `[import] LLM connection "${storedSession.llmConnection}" not found — clearing to use default`,
        )
        warnings.push(
          `LLM connection "${storedSession.llmConnection}" not found in target — session will use default`,
        )
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      } else {
        sessionLog.info(
          `[import] LLM connection "${storedSession.llmConnection}" resolved OK`,
        )
      }
    } else if (mode === 'move' && !storedSession.llmConnection) {
      sessionLog.info(
        '[import] No LLM connection in bundle — will use default',
      )
    }

    // Write JSONL file (after compatibility checks so remapped values are persisted)
    const sessionFile = getSessionFilePath(workspaceRootPath, sessionId)
    sessionLog.info(
      `[import] Writing JSONL: ${sessionFile} (llmConnection=${storedSession.llmConnection ?? 'default'}, messages=${storedSession.messages.length})`,
    )
    writeSessionJsonl(sessionFile, storedSession)

    // Write all bundle files (attachments, plans, data, downloads, etc.)
    // Uses restoreFiles() for path traversal, size, and base64 validation.
    restoreFiles(sessionDir, bundle.files)

    // Register in-memory — pass session metadata without messages to avoid
    // StoredMessage[] vs Message[] type mismatch, then convert messages separately
    const { messages: bundleMessages, ...sessionMeta } = storedSession
    const managed = createManagedSession(sessionMeta, workspace, {
      messagesLoaded: true,
      workingDirectory: storedSession.workingDirectory,
      permissionMode: this.currentGlobalPermissionMode,
    })
    managed.messages = bundleMessages.map(storedToMessage)

    setPermissionMode(sessionId, managed.permissionMode ?? 'ask', {
      changedBy: 'restore',
    })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
    }

    this.sessions.set(sessionId, managed)

    // Initialize automation metadata
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(sessionId, {
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        sessionStatus: storedSession.sessionStatus,
        sessionName: managed.name,
      })
    }

    // Emit session_created so renderer picks it up
    this.sendEvent({ type: 'session_created', sessionId }, workspaceId)

    sessionLog.info(
      `[import] Complete: sessionId=${sessionId}, transferredSummary=${managed.transferredSessionSummary ? `${managed.transferredSessionSummary.length} chars` : 'none'}, applied=${managed.transferredSessionSummaryApplied}, warnings=${warnings.length > 0 ? warnings.join('; ') : 'none'}`,
    )
    return { sessionId, warnings: warnings.length > 0 ? warnings : undefined }
  }

  /**
   * Find an LLM connection on this server that matches the given provider type.
   * Checks workspace default first, then falls back to any matching connection.
   */
  private findCompatibleLlmConnection(
    workspaceRootPath: string,
    providerType: string,
  ): string | null {
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultSlug = wsConfig?.defaults?.defaultLlmConnection
    if (defaultSlug) {
      const conn = getLlmConnection(defaultSlug)
      if (conn?.providerType === providerType) return defaultSlug
    }
    // Fall back: any connection with matching provider type
    const connections = getLlmConnections()
    const match = connections.find((c) => c.providerType === providerType)
    return match?.slug ?? null
  }

  /**
   * Clean up all resources held by the SessionManager.
   * Should be called on app shutdown to prevent resource leaks.
   */
  cleanup(): void {
    sessionLog.info('Cleaning up resources...')

    // Stop all ConfigWatchers (file system watchers)
    for (const [path, watcher] of this.configWatchers) {
      watcher.stop()
      sessionLog.info(`Stopped config watcher for ${path}`)
    }
    this.configWatchers.clear()

    // Dispose all AutomationSystems (includes scheduler, handlers, and event loggers)
    for (const [workspacePath, automationSystem] of this.automationSystems) {
      try {
        automationSystem.dispose()
        sessionLog.info(`Disposed AutomationSystem for ${workspacePath}`)
      } catch (error) {
        sessionLog.error(
          `Failed to dispose AutomationSystem for ${workspacePath}:`,
          error,
        )
      }
    }
    this.automationSystems.clear()

    // Clear all pending delta flush timers
    for (const [, timer] of this.deltaFlushTimers) {
      clearTimeout(timer)
    }
    this.deltaFlushTimers.clear()
    this.pendingDeltas.clear()

    // Clear pending credential resolvers (they won't be resolved, but prevents memory leak)
    this.pendingCredentialResolvers.clear()
    this.pendingPermissionRequests.clear()
    this.adminRememberApprovals.clear()

    // Clean up session-scoped tool callbacks for all sessions
    for (const sessionId of this.sessions.keys()) {
      unregisterSessionScopedToolCallbacks(sessionId)
    }

    sessionLog.info('Cleanup complete')
  }
}
