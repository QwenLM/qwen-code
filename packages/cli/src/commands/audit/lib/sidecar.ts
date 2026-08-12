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

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { probeGit, runGit, type FilesPlan } from './files-plan.js';

/** Callers are agent-authored and read whole into the sidecar: bound the
 *  read so a pathological path cannot OOM the capture. */
const CALLER_MAX_BYTES = 10 * 1024 * 1024;

const GIT_TIMEOUT_MS = 30_000;

function git(root: string, args: string[]): string | null {
  return runGit(root, args, GIT_TIMEOUT_MS);
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
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
  /** Set when a capture arm failed after the toplevel probe succeeded: the
   *  sidecar is partial, and the report header says so. */
  captureDegraded?: Array<'diff' | 'untracked'>;
  /** The toplevel probe FAILED (timeout, transient error, missing binary)
   *  — as opposed to git's definitive not-a-worktree answer. The capture
   *  degrades like noVcs, but the header must not claim "outside any git
   *  worktree" and the drift arms re-probe at checkpoint time. */
  vcsProbeFailed?: boolean;
}

export interface Sidecar {
  meta: SidecarMeta;
  /** sha256 of every walked subject and test file at capture time. */
  hashes: Record<string, string>;
  /** sha256 of every registered deep-read caller readable at capture,
   *  keyed by absolute path. */
  callerHashes: Record<string, string>;
  /** Every registered caller by absolute path, readable or not — a name
   *  without a hash was unreadable at capture, but drift-check still
   *  watches it, so a registration is never silently dropped. */
  callerNames: string[];
  /** Uncoverable files are name-recorded, never content-copied or hashed. */
  uncoverableNames: string[];
}

/** Hash-and-copy one registered caller. Callers arrive absolute and
 *  platform-native; the copy is keyed by the path with its drive-letter or
 *  root prefix stripped, so the join below the sidecar is valid on every
 *  platform. Returns the hash, or undefined when the caller vanished or was
 *  unreadable — the name is still recorded by the caller. */
function recordCaller(sidecarDir: string, caller: string): string | undefined {
  try {
    // Stat before reading: callers are agent-authored — a writer-less FIFO
    // blocks readFileSync forever and a device node buffers until OOM. A
    // skipped caller stays name-registered (drift-check watches it), so the
    // skip is never a silent drop.
    const st = lstatSync(caller);
    if (!st.isFile() || st.size > CALLER_MAX_BYTES) return undefined;
    const hash = sha256(readFileSync(caller));
    const callersRoot = join(sidecarDir, 'callers');
    const dest = join(callersRoot, caller.replace(/^([A-Za-z]:)?[\\/]/, ''));
    // Caller paths are agent-authored: '..' segments must not normalize the
    // copy outside the sidecar. The hash still rides in callerHashes, so a
    // skipped copy never becomes a silent drop at drift-check time.
    const rel = relative(callersRoot, dest);
    if (rel.startsWith('..') || isAbsolute(rel)) return hash;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(caller, dest);
    return hash;
  } catch {
    return undefined;
  }
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
    try {
      const existing = loadSidecar(sidecarDir);
      for (const caller of callerPaths) {
        if (existing.callerNames.includes(caller)) continue;
        existing.callerNames.push(caller);
        // An unreadable caller is recorded by name only.
        const hash = recordCaller(sidecarDir, caller);
        if (hash !== undefined) existing.callerHashes[caller] = hash;
      }
      writeFileSync(existingPath, JSON.stringify(existing, null, 2), 'utf8');
      return existing;
    } catch {
      // A capture killed mid-write leaves a truncated sidecar.json; without
      // this fall-through the remedy loadSidecar names — re-run snapshot,
      // which Step 4 does to extend the caller set — re-enters this same
      // branch and throws forever. A fresh capture rewrites the file, which
      // is all the recovery the corrupted one allows.
    }
  }

  const probe = probeGit(
    rootAbs,
    ['rev-parse', '--show-toplevel'],
    GIT_TIMEOUT_MS,
  );
  const top = probe.ok ? probe.out : null;
  const meta: SidecarMeta = {
    capturedAt: new Date().toISOString(),
    noVcs: top === null,
  };
  if (!probe.ok && !probe.notRepo) {
    meta.vcsProbeFailed = true;
  }
  const captureDegraded: Array<'diff' | 'untracked'> = [];
  if (top !== null) {
    meta.headSha = git(rootAbs, ['rev-parse', 'HEAD'])?.trim();
    const subtree = subtreeHashAt(rootAbs, top.trim());
    if (subtree) meta.subtreeHash = subtree;
    // Tracked and staged changes, path-scoped so the sidecar never carries
    // unrelated dirty content from elsewhere in the repository.
    const diff = git(rootAbs, ['diff', 'HEAD', '--', rootAbs]);
    if (diff === null) {
      captureDegraded.push('diff');
    } else if (diff.length > 0) {
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
    if (others === null) {
      captureDegraded.push('untracked');
    } else {
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
        try {
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(src, dest);
        } catch {
          // A file that vanishes between the listing and its copy is
          // skipped; the capture degrades instead of aborting.
        }
      }
    }
  }

  // Object.create(null): walked names are filesystem-controlled — a file
  // named `__proto__` must get a baseline like any other.
  const hashes: Record<string, string> = Object.create(null);
  for (const file of [...plan.subjectFiles, ...plan.testCorpus]) {
    try {
      hashes[file.path] = sha256(readFileSync(join(rootAbs, file.path)));
    } catch {
      // A file that vanishes between plan and capture is reported deleted
      // at the first checkpoint: the absence is the signal.
    }
  }

  const callerHashes: Record<string, string> = Object.create(null);
  for (const caller of callerPaths) {
    // An unreadable caller is recorded by name only.
    const hash = recordCaller(sidecarDir, caller);
    if (hash !== undefined) callerHashes[caller] = hash;
  }

  if (captureDegraded.length > 0) meta.captureDegraded = captureDegraded;
  const sidecar: Sidecar = {
    meta,
    hashes,
    callerHashes,
    callerNames: [...new Set(callerPaths)],
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
  /** Walked files the plan enumerates that are now missing — present at
   *  capture or vanished before it. */
  deletedFiles: string[];
  /** New files under the audited path matching the enumerated sets. */
  newFiles: string[];
  /** Registered callers whose content hash moved. */
  driftedCallers: string[];
  /** HEAD moved with content unchanged everywhere — fires no stop. */
  headMoved: boolean;
  subtreeMoved: boolean;
  /** The git probe failed, so "not moved" cannot be claimed: git() returns
   *  null on any failure, and without a marker a mid-run commit would read
   *  as definitively absent. */
  headUnknown?: boolean;
  subtreeUnknown?: boolean;
}

