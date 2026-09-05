/**
 * Runtime probe for the local-files bridge.
 *
 * The bridge needs three things the deployment cannot promise: a Chromium
 * picker, a secure context, and a top-level (or same-origin) document. A remote
 * daemon reached over plain http fails the second; the Chrome extension's side
 * panel fails the third, because it frames the Web Shell from a
 * `chrome-extension://` parent. `localhost` counts as a secure context, so an
 * SSH tunnel to the daemon host needs no TLS.
 */

export type LocalFilesFrame =
  | 'top-level'
  | 'same-origin-iframe'
  | 'cross-origin-iframe';

export type LocalFilesBlocker =
  | 'unsupported-browser'
  | 'insecure-context'
  | 'cross-origin-frame'
  /** The session's workspace cannot host a bridge (untrusted or live). */
  | 'workspace-ineligible'
  | null;

export interface LocalFilesCapability {
  pickerAvailable: boolean;
  secureContext: boolean;
  frame: LocalFilesFrame;
  /** Why the bridge cannot be offered here, or null when it can. */
  blocker: LocalFilesBlocker;
}

/** The slice of `window` the probe reads; injectable so tests need no DOM. */
export interface LocalFilesWindowLike {
  isSecureContext: boolean;
  showDirectoryPicker?: unknown;
  self: unknown;
  top: unknown;
}

function detectFrame(win: LocalFilesWindowLike): LocalFilesFrame {
  if (win.top === null || win.top === win.self) return 'top-level';
  // Reading the parent's location throws exactly when the frame is cross-origin.
  try {
    void (win.top as { location?: { href?: string } }).location?.href;
    return 'same-origin-iframe';
  } catch {
    return 'cross-origin-iframe';
  }
}

export function detectLocalFilesCapability(
  win: LocalFilesWindowLike,
): LocalFilesCapability {
  const pickerAvailable = typeof win.showDirectoryPicker === 'function';
  const secureContext = win.isSecureContext === true;
  const frame = detectFrame(win);
  // Ordered by what the user can act on: a missing picker is a browser choice,
  // an insecure origin is a deployment choice, a cross-origin frame is ours.
  const blocker: LocalFilesBlocker = !pickerAvailable
    ? 'unsupported-browser'
    : !secureContext
      ? 'insecure-context'
      : frame === 'cross-origin-iframe'
        ? 'cross-origin-frame'
        : null;
  return { pickerAvailable, secureContext, frame, blocker };
}
