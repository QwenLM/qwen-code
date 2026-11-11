/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';

const COMMAND_NAME_RE = /^[a-zA-Z0-9:_-]+$/;

export interface SlashCommandStyleOptions {
  /** Whether the current command catalog resolves this input. */
  isKnownCommand?: boolean;
  /**
   * Whether command discovery has settled. While it is still loading, an
   * existing single-segment root path remains ambiguous and is conservatively
   * treated as a command candidate.
   */
  commandCatalogReady?: boolean;
}

function firstSlashToken(text: string): string {
  return text.trim().slice(1).split(/\s+/)[0] ?? '';
}

/**
 * Returns whether slash-prefixed text starts with a filesystem path.
 * Registered commands take precedence over this lexical check; callers that
 * have a command catalog must pass that result to
 * `isSlashCommandStyleUserPromptText`.
 */
export function isPathLikeCommandStyleText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return false;
  }

  const firstToken = firstSlashToken(trimmed);
  if (!firstToken) {
    return false;
  }

  if (firstToken.includes('/')) {
    return true;
  }

  return existsSync(`/${firstToken}`);
}

/**
 * Classifies slash-prefixed user text for routing and queue admission.
 *
 * Known commands win over path names. Nested paths and source-code comments
 * are unambiguous plain text. An existing root path is plain text only after
 * command discovery has settled, so a command that shares the path name can
 * still resolve.
 */
export function isSlashCommandStyleUserPromptText(
  text: string,
  options: SlashCommandStyleOptions = {},
): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return false;
  }

  if (options.isKnownCommand) {
    return true;
  }

  if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
    return false;
  }

  const firstToken = firstSlashToken(trimmed);
  if (firstToken.includes('/')) {
    return false;
  }

  if (options.commandCatalogReady === false) {
    return true;
  }

  if (firstToken && existsSync(`/${firstToken}`)) {
    return false;
  }

  return firstToken === '' || COMMAND_NAME_RE.test(firstToken);
}

/**
 * Returns whether text uses a local-command prefix. Question-mark commands do
 * not overlap with filesystem paths, while slash commands use the path-aware
 * classifier above.
 */
export function isCommandStyleUserPromptText(
  text: string,
  options: SlashCommandStyleOptions = {},
): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('?') ||
    isSlashCommandStyleUserPromptText(trimmed, options)
  );
}
