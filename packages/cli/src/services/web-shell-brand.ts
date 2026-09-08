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
import { resolveEnvVarsInString } from '@qwen-code/qwen-code-core/envVarResolver';
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
   * Operator-facing explanations of rejected or advisory brand inputs, one
   * per cause. Never sent to the client; the route writes each entry to
   * stderr as its own line so a deployment that configured a brand and
   * silently got the built-in one can find out why, and so a log rule keyed
   * on one key's prefix is not displaced by another key's reason.
   */
  warnings?: string[];
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
 * For the same reason the brand leaves are read from each layer's
 * pre-substitution snapshot (`originalSettings`), and a value containing an
 * environment placeholder is ignored with a warning: `loadSettings`
 * substitutes placeholders from the process-wide environment, which
 * `loadEnvironment` populates workspace-first at boot — resolving a brand
 * placeholder would let a repository supply the value, which is the workspace
 * exclusion above through a side door.
 *
 * The terminal banner's `ui.customBannerTitle` and `ui.customAsciiArt` are the
 * TUI equivalents; this resolver follows their sanitization and path-resolution
 * conventions so one deployment's branding reads the same on both surfaces.
 */
export function resolveWebShellBrand(
  settings: LoadedSettings,
): ResolvedWebShellBrand {
  const brand: WebShellBrand = {};
  const warnings: string[] = [];

  const name = readBrandLeaf(settings, 'name');
  warnings.push(...name.warnings);
  if (name.resolved) {
    const sanitized = sanitizeBrandName(name.resolved.value);
    if (sanitized) brand.name = sanitized;
  }

  const logo = readBrandLeaf(settings, 'logoPath');
  warnings.push(...logo.warnings);
  if (logo.resolved) {
    const resolved = readBrandLogo(logo.resolved.value, logo.resolved.dir);
    warnings.push(...resolved.warnings);
    if (resolved.dataUri !== undefined) {
      brand.logoDataUri = resolved.dataUri;
    }
  }
  return warnings.length > 0 ? { brand, warnings } : { brand };
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
): { resolved?: ScopedBrandValue; warnings: string[] } {
  let resolved: ScopedBrandValue | undefined;
  let warnings: string[] = [];
  for (const file of [
    settings.systemDefaults,
    settings.user,
    settings.system,
  ]) {
    // Read the pre-substitution snapshot, not `file.settings`: loadSettings
    // substitutes placeholders from the process-wide environment, which a
    // workspace's own `.qwen/.env` or `env` block populates first at boot —
    // so the substituted text is workspace-influenced even though the layer
    // that wrote it is not.
    const value = file.originalSettings.ui?.brand?.[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    // A defined-but-empty string is an explicit "use the built-in brand", and
    // it wins over a lower layer's value exactly as `mergeSettings` lets any
    // defined value win. Skipping it instead would leave a managed
    // SystemDefaults brand impossible to opt out of from user settings, which
    // is what the schema description promises empty means.
    if (trimmed.length === 0) {
      resolved = undefined;
      warnings = [];
      continue;
    }
    // Refuse on substitution, not on syntax: run the authoritative engine and
    // refuse only when it would actually change the value. A literal `$5` or
    // `Cost$Less` resolves to itself (the variable is undefined) and is kept;
    // a placeholder that resolves — which only the process-wide environment
    // can arrange, and a workspace populates that first at boot — is refused,
    // because that would smuggle the workspace layer back in. The layer still
    // wins over lower layers: the key is unset with a warning, not skipped.
    if (resolveEnvVarsInString(trimmed) !== trimmed) {
      resolved = undefined;
      warnings = [
        `ui.brand.${key} uses an environment placeholder, which brand keys do not resolve — the substitution source is process-wide and a workspace can supply it. Set a literal value instead.`,
      ];
      continue;
    }
    resolved = {
      value: trimmed,
      dir: file.path ? path.dirname(file.path) : '',
    };
    warnings = [];
  }
  return { resolved, warnings };
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
): { dataUri?: string; warnings: string[] } {
  const expanded = resolvePath(configuredPath);
  let filePath = expanded;
  if (!path.isAbsolute(expanded)) {
    if (!declaringDir) {
      return {
        warnings: [
          `ui.brand.logoPath '${configuredPath}' is relative but its settings layer has no owning file directory to resolve against`,
        ],
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
    return { warnings: [`ui.brand.logoPath is not readable: ${filePath}`] };
  }
  if (!stat) {
    return { warnings: [`ui.brand.logoPath does not exist: ${filePath}`] };
  }
  if (stat.isSymbolicLink()) {
    return {
      warnings: [`ui.brand.logoPath must not be a symlink: ${filePath}`],
    };
  }
  if (!stat.isFile()) {
    return {
      warnings: [`ui.brand.logoPath must be a regular file: ${filePath}`],
    };
  }
  if (stat.nlink > 1) {
    return {
      warnings: [
        `ui.brand.logoPath must not have multiple hard links (nlink=${stat.nlink}): ${filePath}`,
      ],
    };
  }
  if (stat.size > MAX_BRAND_LOGO_BYTES) {
    return {
      warnings: [
        `ui.brand.logoPath exceeds ${MAX_BRAND_LOGO_BYTES} bytes: ${filePath}`,
      ],
    };
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    return { warnings: [`ui.brand.logoPath is not resolvable: ${filePath}`] };
  }

  const read = readRegularFileNoFollow(realPath, stat);
  if (read.content === undefined) {
    return {
      warnings: [
        `ui.brand.logoPath could not be read: ${filePath} (${read.reason})`,
      ],
    };
  }
  const root = parseSvgRootTag(read.content);
  if (root === undefined) {
    return {
      warnings: [
        `ui.brand.logoPath is not an SVG document (root element is not a namespaced <svg>): ${filePath}`,
      ],
    };
  }

  const warnings: string[] = [];
  // Warn rather than reject: the file is usable, but without a viewBox (or
  // an explicit width and height) the browser cannot scale the artwork into
  // the fixed sidebar box and may paint a blank mark — and since the image
  // loads successfully, no client-side error event fires to reveal it. The
  // daemon's stderr is the only channel that can tell the operator.
  if (!hasScalingGeometry(root.tag)) {
    warnings.push(
      `ui.brand.logoPath has no viewBox or width/height, so it cannot be scaled into the sidebar logo box and may render blank: ${filePath}`,
    );
  }
  // A prefix-bound root with unprefixed children loads successfully but
  // paints nothing: the children are in no namespace. Same advisory channel.
  if (
    root.prefix !== undefined &&
    hasUnprefixedSvgElements(root.content, root.prefix)
  ) {
    warnings.push(
      `ui.brand.logoPath has a prefix-bound <${root.prefix}:svg> root but unprefixed elements inside it, which are in no namespace and render blank: ${filePath}`,
    );
  }

  return {
    dataUri: `data:image/svg+xml,${encodeURIComponent(read.content)}`,
    warnings,
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
 * first element to be an `svg` element (any prefix) whose binding declares
 * the SVG namespace, returning its start tag, prefix and the full content
 * (or `undefined` when the shape is anything else).
 *
 * The namespace requirement is renderability, not paranoia: a root element
 * not in the SVG namespace is parsed as an image only when the binding is
 * present, so without it the daemon would ship a data URI that paints a
 * blank mark and writes nothing to stderr. This is a correctness check, not
 * a security boundary. The client renders a custom logo as an `img` whose
 * `src` is the data URI, never as injected markup, and SVG loaded as an
 * image cannot run script. Do not switch the client to inline rendering
 * without adding a sanitizer here first.
 */
function parseSvgRootTag(
  content: string,
): { tag: string; prefix?: string; content: string } | undefined {
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
    // The prefix is namespace-irrelevant — any prefix bound to the SVG
    // namespace renders identically — so match the optional prefix rather
    // than hard-coding `svg:`. The lookahead replaces a manual boundary
    // check: `<svgfoo` fails it, as does `<svg:svgfoo`.
    const rootMatch = /^<(?:([A-Za-z_][\w.-]*):)?svg(?=[\s/>])/.exec(rest);
    if (!rootMatch) return undefined;
    const end = skipMarkupConstruct(rest);
    if (end === -1) return undefined;
    const tag = rest.slice(0, end);
    const prefix = rootMatch[1];
    // A prefix-bound root (`<svg:svg>`, the Batik/XSL shape) is namespace-
    // well-formed and renders as an image; it is accepted when its prefix
    // binds to the SVG namespace. A prefix binding on an unprefixed root
    // does not count — `xmlns:svg` alone leaves `<svg>` in no namespace.
    const binding = prefix === undefined ? 'xmlns' : `xmlns:${prefix}`;
    if (readAttributeValue(tag, binding) !== SVG_NAMESPACE) {
      return undefined;
    }
    return { tag, prefix, content };
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
 * the match. The loop indexes UTF-16 code units rather than spreading code
 * points: an astral character becomes TWO spaces, so indices in the blanked
 * copy stay aligned with the original — attribute values are read back from
 * the original text by index.
 */
function blankQuotedSpans(text: string): string {
  let quote: string | undefined;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
        out += ch;
      } else {
        out += ' ';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    }
    out += ch;
  }
  return out;
}

/**
 * Read one attribute's value from a start tag, or `undefined` when the
 * attribute is absent. The match runs over quote-blanked text, so an
 * attribute-shaped substring inside another attribute's value does not count;
 * the value itself is sliced from the original text by index (the blanked
 * copy is length-preserving) and XML entity and character references are
 * decoded, as a real parser would do before comparing.
 */
function readAttributeValue(tag: string, name: string): string | undefined {
  const blanked = blankQuotedSpans(tag);
  const re = new RegExp(
    `(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(["'])`,
    'g',
  );
  const match = re.exec(blanked);
  if (match === null) return undefined;
  const quoteChar = match[1]!;
  const valueStart = match.index + match[0].length;
  const valueEnd = tag.indexOf(quoteChar, valueStart);
  if (valueEnd === -1) return undefined;
  return decodeXmlEntities(tag.slice(valueStart, valueEnd));
}

/** Decode the five predefined entities and numeric character references. */
function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g,
    (entity, body: string) => {
      if (body === 'lt') return '<';
      if (body === 'gt') return '>';
      if (body === 'amp') return '&';
      if (body === 'quot') return '"';
      if (body === 'apos') return "'";
      const codePoint = body.startsWith('#x')
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint)
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
}

/**
 * True when the root tag carries geometry the browser can scale into the
 * fixed sidebar logo box: a valid `viewBox` with a non-zero viewport, or
 * explicit `width` and `height` that are positive and not percentages.
 * Name-presence alone is not enough — `viewBox=""` or `width="0"` paints
 * nothing, and `width="100%"` ties the artwork to the viewport it never
 * fills at 26px. A malformed viewBox is ignored by browsers, so it falls
 * through to the width/height check rather than deciding on its own.
 */
function hasScalingGeometry(rootTag: string): boolean {
  const viewBox = readAttributeValue(rootTag, 'viewBox');
  if (viewBox !== undefined && viewBox.trim() !== '') {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts.every((p) => Number.isFinite(p))) {
      return parts[2]! > 0 && parts[3]! > 0;
    }
    // Malformed: browsers ignore the attribute — decide on width/height.
  }
  const width = readAttributeValue(rootTag, 'width');
  const height = readAttributeValue(rootTag, 'height');
  if (width === undefined || height === undefined) return false;
  const usable = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.endsWith('%')) return false;
    const numeric = parseFloat(trimmed);
    return Number.isFinite(numeric) && numeric > 0;
  };
  return usable(width) && usable(height);
}

/**
 * True when a prefix-bound document draws with unprefixed elements: the
 * children land in NO namespace, so the browser loads the image successfully
 * and paints nothing — a blank mark with no error event to catch it.
 */
function hasUnprefixedSvgElements(content: string, prefix: string): boolean {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `<(?!(?:${escaped}):)(?:circle|ellipse|g|image|line|path|polygon|polyline|rect|text|use)[\\s/>]`,
  ).test(content);
}
