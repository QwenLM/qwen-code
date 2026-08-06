/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Run-start captures and checkpoint drift detection for /audit, per
// docs/design/legacy-code-audit.md: the sidecar keeps a re-audit alignable
// with the run it follows (file:line anchors drift with HEAD), and the
// drift arms re-check the audited path — not the repository — before
// verification, before each high-tier round, and at write time.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { FilesPlan } from './files-plan.js';

const GIT_TIMEOUT_MS = 30_000;

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** `HEAD:<path>` needs the path relative to the toplevel, POSIX separators;
 *  the empty string (auditing the toplevel itself) reads the root tree. Both
 *  sides are realpath'd — git reports the symlink-resolved toplevel. */
function subtreeHashAt(rootAbs: string, toplevel: string): string | undefined {
  const rel = relative(realpathSync(toplevel), realpathSync(rootAbs))
    .split(sep)
    .join('/');
  return git(rootAbs, ['rev-parse', `HEAD:${rel}`])?.trim();
}

export interface SidecarMeta {
  capturedAt: string;
  /** Outside any git worktree there is no SHA or dirty state; the content
   *  hashes are the run's only alignment mechanism and the header says so. */
  noVcs: boolean;
  headSha?: string;
  /** `git rev-parse HEAD:<path>` — the subtree hash, so a commit elsewhere
   *  in the repository neither breaks alignment nor stops the run. Absent
   *  when the audited path has no HEAD entry (the vendored case). */
  subtreeHash?: string;
}

export interface Sidecar {
  meta: SidecarMeta;
  /** sha256 of every walked subject and test file at capture time. */
  hashes: Record<string, string>;
  /** sha256 of every registered deep-read caller, keyed by absolute path. */
  callerHashes: Record<string, string>;
  /** Uncoverable files are name-recorded, never content-copied or hashed. */
  uncoverableNames: string[];
}

/** Capture the run-start sidecar: the path-scoped diff, the untracked
 *  content copies, and the per-file content hashes. Unconditional — never
 *  gated on a dirty/clean determination, because `git status` never shows
 *  the gitignored-untracked class this capture exists for. */
