/**
 * Grant acquisition and recovery for the local-files bridge.
 *
 * Two paths, because the browser splits them: `pickDirectoryHandle` needs a
 * user gesture and opens the native picker; `ensureReadwritePermission` reports
 * whether an already-stored handle can be used silently. Chrome may answer
 * `granted` after a reload (persistent permission) or `prompt`, and `prompt`
 * can only be cleared by another real gesture — `requestPermission()` consumes
 * the activation that a page load does not have. The UI therefore needs a
 * reconnect affordance even though the common case is silent.
 */

import {
  detectLocalFilesCapability,
  type LocalFilesBlocker,
  type LocalFilesWindowLike,
} from './capabilities.js';
import { LocalDirectory } from './local-directory.js';

export type PickResult =
  | { kind: 'picked'; handle: FileSystemDirectoryHandle }
  | { kind: 'cancelled' }
  | { kind: 'unavailable'; blocker: Exclude<LocalFilesBlocker, null> }
  /** The picker existed and was invoked, but the grant itself failed. */
  | { kind: 'failed'; message: string };

export interface DirectoryPickerLike {
  (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }): Promise<FileSystemDirectoryHandle>;
}

/** Same picker id every time so Chrome reopens the user's last choice. */
const PICKER_ID = 'qwen-local-files';

/**
 * Wrap a granted handle in the path-safe facade. This is the seam where the
 * real `FileSystemDirectoryHandle` meets the structural interfaces
 * `LocalDirectory` is written against.
 */
export function openLocalDirectory(
  handle: FileSystemDirectoryHandle,
): LocalDirectory {
  return new LocalDirectory(handle);
}

export function pickDirectoryHandle(
  win: LocalFilesWindowLike,
): Promise<PickResult> {
  const capability = detectLocalFilesCapability(win);
  if (capability.blocker !== null) {
    return Promise.resolve({
      kind: 'unavailable',
      blocker: capability.blocker,
    });
  }
  const pick = win.showDirectoryPicker as DirectoryPickerLike;
  return pick({ id: PICKER_ID, mode: 'readwrite' }).then(
    (handle) => ({ kind: 'picked' as const, handle }),
    (err: unknown) =>
      // A dismissed picker is a normal outcome, not a failure — the UI must not
      // report it as one. Anything else keeps its own message: labelling a
      // policy block "unsupported browser" would send the user to the wrong fix.
      (err as { name?: unknown })?.name === 'AbortError'
        ? { kind: 'cancelled' as const }
        : {
            kind: 'failed' as const,
            message: err instanceof Error ? err.message : String(err),
          },
  );
}

export interface PermissionResult {
  state: PermissionState;
  /** True when reaching `granted` required (and consumed) a user gesture. */
  requested: boolean;
}

/**
 * Report — and optionally ask for — readwrite access to a stored handle. Pass
 * `allowRequest: true` only from inside a real click handler.
 */
export async function ensureReadwritePermission(
  handle: FileSystemDirectoryHandle,
  options: { allowRequest?: boolean } = {},
): Promise<PermissionResult> {
  const descriptor = { mode: 'readwrite' as const };
  let state: PermissionState;
  try {
    state = await handle.queryPermission(descriptor);
  } catch {
    // A handle whose permission cannot even be queried is unusable; report it
    // as denied so the caller asks the user to pick again.
    return { state: 'denied', requested: false };
  }
  if (state === 'granted') return { state, requested: false };
  if (state !== 'prompt' || options.allowRequest !== true) {
    return { state, requested: false };
  }
  try {
    const requested = await handle.requestPermission(descriptor);
    return { state: requested, requested: true };
  } catch {
    return { state: 'denied', requested: true };
  }
}
