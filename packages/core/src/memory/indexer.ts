/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { QWEN_DIR } from '../utils/paths.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getMemoryRootTrustedAnchor,
  getTeamAutoMemoryIndexPath,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryIndexPath,
  getUserAutoMemoryRoot,
  TEAM_AUTO_MEMORY_DIRNAME,
} from './paths.js';
import { resolveTrustedMemoryRoot } from './trusted-memory-filesystem.js';
import {
  scanAllAutoMemoryTopicDocumentsFromRoot,
  scanAutoMemoryTopicDocuments,
  scanTeamAutoMemoryTopicDocuments,
  scanUserAutoMemoryTopicDocuments,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import type { AutoMemoryScope } from './types.js';
import type { AutoMemoryMetadata } from './types.js';
import {
  INDEX_TRUNCATION_NOTICE,
  MAX_INDEX_LINE_CHARS,
  MAX_INDEX_LINES,
  trimIndexToBudget,
} from './index-budget.js';

const MAX_INDEX_FIELD_CHARS = 120;
// The description is the only optional part of an entry, so it absorbs all the
// shortening. A hook that would have to be CUT below this length is not worth
// the bytes it costs, so the entry is then emitted without one — but a hook
// that fits whole in the leftover room is kept however small that room is.
const MIN_INDEX_HOOK_CHARS = 24;
const INDEX_HOOK_SEPARATOR = ' — ';
const INDEX_ALSO_OPEN = ' (also: ';

/**
 * Shorten an already-sanitized field to `limit`, preferring a word boundary.
 * Only display text may pass through here — never a link target, which stops
 * resolving the moment it is cut.
 */
function truncateIndexField(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  let head = value.slice(0, limit - 1);
  // Back off one unit when the cut lands inside a surrogate pair: a lone high
  // surrogate does not survive the write to MEMORY.md (the file carries U+FFFD
  // instead), so the index stops round-tripping and the team rebuild's
  // unchanged-content skip can never fire again.
  const lastUnit = head.charCodeAt(head.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    head = head.slice(0, -1);
  }
  // Back off to a word boundary only when the boundary keeps most of the
  // window (the same guard compressFindingSummary applies): an unconditional
  // backoff deletes everything after the last whitespace, collapsing a field
  // whose tail is one long unbroken run — the normal shape of CJK prose,
  // which has no word-separating spaces — to its leading token plus `…`.
  const boundary = head.replace(/\s+\S*$/, '').trimEnd();
  const cut = boundary.length >= limit * 0.6 ? boundary : head;
  return `${cut.trimEnd()}…`;
}

/**
 * Sanitize an attacker-controlled frontmatter field (title/description) before
 * embedding it into the COMMITTED MEMORY.md, which loads verbatim into every
 * collaborator's system prompt. A malicious team-memory file could otherwise
 * smuggle prompt-injection text or markdown that forges new structure into the
 * shared context. Strip control / zero-width / bidi chars, collapse all
 * whitespace (incl. newlines) so the entry can't break out of its one-line list
 * item, defang code/link markdown, and cap length.
 */
function sanitizeIndexField(value: string): string {
  const cleaned = value
    // C0/C1 control chars (CR, LF, TAB, ESC, ...) -> space.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    // Zero-width + bidi-override chars that can hide or reorder injected text.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    // Unpaired surrogates, reachable from frontmatter via a YAML `\uD835`
    // escape. They do not survive the write to MEMORY.md (the file carries
    // U+FFFD instead), so the index would stop round-tripping and the team
    // rebuild's unchanged-content skip could never fire again. Pairs are kept.
    .replace(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      '',
    )
    // Defang code spans/fences and markdown links so the field can't forge a
    // fenced "system" block or a clickable link inside the shared doc.
    .replace(/`/g, "'")
    .replace(/\]\(/g, '] (')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateIndexField(cleaned, MAX_INDEX_FIELD_CHARS);
}

// Chars left RAW in a link target: alphanumerics plus the path punctuation
// (`. - _ ~`) that keeps the link resolving to the real file. `/` is checked
// separately so the class needs no slash (sidesteps the regex-literal /
// no-useless-escape ambiguity around a `/` inside `[...]`).
const PATH_TARGET_SAFE = /[A-Za-z0-9._~-]/;
// Printable non-ASCII also stays RAW: a Markdown destination accepts it, and
// encoding it would expand one CJK char to nine — a few ordinary non-ASCII
// paths would then spend the whole index budget and evict every
// other entry. Still encoded: whitespace (a destination may not contain any,
// and `\s` covers the non-ASCII spaces a filename may legally hold), C0/C1
// controls, ASCII punctuation, EVERY invisible format character — the
// zero-width, bidi, soft-hyphen, variation-selector, Mongolian vowel-separator
// and Hangul-filler ranges below, i.e. Unicode's `Cf` ∪
// `Default_Ignorable_Code_Point` ∪ `Bidi_Control` in the BMP — because they
// hide or reorder text that lands verbatim in every collaborator's system
// prompt, and lone surrogates (they do not survive the write). An astral char
// arrives as a pair, so it stays encoded too.
//
// This has to stay a per-code-unit DENYLIST rather than an allowlist built from
// `\p{…}` classes: those need the `u` flag, under which an astral character is
// one code point instead of a surrogate pair, so `\ud800-\udfff` stops firing
// for well-formed pairs and the tag-steganography range U+E0020-U+E007F would
// pass through raw.
const PATH_TARGET_RAW_NON_ASCII =
  // The class matches per code unit on purpose (see above), so the combining
  // marks it excludes are listed as bare code points, not as sequences.
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /[^\s\u0000-\u009f\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u2069\u206a-\u206f\u3164\ufeff\ufe00-\ufe0f\uffa0\ufff0-\ufffb\ud800-\udfff]/;
const utf8Encoder = new TextEncoder();

/**
 * Percent-encode an attacker-controlled relative PATH so it can sit in the
 * committed MEMORY.md as a Markdown link target `](path)` (and in the
 * "(also: …)" list) while staying BOTH addressable and injection-safe. Git
 * filenames may legally contain newlines, spaces and `()[]` + backticks, so a
 * raw path (`ok.md` + newline + `- SYSTEM: …`) injects a second physical line
 * or closes the `](…)` target early. An earlier fix rewrote those chars to `_`,
 * which defused injection but pointed the link at a file that does NOT exist.
 * Instead, percent-encode every char that is neither addressable-ASCII nor
 * printable non-ASCII: the breakout chars become inert ASCII (newline→`%0A`,
 * `(`→`%28`, `)`→`%29`, space→`%20`, backtick→`%60`, …) so the target is one
 * line with no `](`/`)` breakout, yet `decodeURIComponent` recovers the exact
 * path — the link still resolves to the real file. `/` is kept literal so it
 * stays a usable path.
 * The path is deliberately NOT shortened: a truncated target points at a file
 * that does not exist, and a dead link costs more than a long line. Overall
 * index size stays bounded by the character budget in {@link assembleIndex}.
 */
function encodeIndexPathTarget(value: string): string {
  let out = '';
  for (const ch of value) {
    if (
      ch === '/' ||
      PATH_TARGET_SAFE.test(ch) ||
      PATH_TARGET_RAW_NON_ASCII.test(ch)
    ) {
      out += ch;
      continue;
    }
    for (const byte of utf8Encoder.encode(ch)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * Render one index entry. The link is built first and never shortened, because
 * it is the entry's only functional part; the description takes whatever room
 * the link leaves, and is dropped entirely when that room is too small to be
 * useful. An entry whose link alone exceeds {@link MAX_INDEX_LINE_CHARS} is
 * therefore allowed to run long — a resolving long link beats a short dead one.
 * Grouped siblings reserve their space before the description is rendered;
 * targets that do not fit are dropped whole, never sliced.
 */
function docIndexLine(
  doc: ScannedAutoMemoryDocument,
  others: ScannedAutoMemoryDocument[] = [],
): string {
  const title = sanitizeIndexField(doc.title) || doc.type;
  const link = `- [${title}](${encodeIndexPathTarget(doc.relativePath)})`;
  let also = '';
  for (const other of others) {
    const target = encodeIndexPathTarget(other.relativePath);
    const next = also ? `${also}, ${target}` : target;
    if (
      link.length + INDEX_ALSO_OPEN.length + next.length + 1 >
      MAX_INDEX_LINE_CHARS
    ) {
      // Drop THIS sibling whole and keep measuring the rest: a later, shorter
      // target may still fit, and a grouped member has no index line of its
      // own — skipping the rest here would hide it from the index entirely.
      continue;
    }
    also = next;
  }
  const suffix = also ? `${INDEX_ALSO_OPEN}${also})` : '';
  const room =
    MAX_INDEX_LINE_CHARS -
    link.length -
    suffix.length -
    INDEX_HOOK_SEPARATOR.length;
  const description = sanitizeIndexField(doc.description) || doc.type;
  // A hook that FITS whole costs nothing beyond its bytes — keep it. Drop the
  // hook only when it would have to be CUT below MIN_INDEX_HOOK_CHARS.
  if (description.length > room && room < MIN_INDEX_HOOK_CHARS) {
    return `${link}${suffix}`;
  }
  return `${link}${INDEX_HOOK_SEPARATOR}${truncateIndexField(description, room)}${suffix}`;
}

/**
 * Assemble pre-built index lines into the final MEMORY.md body, enforcing the
 * line-count and character caps and appending a truncation warning when either
 * trips. Each entry is exactly one line (descriptions are single-line).
 */
function assembleIndex(lines: string[]): string {
  const raw = lines.join('\n');
  const wasLineTruncated = lines.length > MAX_INDEX_LINES;
  const truncated = trimIndexToBudget(lines);

  if (!wasLineTruncated && truncated.length === raw.length) {
    return truncated;
  }

  return `${truncated}${INDEX_TRUNCATION_NOTICE}`;
}

export function buildManagedAutoMemoryIndex(
  docs: ScannedAutoMemoryDocument[],
  _metadata?: Pick<
    AutoMemoryMetadata,
    'updatedAt' | 'lastDreamAt' | 'lastDreamSessionId'
  >,
): string {
  return assembleIndex(docs.map((doc) => docIndexLine(doc)));
}

/**
 * Normalize a description for dedup grouping: lowercase, collapse whitespace,
 * strip trailing punctuation. Conservative (normalized-exact, not fuzzy) so two
 * genuinely different facts are never silently merged.
 */
function normalizeDescription(description: string): string {
  return description
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?)\]}'"`]+$/g, '')
    .trim();
}

