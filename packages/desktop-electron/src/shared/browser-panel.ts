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
  close: 'desktop-browser:close',
  openRequested: 'desktop-browser:open-requested',
  stateChanged: 'desktop-browser:state-changed',
} as const;

export const DESKTOP_LINK_CHANNELS = {
  open: 'desktop-link:open',
  getPreference: 'desktop-link:get-preference',
  setPreference: 'desktop-link:set-preference',
} as const;

export const BROWSER_PANEL_PARTITION = 'qwen-browser-panel';

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
  close(): Promise<void>;
  onOpenRequested(callback: (url: string) => void): () => void;
  onStateChanged(callback: (state: BrowserPanelState) => void): () => void;
}

export type DesktopLinkOpenPreference = 'in-app' | 'external';

export interface DesktopLinkOpenOptions {
  forceExternal?: boolean;
}

export interface DesktopLinkApi {
  open(url: string, options?: DesktopLinkOpenOptions): Promise<void>;
  getPreference(): Promise<DesktopLinkOpenPreference>;
  setPreference(preference: DesktopLinkOpenPreference): Promise<void>;
}

export interface QwenCodeDesktopApi {
  browserPanel: BrowserPanelApi;
  links: DesktopLinkApi;
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

export function normalizeExternalOpenUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' ||
      url.protocol === 'https:' ||
      url.protocol === 'mailto:'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeDesktopLinkOpenPreference(
  raw: unknown,
): DesktopLinkOpenPreference | undefined {
  return raw === 'in-app' || raw === 'external' ? raw : undefined;
}

export function shouldOpenDesktopLinkExternally(
  normalizedUrl: string,
  preference: DesktopLinkOpenPreference,
  forceExternal: boolean,
): boolean {
  return (
    new URL(normalizedUrl).protocol === 'mailto:' ||
    forceExternal ||
    preference === 'external'
  );
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
