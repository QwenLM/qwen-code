/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure onboarding helpers for the side panel. No DOM / `chrome.*` access, so
 * they can be unit-reasoned and reused by sidepanel.js (loaded as an ES
 * module). Kept as a static asset — the panel ships without a bundler.
 */

/** `qwen serve`'s default loopback bind (mirrors daemon/config.ts). */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:4170';

/**
 * Resolve the daemon base URL from a `chrome.storage` override, falling back to
 * the loopback default when unset/blank.
 *
 * @param {unknown} storedBaseUrl value read from chrome.storage.local
 * @returns {string} a non-empty base URL
 */
export function resolveBaseUrl(storedBaseUrl) {
  const trimmed = typeof storedBaseUrl === 'string' ? storedBaseUrl.trim() : '';
  return trimmed || DEFAULT_BASE_URL;
}

/**
 * The exact command the user must run so the daemon (a) lets this extension
 * frame its Web Shell (the `frame-ancestors` CSP, see serve/web-shell-static.ts)
 * and (b) accepts the extension's cross-origin requests.
 *
 * `extensionId` comes from `chrome.runtime.id` at call time, so the command is
 * always correct for both the dev-unpacked id and the published id — no need to
 * know the id ahead of time or hardcode it.
 *
 * @param {string} extensionId the extension's own id (chrome.runtime.id)
 * @returns {string}
 */
export function allowOriginCommand(extensionId) {
  return `qwen serve --allow-origin chrome-extension://${extensionId}`;
}

/**
 * Decide which side-panel screen to show from two daemon probes:
 *  - `healthOk`: did `GET /health` succeed?
 *  - `allowOriginActive`: does `GET /capabilities` list the `allow_origin`
 *    feature (i.e. the daemon was booted with `--allow-origin`)?
 *
 * @param {{healthOk: boolean, allowOriginActive: boolean}} probe
 * @returns {'down' | 'needs-allow-origin' | 'ready'}
 *   - `down`               daemon unreachable → tell the user to start it
 *   - `needs-allow-origin` daemon up but framing not permitted → tell them to
 *                          restart it with the `--allow-origin` flag
 *   - `ready`              safe to load the Web Shell iframe
 *
 * Note: `/capabilities` only reports that *some* `--allow-origin` is set, not
 * that *this* origin is in the allowlist. A daemon allow-listing a different
 * origin reads as `ready` yet would still block our frame; that uncommon case
 * is left to surface as a blocked iframe rather than complicating the gate,
 * since the welcome command we hand out always names this exact origin.
 */
export function decideState({ healthOk, allowOriginActive }) {
  if (!healthOk) return 'down';
  if (!allowOriginActive) return 'needs-allow-origin';
  return 'ready';
}
