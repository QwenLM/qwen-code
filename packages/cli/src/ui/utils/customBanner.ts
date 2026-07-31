/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createDebugLogger,
  stripTerminalControlSequences,
  TERMINAL_OSC_REGEX,
  TERMINAL_CSI_REGEX,
  TERMINAL_SHIFT_DCS_REGEX,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings, SettingsFile } from '../../config/settings.js';
import type {
  AsciiArtSource,
  CustomAsciiArtSetting,
} from '../../config/settingsSchema.js';
import { getCachedStringWidth, toCodePoints } from './textUtils.js';

const debugLogger = createDebugLogger('BANNER');

/** Hard cap on the size of an ASCII-art file the resolver will read. */
const MAX_FILE_BYTES = 64 * 1024;
/** Hard cap on the number of lines kept after sanitization. */
const MAX_ART_LINES = 200;
/** Hard cap on the visual width (columns) kept per line after sanitization. */
const MAX_ART_COLS = 200;
/** Hard cap on title length after sanitization. */
const MAX_TITLE_LENGTH = 80;
/**
 * Hard cap on subtitle length after sanitization. Larger than the title cap
 * because the subtitle commonly carries a tagline / "powered by" line that
 * runs longer than the brand name itself; still bounded so a single
 * pasted paragraph can't blow out the info panel.
 */
const MAX_SUBTITLE_LENGTH = 160;