interface TeamIndexGroup {
  primary: ScannedAutoMemoryDocument;
  others: ScannedAutoMemoryDocument[];
}

/**
 * Group team docs that share a (normalized) description. When two people save
 * the same shared fact, collapsing them into one index line — listing the other
 * files via "(also: …)" — keeps the index readable. The topic files themselves
 * are never removed (they remain the source of truth); only the index display
 * collapses, and an "(also: …)" entry that does not fit is dropped whole.
 * Empty descriptions are never grouped. Input is assumed pre-sorted by
 * relativePath, so group order and each group's primary are deterministic.
 */
function groupTeamDocsByDescription(
  docs: ScannedAutoMemoryDocument[],
): TeamIndexGroup[] {
  const groups = new Map<string, ScannedAutoMemoryDocument[]>();
  const order: string[] = [];
  for (const doc of docs) {
    const norm = normalizeDescription(doc.description);
    // Empty descriptions carry no dedup signal — key each uniquely by path.
    const key = norm.length > 0 ? `d:${norm}` : `u:${doc.relativePath}`;
    let members = groups.get(key);
    if (!members) {
      members = [];
      groups.set(key, members);
      order.push(key);
    }
    members.push(doc);
  }
  return order.map((key) => {
    const members = groups.get(key)!;
    return { primary: members[0], others: members.slice(1) };
  });
}

