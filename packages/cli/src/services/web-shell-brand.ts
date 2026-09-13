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
import { SaxesParser } from 'saxes';
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
 * pre-substitution snapshot (`originalSettings`) and refused with a warning
 * whenever substitution would actually change them: `loadSettings`
 * substitutes placeholders from the process-wide environment, which
 * `loadEnvironment` populates workspace-first at boot — so a substituted
 * brand value could be workspace-supplied even though the layer that wrote
 * it is not. A placeholder that resolves to itself (the variable is unset)
 * is kept verbatim, so a typo'd variable surfaces as the literal text rather
 * than silently falling back.
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
    // Refuse exactly when substitution actually changed the value — compare
    // against the layer's own post-substitution field, which loadSettings
    // produced with the authoritative engine (process env PLUS the home-.env
    // fallback). A literal `$5` or `Cost$Less` resolves to itself and is
    // kept; a placeholder that resolved is refused, because its value came
    // from an environment a workspace populates first. The layer still wins
    // over lower layers: the key is unset with a warning, not skipped.
    const substituted = file.settings.ui?.brand?.[key];
    if (typeof substituted === 'string' && substituted !== value) {
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
    // A placeholder that never resolved leaves its token in the path — the
    // "does not exist" message would otherwise send the operator debugging a
    // directory that literally contains `${...}` without saying so.
    const hint = /\$(?:\w+|\{[^}]*\})/.test(configuredPath)
      ? ' (the path still contains an environment placeholder — is the variable set?)'
      : '';
    return {
      warnings: [`ui.brand.logoPath does not exist: ${filePath}${hint}`],
    };
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
  const root = parseSvgRoot(read.content);
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
  const scalingIssue = scalingIssueOf(root.attrs);
  if (scalingIssue !== undefined) {
    warnings.push(`ui.brand.logoPath ${scalingIssue}: ${filePath}`);
  }
  // A prefix-bound root with unprefixed children loads successfully but
  // paints nothing — unless the document ALSO binds the default namespace,
  // which puts the unprefixed children back into the SVG namespace.
  if (
    root.prefix !== undefined &&
    root.attrs['xmlns'] !== SVG_NAMESPACE &&
    root.hasUnprefixedElements
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

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Parse the document with a real streaming XML parser and require the root
 * element to be an `svg` element (any prefix) whose binding declares the SVG
 * namespace, returning its attributes, its prefix, and whether the body
 * holds an element outside that prefix.
 *
 * The namespace requirement is renderability, not paranoia: a root element
 * not in the SVG namespace does not render as an image, so without the check
 * the daemon would ship a data URI that paints a blank mark and writes
 * nothing to stderr. This is a correctness check, not a security boundary.
 * The client renders a custom logo as an `img` whose `src` is the data URI,
 * never as injected markup, and SVG loaded as an image cannot run script. Do
 * not switch the client to inline rendering without adding a sanitizer here
 * first.
 *
 * saxes is the parser jsdom uses, so "would a browser's XML parser accept
 * this" is answered by the same engine class rather than by a reimplemented
 * case set: duplicate attributes, junk after the root element, undeclared
 * entities, out-of-range character references, malformed comments and the
 * rest are all well-formedness errors it reports. Attribute values arrive
 * entity-decoded, exactly once — the same single decode a browser applies.
 * Namespace processing is enabled because browsers always have it (jsdom
 * passes `xmlns: true` for XML documents): without it, an undeclared prefix
 * such as `xlink:href` on a child parses clean here while the browser
 * fatals on it.
 */
function parseSvgRoot(content: string):
  | {
      prefix: string | undefined;
      attrs: Record<string, string>;
      hasUnprefixedElements: boolean;
    }
  | undefined {
  let failed = false;
  let rootLocal: string | undefined;
  let rootPrefix: string | undefined;
  let rootAttrs: Record<string, string> | undefined;
  let hasUnprefixedElements = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', () => {
    failed = true;
  });
  parser.on('opentag', (tag) => {
    const qName = tag.name;
    const colon = qName.indexOf(':');
    const prefix = colon === -1 ? undefined : qName.slice(0, colon);
    if (rootLocal === undefined) {
      rootLocal = colon === -1 ? qName : qName.slice(colon + 1);
      rootPrefix = prefix;
      // xmlns mode types attribute values as objects holding the decoded
      // string; flatten them back to the Record<string, string> callers read.
      rootAttrs = Object.fromEntries(
        Object.entries(tag.attributes).map(([key, attr]) => [key, attr.value]),
      );
      return;
    }
    // A prefix-bound root with an element outside its prefix paints nothing
    // for that element — it lands in no (or another) namespace. The default
    // `xmlns` rescue is judged by the caller, which has the root's attrs.
    if (rootPrefix !== undefined && prefix !== rootPrefix) {
      hasUnprefixedElements = true;
    }
  });
  try {
    // close() is load-bearing, not a courtesy: without it the parser never
    // sees EOF, so `<svg ...>` with no closing tag parses clean here while a
    // browser's XML parser rejects it as unclosed.
    parser.write(content).close();
  } catch {
    failed = true;
  }
  if (failed || rootLocal !== 'svg' || rootAttrs === undefined) {
    return undefined;
  }
  // A prefix binding on an unprefixed root does not count — `xmlns:svg`
  // alone leaves `<svg>` in no namespace.
  const binding = rootPrefix === undefined ? 'xmlns' : `xmlns:${rootPrefix}`;
  if (rootAttrs[binding] !== SVG_NAMESPACE) return undefined;
  return { prefix: rootPrefix, attrs: rootAttrs, hasUnprefixedElements };
}

/**
 * The scaling advisory's reason, or undefined when the root carries geometry
 * the browser can scale into the fixed sidebar logo box. Name-presence alone
 * is not enough — `viewBox=""` or `width="0"` paints nothing, `width="100%"`
 * ties the artwork to the viewport it never fills at 26px, and a viewBox
 * with a zero-area viewport disables rendering outright. A malformed viewBox
 * is ignored by browsers, so it falls through to the width/height check
 * rather than deciding on its own.
 */
function scalingIssueOf(attrs: Record<string, string>): string | undefined {
  const viewBox = attrs['viewBox'];
  if (viewBox !== undefined && viewBox.trim() !== '') {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts.every((p) => Number.isFinite(p))) {
      if (parts[2]! > 0 && parts[3]! > 0) return undefined;
      return 'has a viewBox with a zero-area viewport, so the browser paints nothing at any size';
    }
    // Malformed: browsers ignore the attribute — decide on width/height.
  }
  const width = attrs['width'];
  const height = attrs['height'];
  const usable = (value: string | undefined) => {
    if (value === undefined) return false;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.endsWith('%')) return false;
    const numeric = parseFloat(trimmed);
    return Number.isFinite(numeric) && numeric > 0;
  };
  if (usable(width) && usable(height)) return undefined;
  if (viewBox !== undefined && viewBox.trim() !== '') {
    return 'has a malformed viewBox and no usable width/height, so it cannot be scaled into the sidebar logo box and may render blank';
  }
  return 'has no viewBox or width/height, so it cannot be scaled into the sidebar logo box and may render blank';
}
