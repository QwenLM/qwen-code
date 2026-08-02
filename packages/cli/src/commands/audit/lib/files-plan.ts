/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Core logic for `qwen audit plan-files`: enumerate a directory of existing
// code into an audit plan.
//
// Relationship to review/lib/diff-plan.ts: that module's input is diff text
// (an increment); this module's input is the filesystem (a tree). The
// classification rules are shared via classifyPath so that
// source/test/docs/generated means the same thing in both pipelines.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { classifyPath, type PathKind } from '../../review/lib/diff-plan.js';

/** Below this many source lines, every dimension agent reads the whole file
 *  set (the topology both experiments validated). */
export const WHOLE_READ_SRC_LINES = 8000;
/** Chunk target, aligned with review's chunk size. */
export const DEFAULT_MAX_CHUNK_LINES = 400;
/** Files at or above this many lines get the invariant-checklist triple. */
export const HEAVY_FILE_LINES = 1000;

const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|pdf|zip|gz|tar|woff2?|ttf|otf|mp4|mov|wasm|lock)$/i;

export type AuditEffort = 'low' | 'medium' | 'high';

export type AuditRoleId =
  | '1a'
  | '1c'
  | '2'
  | '3a'
  | '3b'
  | '3c'
  | '4'
  | '5'
  | '6a'
  | '6b'
  | '6c';

export interface AuditFile {
  /** Relative to the audited root, POSIX separators. */
  path: string;
  kind: PathKind;
  lines: number;
  chars: number;
  heavy: boolean;
}

export interface AuditChunk {
  id: number;
  files: string[];
  lines: number;
  chars: number;
  /** A single file larger than maxChunkLines stands alone; its agent pages. */
  oversized: boolean;
}

export interface FilesPlan {
  topology: 'whole' | 'chunked';
  totalFiles: number;
  srcLines: number;
  files: AuditFile[];
  /** Test files: never audit subjects — evidence for Agent 5 and for
   *  inferring intent. */
  evidenceFiles: Array<{ path: string; lines: number }>;
  docsFiles: string[];
  generatedFiles: string[];
  chunks: AuditChunk[];
  heavyFiles: string[];
  roster: AuditRoleId[];
  /** Subsets of roster for the chunked topology: per-chunk fan-out vs
   *  whole-module agents. Written by the planner so the orchestrator never
   *  re-derives them. */
  chunkScopedRoles: AuditRoleId[];
  wholeModuleRoles: AuditRoleId[];
}

/** Enumerate files under rootAbs. Inside a git repo, `git ls-files` honors
 *  every gitignore layer for free and reports paths relative to the `-C`
 *  directory (i.e. already relative to rootAbs). Elsewhere, a naive
 *  recursive walk. Returns paths relative to rootAbs with POSIX separators. */
function enumeratePaths(rootAbs: string): string[] {
  try {
    const out = execFileSync(
      'git',
      [
        '-C',
        rootAbs,
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split('\0').filter((p) => p.length > 0);
  } catch {
    const files: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), childRel);
        } else if (entry.isFile()) {
          files.push(childRel);
        }
      }
    };
    walk(rootAbs, '');
    return files;
  }
}

function toPosixPath(p: string): string {
  return p.split(sep).join('/');
}

