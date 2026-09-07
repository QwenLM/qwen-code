/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createDebugLogger,
  stripTerminalControlSequences,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { resolvePath } from '../utils/resolvePath.js';

const debugLogger = createDebugLogger('WEB_SHELL_BRAND');

const MAX_BRAND_LOGO_BYTES = 32 * 1024;

/** Matches `MAX_TITLE_LENGTH` in `ui/utils/customBanner.ts`. */
const MAX_BRAND_NAME_LENGTH = 80;

/** What goes on the wire. Absent fields mean "use the client's built-in brand". */
export interface WebShellBrand {
  name?: string;
  logoDataUri?: string;
}

export interface ResolvedWebShellBrand {
  brand: WebShellBrand;
  /**
   * Operator-facing explanation of a rejected logo. Never sent to the client;
   * the route writes it to stderr so a deployment that configured a logo and
   * silently got the built-in one can find out why.
   */
  warning?: string;
}

/**
 * Resolve `ui.brand` for the Web Shell.
 *
 * Reads the system-defaults, user and system layers only, in the same
 * precedence `mergeSettings` gives them. The workspace layer is deliberately
 * excluded: a workspace `.qwen/settings.json` usually arrives from a repository
 * the person opening the shell did not write, so it must not be able to rename
 * the product or name a file for the daemon to read and inline into every
 * connected browser. `general.voice.keytermsFile` excludes it for the same
 * reason.
 *
 * The terminal banner's `ui.customBannerTitle` and `ui.customAsciiArt` are the
 * TUI equivalents; this resolver follows their sanitization and path-resolution
 * conventions so one deployment's branding reads the same on both surfaces.
 */
export function resolveWebShellBrand(
  settings: LoadedSettings,
): ResolvedWebShellBrand {
  const brand: WebShellBrand = {};

  const name = readBrandLeaf(settings, 'name');
  if (name) {
    const sanitized = sanitizeBrandName(name.value);
    if (sanitized) brand.name = sanitized;
  }

  const logo = readBrandLeaf(settings, 'logoPath');
  if (!logo) return { brand };

  const resolved = readBrandLogo(logo.value, logo.dir);
  if (resolved.warning) return { brand, warning: resolved.warning };
  brand.logoDataUri = resolved.dataUri;
  return { brand };
}

interface ScopedBrandValue {
  value: string;
  /**
   * Directory of the settings file that declared the value, so a relative logo
   * path resolves against the file that wrote it — the convention
   * `ui.customAsciiArt` already uses. Empty when the layer has no file path.
   */
  dir: string;
}

/** Last defined value wins, matching `mergeSettings` scalar precedence. */
function readBrandLeaf(
  settings: LoadedSettings,
  key: 'name' | 'logoPath',
): ScopedBrandValue | undefined {
  let resolved: ScopedBrandValue | undefined;
  for (const file of [
    settings.systemDefaults,
    settings.user,
    settings.system,
  ]) {
    const value = file.settings.ui?.brand?.[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    // A defined-but-empty string is an explicit "use the built-in brand", and
    // it wins over a lower layer's value exactly as `mergeSettings` lets any
    // defined value win. Skipping it instead would leave a managed
    // SystemDefaults brand impossible to opt out of from user settings, which
    // is what the schema description promises empty means.
    resolved =
      trimmed.length === 0
        ? undefined
        : { value: trimmed, dir: file.path ? path.dirname(file.path) : '' };
  }
  return resolved;
}

/**
 * Mirrors `sanitizeSingleLine` in `ui/utils/customBanner.ts`: strip terminal
 * escape sequences, fold whitespace to single spaces, and clamp the length.
 *
 * The name lands in `document.title` and in React text nodes. React escapes
 * text, so this is not an injection guard — it keeps a value copied out of a
 * TUI config from corrupting the tab title or wrapping the sidebar brand row.
 */
function sanitizeBrandName(raw: string): string | undefined {
  let name = stripTerminalControlSequences(raw).replace(/\s+/g, ' ').trim();
  if (!name) return undefined;
  if (name.length > MAX_BRAND_NAME_LENGTH) {
    debugLogger.warn(
      `Truncated ui.brand.name to ${MAX_BRAND_NAME_LENGTH} characters.`,
    );
    name = name.slice(0, MAX_BRAND_NAME_LENGTH);
  }
  return name;
}

function readBrandLogo(
  configuredPath: string,
  declaringDir: string,
): { dataUri?: string; warning?: string } {
  const expanded = resolvePath(configuredPath);
  let filePath = expanded;
  if (!path.isAbsolute(expanded)) {
    if (!declaringDir) {
      return {
        warning: `ui.brand.logoPath '${configuredPath}' is relative but its settings layer has no owning file directory to resolve against`,
      };
    }
    filePath = path.resolve(declaringDir, expanded);
  }

  // Refuse non-regular files before opening: on POSIX, opening a FIFO read-only
  // blocks until a writer connects, which would hang the request. `lstatSync`
  // rather than `statSync` so a symlinked path soft-fails here too.
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  } catch {
    return { warning: `ui.brand.logoPath is not readable: ${filePath}` };
  }
  if (!stat) {
    return { warning: `ui.brand.logoPath does not exist: ${filePath}` };
  }
  if (stat.isSymbolicLink()) {
    return { warning: `ui.brand.logoPath must not be a symlink: ${filePath}` };
  }
  if (!stat.isFile()) {
    return { warning: `ui.brand.logoPath must be a regular file: ${filePath}` };
  }
  if (stat.nlink > 1) {
    return {
      warning: `ui.brand.logoPath must not have multiple hard links (nlink=${stat.nlink}): ${filePath}`,
    };
  }
  if (stat.size > MAX_BRAND_LOGO_BYTES) {
    return {
      warning: `ui.brand.logoPath exceeds ${MAX_BRAND_LOGO_BYTES} bytes: ${filePath}`,
    };
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    return { warning: `ui.brand.logoPath is not resolvable: ${filePath}` };
  }

  const read = readRegularFileNoFollow(realPath, stat);
  if (read.content === undefined) {
    return {
      warning: `ui.brand.logoPath could not be read: ${filePath} (${read.reason})`,
    };
  }
  if (!hasSvgRoot(read.content)) {
    return {
      warning: `ui.brand.logoPath is not an SVG document (root element is not a namespaced <svg>): ${filePath}`,
    };
  }

  return {
    dataUri: `data:image/svg+xml,${encodeURIComponent(read.content)}`,
  };
}