export interface ResolvedBanner {
  asciiArt: { small?: string; large?: string };
  title?: string;
  /**
   * Optional subtitle rendered between the title and the auth/model line.
   * Sanitized like the title (control sequences stripped, newlines folded
   * to spaces). When undefined, `<Header />` keeps the existing blank
   * spacer row for back-compat.
   */
  subtitle?: string;
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
export function resolveCustomBanner(settings: LoadedSettings): ResolvedBanner {
  const ui = settings.merged.ui;
  const cache = new Map<string, CacheEntry>();

  const title = sanitizeTitle(ui?.customBannerTitle);
  const subtitle = sanitizeSubtitle(ui?.customBannerSubtitle);

  // Tiers are resolved per-scope so each `{path}` resolves against the file
  // it was declared in — not the merged view, which would hide which scope
  // contributed the inner `small` / `large` keys after deep-merge.
  const scoped = collectScopedTiers(settings);

  return {
    asciiArt: {
      small:
        scoped.small &&
        resolveTier(scoped.small.source, scoped.small.dir, cache),
      large:
        scoped.large &&
        resolveTier(scoped.large.source, scoped.large.dir, cache),
    },
    title,
    subtitle,
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
 *
 * Workspace settings are skipped entirely when `settings.isTrusted` is
 * false. The standard `settings.merged` view already drops untrusted
 * workspace data; this resolver bypasses that view (it needs per-scope
 * file paths to resolve relative `{path}` entries), so the trust check
 * has to be re-applied here. Without it, an untrusted checkout could
 * influence startup rendering and trigger local file reads through a
 * `{path}` entry before the user has opted in.
 */
function collectScopedTiers(settings: LoadedSettings): {
  small?: ScopedSource;
  large?: ScopedSource;
} {
  const order: SettingsFile[] = [
    settings.system,
    ...(settings.isTrusted ? [settings.workspace] : []),
    settings.user,
    settings.systemDefaults,
  ];
  let small: ScopedSource | undefined;
  let large: ScopedSource | undefined;
  for (const file of order) {
    if (small && large) break;
    const raw = file.settings.ui?.customAsciiArt;
    if (raw === undefined || raw === null) continue;
    const tiers = normalizeTiers(raw);
    if (!tiers) continue;
    // `dir` is only meaningful for `{path}` entries (relative paths
    // resolve against the file that declared them). Inline-string tiers
    // don't need it, so a scope with no associated file path (e.g.
    // `systemDefaults`, future SDK-injected scopes) can still contribute
    // string art. When a `{path}` lands in a path-less scope we soft-fail
    // that tier specifically and log a `[BANNER]` warn — dropping the
    // entire scope was unnecessary coupling.
    const dir = file.path ? path.dirname(file.path) : '';
    const considerTier = (
      tier: AsciiArtSource | undefined,
      label: 'small' | 'large',
    ): ScopedSource | undefined => {
      if (tier === undefined) return undefined;
      const isPathSource = typeof tier === 'object';
      if (isPathSource && !dir) {
        debugLogger.warn(
          `Ignoring ui.customAsciiArt.${label}: {path} entry has no owning settings file directory to resolve against.`,
        );
        return undefined;
      }
      return { source: tier, dir };
    };
    if (!small) {
      const next = considerTier(tiers.small, 'small');
      if (next) small = next;
    }
    if (!large) {
      const next = considerTier(tiers.large, 'large');
      if (next) large = next;
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

  // Mirror the JSON schema's mutually-exclusive object branches: an object
  // with `path` cannot also carry `small` / `large`, and vice versa. The
  // schema rejects this shape in VS Code; without the same check at
  // runtime, JSON parsed at startup would silently let `path` win and
  // drop the tier keys (or vice versa).
  const hasPath = 'path' in value && typeof value.path === 'string';
  const hasTierKeys = 'small' in value || 'large' in value;
  if (hasPath && hasTierKeys) {
    debugLogger.warn(
      'Ignoring ui.customAsciiArt: object combines `path` with `small` / `large`. Use one shape or the other.',
    );
    return undefined;
  }

  if (hasPath) {
    return { small: value, large: value };
  }

  if (hasTierKeys) {
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
    // Step 1: refuse non-regular files BEFORE opening. On POSIX, opening a
    // FIFO / named pipe read-only blocks until a writer connects — which
    // means a misconfigured `customAsciiArt: { "path": "/tmp/some-fifo" }`
    // would hang CLI startup forever. `O_NOFOLLOW` does not help here; it
    // refuses symlinks at the final path component, not FIFOs / sockets /
    // devices. `lstatSync` (rather than `statSync`) also covers the
    // "configured path is itself a symlink" case so we soft-fail before
    // opening.
    let preOpenStat: fs.Stats;
    try {
      preOpenStat = fs.lstatSync(absolutePath);
    } catch (err) {
      debugLogger.warn(
        `Failed to stat ui.customAsciiArt at ${absolutePath}: ${(err as Error).message}`,
      );
      return undefined;
    }
    if (!preOpenStat.isFile()) {
      debugLogger.warn(
        `Ignoring ui.customAsciiArt: ${absolutePath} is not a regular file.`,
      );
      return undefined;
    }

    // Step 2: open with O_NOFOLLOW (POSIX only) so a TOCTOU symlink swap
    // between the lstat above and this open also soft-fails. Windows has
    // no equivalent constant, so it falls back to a plain read.
    const flags =
      typeof fs.constants.O_NOFOLLOW === 'number'
        ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        : fs.constants.O_RDONLY;
    fd = fs.openSync(absolutePath, flags);
    // Re-check via fstat on the FD: if anything changed between lstat and
    // open, refuse rather than reading whatever the FD now points at.
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
 * Banner-specific sanitizer. Re-uses the OSC / CSI / SS2 / SS3 patterns
 * exported from `stripTerminalControlSequences` (in
 * `@qwen-code/qwen-code-core`) so the regexes are authored once, but
 * preserves `\n` and `\t` — multi-line / tab-aligned ASCII art needs
 * those, while the shared core helper strips them. The fallback range
 * here matches the core helper's C0/C1/DEL strip but carves out
 * `\t` (0x09) and `\n` (0x0a) so they survive into the rendered art.
 */
function sanitizeArt(input: string): string {
  // Normalize CRLF / CR to LF so the column cap is computed against the
  // same line boundaries the renderer will see.
  let s = input.replace(/\r\n?/g, '\n');
  s = s
    .replace(TERMINAL_OSC_REGEX, ' ')
    .replace(TERMINAL_CSI_REGEX, ' ')
    .replace(TERMINAL_SHIFT_DCS_REGEX, ' ');
  // Remaining C0 controls + DEL + C1 controls (0x80-0x9f, e.g. single-byte
  // CSI 0x9b) → space. Keep \n (0x0a) and \t (0x09) so multi-line ASCII art
  // and tab-aligned art survive.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');

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
    // Cap by *visual* width (terminal cells), not UTF-16 length: 200 CJK
    // fullwidth characters render as ~400 cells, and a `.length` slice
    // could split a fullwidth code point or surrogate pair down the
    // middle. We walk code points until adding the next one would push
    // the cell width past the cap.
    if (getCachedStringWidth(trimmed) <= MAX_ART_COLS) {
      return trimmed;
    }
    truncatedCols = true;
    const codePoints = toCodePoints(trimmed);
    let kept = '';
    for (const cp of codePoints) {
      if (getCachedStringWidth(kept + cp) > MAX_ART_COLS) break;
      kept += cp;
    }
    return kept;
  });

  // Drop trailing empty lines so width measurement isn't skewed by a
  // hanging blank row.
  while (cappedLines.length > 0 && cappedLines[cappedLines.length - 1] === '') {
    cappedLines.pop();
  }

  if (cappedLines.length === 0) return '';

  if (truncatedRows) {
    debugLogger.warn(`Truncated ui.customAsciiArt to ${MAX_ART_LINES} lines.`);
  }
  if (truncatedCols) {
    debugLogger.warn(
      `Truncated ui.customAsciiArt to ${MAX_ART_COLS} columns per line.`,
    );
  }

  return cappedLines.join('\n');
}

function sanitizeTitle(raw: unknown): string | undefined {
  return sanitizeSingleLine(raw, MAX_TITLE_LENGTH, 'ui.customBannerTitle');
}

function sanitizeSubtitle(raw: unknown): string | undefined {
  return sanitizeSingleLine(
    raw,
    MAX_SUBTITLE_LENGTH,
    'ui.customBannerSubtitle',
  );
}

/**
 * Shared cleaner for any single-line info-panel string (title, subtitle).
 * Delegates the escape-sequence + C0/C1 stripping to the core
 * `stripTerminalControlSequences` helper (which already handles `\n` /
 * `\t` because single-line fields don't need them), then folds any
 * remaining whitespace into a single space and trims the ends. Returns
 * `undefined` for empty input so `<Header />` knows to fall back to its
 * default rendering.
 */
function sanitizeSingleLine(
  raw: unknown,
  maxLength: number,
  fieldLabel: string,
): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let t = stripTerminalControlSequences(raw).replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  if (t.length > maxLength) {
    debugLogger.warn(`Truncated ${fieldLabel} to ${maxLength} characters.`);
    t = t.slice(0, maxLength);
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
