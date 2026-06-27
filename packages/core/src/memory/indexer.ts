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
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getTeamAutoMemoryIndexPath,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryIndexPath,
  TEAM_AUTO_MEMORY_DIRNAME,
} from './paths.js';
import {
  scanAutoMemoryTopicDocuments,
  scanTeamAutoMemoryTopicDocuments,
  scanUserAutoMemoryTopicDocuments,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import type { AutoMemoryMetadata } from './types.js';

const MAX_INDEX_LINE_CHARS = 150;
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;
const MAX_INDEX_FIELD_CHARS = 120;

function truncateIndexLine(text: string): string {
  if (text.length <= MAX_INDEX_LINE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_INDEX_LINE_CHARS - 1).trimEnd()}…`;
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
  if (cleaned.length <= MAX_INDEX_FIELD_CHARS) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_INDEX_FIELD_CHARS - 1).trimEnd()}…`;
}

/**
 * Sanitize an attacker-controlled relative PATH before embedding it into the
 * committed MEMORY.md (as a link target `](path)` and in the "(also: …)" list).
 * Git filenames may legally contain newlines and markdown delimiters, so a raw
 * path like `ok.md\n- SYSTEM: injected.md` would inject a second physical line —
 * reopening the prompt-injection surface that sanitizeIndexField closes for
 * title/description. Strip control / zero-width / bidi chars (a newline here is
 * the injection), neutralize the `()[]\`` delimiters that let a path break out
 * of its `](…)` target or forge a code span, collapse whitespace to one line,
 * and cap length. Path separators are kept so the entry stays a usable reference.
 */
function sanitizeIndexPath(value: string): string {
  const cleaned = value
    // C0/C1 control chars (incl. CR/LF) stripped — a newline is the line-break
    // injection we are defusing, so remove it rather than turn it into a space.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // Zero-width + bidi-override chars that can hide or reorder injected text.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    // Defang the markdown link/code delimiters a crafted filename could use to
    // close the `](…)` target early and forge structure after it.
    .replace(/[()[\]`]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= MAX_INDEX_FIELD_CHARS) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_INDEX_FIELD_CHARS - 1).trimEnd()}…`;
}

function docIndexLine(doc: ScannedAutoMemoryDocument): string {
  const title = sanitizeIndexField(doc.title) || doc.type;
  const description = sanitizeIndexField(doc.description) || doc.type;
  return `- [${title}](${sanitizeIndexPath(doc.relativePath)}) — ${description}`;
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
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_INDEX_BYTES);
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
  return assembleIndex(docs.map((doc) => truncateIndexLine(docIndexLine(doc))));
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
 * collapses, and an over-long "(also: …)" suffix may itself be truncated.
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
  const base = docIndexLine(group.primary);
  if (group.others.length === 0) {
    return truncateIndexLine(base);
  }
  const also = group.others
    .map((doc) => sanitizeIndexPath(doc.relativePath))
    .join(', ');
  return truncateIndexLine(`${base} (also: ${also})`);
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
  });
  return content;
}

/**
 * Rebuild the MEMORY.md index for the user-level (cross-project) memory dir.
 * Mirrors {@link rebuildManagedAutoMemoryIndex} but uses the global root
 * and skips metadata (user memory has no per-project state file).
 */
export async function rebuildUserAutoMemoryIndex(): Promise<string> {
  const docs = await scanUserAutoMemoryTopicDocuments();
  const content = buildManagedAutoMemoryIndex(docs);
  await atomicWriteFile(getUserAutoMemoryIndexPath(), content, {
    encoding: 'utf-8',
  });
  return content;
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
    throw new Error(
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
    throw new Error(
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
