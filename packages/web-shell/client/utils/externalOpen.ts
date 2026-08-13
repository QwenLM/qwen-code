/**
 * External-URL opening helper shared by markdown links and `external_url`
 * link artifacts.
 *
 * Inside the packaged desktop shell the webview's implicit `target="_blank"`
 * / `window.open` handling cannot be relied upon (a failed new-window request
 * is silently dropped, which reads as a "styled but dead" link), so external
 * clicks are routed through the shell's `open_external_url` command instead.
 * In a plain browser the helper falls back to `window.open`.
 */

type TauriInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function tauriInvoke(): TauriInvoke | undefined {
  if (typeof window === 'undefined') return undefined;
  const core = (window as { __TAURI__?: { core?: { invoke?: unknown } } })
    .__TAURI__?.core;
  return typeof core?.invoke === 'function'
    ? (core.invoke as TauriInvoke)
    : undefined;
}

/** True when the Web Shell runs inside the packaged Tauri desktop window. */
export function isDesktopShell(): boolean {
  return tauriInvoke() !== undefined;
}

/**
 * Opens `url` in the OS default browser. Rejects when the open fails so
 * callers can surface a visible error instead of swallowing the click.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke('open_external_url', { url });
    return;
  }
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win) {
    throw new Error('The browser blocked the new window.');
  }
  win.opener = null;
}
