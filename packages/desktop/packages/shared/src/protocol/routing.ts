/**
 * Exhaustive channel routing table for hybrid local/remote transport.
 *
 * Every RPC channel must belong to exactly one of two sets:
 * - LOCAL_ONLY: Always runs on the local Electron server, never proxied.
 * - REMOTE_ELIGIBLE: Runs on whichever server owns the workspace.
 *
 * An exhaustiveness test ensures new channels fail CI until classified.
 */

import { RPC_CHANNELS } from './channels';

// ---------------------------------------------------------------------------
// LOCAL_ONLY — fundamentally requires local OS / Electron
// ---------------------------------------------------------------------------

export const LOCAL_ONLY_CHANNELS = new Set<string>([
  // remote — local connectivity management (reaches out to remote server from local app)
  RPC_CHANNELS.remote.TEST_CONNECTION,

  // sessions — local workspace overview for project sidebar.
  // The embedded server already has lightweight metadata for local workspaces.
  RPC_CHANNELS.sessions.GET_FOR_WORKSPACE,

  // workspaces — local workspace CRUD (workspace list is local config)
  RPC_CHANNELS.workspaces.GET,
  RPC_CHANNELS.workspaces.CREATE,
  RPC_CHANNELS.workspaces.CHECK_SLUG,
  RPC_CHANNELS.workspaces.UPDATE_REMOTE,

  // window — Electron window management
  RPC_CHANNELS.window.GET_WORKSPACE,
  RPC_CHANNELS.window.GET_MODE,
  RPC_CHANNELS.window.OPEN_WORKSPACE,
  RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW,
  RPC_CHANNELS.window.SWITCH_WORKSPACE,
  RPC_CHANNELS.window.CLOSE,
  RPC_CHANNELS.window.CLOSE_REQUESTED,
  RPC_CHANNELS.window.CONFIRM_CLOSE,
  RPC_CHANNELS.window.CANCEL_CLOSE,
  RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS,
  RPC_CHANNELS.window.BEGIN_DRAG,
  RPC_CHANNELS.window.MOVE_DRAG,
  RPC_CHANNELS.window.END_DRAG,
  RPC_CHANNELS.window.FOCUS_STATE,
  RPC_CHANNELS.window.GET_FOCUS_STATE,

  // file — native file dialog
  RPC_CHANNELS.file.OPEN_DIALOG,
  // file — draft hydration for user-attached paths. Paths in drafts.json were captured
  // via webUtils.getPathForFile in the renderer, so they point at the user's local machine
  // — even when the workspace itself lives on a remote server. Routing this REMOTE_ELIGIBLE
  // would send the local path to a remote filesystem that can't resolve it.
  RPC_CHANNELS.file.READ_USER_ATTACHMENT,

  // dialog — native folder dialog
  RPC_CHANNELS.dialog.OPEN_FOLDER,

  // auth — local auth state + native dialogs
  RPC_CHANNELS.auth.LOGOUT,
  RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION,
  RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION,

  // shell — local OS shell (openFile/showInFolder guarded for remote)
  RPC_CHANNELS.shell.OPEN_URL,
  RPC_CHANNELS.shell.OPEN_FILE,
  RPC_CHANNELS.shell.SHOW_IN_FOLDER,

  // skills — local filesystem actions (guarded for remote)
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,

  // system — local OS info
  RPC_CHANNELS.system.VERSIONS,
  RPC_CHANNELS.system.HOME_DIR,
  RPC_CHANNELS.system.IS_DEBUG_MODE,

  // theme — app/OS-level preferences, not workspace content
  RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE,
  RPC_CHANNELS.theme.SYSTEM_CHANGED,
  RPC_CHANNELS.theme.APP_CHANGED,
  RPC_CHANNELS.theme.GET_APP,
  RPC_CHANNELS.theme.GET_PRESETS,
  RPC_CHANNELS.theme.LOAD_PRESET,
  RPC_CHANNELS.theme.GET_COLOR_THEME,
  RPC_CHANNELS.theme.SET_COLOR_THEME,
  RPC_CHANNELS.theme.BROADCAST_PREFERENCES,
  RPC_CHANNELS.theme.PREFERENCES_CHANGED,
  RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.SET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES,
  RPC_CHANNELS.theme.BROADCAST_WORKSPACE_THEME,
  RPC_CHANNELS.theme.WORKSPACE_THEME_CHANGED,

  // update — local auto-update
  RPC_CHANNELS.update.CHECK,
  RPC_CHANNELS.update.GET_INFO,
  RPC_CHANNELS.update.INSTALL,
  RPC_CHANNELS.update.DISMISS,
  RPC_CHANNELS.update.GET_DISMISSED,
  RPC_CHANNELS.update.AVAILABLE,
  RPC_CHANNELS.update.DOWNLOAD_PROGRESS,

  // releaseNotes — local app info
  RPC_CHANNELS.releaseNotes.GET,
  RPC_CHANNELS.releaseNotes.GET_LATEST_VERSION,

  // badge — local dock badge
  RPC_CHANNELS.badge.REFRESH,
  RPC_CHANNELS.badge.SET_ICON,
  RPC_CHANNELS.badge.DRAW,
  RPC_CHANNELS.badge.DRAW_WINDOWS,

  // menu — local menu events
  RPC_CHANNELS.menu.NEW_CHAT,
  RPC_CHANNELS.menu.NEW_WINDOW,
  RPC_CHANNELS.menu.OPEN_SETTINGS,
  RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS,
  RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE,
  RPC_CHANNELS.menu.TOGGLE_SIDEBAR,
  RPC_CHANNELS.menu.QUIT,
  RPC_CHANNELS.menu.MINIMIZE,
  RPC_CHANNELS.menu.MAXIMIZE,
  RPC_CHANNELS.menu.ZOOM_IN,
  RPC_CHANNELS.menu.ZOOM_OUT,
  RPC_CHANNELS.menu.ZOOM_RESET,
  RPC_CHANNELS.menu.TOGGLE_DEV_TOOLS,
  RPC_CHANNELS.menu.UNDO,
  RPC_CHANNELS.menu.REDO,
  RPC_CHANNELS.menu.CUT,
  RPC_CHANNELS.menu.COPY,
  RPC_CHANNELS.menu.PASTE,
  RPC_CHANNELS.menu.SELECT_ALL,

  // deeplink — local deep link handling
  RPC_CHANNELS.deeplink.NAVIGATE,

  // notification — local OS notifications
  RPC_CHANNELS.notification.SHOW,
  RPC_CHANNELS.notification.NAVIGATE,
  RPC_CHANNELS.notification.GET_ENABLED,
  RPC_CHANNELS.notification.SET_ENABLED,

  // input — local input preferences
  RPC_CHANNELS.input.GET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.SET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  RPC_CHANNELS.input.SET_SPELL_CHECK,

  // power — local power management
  RPC_CHANNELS.power.GET_KEEP_AWAKE,
  RPC_CHANNELS.power.SET_KEEP_AWAKE,

  // appearance — local UI preferences
  RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,

  // caching — prompt cache and context settings
  RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT,

  // memory — Qwen managed auto-memory settings
  RPC_CHANNELS.memory.GET_SETTINGS,
  RPC_CHANNELS.memory.SET_SETTINGS,
  RPC_CHANNELS.memory.GET_SETTINGS_PATH,
  RPC_CHANNELS.memory.GET_PATHS,
  RPC_CHANNELS.memory.OPEN_PATH,

  // tools — local tool settings
  RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,

  // browserPane — Electron BrowserView
  RPC_CHANNELS.browserPane.CREATE,
  RPC_CHANNELS.browserPane.DESTROY,
  RPC_CHANNELS.browserPane.LIST,
  RPC_CHANNELS.browserPane.NAVIGATE,
  RPC_CHANNELS.browserPane.GO_BACK,
  RPC_CHANNELS.browserPane.GO_FORWARD,
  RPC_CHANNELS.browserPane.RELOAD,
  RPC_CHANNELS.browserPane.STOP,
  RPC_CHANNELS.browserPane.FOCUS,
  RPC_CHANNELS.browserPane.HIDE,
  RPC_CHANNELS.browserPane.DOCK,
  RPC_CHANNELS.browserPane.TOGGLE_DOCK_EXPANDED,
  RPC_CHANNELS.browserPane.SNAPSHOT,
  RPC_CHANNELS.browserPane.CLICK,
  RPC_CHANNELS.browserPane.FILL,
  RPC_CHANNELS.browserPane.SELECT,
  RPC_CHANNELS.browserPane.SCREENSHOT,
  RPC_CHANNELS.browserPane.EVALUATE,
  RPC_CHANNELS.browserPane.SCROLL,
  RPC_CHANNELS.browserPane.LAUNCH,
  RPC_CHANNELS.browserPane.STATE_CHANGED,
  RPC_CHANNELS.browserPane.REMOVED,
  RPC_CHANNELS.browserPane.INTERACTED,

  // gitbash — Windows-specific local
  RPC_CHANNELS.gitbash.CHECK,
  RPC_CHANNELS.gitbash.BROWSE,
  RPC_CHANNELS.gitbash.SET_PATH,

  // debug — local debug logging
  RPC_CHANNELS.debug.LOG,

  // onboarding — local auth setup flow
  RPC_CHANNELS.onboarding.GET_AUTH_STATE,
  RPC_CHANNELS.onboarding.VALIDATE_MCP,
  RPC_CHANNELS.onboarding.START_MCP_OAUTH,
  RPC_CHANNELS.onboarding.DEFER_SETUP,
  RPC_CHANNELS.settings.GET_NETWORK_PROXY,
  RPC_CHANNELS.settings.SET_NETWORK_PROXY,

  // server config — local embedded server settings
  RPC_CHANNELS.settings.GET_SERVER_CONFIG,
  RPC_CHANNELS.settings.SET_SERVER_CONFIG,
  RPC_CHANNELS.settings.GET_SERVER_STATUS,
]);

