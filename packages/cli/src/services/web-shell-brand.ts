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
  if (resolved.dataUri === undefined) {
    return { brand, warning: resolved.warning };
  }
  brand.logoDataUri = resolved.dataUri;
  return resolved.warning ? { brand, warning: resolved.warning } : { brand };
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
  const rootTag = parseSvgRootTag(read.content);
  if (rootTag === undefined) {
    return {
      warning: `ui.brand.logoPath is not an SVG document (root element is not a namespaced <svg>): ${filePath}`,
    };
  }

  return {
    dataUri: `data:image/svg+xml,${encodeURIComponent(read.content)}`,
    // Warn rather than reject: the file is usable, but without a viewBox (or
    // an explicit width and height) the browser cannot scale the artwork into
    // the fixed sidebar box and may paint a blank mark — and since the image
    // loads successfully, no client-side error event fires to reveal it. The
    // daemon's stderr is the only channel that can tell the operator.
    ...(hasScalingGeometry(rootTag)
      ? {}
      : {
          warning: `ui.brand.logoPath has no viewBox or width/height, so it cannot be scaled into the sidebar logo box and may render blank: ${filePath}`,
        }),
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
 * first element to be an `<svg>` that declares the SVG namespace, returning
 * the root start tag (or `undefined` when the shape is anything else).
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
function parseSvgRootTag(content: string): string | undefined {
  let rest = content.replace(/^\uFEFF/, '');
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end === -1) return undefined;
      rest = rest.slice(end + 2);
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end === -1) return undefined;
      rest = rest.slice(end + 3);
      continue;
    }
    if (rest.startsWith('<!')) {
      const end = skipMarkupConstruct(rest);
      if (end === -1) return undefined;
      rest = rest.slice(end);
      continue;
    }
    if (!rest.startsWith('<svg')) return undefined;
    const boundary = rest[4];
    if (
      boundary !== undefined &&
      boundary !== '>' &&
      boundary !== '/' &&
      !/\s/.test(boundary)
    ) {
      return undefined;
    }
    const end = skipMarkupConstruct(rest);
    if (end === -1) return undefined;
    const tag = rest.slice(0, end);
    return declaresSvgNamespace(tag) ? tag : undefined;
  }
}

/**
 * Length of the markup construct at `text` (a start tag or a `<!…>`
 * declaration) up to and including its closing `>`. XML permits `>`, `[` and
 * `]` inside quoted literals, so the scan tracks quote state; `[`/`]` depth is
 * tracked too, for DOCTYPE internal subsets. Returns -1 when unterminated —
 * fail-closed, since a document this scanner cannot bound is not accepted.
 */
function skipMarkupConstruct(text: string): number {
  let quote: string | undefined;
  let subsetDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      subsetDepth++;
      continue;
    }
    if (ch === ']' && subsetDepth > 0) {
      subsetDepth--;
      continue;
    }
    if (ch === '>' && subsetDepth === 0) return i + 1;
  }
  return -1;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Replace every character inside a quoted literal with a space, preserving
 * length and the quote characters themselves. XML attribute values cannot
 * contain their delimiter quote, so this is exact — and it lets attribute
 * tests run over text where the contents of foreign attribute values (which
 * may hold whitespace, `>`, or an `xmlns`-shaped substring) no longer confuse
 * the match.
 */
function blankQuotedSpans(text: string): string {
  const chars = [...text];
  let quote: string | undefined;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else {
        chars[i] = ' ';
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
  }
  return chars.join('');
}

/**
 * True when the root start tag declares the SVG default namespace. The match
 * runs over quote-blanked text, so an `xmlns`-shaped substring inside another
 * attribute's value does not count, and a prefix-only binding (`xmlns:svg`,
 * which Inkscape emits beside the real `xmlns`) still refuses. Whitespace
 * around `=` is allowed, as XML's grammar permits.
 */
function declaresSvgNamespace(tag: string): boolean {
  const blanked = blankQuotedSpans(tag);
  const re = /(?:^|\s)xmlns\s*=\s*(["'])/g;
  for (let match = re.exec(blanked); match !== null; match = re.exec(blanked)) {
    const quoteChar = match[1]!;
    const valueStart = match.index + match[0].length;
    const valueEnd = tag.indexOf(quoteChar, valueStart);
    if (valueEnd === -1) continue;
    if (tag.slice(valueStart, valueEnd) === SVG_NAMESPACE) return true;
  }
  return false;
}

/**
 * True when the root tag carries geometry the browser can scale into the
 * fixed sidebar logo box: a `viewBox`, or an explicit `width` and `height`.
 */
function hasScalingGeometry(rootTag: string): boolean {
  const blanked = blankQuotedSpans(rootTag);
  const has = (name: string) =>
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']`).test(blanked);
  return has('viewBox') || (has('width') && has('height'));
}
