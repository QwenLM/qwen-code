/**
 * Null-object BrowserPaneManager for headless mode.
 *
 * All methods return safe defaults or throw a clear error.
 * This replaces scattered `if (!browserPaneManager)` guards in handler code
 * with a proper null-object pattern — headless mode injects this stub,
 * Electron GUI injects the real implementation.
 */

import type {
  IBrowserPaneManager,
  AccessibilitySnapshot,
  BrowserConsoleEntry,
  BrowserConsoleOptions,
  BrowserDownloadEntry,
  BrowserDownloadOptions,
  BrowserInstanceSnapshot,
  BrowserKeyArgs,
  BrowserNetworkEntry,
  BrowserNetworkOptions,
  BrowserScreenshotOptions,
  BrowserScreenshotRegionTarget,
  BrowserScreenshotResult,
  BrowserWaitArgs,
  BrowserWaitResult,
} from '../handlers/browser-pane-manager-interface'
import type { BrowserInstanceInfo } from '@craft-agent/shared/protocol'

const NOT_AVAILABLE = 'Browser automation is not available in headless mode'

function unavailable(method: string): never {
  throw new Error(`${method}: ${NOT_AVAILABLE}`)
}

export class NullBrowserPaneManager implements IBrowserPaneManager {
  // -- Session lifecycle (no-ops) --
  setSessionPathResolver(_fn: (sessionId: string) => string | null): void {}
  destroyForSession(_sessionId: string): void {}
  async clearVisualsForSession(_sessionId: string): Promise<void> {}
  unbindAllForSession(_sessionId: string): void {}
  getOrCreateForSession(_sessionId: string): string { return unavailable('getOrCreateForSession') }
  setAgentControl(_sessionId: string, _meta: { displayName?: string; intent?: string }): void {}

  // -- Instance management --
  createForSession(_sessionId: string, _options?: { show?: boolean }): string { return unavailable('createForSession') }
  getInstance(_id: string): BrowserInstanceSnapshot | undefined { return undefined }
  listInstances(): BrowserInstanceInfo[] { return [] }
  focusBoundForSession(_sessionId: string): string { return unavailable('focusBoundForSession') }
  bindSession(_id: string, _sessionId: string): void { unavailable('bindSession') }
  focus(_id: string): void { unavailable('focus') }
  destroyInstance(_id: string): void {}
  hide(_id: string): void {}
  clearAgentControl(_sessionId: string): void {}
  clearAgentControlForInstance(_instanceId: string, _sessionId?: string): { released: boolean; reason?: string } {
    return { released: false, reason: NOT_AVAILABLE }
  }

  // -- Navigation --
  async navigate(_id: string, _url: string): Promise<{ url: string; title: string }> { unavailable('navigate') }
  async goBack(_id: string): Promise<void> { unavailable('goBack') }
  async goForward(_id: string): Promise<void> { unavailable('goForward') }

  // -- Interaction --
  async getAccessibilitySnapshot(_id: string): Promise<AccessibilitySnapshot> { unavailable('getAccessibilitySnapshot') }
  async clickElement(_id: string, _ref: string, _options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }): Promise<void> { unavailable('clickElement') }
  async clickAtCoordinates(_id: string, _x: number, _y: number): Promise<void> { unavailable('clickAtCoordinates') }
  async drag(_id: string, _x1: number, _y1: number, _x2: number, _y2: number): Promise<void> { unavailable('drag') }
  async fillElement(_id: string, _ref: string, _value: string): Promise<void> { unavailable('fillElement') }
  async typeText(_id: string, _text: string): Promise<void> { unavailable('typeText') }
  async selectOption(_id: string, _ref: string, _value: string): Promise<void> { unavailable('selectOption') }
  async setClipboard(_id: string, _text: string): Promise<void> { unavailable('setClipboard') }
  async getClipboard(_id: string): Promise<string> { return unavailable('getClipboard') }
  async scroll(_id: string, _direction: 'up' | 'down' | 'left' | 'right', _amount?: number): Promise<void> { unavailable('scroll') }
  async sendKey(_id: string, _args: BrowserKeyArgs): Promise<void> { unavailable('sendKey') }
  async uploadFile(_id: string, _ref: string, _filePaths: string[]): Promise<unknown> { return unavailable('uploadFile') }
  async evaluate(_id: string, _expression: string): Promise<unknown> { return unavailable('evaluate') }

  // -- Screenshot --
  async screenshot(_id: string, _options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> { return unavailable('screenshot') }
  async screenshotRegion(_id: string, _target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> { return unavailable('screenshotRegion') }

  // -- Monitoring --
  getConsoleLogs(_id: string, _options?: BrowserConsoleOptions): BrowserConsoleEntry[] { return [] }
  windowResize(_id: string, _width: number, _height: number): { width: number; height: number } { return unavailable('windowResize') }
  getNetworkLogs(_id: string, _options?: BrowserNetworkOptions): BrowserNetworkEntry[] { return [] }
  async waitFor(_id: string, _args: BrowserWaitArgs): Promise<BrowserWaitResult> { return unavailable('waitFor') }
  async getDownloads(_id: string, _options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> { return [] }
  async detectSecurityChallenge(_id: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    return { detected: false, provider: 'none', signals: [] }
  }
}
