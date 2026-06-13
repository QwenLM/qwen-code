/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Max serialized tool-call size considered safe to inline into a chat message. */
const MAX_RENDER_BYTES = 2048;

/**
 * Heuristic for secret-looking content in tool-call args — a key or value that
 * smells like a credential. Conservative (false-positives are fine: the bridge
 * just shows a "tap to view in the web client" link instead of inlining).
 */
const SECRET_RE =
  /(api[_-]?key|secret|token|password|passwd|credential|authorization|bearer|private[_-]?key|client[_-]?secret|access[_-]?key)/i;

/**
 * Advisory hint on whether a permission request's tool-call args are safe to
 * render directly into a chat message (`add-bridge-protocol`). A bridge uses this
 * to decide between inlining the args and showing a "tap to view in the web
 * client" deep link — so secrets aren't echoed into a group chat and a huge diff
 * isn't dumped into Telegram.
 */
export interface BridgeHints {
  /** Safe to inline the args directly into a chat message? */
  renderable: boolean;
  /** Why not (only when `renderable` is false). */
  reason?: 'too_large' | 'possible_secret';
}

/**
 * Compute {@link BridgeHints} for a tool call. PURE + total (never throws — a
 * weird/unserializable shape degrades to not-renderable). Checks for a
 * secret-looking key/value first (worse than size), then the size cap.
 */
export function computeBridgeHints(toolCall: unknown): BridgeHints {
  const tc =
    toolCall && typeof toolCall === 'object'
      ? (toolCall as Record<string, unknown>)
      : {};
  // Prefer the args sub-object when present; otherwise inspect the whole call.
  const subject = 'args' in tc ? tc['args'] : tc;
  let json: string;
  try {
    json = JSON.stringify(subject ?? {}) ?? '';
  } catch {
    // Circular / unserializable → treat as not safe to render.
    return { renderable: false, reason: 'too_large' };
  }
  if (SECRET_RE.test(json)) {
    return { renderable: false, reason: 'possible_secret' };
  }
  if (json.length > MAX_RENDER_BYTES) {
    return { renderable: false, reason: 'too_large' };
  }
  return { renderable: true };
}
