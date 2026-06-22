// Load user's shell environment first (before other imports that may use env)
// This ensures tools like Homebrew, nvm, etc. are available to the agent
import { loadShellEnv } from './shell-env'
loadShellEnv()

import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { hostname, homedir } from 'os'
import { mkdirSync } from 'fs'
import * as Sentry from '@sentry/electron/main'

// Multi-worktree dev instances need separate Electron userData directories.
// This isolates Chromium's single-instance lock, cache, cookies, and local storage.
if (process.env.CRAFT_USER_DATA_DIR) {
  try {
    mkdirSync(process.env.CRAFT_USER_DATA_DIR, { recursive: true })
    app.setPath('userData', process.env.CRAFT_USER_DATA_DIR)
  } catch (error) {
    console.warn('[main] Failed to set CRAFT_USER_DATA_DIR:', error)
  }
}

// Initialize Sentry error tracking as early as possible after app import.
// Only enabled in production (packaged) builds to avoid noise during development.
// DSN is baked in at build time via esbuild --define (same pattern as OAuth secrets).
//
// NOTE: Source map upload is intentionally disabled. Stack traces in Sentry will show
// bundled/minified code. To enable source map upload in the future:
//   1. Add SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT to CI secrets
//   2. Re-enable the @sentry/vite-plugin in vite.config.ts (handles renderer maps)
//   3. Add @sentry/esbuild-plugin to scripts/electron-build-main.ts (handles main process maps)
Sentry.init({
  dsn: process.env.SENTRY_ELECTRON_INGEST_URL,
  environment: app.isPackaged ? 'production' : 'development',
  release: app.getVersion(),
  // Enabled whenever the ingest URL is available — works in both production (baked via CI)
  // and development (injected via .env / 1Password). Filter by environment in Sentry dashboard.
  enabled: !!process.env.SENTRY_ELECTRON_INGEST_URL,

  // Scrub sensitive data before sending to Sentry.
  // Removes authorization headers, API keys/tokens, and credential-like values.
  beforeSend(event) {
    // Scrub request headers (authorization, cookies)
    if (event.request?.headers) {
      const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key']
      for (const header of sensitiveHeaders) {
        if (event.request.headers[header]) {
          event.request.headers[header] = '[REDACTED]'
        }
      }
    }

    // Scrub breadcrumb data that may contain sensitive values
    if (event.breadcrumbs) {
      for (const breadcrumb of event.breadcrumbs) {
        if (breadcrumb.data) {
          for (const key of Object.keys(breadcrumb.data)) {
            const lowerKey = key.toLowerCase()
            if (lowerKey.includes('token') || lowerKey.includes('key') ||
                lowerKey.includes('secret') || lowerKey.includes('password') ||
                lowerKey.includes('credential') || lowerKey.includes('auth')) {
              breadcrumb.data[key] = '[REDACTED]'
            }
          }
        }
      }
    }

    return event
  },
})

// Initialize i18n for main process (menus, dialogs, etc.)
import { setupI18n, i18n } from '@craft-agent/shared/i18n'
setupI18n()

// Set anonymous machine ID for Sentry user tracking (no PII — just a hash).
// Uses hostname + homedir to produce a stable per-machine identifier.
const machineId = createHash('sha256').update(hostname() + homedir()).digest('hex').slice(0, 16)
Sentry.setUser({ id: machineId })

import { join, delimiter } from 'path'
import { existsSync, readFileSync } from 'fs'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@craft-agent/server-core/sessions'
import { registerAllRpcHandlers } from './handlers/index'
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient } from '@craft-agent/server-core/handlers/rpc'
import type { PlatformServices } from '../runtime/platform'
import { createElectronPlatform } from './platform'
import type { HandlerDeps } from './handlers/handler-deps'
import { bootstrapServer, releaseServerLock, parseServerPort } from '@craft-agent/server-core/bootstrap'
import { createMessagingBootstrap, type MessagingBootstrapHandle } from '@craft-agent/messaging-gateway'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { initModelRefreshService, getModelRefreshService, setFetcherPlatform } from '@craft-agent/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@craft-agent/server-core/services'
import { createApplicationMenu } from './menu'
import { WindowManager } from './window-manager'
import { loadWindowState, saveWindowState } from './window-state'
import { ensureDefaultConversationWorkspace, getWorkspaces, getWorkspaceByNameOrId, isProtectedWorkspace } from '@craft-agent/shared/config'
import { initializeDocs } from '@craft-agent/shared/docs'
import { initializeReleaseNotes } from '@craft-agent/shared/release-notes'
import { ensureDefaultPermissions } from '@craft-agent/shared/agent/permissions-config'
import { ensureToolIcons, ensurePresetThemes } from '@craft-agent/shared/config'
import { setBundledAssetsRoot } from '@craft-agent/shared/utils'
import { initializeBackendHostRuntime } from '@craft-agent/shared/agent/backend'
import { setPowerShellValidatorRoot } from '@craft-agent/shared/agent'
import { handleDeepLink } from './deep-link'
import { BrowserPaneManager } from './browser-pane-manager'
import { OAuthFlowStore } from '@craft-agent/shared/auth'
import { registerThumbnailScheme, registerThumbnailHandler } from './thumbnail-protocol'
import log, { isDebugMode, mainLog, getLogFilePath, getMessagingGatewayLogFilePath, messagingGatewayLog } from './logger'
import { setPerfEnabled, enableDebug } from '@craft-agent/shared/utils'
import { initNotificationService, initBadgeIcon, initInstanceBadge, updateBadgeCount } from './notifications'
import { checkForUpdatesOnLaunch, setAutoUpdateEventSink, isUpdating } from './auto-update'
import type { EventSink } from '@craft-agent/server-core/transport'
import { validateGitBashPath, checkVCRedistInstalled } from '@craft-agent/server-core/services'

// Initialize electron-log for renderer process support
log.initialize()

// Enable debug/perf in dev mode (running from source)
if (isDebugMode) {
  process.env.CRAFT_DEBUG = '1'
  enableDebug()
  setPerfEnabled(true)
}