export function loadSidecar(sidecarDir: string): Sidecar {
  const file = join(sidecarDir, 'sidecar.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(
      `audit: cannot read sidecar ${file} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    return JSON.parse(raw) as Sidecar;
  } catch {
    throw new Error(
      `audit: sidecar ${file} is corrupt or truncated — re-run \`qwen audit snapshot\`.`,
    );
  }
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
    const baseline = Object.hasOwn(sidecar.hashes, file.path)
      ? sidecar.hashes[file.path]
      : undefined;
    const abs = join(rootAbs, file.path);
    if (!existsSync(abs)) {
      // A plan-enumerated file that is gone — whether or not it carried a
      // capture baseline — is drift the orchestrator must see.
      deletedFiles.push(file.path);
      continue;
    }
    let current: string;
    try {
      current = sha256(readFileSync(abs));
    } catch {
      // Unreadable or replaced by a directory since the capture: content
      // that can no longer be aligned against the baseline is drift.
      driftedFiles.push(file.path);
      continue;
    }
    if (baseline === undefined) {
      newFiles.push(file.path);
    } else if (current !== baseline) {
      driftedFiles.push(file.path);
    }
  }

  const driftedCallers: string[] = [];
  for (const caller of sidecar.callerNames) {
    const baseline = Object.hasOwn(sidecar.callerHashes, caller)
      ? sidecar.callerHashes[caller]
      : undefined;
    if (!existsSync(caller)) {
      driftedCallers.push(caller);
      continue;
    }
    // A name without a baseline was unreadable at capture — content that
    // (re)appears there cannot be aligned against anything, so it drifts.
    if (baseline === undefined) {
      driftedCallers.push(caller);
      continue;
    }
    try {
      if (sha256(readFileSync(caller)) !== baseline) {
        driftedCallers.push(caller);
      }
    } catch {
      driftedCallers.push(caller);
    }
  }

  let headMoved = false;
  let subtreeMoved = false;
  let headUnknown = false;
  let subtreeUnknown = false;
  // A FAILED capture-time probe re-arms the git drift checks: git may have
  // recovered by checkpoint time, and a definitive not-a-worktree capture
  // has nothing to re-probe.
  if (!sidecar.meta.noVcs || sidecar.meta.vcsProbeFailed) {
    const head = git(rootAbs, ['rev-parse', 'HEAD'])?.trim();
    if (head === undefined || sidecar.meta.headSha === undefined) {
      headUnknown = true;
    } else {
      headMoved = head !== sidecar.meta.headSha;
    }
    if (sidecar.meta.subtreeHash !== undefined) {
      const top = git(rootAbs, ['rev-parse', '--show-toplevel']);
      if (top === null) {
        subtreeUnknown = true;
      } else {
        const subtree = subtreeHashAt(rootAbs, top.trim());
        if (subtree === undefined) subtreeUnknown = true;
        else subtreeMoved = subtree !== sidecar.meta.subtreeHash;
      }
    }
  }

  const report: DriftReport = {
    driftedFiles,
    deletedFiles,
    newFiles,
    driftedCallers,
    headMoved,
    subtreeMoved,
  };
  if (headUnknown) report.headUnknown = true;
  if (subtreeUnknown) report.subtreeUnknown = true;
  return report;
}
