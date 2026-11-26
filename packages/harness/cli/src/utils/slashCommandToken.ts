/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';

const COMMAND_NAME_RE = /^[a-zA-Z0-9:_-]+$/;

/**
 * Given the text after the leading command prefix, returns the command-name
 * token, or null when the input is not a plausible command name — a nested path
 * (`a/b`), an unsupported character set, or an existing absolute path
 * (`/etc/hosts`), all of which are ordinary prompt text that must reach the
 * model untouched.
 */
function commandNameFromBody(body: string): string | null {
  const firstToken = body.split(/\s+/)[0] ?? '';
  if (!firstToken || firstToken.includes('/')) {
    return null;
  }

  if (!COMMAND_NAME_RE.test(firstToken)) {
    return null;
  }

  return existsSync(`/${firstToken}`) ? null : firstToken;
}

/**
 * Returns a token that may resolve once command discovery finishes. Unlike the
 * unknown-command extractor, this intentionally does not reject an existing
 * root path or a non-ASCII name: the loaded catalog gets the first chance to
 * resolve the token before path fallback is applied.
 */
export function extractPotentialCommandStyleToken(
  rawQuery: string,
): string | null {
  const trimmed = rawQuery.trim();
  if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
    return null;
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
    return null;
  }

  const firstToken = trimmed.slice(1).split(/\s+/)[0] ?? '';
  return firstToken && !firstToken.includes('/') ? firstToken : null;
}

/**
 * Extracts the command name from `/`-prefixed input. Used by the
 * unknown-command reporters, which only ever consider `/` a command prefix.
 */
export function extractSlashCommandToken(rawQuery: string): string | null {
  const trimmed = rawQuery.trim();
  return trimmed.startsWith('/') ? commandNameFromBody(trimmed.slice(1)) : null;
}

/**
 * Extracts the command name from `/`- or `?`-prefixed input, matching the
 * dispatch surface of `isCommandStyleUserPromptText`. Used to decide whether an
 * input is worth waiting for the command catalog: `parseSlashCommand` strips the
 * prefix character unconditionally, so `?help` resolves to the same command as
 * `/help`.
 */
export function extractCommandStyleToken(rawQuery: string): string | null {
  const trimmed = rawQuery.trim();
  return trimmed.startsWith('/') || trimmed.startsWith('?')
    ? commandNameFromBody(trimmed.slice(1))
    : null;
}
