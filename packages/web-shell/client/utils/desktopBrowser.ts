export interface DesktopBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopBrowserState {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface DesktopBrowserApi {
  open(url: string, bounds: DesktopBrowserBounds): Promise<void>;
  navigate(url: string): Promise<void>;
  setBounds(bounds: DesktopBrowserBounds): void;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  onOpenRequested(callback: (url: string) => void): () => void;
  onStateChanged(callback: (state: DesktopBrowserState) => void): () => void;
}

export type DesktopLinkOpenPreference = 'in-app' | 'external';

export interface DesktopLinkApi {
  open(url: string, options?: { forceExternal?: boolean }): Promise<void>;
  getPreference(): Promise<DesktopLinkOpenPreference>;
  setPreference(preference: DesktopLinkOpenPreference): Promise<void>;
}

declare global {
  interface Window {
    qwenCodeDesktop?: {
      browserPanel?: DesktopBrowserApi;
      links?: DesktopLinkApi;
    };
  }
}

export function getDesktopBrowserApi(): DesktopBrowserApi | undefined {
  return typeof window === 'undefined'
    ? undefined
    : window.qwenCodeDesktop?.browserPanel;
}

export function getDesktopLinkApi(): DesktopLinkApi | undefined {
  return typeof window === 'undefined'
    ? undefined
    : window.qwenCodeDesktop?.links;
}
