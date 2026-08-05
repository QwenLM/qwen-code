import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { DEFAULT_DOCKED_BROWSER_INSTANCE_ID } from '@/atoms/browser-pane'
import type { ElectronAPI } from '../../../shared/types'

export type BrowserPaneApi = ElectronAPI['browserPane']

export interface OpenUrlInBuiltInBrowserOptions {
  /** Browser pane API surface (window.electronAPI.browserPane). */
  browserPaneApi?: BrowserPaneApi
  /** Channel availability probe (window.electronAPI.isChannelAvailable). */
  isChannelAvailable?: (channel: string) => boolean
  /** Opens the URL in the system default browser. */
  openExternal: (url: string) => void
}

function shouldUseBuiltInBrowser(trimmedUrl: string): boolean {
  const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl)
  const hasSchemeSeparator = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedUrl)
  const hostPattern =
    /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i
  const looksLikeHost = hostPattern.test(trimmedUrl)
  return hasSchemeSeparator
    ? /^https?:\/\//i.test(trimmedUrl)
    : !hasExplicitScheme || looksLikeHost
}

/**
 * Open a URL in the docked built-in browser, falling back to the system
 * default browser on any failure so link clicks never no-op silently
 * (https://github.com/QwenLM/qwen-code/issues/8593).
 */
export async function openUrlInBuiltInBrowser(
  url: string,
  { browserPaneApi, isChannelAvailable, openExternal }: OpenUrlInBuiltInBrowserOptions,
): Promise<void> {
  const trimmedUrl = url.trim()

  if (!shouldUseBuiltInBrowser(trimmedUrl)) {
    openExternal(url)
    return
  }

  // The API surface is always present in Electron builds (built from the channel
  // map), so probe channel availability to detect servers without browser-pane
  // handlers (headless / thin-client) before attempting the built-in path.
  if (!browserPaneApi || isChannelAvailable?.(RPC_CHANNELS.browserPane.CREATE) === false) {
    openExternal(url)
    return
  }

  let instanceId: string | null = null
  try {
    instanceId = await browserPaneApi.create({
      id: DEFAULT_DOCKED_BROWSER_INSTANCE_ID,
      show: true,
      presentation: 'docked',
    })
    await browserPaneApi.navigate(instanceId, trimmedUrl)
    await browserPaneApi.focus(instanceId)
  } catch (error) {
    console.warn(
      '[App] Failed to open URL in built-in browser, falling back to default browser:',
      error,
    )
    if (instanceId) {
      // Hide the half-opened pane so a failed navigation does not leave a
      // stuck empty dock behind.
      browserPaneApi.hide(instanceId).catch(() => {})
    }
    openExternal(url)
  }
}