export function captureSidecar(
  plan: FilesPlan,
  sidecarDir: string,
  callerPaths: string[] = [],
): Sidecar {
  const rootAbs = plan.targetPathAbsolute;
  mkdirSync(sidecarDir, { recursive: true });

  // A re-run with --callers (1c's registration lands mid-fan-out) preserves
  // the run-start captures and only extends the caller set — the walked-file
  // baseline must stay the run-start content.
  const existingPath = join(sidecarDir, 'sidecar.json');
  if (existsSync(existingPath)) {
    const existing = loadSidecar(sidecarDir);
    for (const caller of callerPaths) {
      if (caller in existing.callerHashes) continue;
      try {
        existing.callerHashes[caller] = sha256(readFileSync(caller, 'utf8'));
        const dest = join(
          sidecarDir,
          'callers',
          caller.replace(/^([A-Za-z]:)?\//, ''),
        );
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(caller, dest);
      } catch {
        // An unreadable caller is recorded by name only.
      }
    }
    writeFileSync(existingPath, JSON.stringify(existing, null, 2), 'utf8');
    return existing;
  }

  const top = git(rootAbs, ['rev-parse', '--show-toplevel']);
  const meta: SidecarMeta = {
    capturedAt: new Date().toISOString(),
    noVcs: top === null,
  };
  if (top !== null) {
    meta.headSha = git(rootAbs, ['rev-parse', 'HEAD'])?.trim();
    const subtree = subtreeHashAt(rootAbs, top.trim());
    if (subtree) meta.subtreeHash = subtree;
    // Tracked and staged changes, path-scoped so the sidecar never carries
    // unrelated dirty content from elsewhere in the repository.
    const diff = git(rootAbs, ['diff', 'HEAD', '--', rootAbs]);
    if (diff !== null && diff.length > 0) {
      writeFileSync(join(sidecarDir, 'diff.patch'), diff, 'utf8');
    }
  }

  // Untracked content copies: `git ls-files --others` WITHOUT
  // --exclude-standard — the raw listing covers the gitignored-untracked
  // class — filtered to the files the plan enumerates, so the capture
  // inherits the enumeration's directory-name exclusions.
  const enumerated = new Set([
    ...plan.subjectFiles.map((f) => f.path),
    ...plan.testCorpus.map((f) => f.path),
  ]);
  if (top !== null) {
    const others = git(rootAbs, ['ls-files', '-z', '--others', '--', rootAbs]);
    if (others !== null) {
      const listed = others.split('\0').filter((p) => p.length > 0);
      // A collapsed trailing-/ entry is a nested git repository: expand it
      // against the enumerated files under it.
      const names = new Set<string>();
      for (const entry of listed) {
        if (entry.endsWith('/')) {
          for (const rel of enumerated) {
            if (rel.startsWith(entry)) names.add(rel);
          }
        } else {
          names.add(entry);
        }
      }
      for (const rel of [...names].sort()) {
        if (!enumerated.has(rel)) continue;
        const src = join(rootAbs, rel);
        const dest = join(sidecarDir, 'untracked', rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
      }
    }
  }

  const hashes: Record<string, string> = {};
  for (const file of [...plan.subjectFiles, ...plan.testCorpus]) {
    try {
      hashes[file.path] = sha256(
        readFileSync(join(rootAbs, file.path), 'utf8'),
      );
    } catch {
      // A file that vanishes between plan and capture is drift the first
      // checkpoint reports; the missing key is the signal.
    }
  }

  const callerHashes: Record<string, string> = {};
  for (const caller of callerPaths) {
    try {
      callerHashes[caller] = sha256(readFileSync(caller, 'utf8'));
      const dest = join(
        sidecarDir,
        'callers',
        caller.replace(/^([A-Za-z]:)?\//, ''),
      );
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(caller, dest);
    } catch {
      // An unreadable caller is recorded by name only.
    }
  }

  const sidecar: Sidecar = {
    meta,
    hashes,
    callerHashes,
    uncoverableNames: plan.uncoverable.map((u) => u.path),
  };
  writeFileSync(
    join(sidecarDir, 'sidecar.json'),
    JSON.stringify(sidecar, null, 2),
    'utf8',
  );
  return sidecar;
}

export interface DriftReport {
  /** Walked files whose content hash moved since the capture. */
  driftedFiles: string[];
  /** Walked files present at capture and now missing. */
  deletedFiles: string[];
  /** New files under the audited path matching the enumerated sets. */
  newFiles: string[];
  /** Registered callers whose content hash moved. */
  driftedCallers: string[];
  /** HEAD moved with content unchanged everywhere — fires no stop. */
  headMoved: boolean;
  subtreeMoved: boolean;
}

export function loadSidecar(sidecarDir: string): Sidecar {
  return JSON.parse(
    readFileSync(join(sidecarDir, 'sidecar.json'), 'utf8'),
  ) as Sidecar;
}

/** Re-check the audited path against the run-start capture. Content-keyed:
 *  a file whose content is unchanged is not drifted, whatever HEAD did. */
export function driftCheck(plan: FilesPlan, sidecarDir: string): DriftReport {
  const rootAbs = plan.targetPathAbsolute;
  const sidecar = loadSidecar(sidecarDir);
  const driftedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const newFiles: string[] = [];

  for (const file of [...plan.subjectFiles, ...plan.testCorpus]) {
    const baseline = sidecar.hashes[file.path];
    const abs = join(rootAbs, file.path);
    if (!existsSync(abs)) {
      if (baseline !== undefined) deletedFiles.push(file.path);
      continue;
    }
    const current = sha256(readFileSync(abs, 'utf8'));
    if (baseline === undefined) {
      newFiles.push(file.path);
    } else if (current !== baseline) {
      driftedFiles.push(file.path);
    }
  }

  const driftedCallers: string[] = [];
  for (const [caller, baseline] of Object.entries(sidecar.callerHashes)) {
    if (!existsSync(caller)) {
      driftedCallers.push(caller);
      continue;
    }
    if (sha256(readFileSync(caller, 'utf8')) !== baseline) {
      driftedCallers.push(caller);
    }
  }

  let headMoved = false;
  let subtreeMoved = false;
  if (!sidecar.meta.noVcs) {
    const head = git(rootAbs, ['rev-parse', 'HEAD'])?.trim();
    headMoved = head !== undefined && head !== sidecar.meta.headSha;
    if (sidecar.meta.subtreeHash !== undefined) {
      const top = git(rootAbs, ['rev-parse', '--show-toplevel']);
      const subtree = top ? subtreeHashAt(rootAbs, top.trim()) : undefined;
      subtreeMoved =
        subtree !== undefined && subtree !== sidecar.meta.subtreeHash;
    }
  }

  return {
    driftedFiles,
    deletedFiles,
    newFiles,
    driftedCallers,
    headMoved,
    subtreeMoved,
  };
}
