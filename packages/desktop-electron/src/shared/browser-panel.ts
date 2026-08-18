/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const BROWSER_PANEL_CHANNELS = {
  open: 'desktop-browser:open',
  navigate: 'desktop-browser:navigate',
  setBounds: 'desktop-browser:set-bounds',
  goBack: 'desktop-browser:go-back',
  goForward: 'desktop-browser:go-forward',
  reload: 'desktop-browser:reload',
  openExternal: 'desktop-browser:open-external',
  close: 'desktop-browser:close',
  stateChanged: 'desktop-browser:state-changed',
} as const;

export const BROWSER_PANEL_PARTITION = 'qwen-browser-panel';

export const BROWSER_PANEL_CSS = `
  [data-qwen-desktop-browser-panel] {
    app-region: no-drag;
    background: var(--background, #ffffff);
    color: var(--foreground, #111111);
    display: flex;
    flex: 0 0 var(--qwen-desktop-browser-width, 520px);
    height: 100%;
    min-height: 0;
    min-width: 0;
    width: var(--qwen-desktop-browser-width, 520px);
  }

  [data-qwen-desktop-browser-panel][hidden] {
    display: none;
  }

  [data-qwen-desktop-browser-resize] {
    cursor: col-resize;
    flex: 0 0 8px;
    position: relative;
    touch-action: none;
    width: 8px;
    z-index: 2;
  }

  [data-qwen-desktop-browser-resize]::after {
    background: var(--border, #d4d4d4);
    content: '';
    inset: 0 3px;
    position: absolute;
  }

  [data-qwen-desktop-browser-surface] {
    border-left: 1px solid var(--border, #d4d4d4);
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  [data-qwen-desktop-browser-toolbar] {
    align-items: center;
    background: var(--sidebar-background, var(--background, #ffffff));
    border-bottom: 1px solid var(--border, #d4d4d4);
    display: flex;
    flex: 0 0 42px;
    gap: 4px;
    min-width: 0;
    padding: 5px 7px;
  }

  [data-qwen-desktop-browser-toolbar] button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    height: 30px;
    justify-content: center;
    padding: 0;
    width: 30px;
  }

  [data-qwen-desktop-browser-toolbar] button:hover:not(:disabled) {
    background: var(--accent, rgba(127, 127, 127, 0.16));
  }

  [data-qwen-desktop-browser-toolbar] button:disabled {
    cursor: default;
    opacity: 0.35;
  }

  [data-qwen-desktop-browser-address-form] {
    flex: 1 1 auto;
    min-width: 0;
  }

  [data-qwen-desktop-browser-address] {
    background: var(--background, #ffffff);
    border: 1px solid var(--border, #d4d4d4);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    height: 30px;
    min-width: 0;
    outline: none;
    padding: 0 9px;
    width: 100%;
  }

  [data-qwen-desktop-browser-address]:focus {
    border-color: var(--ring, #737373);
  }

  [data-qwen-desktop-browser-content] {
    background: #ffffff;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    position: relative;
  }
`;

export interface BrowserPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPanelState {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserPanelApi {
  open(url: string, bounds: BrowserPanelBounds): Promise<void>;
  navigate(url: string): Promise<void>;
  setBounds(bounds: BrowserPanelBounds): void;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  openExternal(url: string): Promise<void>;
  close(): Promise<void>;
  onStateChanged(callback: (state: BrowserPanelState) => void): () => void;
}

export interface LinkClickInput {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  pageUrl: string;
  platform: NodeJS.Platform;
  url: string;
}

export function normalizeBrowserPanelUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeBrowserPanelBounds(
  raw: unknown,
): BrowserPanelBounds | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Partial<BrowserPanelBounds>;
  if (
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height)
  ) {
    return undefined;
  }
  const bounds = {
    x: Math.round(value.x!),
    y: Math.round(value.y!),
    width: Math.round(value.width!),
    height: Math.round(value.height!),
  };
  return bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0
    ? bounds
    : undefined;
}

export function shouldOpenLinkInApp(input: LinkClickInput): boolean {
  if (input.button !== 0) return false;
  const modifier = input.platform === 'darwin' ? input.metaKey : input.ctrlKey;
  if (!modifier) return false;
  const url = normalizeBrowserPanelUrl(input.url);
  if (!url) return false;
  try {
    return new URL(url).origin !== new URL(input.pageUrl).origin;
  } catch {
    return false;
  }
}
