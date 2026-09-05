/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streaming markdown heal (opencode parity): while an assistant message is
 * still streaming, the incremental markdown parser re-parses the trailing
 * blocks on every delta, and unclosed syntax (`1. **聚合` before the closing
 * `**` arrives) flips the tail between literal-marker text and rendered
 * styles frame to frame — the "left-right flicker" on dense Chinese
 * documents. Healing closes the unterminated markers before rendering so the
 * tail always renders as markdown; when streaming settles the raw text is
 * rendered as-is (the message on disk is the truth).
 */
import remend from 'remend';

export function healStreamingMarkdown(text: string): string {
  return remend(text, { linkMode: 'text-only' });
}

/**
 * Render content for an assistant item: while streaming, heal the raw text
 * (unclosed markers render as styled text instead of flipping between
 * literal markers and rendered styles frame to frame); once settled, the
 * message on disk is the truth and the raw text renders as-is.
 */
export function assistantMarkdownForRender(
  text: string,
  streaming: boolean,
): string {
  return streaming ? healStreamingMarkdown(text) : text;
}
