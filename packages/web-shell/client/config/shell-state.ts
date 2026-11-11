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

const SHELL_NONCE_STORAGE_KEY = 'qwen-shell-nonce';
/**
 * Stamps the `localStorage` mirror with the launch that wrote it. WebView2 keeps
 * each origin's storage on disk, so a mirror outlives its launch; when an
 * ephemeral port comes back around, an unstamped mirror would look newer than
 * the native catalog the other launches have been building. One stamp per
 * catalog: a key whose read failed keeps its older mirror, and a sibling's
 * write this launch must not vouch for it.
 */
const SHELL_MIRROR_STAMP_PREFIX = 'qwen-shell-mirror-launch';

function mirrorStampKey(key: string): string {
  return `${SHELL_MIRROR_STAMP_PREFIX}:${key}`;
}

/**
 * Records, per catalog, the native value the mirror was derived from: what
 * the cache held immediately before the write. A foreign-stamped mirror whose
 * base still equals the native value is the only surviving copy of a write
 * the shell never stored; one whose base no longer matches has been superseded.
 * Like the stamp, this lives in localStorage — the native value is capped at
 * SHELL_STATE_MAX_VALUE_BYTES and its key allowlist admits no metadata key.
 */
const SHELL_MIRROR_BASE_PREFIX = 'qwen-shell-mirror-base';

function mirrorBaseKey(key: string): string {
  return `${SHELL_MIRROR_BASE_PREFIX}:${key}`;
}

const cache = new Map<string, string | null>();
let hydration: Promise<void> | undefined;
let shellNonce: string | undefined;

/**
 * The per-launch value Rust appends beside `token=` in the boot fragment. The
 * `shell_state_*` commands require it because Tauri reports the top-level
 * document's URL: a cross-origin frame inside the Web Shell clears the origin
 * check on Windows, and this is the piece it cannot read. Session storage keeps
 * it across an in-app reload that drops the fragment; memory keeps every call
 * in this document on the same value.
 */
function readShellNonce(): string {
  if (shellNonce !== undefined) return shellNonce;
  try {
    const fromHash = new URLSearchParams(
      window.location.hash.replace(/^#/, ''),
    ).get('shell');
    if (fromHash) {
      shellNonce = fromHash;
      try {
        window.sessionStorage.setItem(SHELL_NONCE_STORAGE_KEY, fromHash);
      } catch {
        // This document's own memory is enough.
      }
      return shellNonce;
    }
    shellNonce = window.sessionStorage.getItem(SHELL_NONCE_STORAGE_KEY) ?? '';
  } catch {
    shellNonce = '';
  }
  return shellNonce;
}

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string, base: string | null): void {
  try {
    window.localStorage.setItem(key, value);
    window.localStorage.setItem(mirrorStampKey(key), readShellNonce());
    if (base === null) {
      window.localStorage.removeItem(mirrorBaseKey(key));
    } else {
      window.localStorage.setItem(mirrorBaseKey(key), base);
    }
  } catch {
    // The desktop copy below still persists it; a browser keeps the session copy.
  }
}

/** The native value this catalog's mirror was derived from, if recorded. */
function readMirrorBase(key: string): string | null {
  try {
    return window.localStorage.getItem(mirrorBaseKey(key));
  } catch {
    return null;
  }
}

/** Whether this catalog's mirror on this origin was written by this launch. */
function mirrorFromThisLaunch(key: string): boolean {
  const launch = readShellNonce();
  if (!launch) return false;
  try {
    return window.localStorage.getItem(mirrorStampKey(key)) === launch;
  } catch {
    return false;
  }
}

function removeLocal(key: string): void {
  try {
    window.localStorage.removeItem(key);
    window.localStorage.removeItem(mirrorStampKey(key));
    window.localStorage.removeItem(mirrorBaseKey(key));
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
  const base = cache.get(key);
  writeLocal(key, value, typeof base === 'string' ? base : null);
  const invoke = invokeDesktop();
  if (!invoke) return;
  cache.set(key, value);
  void invoke('shell_state_write', {
    key,
    value,
    nonce: readShellNonce(),
  }).catch(() => {
    // The in-memory copy keeps this session usable, and the mirror below is
    // re-pushed at the next same-origin hydration while the native catalog
    // still matches the base the mirror records: a launch on a fresh loopback
    // origin loses a write the shell never stored, and a native write that
    // landed since supersedes it.
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
        const native = await invoke('shell_state_read', {
          key,
          nonce: readShellNonce(),
        });
        const local = readLocal(key);
        if (local !== null && local !== native) {
          // A copy this launch wrote is newer than the native value: a write
          // that silently never landed. A copy from an earlier launch can
          // reappear when an ephemeral port is reused; it is older only when
          // the native catalog moved past the base it records, and re-pushing
          // it then would drop whatever the launches in between added. While
          // its base still equals the native value it is instead the only
          // surviving copy of a write that never landed, so it is adopted. A
          // mirror with no recorded base is dropped the same way. With no
          // native copy at all there is nothing to lose, so migration still
          // adopts the mirror.
          if (
            typeof native === 'string' &&
            !mirrorFromThisLaunch(key) &&
            readMirrorBase(key) !== native
          ) {
            cache.set(key, native);
            removeLocal(key);
            return;
          }
          await invoke('shell_state_write', {
            key,
            value: local,
            nonce: readShellNonce(),
          });
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
