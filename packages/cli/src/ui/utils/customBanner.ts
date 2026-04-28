/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { LoadedSettings, SettingsFile } from '../../config/settings.js';
import type {
  AsciiArtSource,
  CustomAsciiArtSetting,
} from '../../config/settingsSchema.js';

const debugLogger = createDebugLogger('BANNER');

/** Hard cap on the size of an ASCII-art file the resolver will read. */
const MAX_FILE_BYTES = 64 * 1024;
/** Hard cap on the number of lines kept after sanitization. */
const MAX_ART_LINES = 200;
/** Hard cap on the visual width (columns) kept per line after sanitization. */
const MAX_ART_COLS = 200;
/** Hard cap on title length after sanitization. */
const MAX_TITLE_LENGTH = 80;

export interface ResolvedBanner {
  asciiArt: { small?: string; large?: string };
  title?: string;
}

/**
 * Per-resolver-call memo so the same source isn't read or sanitized twice
 * when the user sets `customAsciiArt` to a single value (which becomes both
 * the small and large tier).
 */
type CacheEntry = { value: string | undefined };

/**
 * Resolve the user's banner customization into the shape `<Header />`
 * expects. Soft-fails on every error path: any malformed input, missing
 * file, oversized file, or sanitization rejection logs a `[BANNER]` warn
 * and falls back to the locked default for that field. The CLI must never
 * crash on a banner config error.
 */
export function resolveCustomBanner(
  settings: LoadedSettings,
): ResolvedBanner {
  const ui = settings.merged.ui;
  const cache = new Map<string, CacheEntry>();

  const title = sanitizeTitle(ui?.customBannerTitle);

  // Tiers are resolved per-scope so each `{path}` resolves against the file
  // it was declared in — not the merged view, which would hide which scope
  // contributed the inner `small` / `large` keys after deep-merge.
  const scoped = collectScopedTiers(settings);

  return {
    asciiArt: {
      small:
        scoped.small && resolveTier(scoped.small.source, scoped.small.dir, cache),
      large:
        scoped.large && resolveTier(scoped.large.source, scoped.large.dir, cache),
    },
    title,
  };
}

interface ScopedSource {
  source: AsciiArtSource;
  dir: string;
}

/**
 * Walk settings scopes in merge-precedence order (highest first) and pick,
 * for each tier, the first scope that defines it. Each tier carries its
 * scope's directory so relative `{path}` entries resolve against the file
 * that declared them.
 */
function collectScopedTiers(settings: LoadedSettings): {
  small?: ScopedSource;
  large?: ScopedSource;
} {
  const order: SettingsFile[] = [
    settings.system,
    settings.workspace,
    settings.user,
    settings.systemDefaults,
  ];
  let small: ScopedSource | undefined;
  let large: ScopedSource | undefined;
  for (const file of order) {
    if (small && large) break;
    const raw = file.settings.ui?.customAsciiArt;
    if (raw === undefined || raw === null) continue;
    if (!file.path) continue;
    const tiers = normalizeTiers(raw);
    if (!tiers) continue;
    const dir = path.dirname(file.path);
    if (!small && tiers.small !== undefined) {
      small = { source: tiers.small, dir };
    }
    if (!large && tiers.large !== undefined) {
      large = { source: tiers.large, dir };
    }
  }
  return { small, large };
}

interface NormalizedTiers {
  small?: AsciiArtSource;
  large?: AsciiArtSource;
}

function normalizeTiers(
  value: CustomAsciiArtSetting,
): NormalizedTiers | undefined {
  if (typeof value === 'string') {
    return { small: value, large: value };
  }
  if (!value || typeof value !== 'object') {
    debugLogger.warn(
      'Ignoring ui.customAsciiArt: expected a string, {path}, or {small,large} object.',
    );
    return undefined;
  }

  if ('path' in value && typeof value.path === 'string') {
    return { small: value, large: value };
  }

  if ('small' in value || 'large' in value) {
    const tiered = value as {
      small?: unknown;
      large?: unknown;
    };
    return {
      small: validateSource(tiered.small),
      large: validateSource(tiered.large),
    };
  }

  debugLogger.warn(
    'Ignoring ui.customAsciiArt: expected a string, {path}, or {small,large} object.',
  );
  return undefined;
}

function validateSource(source: unknown): AsciiArtSource | undefined {
  if (source === undefined || source === null) return undefined;
  if (typeof source === 'string') return source;
  if (
    typeof source === 'object' &&
    'path' in source &&
    typeof (source as { path: unknown }).path === 'string'
  ) {
    return { path: (source as { path: string }).path };
  }
  debugLogger.warn(
    'Ignoring ui.customAsciiArt tier: expected a string or {path} object.',
  );
  return undefined;
}

function resolveTier(
  source: AsciiArtSource | undefined,
  ownerDir: string,
  cache: Map<string, CacheEntry>,
): string | undefined {
  if (source === undefined) return undefined;

  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (!trimmed) return undefined;
    const key = `inline:${source}`;
    return memo(cache, key, () => sanitizeArt(source));
  }

  const resolvedPath = path.isAbsolute(source.path)
    ? source.path
    : path.resolve(ownerDir, source.path);

  return memo(cache, `path:${resolvedPath}`, () => {
    const raw = readArtFile(resolvedPath);
    if (raw === undefined) return undefined;
    return sanitizeArt(raw);
  });
}