// Bundle CLI tools: resolve platform-specific uv binary and wrapper scripts.
// These are available to all agent Bash sessions via CRAFT_UV, CRAFT_SCRIPTS env vars
// and PATH prepend. uv auto-downloads Python 3.12 on first use (~5s, then cached).
{
  // In packaged app: resources are at process.resourcesPath/app/resources/
  // In dev: resources are at __dirname/../resources/ (sibling of dist/)
  const resourcesBase = app.isPackaged
    ? join(process.resourcesPath, 'app')
    : join(__dirname, '..')
  const platformKey = `${process.platform}-${process.arch}`
  const uvPlatformDir = join(resourcesBase, 'resources', 'bin', platformKey)
  const uvBinary = join(uvPlatformDir, process.platform === 'win32' ? 'uv.exe' : 'uv')
  const binDir = join(resourcesBase, 'resources', 'bin')
  const scriptsDir = join(resourcesBase, 'resources', 'scripts')

  const bundledUvExists = existsSync(uvBinary)
  const fallbackUv = bundledUvExists ? null : 'uv'

  // Runtime resolver hints for shared session tools
  process.env.CRAFT_IS_PACKAGED = app.isPackaged ? '1' : '0'
  process.env.CRAFT_RESOURCES_BASE = resourcesBase
  process.env.CRAFT_APP_ROOT = app.isPackaged ? app.getAppPath() : process.cwd()

  process.env.CRAFT_UV = bundledUvExists ? uvBinary : (fallbackUv ?? uvBinary)

  // Bun runtime (packaged builds should prefer bundled runtime over PATH)
  const bunBinary = join(resourcesBase, 'vendor', 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun')
  if (existsSync(bunBinary)) {
    process.env.CRAFT_BUN = bunBinary
  }

  process.env.CRAFT_SCRIPTS = scriptsDir
  process.env.CRAFT_COMMANDS_ENTRY = app.isPackaged
    ? join(app.getAppPath(), 'packages', 'craft-agents-commands', 'src', 'main.ts')
    : join(process.cwd(), 'packages', 'craft-agents-commands', 'src', 'main.ts')
  process.env.CRAFT_CLI_ENTRY = app.isPackaged
    ? join(app.getAppPath(), 'packages', 'craft-cli', 'src', 'cli.ts')
    : join(process.cwd(), 'packages', 'craft-cli', 'src', 'cli.ts')
  process.env.CRAFT_COMMANDS_DOC_PATH = app.isPackaged
    ? join(resourcesBase, 'resources', 'docs', 'craft-cli.md')
    : join(process.cwd(), 'apps', 'electron', 'resources', 'docs', 'craft-cli.md')
  process.env.CRAFT_CLI_DOC_PATH = process.env.CRAFT_COMMANDS_DOC_PATH
  process.env.CRAFT_AGENT_VERSION = app.getVersion()
  // Prepend both generic wrappers dir and platform uv dir:
  // - binDir exposes wrapper commands (pdf-tool, docx-tool, ...)
  // - uvPlatformDir exposes raw `uv` for direct shell usage / debugging
  process.env.PATH = `${binDir}${delimiter}${uvPlatformDir}${delimiter}${process.env.PATH}`

  if (!bundledUvExists) {
    mainLog.warn('Bundled uv binary missing, CLI document tools may fail unless uv is available on PATH.', {
      expectedUvPath: uvBinary,
      usingCraftUv: process.env.CRAFT_UV,
    })
  }

  if (isDebugMode) {
    mainLog.info('CLI tools configured:', { uvBinary: process.env.CRAFT_UV, binDir, scriptsDir, bundledUvExists })
  }
}

// Custom URL scheme for deeplinks (e.g., craftagents://auth-complete)
// Supports multi-instance dev: CRAFT_DEEPLINK_SCHEME env var (craftagents1, craftagents2, etc.)
const DEEPLINK_SCHEME = process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents'

let windowManager: WindowManager | null = null
let sessionManager: SessionManager | null = null
let browserPaneManager: BrowserPaneManager | null = null
let oauthFlowStore: OAuthFlowStore | null = null
let moduleSink: EventSink | null = null
let moduleClientResolver: ((webContentsId: number) => string | undefined) | null = null

// Messaging gateway: the bootstrap handle is created once sessionManager is
// available (inside createHandlerDeps) and populated with the WS publisher
// after bootstrapServer resolves. Both hosts (Electron + standalone) wire
// through createMessagingBootstrap — do not construct MessagingGatewayRegistry
// directly.
let messagingHandle: MessagingBootstrapHandle | null = null

// Store pending deep link if app not ready yet (cold start)
let pendingDeepLink: string | null = null

// Set app name early (before app.whenReady) to ensure correct macOS menu bar title
// Supports multi-instance dev: CRAFT_APP_NAME env var (e.g., "Qwen Code [1]")
import { BRAND } from '@craft-agent/shared/branding'
app.setName(process.env.CRAFT_APP_NAME || BRAND.appName)

// Register as default protocol client for craftagents:// URLs
// This must be done before app.whenReady() on some platforms
if (process.defaultApp) {
  // Development mode: need to pass the app path
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [process.argv[1]])
  }
} else {
  // Production mode
  app.setAsDefaultProtocolClient(DEEPLINK_SCHEME)
}

// Apply network proxy settings early (Node-level only — Electron sessions require app.whenReady)
import { applyConfiguredProxySettings } from './network-proxy'
void applyConfiguredProxySettings()

// Accept self-signed / untrusted certificates when connecting to a user-configured remote server.
// Only bypasses cert validation for the exact CRAFT_SERVER_URL origin — all other connections
// use standard certificate verification. Without this, wss:// to self-signed servers fails with
// ERR_CERT_AUTHORITY_INVALID because Chromium's WebSocket rejects untrusted certs.
//
// Electron's certificate-error always reports URLs with https:// scheme, so we normalize
// wss:// → https:// (and ws:// → http://) to ensure origins compare correctly.
function normalizeOriginForCert(urlStr: string): string {
  const u = new URL(urlStr)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  else if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.origin
}

