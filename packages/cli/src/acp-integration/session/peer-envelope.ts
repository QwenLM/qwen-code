/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Defangs the only tags that can close or forge the peer-notification envelope.
 *
 * The body is `TeamManager.formatLeaderEnvelope`'s output: real
 * `<teammate_message from="…">` markup whose own `escapeEnvelopeTags` already
 * defanged forged teammate delimiters while leaving ordinary `<`, `>` and
 * quotes intact. XML-escaping the whole body would entity-encode that markup
 * and every comparison inside a report, diverging from the TUI, stream-json
 * and task-list paths that deliver the identical string verbatim. So only this
 * envelope's own delimiters are neutralised here.
 */
export function defangPeerNotificationTags(text: string): string {
  // Only the opening `<` is rewritten, so the tag's own case, spacing and
  // attributes survive unchanged. The `(?![-\w])` guard keeps a longer tag that
  // merely shares the prefix (`<peer-notification-extra>`) out of the match.
  return text.replace(/<(?=\s*\/?\s*peer-notification(?![-\w]))/gi, '&lt;');
}
