/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse } from 'yaml';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Split a command file into its YAML front-matter mapping and the body text.
 * Returns `null` unless the text begins with a `---` line and has a matching
 * closing `---` line, and the parsed front-matter is a mapping. The body is
 * everything after the closing delimiter, with a single leading newline
 * trimmed.
 */
export function parseFrontMatter(
  text: string,
): { frontMatter: Record<string, unknown>; body: string } | null {
  // Normalize CRLF so a Windows-authored file's last front-matter field
  // (e.g. `scope: write\r`) doesn't carry a trailing \r into its value and
  // fail validation.
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return null;

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return null;

  const fmText = lines.slice(1, closeIdx).join('\n');
  let parsed: unknown;
  try {
    parsed = parse(fmText);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  // Body is everything after the closing delimiter; trim one leading newline.
  let body = lines.slice(closeIdx + 1).join('\n');
  if (body.startsWith('\n')) body = body.slice(1);
  return { frontMatter: parsed, body };
}

/**
 * Single-pass placeholder substitution over a command body. Replacement values
 * are NOT re-scanned, so a value containing `${...}` cannot trigger nested
 * expansion. Unknown/missing placeholders resolve to the empty string.
 *
 * - `${args}` → all positional args joined with a single space
 * - `${arg}` → first positional (`args[0]`)
 * - `${arg.N}` → Nth positional, 0-indexed
 * - `${named.KEY}` → `named[KEY]`
 * - `${file}` → `file`
 */
export function substitute(
  body: string,
  ctx: { args: string[]; named: Record<string, string>; file?: string },
): string {
  return body.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const key = expr.trim();
    if (key === 'args') return ctx.args.join(' ');
    if (key === 'arg') return ctx.args[0] ?? '';
    if (key === 'file') return ctx.file ?? '';
    const argMatch = /^arg\.(\d+)$/.exec(key);
    if (argMatch) return ctx.args[Number(argMatch[1])] ?? '';
    const namedMatch = /^named\.(.+)$/.exec(key);
    if (namedMatch) return ctx.named[namedMatch[1]] ?? '';
    return '';
  });
}