if (process.env.CRAFT_SERVER_URL) {
  let serverOrigin: string | undefined
  try {
    serverOrigin = normalizeOriginForCert(process.env.CRAFT_SERVER_URL)
  } catch {
    // Invalid URL — will fail later during connection, no need to handle here
  }
  if (serverOrigin) {
    app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
      try {
        if (normalizeOriginForCert(url) === serverOrigin) {
          event.preventDefault()
          callback(true)
          return
        }
      } catch {
        // URL parse failure — fall through to default rejection
      }
      callback(false)
    })
  }
}

// Register thumbnail:// custom protocol for file preview thumbnails in the sidebar.
// Must happen before app.whenReady() — Electron requires early scheme registration.
registerThumbnailScheme()

// Handle deeplink on macOS (when app is already running)
app.on('open-url', (event, url) => {
  event.preventDefault()
  mainLog.info('Received deeplink:', url)

  if (windowManager) {
    handleDeepLink(url, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(err => {
      mainLog.error('Failed to handle deep link:', err)
    })
  } else {
    // App not ready - store for later
    pendingDeepLink = url
  }
})

// Handle deeplink on Windows/Linux (single instance check)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  mainLog.warn('Another Qwen Code instance already owns the Electron single-instance lock; quitting.', {
    userData: app.getPath('userData'),
    appName: app.getName(),
  })
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine, _workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    // On Windows/Linux, the deeplink is in commandLine
    const url = commandLine.find(arg => arg.startsWith(`${DEEPLINK_SCHEME}://`))
    if (url && windowManager) {
      mainLog.info('Received deeplink from second instance:', url)
      handleDeepLink(url, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(err => {
        mainLog.error('Failed to handle deep link:', err)
      })
    } else if (windowManager) {
      // No deep link - just focus the first window
      const windows = windowManager.getAllWindows()
      if (windows.length > 0) {
        const win = windows[0].window
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    }
  })
}

// Helper to create initial windows on startup
async function createInitialWindows(options: { createDefaultWorkspace: boolean }): Promise<void> {
  if (!windowManager) return

  // Load saved window state
  const savedState = loadWindowState()
  let workspaces = getWorkspaces()

  // If no workspaces exist, create the protected default conversation entry on first run.
  // Thin clients intentionally skip this so the renderer can show the remote picker.
  if (workspaces.length === 0) {
    if (!options.createDefaultWorkspace) {
      windowManager.createWindow({ workspaceId: '' })
      mainLog.info('Created workspace-picker window without a local workspace')
      return
    }

    ensureDefaultConversationWorkspace()
    workspaces = getWorkspaces() // Refresh after creation
    mainLog.info('Created default conversation workspace on first run')
  }

  const validWorkspaceIds = workspaces.map(ws => ws.id)

  const startupWorkspaceId = [
    savedState?.lastFocusedWorkspaceId,
    ...(savedState?.windows.map(saved => saved.workspaceId) ?? []),
  ].find(id => !!id && validWorkspaceIds.includes(id))

  // Default: open one fresh window in the last focused workspace.
  const startupWorkspace = workspaces.find(ws => ws.id === startupWorkspaceId) ?? workspaces[0]
  if (!startupWorkspace) {
    windowManager.createWindow({ workspaceId: '' })
    mainLog.info('Created workspace-picker window because no workspaces are available')
    return
  }

  windowManager.createWindow({ workspaceId: startupWorkspace.id })
  mainLog.info(`Created startup window for workspace: ${startupWorkspace.name}`)
}

