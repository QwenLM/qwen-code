/**
 * Web API adapter — browser-compatible ElectronAPI implementation.
 *
 * Reuses the same WsRpcClient + buildClientApi() + CHANNEL_MAP from the Electron app.
 * Overrides LOCAL_ONLY methods (window management, native dialogs, etc.) with web equivalents.
 *
 * Auth: the browser's session cookie (set by /api/auth) is automatically sent
 * on the WebSocket upgrade request — no bearer token needed.
 */

import i18n from 'i18next'
import { toast } from 'sonner'
import { openExternalUrl } from '@craft-agent/ui'
import { WsRpcClient } from '../../../electron/src/transport/client'
import { buildClientApi } from '../../../electron/src/transport/build-api'
import { CHANNEL_MAP } from '../../../electron/src/transport/channel-map'
import type { ElectronAPI, TransportConnectionState } from '../../../electron/src/shared/types'

// ---------------------------------------------------------------------------
// Web file picker (replaces native Electron dialog)
// ---------------------------------------------------------------------------

function webFilePicker(): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => {
      const files = input.files
      if (!files || files.length === 0) {
        resolve([])
        return
      }
      // Return file names — actual file reading is handled elsewhere
      resolve(Array.from(files).map(f => f.name))
    }
    // If user cancels the dialog
    input.oncancel = () => resolve([])
    input.click()
  })
}

// ---------------------------------------------------------------------------
// System theme detection
// ---------------------------------------------------------------------------

const darkMediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

function getSystemTheme(): boolean {
  return darkMediaQuery?.matches ?? false
}

// ---------------------------------------------------------------------------
// Create web API
// ---------------------------------------------------------------------------

export interface WebApiOptions {
  /** WebSocket server URL (ws:// or wss://) */
  serverUrl: string
  /** Workspace ID to connect as. */
  workspaceId?: string
}