/**
 * Build the team index with cross-author dedup: entries sharing a description
 * collapse into one line. See {@link groupTeamDocsByDescription}.
 */
export function buildTeamAutoMemoryIndex(
  docs: ScannedAutoMemoryDocument[],
): string {
  return assembleIndex(
    groupTeamDocsByDescription(docs).map(({ primary, others }) =>
      docIndexLine(primary, others),
    ),
  );
}

async function readAutoMemoryMetadata(
  projectRoot: string,
): Promise<AutoMemoryMetadata | undefined> {
  try {
    const content = await fs.readFile(
      getAutoMemoryMetadataPath(projectRoot),
      'utf-8',
    );
    return JSON.parse(content) as AutoMemoryMetadata;
  } catch {
    return undefined;
  }
}

export async function rebuildManagedAutoMemoryIndex(
  projectRoot: string,
): Promise<string> {
  const [docs, metadata] = await Promise.all([
    scanAutoMemoryTopicDocuments(projectRoot),
    readAutoMemoryMetadata(projectRoot),
  ]);
  const content = buildManagedAutoMemoryIndex(docs, metadata);
  await atomicWriteFile(getAutoMemoryIndexPath(projectRoot), content, {
    encoding: 'utf-8',
    noFollow: true,
  });
  return content;
}

export async function rebuildAutoMemoryIndexAtRoot(
  root: string,
  scope: AutoMemoryScope,
): Promise<string> {
  if (!existsSync(root)) return '';
  await resolveTrustedMemoryRoot(root, getMemoryRootTrustedAnchor(root));
  const docs = await scanAllAutoMemoryTopicDocumentsFromRoot(root, scope);
  const content = buildManagedAutoMemoryIndex(docs);
  await atomicWriteFile(path.join(root, AUTO_MEMORY_INDEX_FILENAME), content, {
    encoding: 'utf-8',
    noFollow: true,
  });
  return content;
}