function memo(
  cache: Map<string, CacheEntry>,
  key: string,
  compute: () => string | undefined,
): string | undefined {
  const hit = cache.get(key);
  if (hit) return hit.value;
  const value = compute();
  cache.set(key, { value });
  return value;
}

function readArtFile(absolutePath: string): string | undefined {
  let fd: number | undefined;
  try {
    // O_NOFOLLOW prevents a symlink at the configured path from redirecting
    // the read to an attacker-controlled file. Not portable to Windows,
    // where `O_NOFOLLOW` is not defined; fall back to a plain read there.
    const flags =
      typeof fs.constants.O_NOFOLLOW === 'number'
        ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        : fs.constants.O_RDONLY;
    fd = fs.openSync(absolutePath, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      debugLogger.warn(
        `Ignoring ui.customAsciiArt: ${absolutePath} is not a regular file.`,
      );
      return undefined;
    }
    const size = Math.min(stat.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    if (stat.size > MAX_FILE_BYTES) {
      debugLogger.warn(
        `Truncated ui.customAsciiArt at ${absolutePath}: file is ${stat.size} bytes, capped at ${MAX_FILE_BYTES}.`,
      );
    }
    return buffer.toString('utf8');
  } catch (err) {
    debugLogger.warn(
      `Failed to read ui.customAsciiArt at ${absolutePath}: ${(err as Error).message}`,
    );
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Banner-specific sanitizer. Like `stripTerminalControlSequences` but
 * preserves `\n` so multi-line ASCII art survives. Strips OSC/CSI/SS2/SS3
 * sequences and replaces every other C0/C1 control byte (and DEL) with a
 * single space — a hostile or accidental escape can't paint, redirect, or
 * hyperlink in the user's terminal.
 */
function sanitizeArt(input: string): string {
  // Normalize CRLF / CR to LF so the column cap is computed against the
  // same line boundaries the renderer will see.
  let s = input.replace(/\r\n?/g, '\n');
  /* eslint-disable no-control-regex */
  // OSC: ESC ] ... (BEL | ESC \)
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ');
  // CSI: ESC [ params final-byte
  s = s.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, ' ');
  // SS2/SS3/DCS leaders
  s = s.replace(/\x1b[NOP]/g, ' ');
  // Remaining C0/C1 controls + DEL → space, but keep \n and \t.
  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
  /* eslint-enable no-control-regex */

  const rawLines = s.split('\n');
  const truncatedRows = rawLines.length > MAX_ART_LINES;
  const limitedLines = truncatedRows
    ? rawLines.slice(0, MAX_ART_LINES)
    : rawLines;

  let truncatedCols = false;
  const cappedLines = limitedLines.map((line) => {
    // Replace tabs with two spaces so the column count is meaningful and
    // doesn't expand differently per terminal.
    const detabbed = line.replace(/\t/g, '  ');
    const trimmed = detabbed.replace(/\s+$/u, '');
    if (trimmed.length > MAX_ART_COLS) {
      truncatedCols = true;
      return trimmed.slice(0, MAX_ART_COLS);
    }
    return trimmed;
  });

  // Drop trailing empty lines so width measurement isn't skewed by a
  // hanging blank row.
  while (cappedLines.length > 0 && cappedLines[cappedLines.length - 1] === '') {
    cappedLines.pop();
  }

  if (cappedLines.length === 0) return '';

  if (truncatedRows) {
    debugLogger.warn(
      `Truncated ui.customAsciiArt to ${MAX_ART_LINES} lines.`,
    );
  }
  if (truncatedCols) {
    debugLogger.warn(
      `Truncated ui.customAsciiArt to ${MAX_ART_COLS} columns per line.`,
    );
  }

  return cappedLines.join('\n');
}

function sanitizeTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  /* eslint-disable no-control-regex */
  let t = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')
    .replace(/\x1b\[[\d;?]*[a-zA-Z]/g, ' ')
    .replace(/\x1b[NOP]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ');
  /* eslint-enable no-control-regex */
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  if (t.length > MAX_TITLE_LENGTH) {
    debugLogger.warn(
      `Truncated ui.customBannerTitle to ${MAX_TITLE_LENGTH} characters.`,
    );
    t = t.slice(0, MAX_TITLE_LENGTH);
  }
  return t;
}

/**
 * Shared with `<Header />` so the renderer doesn't reinvent the same width
 * arithmetic. Tries `large` first, then `small`; returns the first tier
 * that fits in the available width, or `undefined` to signal "hide the
 * logo column entirely (fall back to the default Qwen logo or no logo)".
 */
export function pickAsciiArtTier(
  small: string | undefined,
  large: string | undefined,
  availableWidth: number,
  logoGap: number,
  minInfoPanelWidth: number,
  measureWidth: (art: string) => number,
): string | undefined {
  for (const candidate of [large, small]) {
    if (!candidate) continue;
    const w = measureWidth(candidate);
    if (availableWidth >= w + logoGap + minInfoPanelWidth) {
      return candidate;
    }
  }
  return undefined;
}
