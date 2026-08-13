/**
 * External-URL opening helper shared by markdown links and `external_url`
 * link artifacts.
 *
 * Inside the packaged desktop shell, external clicks use Tauri's opener
 * plugin. Plain browsers keep native anchor behavior at the call sites.
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
  if (!invoke) throw new Error('The desktop URL opener is unavailable.');
  await invoke('plugin:opener|open_url', { url });
}