export function createWebApi(options: WebApiOptions): {
  api: ElectronAPI
  client: WsRpcClient
} {
  const { serverUrl, workspaceId } = options

  const client = new WsRpcClient(serverUrl, {
    workspaceId,
    autoReconnect: true,
    mode: 'remote',
    // No token — auth is via session cookie sent on WebSocket upgrade
  })

  // Build the API proxy from the same channel map the Electron app uses
  const baseApi = buildClientApi(
    client,
    CHANNEL_MAP,
    (ch) => client.isChannelAvailable(ch),
  )

  // Override LOCAL_ONLY methods with web-compatible implementations
  const webOverrides: Partial<ElectronAPI> = {
    // Shell operations — use browser APIs
    openUrl: (url: string) => {
      const result = openExternalUrl(url)
      if (!result.opened) {
        if (result.reason === 'dangerous') {
          toast.error(`Blocked unsafe URL (${result.detail})`)
        } else if (result.reason === 'internal-deeplink') {
          console.warn('[openUrl] craftagents:// deep links require the desktop app')
        } else {
          console.warn('[openUrl] Malformed URL:', url)
        }
      }
      return Promise.resolve()
    },
    openFile: () => Promise.resolve(), // no-op in browser
    showInFolder: () => Promise.resolve(), // no-op in browser

    // File dialogs
    openFileDialog: webFilePicker,
    openFolderDialog: () => Promise.resolve(null), // not possible in browser

    // System info
    getVersions: () => ({ node: 'n/a', chrome: navigator.userAgent, electron: 'web' }),
    getRuntimeEnvironment: () => 'web',
    getSystemWarnings: () => Promise.resolve({ vcredistMissing: false }),
    isDebugMode: () => Promise.resolve(import.meta.env.DEV),

    // Theme
    getSystemTheme: () => Promise.resolve(getSystemTheme()),
    onSystemThemeChange: (cb: (isDark: boolean) => void) => {
      if (!darkMediaQuery) return () => {}
      const handler = (e: MediaQueryListEvent) => cb(e.matches)
      darkMediaQuery.addEventListener('change', handler)
      return () => darkMediaQuery.removeEventListener('change', handler)
    },

    // Window management — no-ops or browser equivalents
    setTrafficLightsVisible: () => Promise.resolve(),
    closeWindow: () => Promise.resolve(),
    confirmCloseWindow: () => Promise.resolve(),
    cancelCloseWindow: () => Promise.resolve(),
    onCloseRequested: () => () => {},
    getWindowFocusState: () => Promise.resolve(document.hasFocus()),
    onWindowFocusChange: (cb: (focused: boolean) => void) => {
      const onFocus = () => cb(true)
      const onBlur = () => cb(false)
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      return () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
      }
    },

    // Workspace operations — web UI works with a single connection
    getWindowWorkspace: () => Promise.resolve(workspaceId ?? null),
    getWindowMode: () => Promise.resolve('main'),
    // switchWorkspace must call the server so it registers the client's
    // workspaceId — otherwise push events (session updates) won't arrive.
    switchWorkspace: async (wsId: string) => {
      await client.invoke('window:switchWorkspace', wsId)
    },
    openWorkspace: async () => {},
    openSessionInNewWindow: async (_wsId: string, sessionId: string) => {
      // Open in new tab
      window.open(`${window.location.origin}/?session=${sessionId}`, '_blank')
    },

    // Auto-update — not applicable to web (but expose server version for About page)
    checkForUpdates: () => Promise.resolve({ available: false, currentVersion: client.getServerVersion() ?? '' } as any),
    getUpdateInfo: () => Promise.resolve({ available: false, currentVersion: client.getServerVersion() ?? '' } as any),
    installUpdate: () => Promise.resolve(),
    dismissUpdate: () => Promise.resolve(),
    getDismissedUpdateVersion: () => Promise.resolve(null),
    onUpdateAvailable: () => () => {},
    onUpdateDownloadProgress: () => () => {},
    // Release notes — serve from server via RPC (same content as Electron)
    getReleaseNotes: () => client.invoke('releaseNotes:get') as Promise<string>,
    getLatestReleaseVersion: () => client.invoke('releaseNotes:getLatestVersion') as Promise<string | undefined>,

    // Menu events — register as keyboard shortcuts
    onMenuNewChat: () => () => {},
    onMenuOpenSettings: () => () => {},
    onMenuKeyboardShortcuts: () => () => {},
    onMenuToggleFocusMode: () => () => {},
    onMenuToggleSidebar: () => () => {},
    onDeepLinkNavigate: () => () => {},

    // Menu actions — no-ops (web has no native menu)
    menuQuit: () => Promise.resolve(),
    menuNewWindow: () => { window.open(window.location.href, '_blank'); return Promise.resolve() },
    menuMinimize: () => Promise.resolve(),
    menuMaximize: () => Promise.resolve(),
    menuZoomIn: () => Promise.resolve(),
    menuZoomOut: () => Promise.resolve(),
    menuZoomReset: () => Promise.resolve(),
    menuToggleDevTools: () => Promise.resolve(),
    menuUndo: () => { document.execCommand('undo'); return Promise.resolve() },
    menuRedo: () => { document.execCommand('redo'); return Promise.resolve() },
    menuCut: () => { document.execCommand('cut'); return Promise.resolve() },
    menuCopy: () => { document.execCommand('copy'); return Promise.resolve() },
    menuPaste: () => { document.execCommand('paste'); return Promise.resolve() },
    menuSelectAll: () => { document.execCommand('selectAll'); return Promise.resolve() },

    // Badge — use document title
    refreshBadge: () => Promise.resolve(),
    setDockIconWithBadge: () => Promise.resolve(),
    onBadgeDraw: () => () => {},
    onBadgeDrawWindows: () => () => {},

    // Notifications — Web Notifications API
    showNotification: async (title: string, body: string) => {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body })
      }
    },
    onNotificationNavigate: () => () => {},

    // Git bash (Windows-only) — not applicable
    checkGitBash: () => Promise.resolve({ available: true } as any),
    browseForGitBash: () => Promise.resolve(null),
    setGitBashPath: () => Promise.resolve({ success: true }),

    // Skills — open in browser not possible
    openSkillInEditor: () => Promise.resolve(),
    openSkillInFinder: () => Promise.resolve(),

    // Confirmation dialogs — use browser confirm()
    showLogoutConfirmation: () => Promise.resolve(window.confirm(i18n.t('dialog.logoutConfirmation'))),
    showDeleteSessionConfirmation: (name: string) => Promise.resolve(window.confirm(i18n.t('dialog.deleteSessionConfirmation', { name }))),

    // Power settings — not applicable
    getKeepAwakeWhileRunning: () => Promise.resolve(false),
    setKeepAwakeWhileRunning: () => Promise.resolve(),

    // Transport state
    getTransportConnectionState: () => Promise.resolve(client.getConnectionState() as TransportConnectionState),
    onTransportConnectionStateChanged: (cb: (state: TransportConnectionState) => void) => {
      return client.onConnectionStateChanged(cb as any)
    },
    reconnectTransport: () => { client.reconnectNow(); return Promise.resolve() },
    isChannelAvailable: (ch: string) => client.isChannelAvailable(ch),

    // Relaunch — reload page
    relaunchApp: () => { window.location.reload(); return Promise.resolve() },
    removeWorkspace: () => Promise.resolve(false), // not supported in web UI
    invokeOnServer: () => Promise.reject(new Error('Cross-server RPC not available in web UI')),
  }

  // OAuth overrides — web-compatible browser opening
  // The Electron preload uses shell.openExternal() which isn't available in browsers.
  const oauthOverrides: Partial<ElectronAPI> = {
    // Generic source OAuth — server prepares the flow, we open the auth URL in a new tab.
    // The OAuth provider redirects through the relay to our server's /api/oauth/callback,
    // which completes the token exchange and pushes status via WebSocket.
    performOAuth: async (args: {
      sourceSlug: string
      sessionId?: string
      authRequestId?: string
    }) => {
      try {
        const callbackUrl = `${window.location.origin}/api/oauth/callback`
        const result = await client.invoke('oauth:start', {
          sourceSlug: args.sourceSlug,
          callbackUrl,
          sessionId: args.sessionId,
          authRequestId: args.authRequestId,
        })

        // Open auth URL in a new tab — after authentication the relay
        // redirects back to our server's /api/oauth/callback endpoint.
        window.open(result.authUrl, '_blank', 'noopener')

        // The server completes the flow when the callback arrives and pushes
        // auth status via WebSocket — the AuthRequestCard updates automatically.
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'OAuth flow failed',
        }
      }
    },

  }

  const api = { ...baseApi, ...webOverrides, ...oauthOverrides } as ElectronAPI

  return { api, client }
}