app.whenReady().then(async () => {
  // Export packaged state as env var so logger.ts (and headless Bun) don't need 'electron'
  process.env.CRAFT_IS_PACKAGED = app.isPackaged ? 'true' : 'false'

  // Set About panel info (shown via "About <AppName>" on macOS)
  // Detailed credits live in the custom AboutDialog (Help → About)
  app.setAboutPanelOptions({
    applicationName: BRAND.appName,
    applicationVersion: app.getVersion(),
    copyright: BRAND.copyright,
    ...(BRAND.creditsShort ? { credits: BRAND.creditsShort } : {}),
  })

  // Register bundled assets root so all seeding functions can find their files
  // (docs, permissions, themes, tool-icons resolve via getBundledAssetsDir)
  setBundledAssetsRoot(__dirname)

  // Initialize backend runtime bootstrapping.
  initializeBackendHostRuntime({
    hostRuntime: {
      appRootPath: app.isPackaged ? app.getAppPath() : process.cwd(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    },
  })

  // Register PowerShell validator root so it can find the bundled parser script
  // (Windows only: validates PowerShell commands in Plan mode using AST analysis)
  setPowerShellValidatorRoot(join(__dirname, 'resources'))

  // Initialize bundled docs
  initializeDocs()

  // Initialize bundled release notes
  initializeReleaseNotes()

  // Ensure default permissions file exists (copies bundled default.json on first run)
  ensureDefaultPermissions()

  // Seed tool icons to ~/.craft-agent/tool-icons/ (copies bundled SVGs on first run)
  ensureToolIcons()

  // Seed preset themes to ~/.craft-agent/themes/ (copies bundled theme JSONs on first run)
  ensurePresetThemes()

  // Register thumbnail:// protocol handler (scheme was registered earlier, before app.whenReady)
  registerThumbnailHandler()

  // Re-apply proxy settings now that Electron sessions are available
  // (first call before app.whenReady only configured Node-level proxy)
  await applyConfiguredProxySettings()

  // Note: electron-updater handles pending updates internally via autoInstallOnAppQuit

  // Application menu is created after windowManager initialization (see below)

  // Set dock icon on macOS in dev mode; packaged apps use Info.plist/.icns.
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    // In dev, resources are at ../resources/ (sibling of dist/)
    const brandIconRelPath = BRAND.assets.devDockIcon
    if (brandIconRelPath) {
      const dockIconPath = [
        join(__dirname, brandIconRelPath),
        join(__dirname, '..', brandIconRelPath),
      ].find(p => existsSync(p))

      if (dockIconPath) {
        const dockIcon = nativeImage.createFromPath(dockIconPath)
        if (!dockIcon.isEmpty()) {
          app.dock.setIcon(dockIcon)
          // Initialize badge icon for canvas-based badge overlay
          initBadgeIcon(dockIconPath)
        }
      }
    }

    // Multi-instance dev: show instance number badge on dock icon
    // CRAFT_INSTANCE_NUMBER is set by detect-instance.sh for numbered folders
    const instanceNum = process.env.CRAFT_INSTANCE_NUMBER
    if (instanceNum) {
      const num = parseInt(instanceNum, 10)
      if (!isNaN(num) && num > 0) {
        initInstanceBadge(num)
      }
    }
  }

  try {
    // Initialize window manager
    windowManager = new WindowManager()

    // Create the application menu (needs windowManager for New Window action)
    createApplicationMenu(windowManager)

    // When CRAFT_SERVER_URL is set, this Electron instance is a thin client —
    // it only creates windows whose preload connects to the remote server.
    // Skip server-side initialization (SessionManager, model refresh, platform injection).
    const isClientOnly = !!process.env.CRAFT_SERVER_URL
    const isHeadless = !!process.env.CRAFT_HEADLESS

    if (isClientOnly) {
      mainLog.info(`Client-only mode: CRAFT_SERVER_URL=${process.env.CRAFT_SERVER_URL} (server initialization skipped)`)
    }

    // Initialize notification service (always — triggered by server push events)
    initNotificationService(windowManager)

    // Initialize browser pane manager (always — even in headless, for deps wiring)
    browserPaneManager = new BrowserPaneManager()
    browserPaneManager.setWindowManager(windowManager)
    browserPaneManager.registerToolbarIpc()

    // Build real PlatformServices from Electron APIs
    const platform: PlatformServices = createElectronPlatform({
      app,
      nativeImage,
      shell,
      nativeTheme,
      logger: log,
      isDebugMode,
      getLogFilePath,
      captureError: (err) => Sentry.captureException(err),
    })

    // Bootstrap IPC handlers — preload uses sendSync for window-local details
    ipcMain.on('__get-web-contents-id', (e) => {
      e.returnValue = e.sender.id
    })
    ipcMain.on('__get-workspace-id', (e) => {
      e.returnValue = windowManager?.getWorkspaceForWindow(e.sender.id) ?? ''
    })

    // Transport diagnostics bridge — preload reports remote WS connection state changes
    // so failures are visible in terminal/main.log (not only renderer console).
    ipcMain.on('__transport:status', (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        level?: 'info' | 'warn' | 'error'
        message?: string
        status?: string
        attempt?: number
        nextRetryInMs?: number
        error?: unknown
        close?: unknown
        url?: string
      }

      const level = p.level ?? 'info'
      const message = p.message ?? '[transport] status update'
      const context = {
        status: p.status,
        attempt: p.attempt,
        nextRetryInMs: p.nextRetryInMs,
        error: p.error,
        close: p.close,
        url: p.url,
      }

      if (level === 'error') {
        mainLog.error(message, context)
      } else if (level === 'warn') {
        mainLog.warn(message, context)
      } else {
        mainLog.info(message, context)
      }
    })

    // Dialog bridge — preload capability handlers use ipcRenderer.invoke to
    // call main-process-only dialog APIs (dialog, BrowserWindow).
    ipcMain.handle('__dialog:showMessageBox', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showMessageBox(win, spec)
      return { response: result.response }
    })
    ipcMain.handle('__dialog:showOpenDialog', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win, spec)
      return { canceled: result.canceled, filePaths: result.filePaths }
    })

    if (!isClientOnly) {
      // Restore persisted Git Bash path on Windows (must happen before any SDK subprocess spawn)
      if (process.platform === 'win32') {
        const { getGitBashPath, clearGitBashPath } = await import('@craft-agent/shared/config')
        const gitBashPath = getGitBashPath()
        if (gitBashPath) {
          const validation = await validateGitBashPath(gitBashPath)
          if (validation.valid) {
            process.env.QWEN_CODE_GIT_BASH_PATH = validation.path
          } else {
            clearGitBashPath()
            delete process.env.QWEN_CODE_GIT_BASH_PATH
            mainLog.warn(`Cleared invalid persisted Git Bash path: ${gitBashPath}`)
          }
        }
      }

      // Check for VC++ Redistributable on Windows (required by onnxruntime / markitdown).
      // Without it, document conversion tools (PDF, PPTX, DOCX, XLSX) crash with DLL errors.
      // Sets env var so renderer can show an actionable toast with install button.
      if (process.platform === 'win32') {
        const vcCheck = checkVCRedistInstalled()
        if (!vcCheck.installed) {
          mainLog.warn('[vcredist]', vcCheck.message)
          process.env.CRAFT_VCREDIST_MISSING = '1'
          if (vcCheck.downloadUrl) {
            process.env.CRAFT_VCREDIST_URL = vcCheck.downloadUrl
          }
        } else if (isDebugMode) {
          mainLog.info('[vcredist]', vcCheck.message)
        }
      }

      // Pre-import power manager (async import needed for applyPlatformToSubsystems)
      const { onSessionStarted, onSessionStopped } = await import('./power-manager')

      // Client ID tracking for Electron IPC bridge (webContentsId → clientId)
      const clientMap = new Map<number, string>()
      const resolveClientId = (wcId: number) => clientMap.get(wcId)

      // Read embedded server config (Server settings page)
      const { getServerConfig } = await import('@craft-agent/shared/config')
      const embeddedServerConfig = getServerConfig()
      const serverModeEnabled = embeddedServerConfig.enabled && !isClientOnly

      // Derive host/port/token from server config (or env overrides)
      const serverToken = serverModeEnabled && embeddedServerConfig.token
        ? embeddedServerConfig.token
        : randomUUID()
      const rpcHost = process.env.CRAFT_RPC_HOST
        ?? (serverModeEnabled ? '0.0.0.0' : '127.0.0.1')
      const envRpcPort = process.env.CRAFT_RPC_PORT
      const rpcPort = envRpcPort
        ? parseServerPort('CRAFT_RPC_PORT', envRpcPort, 9100)
        : (serverModeEnabled ? embeddedServerConfig.port : 0)

      // Load TLS certificates if configured
      let tls: import('@craft-agent/server-core/transport').WsRpcTlsOptions | undefined
      if (serverModeEnabled && embeddedServerConfig.tlsCertPath && embeddedServerConfig.tlsKeyPath) {
        try {
          tls = {
            cert: readFileSync(embeddedServerConfig.tlsCertPath),
            key: readFileSync(embeddedServerConfig.tlsKeyPath),
          }
          mainLog.info('[server-mode] TLS enabled')
        } catch (err) {
          mainLog.error('[server-mode] Failed to load TLS certificates:', err)
        }
      }

      if (serverModeEnabled) {
        mainLog.info(`[server-mode] Enabled — binding ${rpcHost}:${rpcPort}${tls ? ' (TLS)' : ''}`)
      }

      // Bootstrap the WS RPC server via shared bootstrap function.
      const instance = await bootstrapServer<SessionManager, HandlerDeps>({
        serverToken,
        rpcHost,
        rpcPort,
        tls,
        bundledAssetsRoot: __dirname,
        serverId: 'local',
        serverVersion: app.getVersion(),
        platformFactory: () => platform,
        applyPlatformToSubsystems: (p) => {
          setFetcherPlatform(p)
          setSessionPlatform(p)
          setSessionRuntimeHooks({
            updateBadgeCount,
            onSessionStarted,
            onSessionStopped,
            captureException: (error, context) => {
              Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
                tags: {
                  ...(context?.errorSource ? { errorSource: context.errorSource } : {}),
                  ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
                },
              })
            },
          })
          setSearchPlatform(p)
          setImageProcessor(p.imageProcessor)
        },
        createSessionManager: () => {
          const sm = new SessionManager()
          sm.setBrowserPaneManager(browserPaneManager!)
          return sm
        },
        createHandlerDeps: ({ sessionManager: sm, platform: p, oauthFlowStore: ofs }) => {
          // The messaging handle is built here because it needs sessionManager.
          // The WS publisher is attached after bootstrapServer resolves (via
          // handle.setPublisher) because wsServer isn't available yet.
          messagingHandle = createMessagingBootstrap({
            sessionManager: sm,
            credentialManager: getCredentialManager(),
            getMessagingDir: (wsId: string) =>
              join(homedir(), '.craft-agent', 'workspaces', wsId, 'messaging'),
            getLegacyMessagingDir: (wsId: string) => {
              const ws = getWorkspaces().find((w) => w.id === wsId)
              return ws ? join(ws.rootPath, 'messaging') : undefined
            },
            // Route messaging diagnostics through the dedicated messaging log
            // at ~/.craft-agent/logs/messaging-gateway.log.
            logger: messagingGatewayLog,
            // WhatsApp worker runs under Electron's embedded Node via
            // ELECTRON_RUN_AS_NODE (WhatsAppAdapter defaults nodeBin to
            // process.execPath). In dev we resolve worker.cjs from the
            // monorepo; in packaged builds it's shipped via extraResources
            // (see apps/electron/electron-builder.yml).
            whatsapp: {
              workerEntry: app.isPackaged
                ? join(process.resourcesPath, 'messaging-whatsapp-worker', 'worker.cjs')
                : join(process.cwd(), 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs'),
              pairingMode: 'qr',
            },
          })
          return {
            sessionManager: sm,
            platform: p,
            windowManager: windowManager ?? undefined,
            browserPaneManager: browserPaneManager ?? undefined,
            oauthFlowStore: ofs,
            messagingRegistry: messagingHandle.registry,
          }
        },
        // Headless: register only core handlers (no GUI handlers for browser, settings, etc.)
        // GUI: register all handlers (core + GUI)
        registerAllRpcHandlers: isHeadless
          ? (server, deps, serverCtx) => registerCoreRpcHandlers(server, deps, serverCtx)
          : registerAllRpcHandlers,
        setSessionEventSink: (sm, sink) => sm.setEventSink(sink),
        initializeSessionManager: (sm) => sm.initialize(),
        initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
          const { getCredentialManager } = await import('@craft-agent/shared/credentials')
          const manager = getCredentialManager()
          const [apiKey, oauth] = await Promise.all([
            manager.getLlmApiKey(slug).catch(() => null),
            manager.getLlmOAuth(slug).catch(() => null),
          ])
          return {
            apiKey: apiKey ?? undefined,
            oauthAccessToken: oauth?.accessToken,
            oauthRefreshToken: oauth?.refreshToken,
            oauthIdToken: oauth?.idToken,
          }
        }),
        onClientConnected: ({ clientId, webContentsId }) => {
          if (webContentsId != null) clientMap.set(webContentsId, clientId)
        },
        cleanupClientResources: (clientId) => {
          for (const [wcId, cId] of clientMap) {
            if (cId === clientId) { clientMap.delete(wcId); break }
          }
          cleanupSessionFileWatchForClient(clientId)
        },
      })

      // Capture module-level references for before-quit cleanup and deep-link handlers
      sessionManager = instance.sessionManager
      oauthFlowStore = instance.oauthFlowStore
      moduleSink = instance.wsServer.push.bind(instance.wsServer)
      moduleClientResolver = resolveClientId

      // -----------------------------------------------------------------------
      // Messaging Gateway — attach the WS publisher, init local workspaces,
      // install the fan-out event sink. The handle was created inside
      // createHandlerDeps so the registry could be wired into HandlerDeps.
      // -----------------------------------------------------------------------
      try {
        if (!messagingHandle) {
          throw new Error('Messaging handle was not constructed in createHandlerDeps')
        }

        messagingHandle.setPublisher(instance.wsServer.push.bind(instance.wsServer))

        // Skip remote-owned workspaces — messaging runs on the remote server.
        const localWorkspaceIds = getWorkspaces()
          .filter((ws) => !ws.remoteServer)
          .map((ws) => ws.id)
        await messagingHandle.initializeWorkspaces(localWorkspaceIds)

        // Compose fan-out event sink: RPC push + messaging gateway dispatch.
        // Always install — this lets workspaces enable messaging at runtime
        // without a process restart.
        const baseSink = instance.wsServer.push.bind(instance.wsServer)
        instance.sessionManager.setEventSink(messagingHandle.wrapSink(baseSink))
        if (messagingHandle.registry.size > 0) {
          mainLog.info(`[messaging] Fan-out sink active for ${messagingHandle.registry.size} workspace(s)`)
        }
      } catch (err) {
        mainLog.error('[messaging] Gateway initialization failed:', err)
      }

      // IPC handlers — preload uses sendSync to get WS connection details

      // Remove workspace from config (cleanup stale entries)
      ipcMain.handle('workspace:remove', async (_event, workspaceId: string) => {
        const { getWorkspaceByNameOrId, isProtectedWorkspace, removeWorkspace: remove } = await import('@craft-agent/shared/config')
        const workspace = getWorkspaceByNameOrId(workspaceId)
        if (isProtectedWorkspace(workspace)) return false
        return remove(workspaceId)
      })

      // Persist local project-list pinning even when the active workspace is remote.
      ipcMain.handle('workspace:pinned:set', async (_event, workspaceId: string, pinned: boolean) => {
        const { getWorkspaceByNameOrId } = await import('@craft-agent/shared/config')
        const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
        const workspace = getWorkspaceByNameOrId(workspaceId)
        if (!workspace) return false
        if (isProtectedWorkspace(workspace)) return false

        const config = loadWorkspaceConfig(workspace.rootPath)
        if (!config) return false

        config.pinned = Boolean(pinned)
        saveWorkspaceConfig(workspace.rootPath, config)
        return true
      })

      // Persist local project-list ordering even when the active workspace is remote.
      ipcMain.handle('workspace:reorder', async (_event, orderedIds: string[]) => {
        const { reorderWorkspaces } = await import('@craft-agent/shared/config')
        return reorderWorkspaces(orderedIds)
      })

      // Cross-server RPC — invoke a channel on an arbitrary remote server
      ipcMain.handle('server:invokeOnServer', async (_event, url: string, token: string, channel: string, ...args: unknown[]) => {
        const { connectToRemote } = await import('./handlers/workspace')
        const { client, error } = await connectToRemote(url, token)
        if (!client) throw new Error(error ?? 'Connection failed')
        try {
          return await client.invoke(channel, ...args)
        } finally {
          client.destroy()
        }
      })

      // Transfer session to another workspace — orchestrated in main process
      // so large bundles can be moved directly between owning servers.
      ipcMain.handle('session:transferToRemoteWorkspace', async (_event, sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) => {
        const idx = sessionIndex ?? 0
        const count = sessionCount ?? 1
        const { getWorkspaceByNameOrId } = await import('@craft-agent/shared/config')
        const { connectToRemote } = await import('./handlers/workspace')
        const { CHUNKED_TRANSFER_THRESHOLD, getChunkCount, invokeChunked, prepareChunkedPayload } = await import('./chunked-rpc')

        const targetWorkspace = getWorkspaceByNameOrId(targetWorkspaceId)
        if (!targetWorkspace?.remoteServer) throw new Error(`Workspace ${targetWorkspaceId} has no remote server`)
        if (!sessionManager) throw new Error('Session manager not initialized')

        const sourceWorkspaceLocalId = windowManager?.getWorkspaceForWindow(_event.sender.id)
        if (!sourceWorkspaceLocalId) throw new Error('Unable to resolve source workspace for transfer')

        const sourceWorkspace = getWorkspaceByNameOrId(sourceWorkspaceLocalId)
        if (!sourceWorkspace) throw new Error(`Source workspace ${sourceWorkspaceLocalId} not found`)

        let bundle: any = null

        if (sourceWorkspace.remoteServer) {
          const { url: sourceUrl, token: sourceToken, remoteWorkspaceId: sourceRemoteWorkspaceId } = sourceWorkspace.remoteServer
          console.log(`[Transfer] Exporting remote-owned session ${sessionId} from workspace ${sourceRemoteWorkspaceId}...`)
          const { client: sourceClient, error: sourceError } = await connectToRemote(sourceUrl, sourceToken, sourceRemoteWorkspaceId)
          if (!sourceClient) throw new Error(sourceError ?? 'Connection failed to source remote server')

          try {
            bundle = await sourceClient.invoke('sessions:export', sessionId)
            if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

            try {
              console.log('[Transfer] Generating conversation summary on source server...')
              const transferPayload = await sourceClient.invoke('sessions:exportRemoteTransfer', sessionId)
              if (transferPayload?.summary && bundle.session?.header) {
                ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
                ;(bundle.session.header as any).transferredSessionSummaryApplied = false
                console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
              }
            } catch (err) {
              console.warn('[Transfer] Source-server summary generation failed:', err)
            }
          } finally {
            sourceClient.destroy()
          }
        } else {
          console.log(`[Transfer] Exporting local-owned session ${sessionId} from workspace ${sourceWorkspace.id}...`)
          bundle = await sessionManager.exportSession(sessionId, sourceWorkspace.id)
          if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

          try {
            console.log('[Transfer] Generating conversation summary...')
            const transferPayload = await sessionManager.exportRemoteSessionTransfer(sessionId, sourceWorkspace.id)
            if (transferPayload?.summary && bundle.session?.header) {
              ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
              ;(bundle.session.header as any).transferredSessionSummaryApplied = false
              console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
            }
          } catch (err) {
            console.warn('[Transfer] Summary generation failed:', err)
          }
        }

        console.log(`[Transfer] Export complete: ${bundle.session?.messages?.length ?? 0} messages, ${bundle.files?.length ?? 0} files`)

        const { url, token, remoteWorkspaceId } = targetWorkspace.remoteServer
        console.log(`[Transfer] Connecting to target remote server: ${url}`)
        const { client, error } = await connectToRemote(url, token, remoteWorkspaceId)
        if (!client) throw new Error(error ?? 'Connection failed to target remote server')
        console.log('[Transfer] Connected to target remote server')

        try {
          const preparedBundle = prepareChunkedPayload(bundle)
          const payloadSize = preparedBundle.bytes.length
          const payloadMB = (payloadSize / (1024 * 1024)).toFixed(1)

          const emitProgress = (chunkSent: number, chunkTotal: number) => {
            try { _event.sender.send('transfer:progress', { sessionIndex: idx, sessionCount: count, chunkSent, chunkTotal }) } catch { /* renderer may be gone */ }
          }

          if (payloadSize < CHUNKED_TRANSFER_THRESHOLD) {
            console.log(`[Transfer] Bundle size: ${payloadMB}MB (< 5MB threshold) → using direct RPC`)
            emitProgress(0, 1)
            const result = await client.invoke('sessions:import', remoteWorkspaceId, bundle, 'fork')
            emitProgress(1, 1)
            return result
          }

          const chunkCount = getChunkCount(payloadSize)
          console.log(`[Transfer] Bundle size: ${payloadMB}MB (>= 5MB threshold) → using chunked transfer (${chunkCount} chunks)`)
          return await invokeChunked(
            client,
            'sessions:import',
            [remoteWorkspaceId, bundle, 'fork'],
            1,
            emitProgress,
            preparedBundle,
          )
        } finally {
          client.destroy()
        }
      })

      // App relaunch (for server config changes — NOT an update install)
      ipcMain.handle('app:relaunch', () => {
        app.relaunch()
        app.exit(0)
      })

      // Language change: sync from renderer to main process and rebuild native menu
      ipcMain.handle('i18n:changeLanguage', async (_event, lang: string) => {
        i18n.changeLanguage(lang)
        const { rebuildMenu } = await import('./menu')
        await rebuildMenu()
      })

      ipcMain.on('__get-ws-port', (e) => {
        e.returnValue = instance.port
      })
      ipcMain.on('__get-ws-token', (e) => {
        e.returnValue = instance.token
      })
      ipcMain.on('__get-workspace-remote-config', (e) => {
        const wsId = windowManager?.getWorkspaceForWindow(e.sender.id)
        if (!wsId) { e.returnValue = null; return }
        const ws = getWorkspaceByNameOrId(wsId)
        e.returnValue = ws?.remoteServer ?? null
      })

      // Server config RPC handlers (LOCAL_ONLY — Electron-specific)
      const runningServerState = {
        host: rpcHost,
        port: instance.port,
        tls: !!tls,
        token: serverToken,
        enabled: serverModeEnabled,
      }

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_CONFIG, async () => {
        const { getServerConfig: getConfig } = await import('@craft-agent/shared/config')
        return getConfig()
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.SET_SERVER_CONFIG, async (_ctx: unknown, config: unknown) => {
        const { setServerConfig: setConfig } = await import('@craft-agent/shared/config')
        const cfg = config as import('@craft-agent/shared/config/server-config').ServerConfig
        // Validate port range
        if (cfg.port < 1024 || cfg.port > 65535) {
          throw new Error(`Port must be between 1024 and 65535, got ${cfg.port}`)
        }
        // Validate cert/key files exist if provided
        if (cfg.tlsCertPath && !existsSync(cfg.tlsCertPath)) {
          throw new Error(`Certificate file not found: ${cfg.tlsCertPath}`)
        }
        if (cfg.tlsKeyPath && !existsSync(cfg.tlsKeyPath)) {
          throw new Error(`Private key file not found: ${cfg.tlsKeyPath}`)
        }
        setConfig(cfg)
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_STATUS, async () => {
        const { getServerConfig: getConfig } = await import('@craft-agent/shared/config')
        const saved = getConfig()
        const protocol = runningServerState.tls ? 'wss' : 'ws'

        // Determine display host (LAN IP if bound to 0.0.0.0)
        let displayHost = runningServerState.host
        if (displayHost === '0.0.0.0' || displayHost === '::') {
          const os = await import('os')
          const nets = os.networkInterfaces()
          for (const name of Object.keys(nets)) {
            for (const net of nets[name] ?? []) {
              if (net.family === 'IPv4' && !net.internal) {
                displayHost = net.address
                break
              }
            }
            if (displayHost !== '0.0.0.0' && displayHost !== '::') break
          }
        }

        // Only compare port/tls/token when at least one side has server mode enabled.
        // When both are disabled, the running port is random — comparing it to the
        // saved default (9100) would always produce a false "restart required" banner.
        const needsRestart = saved.enabled !== runningServerState.enabled
          || ((saved.enabled || runningServerState.enabled) && (
            saved.port !== runningServerState.port
            || (!!saved.tlsCertPath) !== runningServerState.tls
            || (saved.token ?? '') !== runningServerState.token
          ))

        return {
          running: true,
          host: runningServerState.host,
          port: runningServerState.port,
          tls: runningServerState.tls,
          url: `${protocol}://${displayHost}:${runningServerState.port}`,
          token: runningServerState.token,
          needsRestart,
          insecureWarning: isInsecureBind,
        }
      })

      // TLS enforcement — warn when server mode binds to a network address without TLS
      // Mirrors the hard guard in packages/server/src/index.ts but warns instead of blocking,
      // since the user explicitly enabled server mode via UI (may be on a trusted LAN).
      const isInsecureBind = serverModeEnabled && !tls
        && !['127.0.0.1', 'localhost', '::1'].includes(rpcHost)
      if (isInsecureBind) {
        mainLog.warn(
          '[server-mode] WARNING: Listening on a network address without TLS. ' +
          'Auth tokens will be sent in cleartext. ' +
          'Configure TLS certificates in Settings > Server.'
        )
      }

      // Wire EventSink to Electron-specific services
      // Must happen BEFORE createInitialWindows() so event handlers use WS from the start
      windowManager.setRpcEventSink(moduleSink!, resolveClientId)
      const { setMenuEventSink } = await import('./menu')
      setMenuEventSink(moduleSink!, resolveClientId)
      const { setNotificationEventSink } = await import('./notifications')
      setNotificationEventSink(moduleSink!, resolveClientId)

      // Headless: print connection details
      if (isHeadless) {
        console.log(`CRAFT_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
        console.log(`CRAFT_SERVER_TOKEN=${instance.token}`)
      }
    }

    // Create initial windows (restores from saved state or opens first workspace)
    // In headless mode the server runs without any UI — skip window creation.
    if (!isHeadless) {
      await createInitialWindows({ createDefaultWorkspace: !isClientOnly })
    }

    // Run credential health check at startup to detect issues early
    // (corruption, machine migration, missing credentials for default connection)
    // Skip in thin-client mode — credentials are managed by the remote server.
    if (!isClientOnly) {
      try {
        const { getCredentialManager } = await import('@craft-agent/shared/credentials')
        const credentialManager = getCredentialManager()
        const health = await credentialManager.checkHealth()
        if (!health.healthy) {
          mainLog.warn('Credential health check failed:', health.issues)
          // Issues will be displayed in Settings → AI when user navigates there
        }
      } catch (err) {
        mainLog.error('Credential health check error:', err)
      }
    }

    // Initialize power manager (loads setting, must happen after config is available)
    // Non-critical — powerSaveBlocker may not work on headless/xvfb setups
    try {
      const { initPowerManager } = await import('./power-manager')
      await initPowerManager()
    } catch (err) {
      mainLog.warn('[power] Power manager init failed (non-critical):', err instanceof Error ? err.message : err)
    }

    // Set Sentry context tags for error grouping (no PII — just config classification).
    // Runs after init so config and auth state are available.
    // Derives values from the default LLM connection instead of legacy config fields.
    try {
      const { getLlmConnection, getDefaultLlmConnection } = await import('@craft-agent/shared/config')
      const workspaces = getWorkspaces()
      const defaultConnSlug = getDefaultLlmConnection()
      const defaultConn = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null
      Sentry.setTag('authType', defaultConn?.authType ?? 'unknown')
      Sentry.setTag('providerType', defaultConn?.providerType ?? 'unknown')
      Sentry.setTag('hasCustomEndpoint', 'false')
      Sentry.setTag('model', defaultConn?.defaultModel ?? 'default')
      Sentry.setTag('workspaceCount', String(workspaces.length))
    } catch (err) {
      mainLog.warn('Failed to set Sentry context tags:', err)
    }

    // Initialize auto-update (check immediately on launch)
    // Skip in dev mode to avoid replacing /Applications app and launching it instead
    if (moduleSink) setAutoUpdateEventSink(moduleSink)
    if (app.isPackaged) {
      checkForUpdatesOnLaunch().catch(err => {
        mainLog.error('[auto-update] Launch check failed:', err)
      })
    } else {
      mainLog.info('[auto-update] Skipping auto-update in dev mode')
    }

    // Process pending deep link from cold start
    if (pendingDeepLink) {
      mainLog.info('Processing pending deep link:', pendingDeepLink)
      await handleDeepLink(pendingDeepLink, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined)
      pendingDeepLink = null
    }

    mainLog.info('App initialized successfully')
    if (isDebugMode) {
      mainLog.info('Debug mode enabled')
    }
    mainLog.info('Application log path:', getLogFilePath())
    mainLog.info('Messaging gateway log path:', getMessagingGatewayLogFilePath())
  } catch (error) {
    mainLog.error('Failed to initialize app:', error instanceof Error ? error.message : error, (error as any)?.stack)
    // Continue anyway - the app will show errors in the UI
  }

  // macOS: Re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && windowManager) {
      // Open first workspace or last focused
      const workspaces = getWorkspaces()
      if (workspaces.length > 0) {
        const savedState = loadWindowState()
        const wsId = savedState?.lastFocusedWorkspaceId || workspaces[0].id
        // Verify workspace still exists
        if (workspaces.some(ws => ws.id === wsId)) {
          windowManager.createWindow({ workspaceId: wsId })
        } else {
          windowManager.createWindow({ workspaceId: workspaces[0].id })
        }
      }
    }
  })
})

app.on('window-all-closed', () => {
  if (process.env.CRAFT_HEADLESS) return  // headless server stays alive
  // On macOS, apps typically stay active until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Track if we're in the process of quitting (to avoid re-entry)
let isQuitting = false

// Save window state and clean up resources before quitting
app.on('before-quit', async (event) => {
  // Avoid re-entry when we call app.exit()
  if (isQuitting) return
  isQuitting = true

  // Ensure Cmd+Q/app quit bypasses layered window close interception (Cmd+W behavior).
  windowManager?.setAppQuitting(true)

  if (windowManager) {
    // Get full window states (includes bounds, type, and query)
    const windows = windowManager.getWindowStates()
    // Get the focused window's workspace as last focused
    const focusedWindow = BrowserWindow.getFocusedWindow()
    let lastFocusedWorkspaceId: string | undefined
    if (focusedWindow) {
      lastFocusedWorkspaceId = windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
    }

    saveWindowState({
      windows,
      lastFocusedWorkspaceId,
    })
    mainLog.info('Saved window state:', windows.length, 'windows')
  }

  // Flush all pending session writes before quitting
  if (sessionManager) {
    // Prevent quit until sessions are flushed
    event.preventDefault()
    try {
      await sessionManager.flushAllSessions()
      mainLog.info('Flushed all pending session writes')
    } catch (error) {
      mainLog.error('Failed to flush sessions:', error)
    }
    // Clean up SessionManager resources (file watchers, timers, etc.)
    sessionManager.cleanup()

    // Clean up browser pane instances
    if (browserPaneManager) {
      browserPaneManager.destroyAll()
    }

    // Clean up OAuth flow store (stop periodic cleanup timer)
    if (oauthFlowStore) {
      oauthFlowStore.dispose()
    }

    // Stop all model refresh timers
    getModelRefreshService().stopAll()

    // Stop messaging gateways so the WhatsApp worker subprocess exits cleanly.
    if (messagingHandle) {
      try {
        await messagingHandle.dispose()
      } catch (err) {
        mainLog.error('[messaging] dispose failed:', err)
      }
    }

    // Clean up power manager (release power blocker)
    const { cleanup: cleanupPowerManager } = await import('./power-manager')
    cleanupPowerManager()

    // Release the server lock file so the next launch doesn't see a stale PID.
    // This must happen regardless of the exit path (normal quit or update quit).
    releaseServerLock()

    // If update is in progress, let electron-updater handle the quit flow
    // Force exit breaks the NSIS installer on Windows
    if (isUpdating()) {
      mainLog.info('Update in progress, letting electron-updater handle quit')
      app.quit()
      return
    }

    // Now actually quit
    app.exit(0)
  }
})

// Handle uncaught exceptions — forward to Sentry explicitly since registering
// a custom handler can interfere with @sentry/electron's automatic capture.
process.on('uncaughtException', (error) => {
  mainLog.error('Uncaught exception:', error)
  Sentry.captureException(error)
})

process.on('unhandledRejection', (reason, promise) => {
  mainLog.error('Unhandled rejection at:', promise, 'reason:', reason)
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)))
})
