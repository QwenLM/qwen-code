/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { basename, normalize } from 'node:path';

/**
 * Maximum length of the short session id rendered in the process title.
 * Eight hex chars is plenty for visual disambiguation while keeping
 * process titles compact (Windows Task Manager and macOS `ps` both
 * truncate aggressively).
 */
const SHORT_SESSION_ID_LEN = 8;

/**
 * Default base name embedded in the process title.
 */
export const DEFAULT_PROCESS_TITLE_BASE = 'qwen-code';

/**
 * Return a short, display-friendly version of a session id.
 *
 * Strips dashes (uuid-style) and truncates to {@link SHORT_SESSION_ID_LEN}
 * characters so the resulting tag fits comfortably in process titles.
 *
 * Falls back to the original id if stripping dashes leaves nothing
 * (e.g. a synthetic id of all dashes), so a non-empty input always
 * produces a non-empty output.
 */
export function shortSessionId(sessionId: string): string {
  const compact = sessionId.replace(/-/g, '');
  return compact.slice(0, SHORT_SESSION_ID_LEN) || sessionId;
}

/**
 * Make `value` safe to embed in a `key=value` process-title token.
 *
 * Whitespace and `=` would break naive split-on-whitespace parsing by
 * external observers, so both are replaced with `_`. All other Unicode,
 * including non-ASCII path components, is preserved verbatim.
 */
function sanitizeProctitleToken(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '=' || /\s/u.test(ch)) {
      out += '_';
    } else {
      out += ch;
    }
  }
  return out;
}

export interface ComposeSessionProcessTitleOptions {
  /** Base name embedded in the title. Defaults to `qwen-code`. */
  baseName?: string;
}

/**
 * Compose an OS process title that encodes the live session identity.
 *
 * Format: `"<base> session=<short-id>[ cwd=<basename>]"`.
 *
 * External tools (terminal multiplexers, tab managers, IDE integrations)
 * can read this from `ps` / Task Manager and reliably map a running
 * process to its session — even when the session was created without an
 * explicit `--resume` flag, which is the common case.
 *
 * The `key=value` token form is intentional: it parses with simple
 * splits and avoids ambiguity if user-facing branding changes. To keep
 * that contract intact, whitespace and `=` inside the cwd basename and
 * session id are replaced with `_` via {@link sanitizeProctitleToken};
 * otherwise a repository under, say, `.../John Doe/` would yield
 * `cwd=John Doe` and break naive token parsing.
 */
export function composeSessionProcessTitle(
  sessionId: string,
  workDir?: string | null,
  options: ComposeSessionProcessTitleOptions = {},
): string {
  const { baseName = DEFAULT_PROCESS_TITLE_BASE } = options;
  const parts: string[] = [
    baseName,
    `session=${sanitizeProctitleToken(shortSessionId(sessionId))}`,
  ];
  if (workDir != null && workDir !== '') {
    const cwdBasename = basename(normalize(String(workDir)));
    if (cwdBasename) {
      parts.push(`cwd=${sanitizeProctitleToken(cwdBasename)}`);
    }
  }
  return parts.join(' ');
}

/**
 * Predicate: is this platform one where setting `process.title` is
 * actually visible in the process table (and only there)?
 *
 * On Linux/macOS Node rewrites the argv buffer, so `process.title` is
 * visible to `ps`/`top` and is the right knob.
 *
 * On Windows, Node sets the **console window title** (the same surface
 * as the OSC `\x1b]2;…\x07` escape), which conflicts with qwen-code's
 * existing OSC writers in `gemini.tsx` and `AppContainer.tsx`. We
 * therefore skip Windows here; runtime identity for Windows users would
 * need a different mechanism (e.g. ETW, named pipe) which is out of
 * scope.
 */
export function shouldSetProcessTitle(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}

export interface SetSessionProcessTitleOptions
  extends ComposeSessionProcessTitleOptions {
  /**
   * Override the platform check. Useful in tests; production callers
   * should let it default to `process.platform`.
   */
  platform?: NodeJS.Platform;
  /**
   * Sink that actually applies the title. Defaults to assigning
   * `process.title`. Tests inject a captured-string sink instead of
   * mutating the live process.
   */
  apply?: (title: string) => void;
}

/**
 * Set the OS process title to encode the live session identity.
 *
 * No-op on Windows (see {@link shouldSetProcessTitle}). Errors from the
 * underlying assignment are swallowed: the title is a best-effort
 * observability hint, not a correctness contract, so a hostile
 * environment (e.g. seccomp-restricted container) must never crash
 * qwen-code over it.
 *
 * Returns the title string that was applied, or `null` if this platform
 * does not set a process title.
 */
export function setSessionProcessTitle(
  sessionId: string,
  workDir?: string | null,
  options: SetSessionProcessTitleOptions = {},
): string | null {
  const { platform, apply, ...composeOptions } = options;
  if (!shouldSetProcessTitle(platform)) {
    return null;
  }
  const title = composeSessionProcessTitle(sessionId, workDir, composeOptions);
  try {
    if (apply) {
      apply(title);
    } else {
      process.title = title;
    }
  } catch {
    // Best-effort only. Some sandboxes refuse to mutate argv or the
    // console title; that is fine, we just lose the observability hint.
  }
  return title;
}
