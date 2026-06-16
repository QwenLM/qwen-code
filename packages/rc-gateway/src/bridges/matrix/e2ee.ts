/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Matrix end-to-end-encryption scaffolding (`add-matrix-bridge`: "Persistent olm
 * crypto store" + encrypted-room participation). E2EE is a SECOND transport,
 * **opt-in and OFF by default** (`MATRIX_ENABLE_E2EE`): the tested fetch path
 * stays the default and continues to detect-and-refuse encrypted rooms, so
 * enabling crypto can never destabilize the working unencrypted bridge.
 *
 * This module is the pure decision/convention layer — the flag, the olm-store
 * path/status, and the per-room transport decision — so the bug-prone routing is
 * unit-tested without the native crypto module or a homeserver. The actual
 * decrypt/encrypt adapter ({@link ./cryptoAdapter.js}, matrix-bot-sdk + the native
 * rust crypto, dynamically imported) is wired live by `startBridge`: when E2EE is
 * on, the SDK crypto client SUBSUMES the fetch `/sync` (so it can't race the
 * to-device megolm keys) and transparently decrypts encrypted rooms — there is no
 * per-room refuse, the whole bridge runs over crypto. When OFF (the default), the
 * fetch path runs unchanged and still detect-and-refuses encrypted rooms
 * (see {@link MatrixTransport} / {@link decideMatrixTransport}, used by the fetch
 * dispatch).
 *
 * Both the sidecar and the in-process `cli.ts` bridge honor the flag (both build
 * through the shared `startBridge`), and `olmStorePresent` is surfaced on the
 * Matrix bridge's `GET /healthz` (see {@link ./health.js}).
 */

import { join } from 'node:path';

/** Sub-directory under `$QWEN_BRIDGE_STATE_DIR` holding the olm/megolm store. */
export const OLM_STORE_DIRNAME = 'olm';

/**
 * Warn line for first boot with no olm store (a re-key event). Emitted by the
 * crypto-adapter slice once decryption is active — NOT in the scaffolding state,
 * where encrypted rooms are refused rather than re-keyed.
 */
export const OLM_STORE_MISSING_LOG =
  'olm_store_missing: no olm/megolm store found — encrypted-room sessions will re-key';

/** How a given room message should be handled. */
export type MatrixTransport =
  /** Plain text — the room is not encrypted (default path). */
  | 'plain'
  /** Decrypt via the crypto adapter — encrypted room AND E2EE enabled + built. */
  | 'crypto'
  /** Refuse with the E2EE notice — encrypted room but crypto is off/unavailable. */
  | 'refuse';

/** `$QWEN_BRIDGE_STATE_DIR/olm/` — the SQLite-backed olm/megolm store root. */
export function olmStoreDir(stateDir: string): string {
  return join(stateDir, OLM_STORE_DIRNAME);
}

/**
 * Parse `MATRIX_ENABLE_E2EE`. Accepts `1`/`true`/`yes`/`on` (case-insensitive);
 * everything else (including unset) is `false`. Default OFF is the safe default —
 * a typo never silently routes ciphertext through an unbuilt path.
 */
export function parseE2eeEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Decide how to handle a room message. `cryptoAvailable` reflects whether the
 * crypto adapter is actually built/loaded — so an enabled flag with no adapter
 * (the Slice-1 state) still safely refuses rather than dropping ciphertext.
 *
 *   not encrypted                 → 'plain'   (untouched default path)
 *   encrypted + !enabled          → 'refuse'  (existing E2EE notice)
 *   encrypted + enabled + !ready  → 'refuse'  (crypto not built/loaded yet)
 *   encrypted + enabled + ready   → 'crypto'
 */
export function decideMatrixTransport(input: {
  encrypted: boolean;
  e2eeEnabled: boolean;
  cryptoAvailable: boolean;
}): MatrixTransport {
  if (!input.encrypted) return 'plain';
  if (input.e2eeEnabled && input.cryptoAvailable) return 'crypto';
  return 'refuse';
}