/**
 * Rebuild the MEMORY.md index for the user-level (cross-project) memory dir.
 * Mirrors {@link rebuildManagedAutoMemoryIndex} but uses the global root
 * and skips metadata (user memory has no per-project state file).
 */
export async function rebuildUserAutoMemoryIndex(): Promise<string> {
  if (!existsSync(getUserAutoMemoryRoot())) return '';
  const docs = await scanUserAutoMemoryTopicDocuments();
  const content = buildManagedAutoMemoryIndex(docs);
  await atomicWriteFile(getUserAutoMemoryIndexPath(), content, {
    encoding: 'utf-8',
    noFollow: true,
  });
  return content;
}

/**
 * Thrown by {@link rebuildTeamAutoMemoryIndex} when the team-memory root (or any
 * parent component) is a symlink that could redirect the committed index OUTSIDE
 * the repository. This is a SECURITY rejection, deliberately distinct from
 * operational IO failures (EACCES/ENOSPC/EPERM): the git-sync gate MUST block on
 * it — never add/commit/push a root that escapes the repo — whereas an
 * operational failure self-corrects on the next rebuild and must not permanently
 * gate legitimate sync.
 */
export class TeamMemoryRootSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamMemoryRootSecurityError';
  }
}

/**
 * Rebuild the team (in-repo, git-tracked) MEMORY.md index from the saved memory
 * files. The team index is generated, never hand-edited — this removes the
 * git merge-conflict surface a hand-maintained shared index would have.
 *
 * Returns the index content, or null when the team dir does not exist yet (it
 * is created lazily on first write, not by a read). Unlike the private indexes,
 * docs are ordered by path (not mtime) so the committed file is deterministic
 * across machines and does not churn after a git checkout.
 */
export async function rebuildTeamAutoMemoryIndex(
  projectRoot: string,
): Promise<string | null> {
  const teamRoot = getTeamAutoMemoryRoot(projectRoot);
  if (!existsSync(teamRoot)) {
    return null;
  }
  // Refuse to write through a symlinked team root. A committed
  // `.qwen/team-memory -> /elsewhere` symlink would otherwise redirect the
  // generated index — and the scanned topic files — OUTSIDE the repo with no
  // tool approval. `noFollow` below only guards the MEMORY.md leaf; the
  // directory symlink it cannot catch is rejected here.
  const rootStat = await fs.lstat(teamRoot);
  if (rootStat.isSymbolicLink()) {
    throw new TeamMemoryRootSecurityError(
      `Refusing to write team memory index: ${teamRoot} is a symlink, which ` +
        `could redirect the committed index outside the repository.`,
    );
  }
  // lstat only inspects the LEAF: a symlinked PARENT (e.g. `.qwen -> /tmp/out`)
  // makes lstat(teamRoot) report a normal dir while every scan/write lands
  // outside the repo. realpath-resolve the whole chain and require it to equal
  // the literal in-repo location (repoRoot/.qwen/team-memory), so a symlink in
  // ANY component is rejected, not just the final one.
  const repoRoot = path.dirname(path.dirname(teamRoot));
  const expectedRoot = path.join(
    await fs.realpath(repoRoot),
    QWEN_DIR,
    TEAM_AUTO_MEMORY_DIRNAME,
  );
  const resolvedRoot = await fs.realpath(teamRoot);
  if (resolvedRoot !== expectedRoot) {
    throw new TeamMemoryRootSecurityError(
      `Refusing to write team memory index: ${teamRoot} resolves to ` +
        `${resolvedRoot}, outside the repository — a parent-directory symlink ` +
        `may be redirecting it.`,
    );
  }
  const docs = await scanTeamAutoMemoryTopicDocuments(projectRoot);
  // Code-unit comparison, NOT localeCompare: the index is committed and pushed,
  // so its ordering must be byte-identical across machines/locales — otherwise
  // two collaborators churn MEMORY.md back and forth and the ff-only sync wedges.
  const ordered = [...docs].sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
  const content = buildTeamAutoMemoryIndex(ordered);
  const indexPath = getTeamAutoMemoryIndexPath(projectRoot);
  // Skip a byte-identical rewrite: regenerating MEMORY.md every run would churn
  // its mtime and produce no-op commits that ping-pong between collaborators.
  const existing = await fs.readFile(indexPath, 'utf-8').catch(() => null);
  if (existing === content) {
    return content;
  }
  // noFollow: never follow a symlink at MEMORY.md itself — replace the link with
  // the regular index instead of writing through it to an attacker path.
  await atomicWriteFile(indexPath, content, {
    encoding: 'utf-8',
    noFollow: true,
  });
  return content;
}
