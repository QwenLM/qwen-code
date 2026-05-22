/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const EstimatedArtWidth = 59;
const BoxBorderWidth = 1;
export const BOX_PADDING_X = 1;

// Calculate width based on art, padding, and border
export const UI_WIDTH =
  EstimatedArtWidth + BOX_PADDING_X * 2 + BoxBorderWidth * 2; // ~63

export const STREAM_DEBOUNCE_MS = 100;

export const SHELL_COMMAND_NAME = 'Shell Command';

export const SHELL_NAME = 'Shell';

// Tool status symbols used in ToolMessage component
export const TOOL_STATUS = {
  SUCCESS: '✓',
  PENDING: 'o',
  EXECUTING: '⊷',
  CONFIRMING: '?',
  CANCELED: '-',
  ERROR: 'x',
} as const;

/**
 * Leading glyph for a tool call line, aligned to Claude Code's
 * `BLACK_CIRCLE` (`figures.ts:4`). `⏺` on macOS terminals; `●` is
 * the close fallback for non-macOS Unicode terminals. ASCII fallback
 * `*` is used on Windows console.
 */
export const TOOL_PREFIX =
  process.platform === 'win32'
    ? '*'
    : process.platform === 'darwin'
      ? '⏺'
      : '●';

/**
 * Leading glyph for a tool's result line; sits indented under the
 * tool call. Aligned to CC's box-drawing "boxupright" used for
 * result continuations. ASCII fallback `>` on Windows.
 */
export const RESULT_PREFIX = process.platform === 'win32' ? '>' : '⎿';

/**
 * Glyph for the ephemeral "thinking…" indicator above the composer.
 * Inspired by CC's `AssistantRedactedThinkingMessage.tsx:16` (`✻`)
 * which renders cleanly in mainstream monospace fonts.
 */
export const THINKING_PREFIX = process.platform === 'win32' ? '*' : '✻';
