/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import {
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getTeamAutoMemoryIndexPath,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryIndexPath,
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

function truncateIndexLine(text: string): string {
  if (text.length <= MAX_INDEX_LINE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_INDEX_LINE_CHARS - 1).trimEnd()}…`;
}

function docIndexLine(doc: ScannedAutoMemoryDocument): string {
  return `- [${doc.title}](${doc.relativePath}) — ${doc.description || doc.type}`;
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
  const also = group.others.map((doc) => doc.relativePath).join(', ');
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
  if (!existsSync(getTeamAutoMemoryRoot(projectRoot))) {
    return null;
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
  await atomicWriteFile(getTeamAutoMemoryIndexPath(projectRoot), content, {
    encoding: 'utf-8',
  });
  return content;
}
