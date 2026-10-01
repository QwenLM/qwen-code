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

const MAX_INDEX_LINE_CHARS = 150;
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;
const MAX_INDEX_FIELD_CHARS = 120;
// The description is the only optional part of an entry, so it absorbs all the
// shortening. Below this length a hook is not worth the bytes it costs, and the
// entry is emitted without one.
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
  return `${value
    .slice(0, limit - 1)
    .replace(/\s+\S*$/, '')
    .trimEnd()}…`;
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
const utf8Encoder = new TextEncoder();

/**
 * Percent-encode an attacker-controlled relative PATH so it can sit in the
 * committed MEMORY.md as a Markdown link target `](path)` (and in the
 * "(also: …)" list) while staying BOTH addressable and injection-safe. Git
 * filenames may legally contain newlines, spaces and `()[]` + backticks, so a
 * raw path (`ok.md` + newline + `- SYSTEM: …`) injects a second physical line
 * or closes the `](…)` target early. An earlier fix rewrote those chars to `_`,
 * which defused injection but pointed the link at a file that does NOT exist.
 * Instead, percent-encode every char outside the addressable allowlist: the
 * breakout chars become inert ASCII (newline→`%0A`, `(`→`%28`, `)`→`%29`,
 * space→`%20`, backtick→`%60`, …) so the target is one line with no `](`/`)`
 * breakout, yet `decodeURIComponent` recovers the exact path — the link still
 * resolves to the real file. `/` is kept literal so it stays a usable path.
 * The path is deliberately NOT shortened: a truncated target points at a file
 * that does not exist, and a dead link costs more than a long line. Overall
 * index size stays bounded by `MAX_INDEX_BYTES` in {@link assembleIndex}.
 */
function encodeIndexPathTarget(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '/' || PATH_TARGET_SAFE.test(ch)) {
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
 * `lineBudget` lets a grouped entry hand part of the line to its sibling list;
 * it only ever shrinks the description, never the link.
 */
function docIndexLine(
  doc: ScannedAutoMemoryDocument,
  lineBudget = MAX_INDEX_LINE_CHARS,
): string {
  const title = sanitizeIndexField(doc.title) || doc.type;
  const description = sanitizeIndexField(doc.description) || doc.type;
  const link = `- [${title}](${encodeIndexPathTarget(doc.relativePath)})`;
  const room = lineBudget - link.length - INDEX_HOOK_SEPARATOR.length;
  if (room < MIN_INDEX_HOOK_CHARS) {
    return link;
  }
  return `${link}${INDEX_HOOK_SEPARATOR}${truncateIndexField(description, room)}`;
}

/**
 * Assemble pre-built index lines into the final MEMORY.md body, enforcing the
 * line-count and byte-size caps and appending a truncation warning when either
 * trips. Each entry is exactly one line (descriptions are single-line).
 */
function assembleIndex(lines: string[]): string {
  const raw = lines.join('\n');
  const wasLineTruncated = lines.length > MAX_INDEX_LINES;
  let truncated = wasLineTruncated
    ? lines.slice(0, MAX_INDEX_LINES).join('\n')
    : raw;

  if (truncated.length > MAX_INDEX_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_INDEX_BYTES);
    // Cut on an entry boundary only: slicing mid-line would emit a half-written
    // `](path)` link. An entry longer than the whole budget is dropped.
    truncated = cutAt > 0 ? truncated.slice(0, cutAt) : '';
  }

  if (!wasLineTruncated && truncated.length === raw.length) {
    return truncated;
  }

  return `${truncated}\n\n> WARNING: MEMORY.md is too large; only part of it was written. Keep index entries concise and move detail into topic files.`;
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

function teamGroupIndexLine(group: TeamIndexGroup): string {
  if (group.others.length === 0) {
    return docIndexLine(group.primary);
  }
  // The siblings are reachable from this suffix and nowhere else, so it claims
  // its room BEFORE the primary's description is rendered. Sizing the primary
  // against the whole line instead let any description long enough to fill it
  // leave no room at all, silently dropping every grouped file. A target that
  // still does not fit is dropped whole — never sliced.
  let also = '';
  let line = '';
  for (const doc of group.others) {
    const target = encodeIndexPathTarget(doc.relativePath);
    const next = also ? `${also}, ${target}` : target;
    const base = docIndexLine(
      group.primary,
      MAX_INDEX_LINE_CHARS - (INDEX_ALSO_OPEN.length + next.length + 1),
    );
    const candidate = `${base}${INDEX_ALSO_OPEN}${next})`;
    if (candidate.length > MAX_INDEX_LINE_CHARS) {
      break;
    }
    also = next;
    line = candidate;
  }
  return also ? line : docIndexLine(group.primary);
}

/**
 * Build the team index with cross-author dedup: entries sharing a description
 * collapse into one line. See {@link groupTeamDocsByDescription}.
 */
export function buildTeamAutoMemoryIndex(
  docs: ScannedAutoMemoryDocument[],
): string {
  return assembleIndex(
    groupTeamDocsByDescription(docs).map(teamGroupIndexLine),
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