// ---------------------------------------------------------------------------
// REMOTE_ELIGIBLE — runs on whichever server owns the workspace
// ---------------------------------------------------------------------------

export const REMOTE_ELIGIBLE_CHANNELS = new Set<string>([
  // server — server-level operations (no workspace context needed)
  RPC_CHANNELS.server.GET_WORKSPACES,
  RPC_CHANNELS.server.CREATE_WORKSPACE,
  RPC_CHANNELS.server.GET_STATUS,
  RPC_CHANNELS.server.GET_HEALTH,
  RPC_CHANNELS.server.GET_ACTIVE_SESSIONS,
  RPC_CHANNELS.server.SHUTTING_DOWN,
  RPC_CHANNELS.server.STATUS_CHANGED,
  RPC_CHANNELS.server.HOME_DIR,

  // sessions — core session runtime
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED,
  RPC_CHANNELS.sessions.LIST_CHANGED,
  RPC_CHANNELS.sessions.LIST_REFRESH_STATE_CHANGED,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  RPC_CHANNELS.sessions.EVENT,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.SET_MODEL,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.FILES_CHANGED,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,

  // transfer — chunked large-payload import (sessions, resources)
  RPC_CHANNELS.transfer.START,
  RPC_CHANNELS.transfer.CHUNK,
  RPC_CHANNELS.transfer.COMMIT,
  RPC_CHANNELS.transfer.ABORT,

  // tasks — workspace content
  RPC_CHANNELS.tasks.GET_OUTPUT,

  // file — workspace files (not openDialog which is native)
  RPC_CHANNELS.file.READ,
  RPC_CHANNELS.file.READ_DATA_URL,
  RPC_CHANNELS.file.READ_PREVIEW_DATA_URL,
  RPC_CHANNELS.file.READ_BINARY,
  RPC_CHANNELS.file.READ_ATTACHMENT,
  RPC_CHANNELS.file.STORE_ATTACHMENT,
  RPC_CHANNELS.file.GENERATE_THUMBNAIL,

  // fs — workspace filesystem
  RPC_CHANNELS.fs.SEARCH,
  RPC_CHANNELS.fs.LIST_DIRECTORY,

  // credentials — remote server's credential state
  RPC_CHANNELS.credentials.HEALTH_CHECK,

  // llmConnections — LLM config lives on server running workspace
  RPC_CHANNELS.llmConnections.LIST,
  RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
  RPC_CHANNELS.llmConnections.GET,
  RPC_CHANNELS.llmConnections.GET_API_KEY,
  RPC_CHANNELS.llmConnections.SAVE,
  RPC_CHANNELS.llmConnections.DELETE,
  RPC_CHANNELS.llmConnections.TEST,
  RPC_CHANNELS.llmConnections.SET_DEFAULT,
  RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_CHANNELS.llmConnections.REFRESH_MODELS,
  RPC_CHANNELS.llmConnections.CHANGED,

  // settings — workspace-level settings
  RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
  RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
  RPC_CHANNELS.settings.LIST_QWEN_PROVIDERS,
  RPC_CHANNELS.settings.CONNECT_QWEN_PROVIDER,
  RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.GET_QWEN_CORE_SETTINGS,
  RPC_CHANNELS.settings.SET_QWEN_CORE_SETTING,
  RPC_CHANNELS.settings.SET_QWEN_MCP_SERVER,
  RPC_CHANNELS.settings.REMOVE_QWEN_MCP_SERVER,
  RPC_CHANNELS.settings.SET_QWEN_HOOK,
  RPC_CHANNELS.settings.REMOVE_QWEN_HOOK,
  RPC_CHANNELS.settings.SET_QWEN_EXTENSION_SETTING,
  RPC_CHANNELS.settings.GET_QWEN_PERMISSION_SETTINGS,
  RPC_CHANNELS.settings.SET_QWEN_PERMISSION_RULES,
  RPC_CHANNELS.settings.GET_GLOBAL_PERMISSION_MODE,
  RPC_CHANNELS.settings.SET_GLOBAL_PERMISSION_MODE,

  // preferences — workspace-level preferences
  RPC_CHANNELS.preferences.READ,
  RPC_CHANNELS.preferences.WRITE,

  // drafts — workspace content
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.drafts.GET_ALL,

  // sources — source config per-workspace
  RPC_CHANNELS.sources.GET,
  RPC_CHANNELS.sources.CREATE,
  RPC_CHANNELS.sources.DELETE,
  RPC_CHANNELS.sources.START_OAUTH,
  RPC_CHANNELS.sources.SAVE_CREDENTIALS,
  RPC_CHANNELS.sources.CHANGED,
  RPC_CHANNELS.sources.GET_PERMISSIONS,
  RPC_CHANNELS.sources.GET_MCP_TOOLS,

  // oauth — OAuth state management
  RPC_CHANNELS.oauth.START,
  RPC_CHANNELS.oauth.COMPLETE,
  RPC_CHANNELS.oauth.CANCEL,
  RPC_CHANNELS.oauth.REVOKE,

  // workspace — workspace config + images (sharp on headless)
  RPC_CHANNELS.workspace.GET_PERMISSIONS,
  RPC_CHANNELS.workspace.READ_IMAGE,
  RPC_CHANNELS.workspace.WRITE_IMAGE,
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,

  // permissions — workspace permissions
  RPC_CHANNELS.permissions.GET_DEFAULTS,
  RPC_CHANNELS.permissions.DEFAULTS_CHANGED,

  // skills — skill content per-workspace (not openEditor/openFinder which are local OS)
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.SET_ENABLED,
  RPC_CHANNELS.skills.MARKETPLACE_LIST,
  RPC_CHANNELS.skills.MARKETPLACE_INSTALL,
  RPC_CHANNELS.skills.CHANGED,

  // statuses — workspace metadata
  RPC_CHANNELS.statuses.LIST,
  RPC_CHANNELS.statuses.REORDER,
  RPC_CHANNELS.statuses.CHANGED,

  // labels — workspace metadata
  RPC_CHANNELS.labels.LIST,
  RPC_CHANNELS.labels.CREATE,
  RPC_CHANNELS.labels.DELETE,
  RPC_CHANNELS.labels.CHANGED,

  // views — workspace UI views
  RPC_CHANNELS.views.LIST,
  RPC_CHANNELS.views.SAVE,

  // toolIcons — workspace config
  RPC_CHANNELS.toolIcons.GET_MAPPINGS,

  // logo — workspace config
  RPC_CHANNELS.logo.GET_URL,

  // automations — workspace automations
  RPC_CHANNELS.automations.GET,
  RPC_CHANNELS.automations.TEST,
  RPC_CHANNELS.automations.SET_ENABLED,
  RPC_CHANNELS.automations.DUPLICATE,
  RPC_CHANNELS.automations.DELETE,
  RPC_CHANNELS.automations.GET_HISTORY,
  RPC_CHANNELS.automations.GET_LAST_EXECUTED,
  RPC_CHANNELS.automations.REPLAY,
  RPC_CHANNELS.automations.CHANGED,

  // git — workspace filesystem
  RPC_CHANNELS.git.GET_BRANCH,

  // resources — workspace resource export/import
  RPC_CHANNELS.resources.EXPORT,
  RPC_CHANNELS.resources.IMPORT,

  // messaging — gateway channels run on workspace server
  RPC_CHANNELS.messaging.WA_REGISTER,
  RPC_CHANNELS.messaging.WA_INCOMING,
  RPC_CHANNELS.messaging.WA_BUTTON_PRESS,
  RPC_CHANNELS.messaging.WA_STATUS,
  RPC_CHANNELS.messaging.WA_QR,
  RPC_CHANNELS.messaging.WA_SEND,
  RPC_CHANNELS.messaging.WA_SEND_BUTTONS,
  RPC_CHANNELS.messaging.WA_SEND_TYPING,
  RPC_CHANNELS.messaging.WA_SEND_FILE,
  RPC_CHANNELS.messaging.WA_CONNECT,
  RPC_CHANNELS.messaging.WA_DISCONNECT,
  RPC_CHANNELS.messaging.BINDING_CHANGED,
  RPC_CHANNELS.messaging.PLATFORM_STATUS,
  RPC_CHANNELS.messaging.GET_CONFIG,
  RPC_CHANNELS.messaging.UPDATE_CONFIG,
  RPC_CHANNELS.messaging.TEST_TELEGRAM,
  RPC_CHANNELS.messaging.SAVE_TELEGRAM,
  RPC_CHANNELS.messaging.DISCONNECT,
  RPC_CHANNELS.messaging.FORGET,
  RPC_CHANNELS.messaging.GET_BINDINGS,
  RPC_CHANNELS.messaging.GENERATE_CODE,
  RPC_CHANNELS.messaging.UNBIND,
  RPC_CHANNELS.messaging.UNBIND_BINDING,
  RPC_CHANNELS.messaging.WA_START_CONNECT,
  RPC_CHANNELS.messaging.WA_SUBMIT_PHONE,
  RPC_CHANNELS.messaging.WA_UI_EVENT,
]);

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function isLocalOnly(channel: string): boolean {
  return LOCAL_ONLY_CHANNELS.has(channel);
}

export function isRemoteEligible(channel: string): boolean {
  return REMOTE_ELIGIBLE_CHANNELS.has(channel);
}