function repositoryRoot(rootAbs: string): string | null {
  try {
    return execFileSync(
      'git',
      ['-C', rootAbs, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return null;
  }
}

/** Enumerate, classify, and measure every auditable file under rootAbs. */
export function collectAuditFiles(rootAbs: string): AuditFile[] {
  const files: AuditFile[] = [];
  const repoRoot = repositoryRoot(rootAbs);
  for (const relPath of enumeratePaths(rootAbs)) {
    if (BINARY_EXT_RE.test(relPath)) {
      continue;
    }
    const absolutePath = join(rootAbs, relPath);
    let content: string;
    try {
      if (!lstatSync(absolutePath).isFile()) {
        continue;
      }
      content = readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    const posix = toPosixPath(relPath);
    const classificationPath = repoRoot
      ? toPosixPath(relative(repoRoot, absolutePath))
      : posix;
    files.push({
      path: posix,
      kind: classifyPath(classificationPath),
      lines: content === '' ? 0 : content.split('\n').length,
      chars: content.length,
      heavy: false,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** Greedy bin-packing: fill each chunk up to maxChunkLines in path order;
 *  an oversized file always stands alone (an agent can page through it, and
 *  splitting mid-file without declaration awareness slices functions). */
export function tileFiles(
  files: AuditFile[],
  maxChunkLines: number,
): AuditChunk[] {
  if (!Number.isSafeInteger(maxChunkLines) || maxChunkLines <= 0) {
    throw new Error('maxChunkLines must be a positive integer.');
  }
  const chunks: AuditChunk[] = [];
  let current: AuditFile[] = [];
  let currentLines = 0;
  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    chunks.push({
      id: chunks.length + 1,
      files: current.map((f) => f.path),
      lines: currentLines,
      chars: current.reduce((n, f) => n + f.chars, 0),
      oversized: false,
    });
    current = [];
    currentLines = 0;
  };
  for (const file of files) {
    if (file.lines > maxChunkLines) {
      flush();
      chunks.push({
        id: chunks.length + 1,
        files: [file.path],
        lines: file.lines,
        chars: file.chars,
        oversized: true,
      });
      continue;
    }
    if (currentLines + file.lines > maxChunkLines) {
      flush();
    }
    current.push(file);
    currentLines += file.lines;
  }
  flush();
  return chunks;
}

/** Effort → roster. `low` is the inline tier: no agents at all. */
export function rosterForEffort(effort: AuditEffort): AuditRoleId[] {
  if (effort === 'low') {
    return [];
  }
  const medium: AuditRoleId[] = [
    '1a',
    '1c',
    '2',
    '3a',
    '3b',
    '3c',
    '4',
    '5',
    '6a',
  ];
  return effort === 'high' ? [...medium, '6b', '6c'] : medium;
}

/** Roles whose walk is meaningful per territory: in the chunked topology
 *  they fan out one agent per chunk. The rest always see the whole module —
 *  a cross-file, repo-grep, or gestalt walk is meaningless per-chunk. */
export const CHUNK_SCOPED_ROLES: readonly AuditRoleId[] = [
  '1a',
  '2',
  '3b',
  '3c',
  '4',
  '6a',
];
export const WHOLE_MODULE_ROLES: readonly AuditRoleId[] = [
  '1c',
  '3a',
  '5',
  '6b',
  '6c',
];

export function buildFilesPlan(
  files: AuditFile[],
  effort: AuditEffort,
  maxChunkLines: number = DEFAULT_MAX_CHUNK_LINES,
): FilesPlan {
  const subjects = files.filter((f) => f.kind === 'source');
  const evidence = files.filter((f) => f.kind === 'test');
  const srcLines = subjects.reduce((n, f) => n + f.lines, 0);
  const topology = srcLines <= WHOLE_READ_SRC_LINES ? 'whole' : 'chunked';
  const chunks =
    topology === 'chunked' ? tileFiles(subjects, maxChunkLines) : [];
  for (const f of subjects) {
    f.heavy = f.lines >= HEAVY_FILE_LINES;
  }
  return {
    topology,
    totalFiles: subjects.length,
    srcLines,
    files: subjects,
    evidenceFiles: evidence.map((f) => ({ path: f.path, lines: f.lines })),
    docsFiles: files.filter((f) => f.kind === 'docs').map((f) => f.path),
    generatedFiles: files
      .filter((f) => f.kind === 'generated')
      .map((f) => f.path),
    chunks,
    heavyFiles: subjects.filter((f) => f.heavy).map((f) => f.path),
    roster: rosterForEffort(effort),
    // In the chunked topology these fan out per chunk / stay whole-module;
    // both lists are subsets of roster and the orchestrator must not have
    // to re-derive them.
    chunkScopedRoles: rosterForEffort(effort).filter((r) =>
      CHUNK_SCOPED_ROLES.includes(r),
    ),
    wholeModuleRoles: rosterForEffort(effort).filter((r) =>
      WHOLE_MODULE_ROLES.includes(r),
    ),
  };
}

export function resolveAuditRoot(targetPath: string): string {
  const abs = resolve(targetPath);
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `audit: ${targetPath} is a file, not a directory. Single files are ` +
        `already covered by /review <file-path> — use that instead.`,
    );
  }
  return abs;
}
