import { invokeDesktop } from '../utils/externalOpen';

/**
 * The only catalogs the desktop shell persists outside the page. The Web Shell
 * is served from an ephemeral loopback origin, so localStorage written by one
 * launch is unreachable on the next; these keys instead travel through the
 * shell's `shell_state_*` commands. Keep this list in sync with
 * `SHELL_STATE_KEYS` in packages/desktop/src-tauri/src/desktop_state.rs.
 */
export const SHELL_STATE_KEYS = [
  'qwen-remote-connections',
  'qwen-workspace-hosts',
] as const;

export type ShellStateKey = (typeof SHELL_STATE_KEYS)[number];

const cache = new Map<string, string | null>();
let hydration: Promise<void> | undefined;

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The desktop copy below still persists it; a browser keeps the session copy.
  }
}

function removeLocal(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Best effort: a stale copy is ignored once the native value is cached.
  }
}

/**
 * Reads a catalog. In the desktop shell the native store wins once hydration
 * has run; everywhere else (and before hydration) this origin's storage is the
 * source.
 */
export function readShellState(key: ShellStateKey): string | null {
  if (invokeDesktop() !== undefined && cache.has(key)) {
    return cache.get(key) ?? null;
  }
  return readLocal(key);
}

export function writeShellState(key: ShellStateKey, value: string): void {
  writeLocal(key, value);
  const invoke = invokeDesktop();
  if (!invoke) return;
  cache.set(key, value);
  void invoke('shell_state_write', { key, value }).catch(() => {
    // The in-memory copy keeps this session usable, and the mirror below is
    // re-pushed at the next same-origin hydration: only a launch on a fresh
    // loopback origin loses a write the shell never stored.
  });
}

/**
 * Loads the native catalogs once, before the first render, and migrates what
 * this launch's origin still has in localStorage. Only the current origin can
 * be migrated: earlier launches wrote under ports that no longer resolve.
 */
export function hydrateShellState(): Promise<void> {
  if (invokeDesktop() === undefined) return Promise.resolve();
  hydration ??= hydrateDesktop();
  return hydration;
}

async function hydrateDesktop(): Promise<void> {
  const invoke = invokeDesktop();
  if (!invoke) return;
  await Promise.all(
    SHELL_STATE_KEYS.map(async (key) => {
      try {
        const native = await invoke('shell_state_read', { key });
        const local = readLocal(key);
        if (local !== null && local !== native) {
          // Within one launch every change writes the mirror and hydration
          // clears it, so a copy that differs from the native value can only
          // be newer: a native write that silently never landed. Re-push it
          // instead of deleting the only surviving copy.
          await invoke('shell_state_write', { key, value: local });
          cache.set(key, local);
          removeLocal(key);
          return;
        }
        if (typeof native === 'string') {
          cache.set(key, native);
          // Equal copies: the native one stays, the mirror is redundant.
          if (local !== null) removeLocal(key);
          return;
        }
        cache.set(key, null);
      } catch {
        // Leave the key uncached so reads keep falling back to localStorage.
      }
    }),
  );
}
