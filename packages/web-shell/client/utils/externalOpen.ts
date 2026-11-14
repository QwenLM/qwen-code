/**
 * External-URL opening helper shared by markdown links and `external_url`
 * link artifacts.
 *
 * Inside the packaged desktop shell, external clicks use Tauri's opener
 * plugin. Plain browsers keep native anchor behavior at the call sites.
 */

export type TauriInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const EXTERNAL_OPEN_SCHEMES = /^(https?:|mailto:)/i;

/** The desktop host's IPC `invoke`, or undefined outside the desktop shell. */
export function tauriInvoke(): TauriInvoke | undefined {
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
 * True in the packaged desktop shell on macOS, where WebKit (WKWebView)
 * never grants Web Notification permission to the embedded web shell. The
 * macOS desktop host posts system notifications itself (see the
 * `show_turn_notification` Tauri command); other platforms keep the
 * standard Web Notification path. The macOS host injects the platform flag
 * at compile time, so this does not depend on the user-agent string.
 */
export function isMacOSDesktopShell(): boolean {
  return (
    isDesktopShell() &&
    (window as { __QWEN_CODE_DESKTOP_PLATFORM__?: unknown })
      .__QWEN_CODE_DESKTOP_PLATFORM__ === 'macos'
  );
}

export function isExternalOpenUrl(url: string | undefined): boolean {
  return Boolean(url?.trim() && EXTERNAL_OPEN_SCHEMES.test(url.trim()));
}

/**
 * Opens `url` in the OS default browser. Rejects when the open fails so
 * callers can surface a visible error instead of swallowing the click.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('The desktop URL opener is unavailable.');
  if (!isExternalOpenUrl(url)) {
    throw new Error('Only http, https, and mailto URLs can be opened.');
  }
  await invoke('plugin:opener|open_url', {
    url: url
      .trim()
      .replace(EXTERNAL_OPEN_SCHEMES, (scheme) => scheme.toLowerCase()),
  });
}
