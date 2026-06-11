/**
 * IBrowserPaneManager — interface for browser pane operations used by SessionManager.
 *
 * Covers all 40 methods SessionManager calls on BrowserPaneManager.
 * The concrete BrowserPaneManager in apps/electron implements this.
 *
 * Structurally compatible with BrowserOwnershipReleaser (domain layer)
 * so releaseBrowserOwnershipOnForcedStop() accepts IBrowserPaneManager.
 */

import type { BrowserInstanceInfo } from '@craft-agent/shared/protocol'

// ---------------------------------------------------------------------------
// Supporting types — minimal subsets of BPM's internal types
// ---------------------------------------------------------------------------

/** Subset of BrowserInstance fields accessed by SessionManager */
export interface BrowserInstanceSnapshot {
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  isVisible: boolean
  title: string
  currentUrl: string
}

export interface BrowserScreenshotOptions {
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: Record<string, unknown>
}

export interface BrowserScreenshotRegionTarget {
  x?: number
  y?: number
  width?: number
  height?: number
  ref?: string
  selector?: string
  padding?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserConsoleOptions {
  level?: 'all' | 'log' | 'info' | 'warn' | 'error'
  limit?: number
}

export interface BrowserConsoleEntry {
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
}

export interface BrowserNetworkOptions {
  limit?: number
  status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx'
  method?: string
  resourceType?: string
}

export interface BrowserNetworkEntry {
  timestamp: number
  method: string
  url: string
  status: number
  resourceType: string
  ok: boolean
}

export interface BrowserWaitArgs {
  kind: 'selector' | 'text' | 'url' | 'network-idle'
  value?: string
  timeoutMs?: number
  pollMs?: number
  idleMs?: number
}

export interface BrowserWaitResult {
  ok: true
  kind: string
  elapsedMs: number
  detail: string
}

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadOptions {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserDownloadEntry {
  id: string
  timestamp: number
  url: string
  filename: string
  state: string
  bytesReceived: number
  totalBytes: number
  mimeType: string
  savePath?: string
}

export interface AccessibilityNode {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  focused?: boolean
  checked?: boolean
  disabled?: boolean
}

export interface AccessibilitySnapshot {
  url: string
  title: string
  nodes: AccessibilityNode[]
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IBrowserPaneManager {
  // -- Session lifecycle ---------------------------------------------------

  /** Register a callback that resolves session IDs to file paths */
  setSessionPathResolver(fn: (sessionId: string) => string | null): void

  /** Destroy all browser instances bound to a session */
  destroyForSession(sessionId: string): void

  /** Clear agent control overlay and native overlay state for a session */
  clearVisualsForSession(sessionId: string): Promise<void>

  /** Unbind all browser instances from a session (non-destructive) */
  unbindAllForSession(sessionId: string): void

  /** Get or create a browser instance for a session, returning the instance ID */
  getOrCreateForSession(sessionId: string): string

  /** Activate or update the agent control overlay for a session */
  setAgentControl(sessionId: string, meta: { displayName?: string; intent?: string }): void

  // -- Instance management -------------------------------------------------

  /** Create a browser instance for a session (optionally shown) */
  createForSession(sessionId: string, options?: { show?: boolean }): string

  /** Get instance info by ID */
  getInstance(id: string): BrowserInstanceSnapshot | undefined

  /** List all browser instances with their public info */
  listInstances(): BrowserInstanceInfo[]

  /** Focus the bound browser instance for a session, creating if needed */
  focusBoundForSession(sessionId: string): string

  /** Bind a browser instance to a session */
  bindSession(id: string, sessionId: string): void

  /** Focus a browser instance window */
  focus(id: string): void

  /** Destroy a browser instance */
  destroyInstance(id: string): void

  /** Hide a browser instance window */
  hide(id: string): void

  /** Clear agent control overlay for all instances in a session */
  clearAgentControl(sessionId: string): void

  /** Clear agent control overlay for a specific instance */
  clearAgentControlForInstance(instanceId: string, sessionId?: string): { released: boolean; reason?: string }

  // -- Navigation ----------------------------------------------------------

  navigate(id: string, url: string): Promise<{ url: string; title: string }>
  goBack(id: string): Promise<void>
  goForward(id: string): Promise<void>

  // -- Interaction ---------------------------------------------------------

  getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot>
  clickElement(id: string, ref: string, options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }): Promise<void>
  clickAtCoordinates(id: string, x: number, y: number): Promise<void>
  drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void>
  fillElement(id: string, ref: string, value: string): Promise<void>
  typeText(id: string, text: string): Promise<void>
  selectOption(id: string, ref: string, value: string): Promise<void>
  setClipboard(id: string, text: string): Promise<void>
  getClipboard(id: string): Promise<string>
  scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>
  sendKey(id: string, args: BrowserKeyArgs): Promise<void>
  uploadFile(id: string, ref: string, filePaths: string[]): Promise<unknown>
  evaluate(id: string, expression: string): Promise<unknown>

  // -- Screenshot ----------------------------------------------------------

  screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult>
  screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult>

  // -- Monitoring ----------------------------------------------------------

  getConsoleLogs(id: string, options?: BrowserConsoleOptions): BrowserConsoleEntry[]
  windowResize(id: string, width: number, height: number): { width: number; height: number }
  getNetworkLogs(id: string, options?: BrowserNetworkOptions): BrowserNetworkEntry[]
  waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult>
  getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]>
  detectSecurityChallenge(id: string): Promise<{ detected: boolean; provider: string; signals: string[] }>
}
