/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared glyph grammar for the chat feed.
 *
 * Keep glyphs centralized so message components express intent instead of
 * scattering visual punctuation across result strings.
 */
export const FEED_MARKER = {
  assistant: '▪ ',
  info: '● ',
  warning: '● ',
  toolPending: '▫ ',
  toolExecutingFrames: ['▫ ', '▪ '] as const,
  toolSuccess: '▪ ',
  toolConfirming: '? ',
  toolCanceled: '- ',
  toolError: 'x ',
  toolResultConnector: '└ ',
  subagentRunning: '◎',
  subagentCompleted: '◉',
  subagentCanceled: '-',
  subagentError: '◉',
  thinkingHeader: 'Thinking',
  thinkingRail: '│ ',
} as const;