/**
 * Read a file the caller already `lstat`ed, refusing to follow a swap between
 * that stat and this open. The reason is returned rather than thrown because
 * it reaches an operator on stderr: "changed while it was being read" sends
 * them hunting a race that does not exist when the real cause was `EACCES`.
 */
function readRegularFileNoFollow(
  filePath: string,
  expectedStat: fs.Stats,
):
  | { content: string; reason?: undefined }
  | { content?: undefined; reason: string } {
  let fd: number | undefined;
  try {
    let flags = fs.constants.O_RDONLY;
    if (typeof fs.constants.O_NOFOLLOW === 'number') {
      flags |= fs.constants.O_NOFOLLOW;
    }
    if (typeof fs.constants.O_NONBLOCK === 'number') {
      flags |= fs.constants.O_NONBLOCK;
    }
    fd = fs.openSync(filePath, flags);
    // Re-verify identity on the FD: if anything changed between the lstat above
    // and this open, refuse rather than read whatever the FD now points at.
    const stat = fs.fstatSync(fd);
    if (
      stat.dev !== expectedStat.dev ||
      stat.ino !== expectedStat.ino ||
      stat.mode !== expectedStat.mode ||
      stat.size !== expectedStat.size ||
      stat.mtimeMs !== expectedStat.mtimeMs ||
      stat.ctimeMs !== expectedStat.ctimeMs ||
      !stat.isFile() ||
      stat.nlink > 1
    ) {
      return { reason: 'changed while it was being read' };
    }
    const content = fs.readFileSync(fd, 'utf-8');
    if (Buffer.byteLength(content, 'utf8') > MAX_BRAND_LOGO_BYTES) {
      return { reason: `exceeds ${MAX_BRAND_LOGO_BYTES} bytes once decoded` };
    }
    return { content };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      reason: code ?? (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    if (fd !== undefined) {
      // A close that throws (a stale NFS handle, say) must not escape: the read
      // result already decided the outcome, and an exception here would take
      // the successfully resolved brand *name* down with it.
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing left to decide.
      }
    }
  }
}

/**
 * Skip the XML prolog — declaration, comments, DOCTYPE — then require the
 * first element to be an `<svg>` that declares the SVG namespace.
 *
 * The namespace requirement is renderability, not paranoia: a bare `<svg>`
 * root is parsed as an image only when it carries
 * `xmlns="http://www.w3.org/2000/svg"`, so without it the daemon would ship a
 * data URI that paints a blank mark and writes nothing to stderr. This is a
 * correctness check, not a security boundary. The client renders a custom logo
 * as an `img` whose `src` is the data URI, never as injected markup, and SVG
 * loaded as an image cannot run script. Do not switch the client to inline
 * rendering without adding a sanitizer here first.
 */
function hasSvgRoot(content: string): boolean {
  let rest = content.replace(/^\uFEFF/, '');
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end === -1) return false;
      rest = rest.slice(end + 2);
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end === -1) return false;
      rest = rest.slice(end + 3);
      continue;
    }
    if (rest.startsWith('<!')) {
      const end = skipDeclaration(rest);
      if (end === -1) return false;
      rest = rest.slice(end);
      continue;
    }
    return /^<svg\s[^>]*xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(
      rest,
    );
  }
}

/** Length of a `<!DOCTYPE …>` prefix, including an internal `[ … ]` subset. */
function skipDeclaration(text: string): number {
  const bracket = text.indexOf('[');
  const close = text.indexOf('>');
  if (bracket === -1 || close === -1) return close === -1 ? -1 : close + 1;
  if (bracket > close) return close + 1;
  const subsetEnd = text.indexOf(']', bracket);
  if (subsetEnd === -1) return -1;
  const afterSubset = text.indexOf('>', subsetEnd);
  return afterSubset === -1 ? -1 : afterSubset + 1;
}
