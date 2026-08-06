import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { DEFAULT_DOCKED_BROWSER_INSTANCE_ID } from '@/atoms/browser-pane'
import type { ElectronAPI } from '../../../shared/types'

export type BrowserPaneApi = ElectronAPI['browserPane']

const EXPLICIT_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i
const HOST_PATTERN =
  /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i

export interface OpenUrlInBuiltInBrowserOptions {
  /** Browser pane API surface (window.electronAPI.browserPane). */
  browserPaneApi?: BrowserPaneApi
  /** Channel availability probe (window.electronAPI.isChannelAvailable). */
  isChannelAvailable?: (channel: string) => boolean
  /** Opens the URL in the system default browser. */
  openExternal: (url: string) => void
}

function shouldUseBuiltInBrowser(trimmedUrl: string): boolean {
  return (
    HOST_PATTERN.test(trimmedUrl) ||
    !EXPLICIT_SCHEME_PATTERN.test(trimmedUrl) ||
    /^https?:\/\//i.test(trimmedUrl)
  )
}

function normalizeExternalUrl(trimmedUrl: string): string {
  if (HOST_PATTERN.test(trimmedUrl)) return `https://${trimmedUrl}`
  if (EXPLICIT_SCHEME_PATTERN.test(trimmedUrl)) return trimmedUrl
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmedUrl.toWellFormed())}`
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
  const externalUrl = normalizeExternalUrl(trimmedUrl)

  if (!shouldUseBuiltInBrowser(trimmedUrl)) {
    openExternal(externalUrl)
    return
  }

  // The API surface is always present in Electron builds (built from the channel
  // map), so probe channel availability to detect servers without browser-pane
  // handlers (headless / thin-client) before attempting the built-in path.
  if (!browserPaneApi || isChannelAvailable?.(RPC_CHANNELS.browserPane.CREATE) === false) {
    openExternal(externalUrl)
    return
  }

  try {
    const instanceId = await browserPaneApi.create({
      id: DEFAULT_DOCKED_BROWSER_INSTANCE_ID,
      show: true,
      presentation: 'docked',
    })
    await browserPaneApi.navigate(instanceId, trimmedUrl)
    await browserPaneApi.focus(instanceId)
  } catch (error) {
    console.warn(
      '[openUrlInBuiltInBrowser] Failed to open URL in built-in browser, falling back to default browser:',
      error,
    )
    openExternal(externalUrl)
  }
}
