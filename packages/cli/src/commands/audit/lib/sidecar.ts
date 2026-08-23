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
//
// THREAT MODEL, and an accepted limit. Every read and write in this file is
// hardened against a hostile audited tree — no symlink is followed, no FIFO
// can hang a capture, no agent-named path escapes its containment, and no
// repository config gets to run a program. What the sidecar does NOT have is
// tamper EVIDENCE: it carries no signature, and by default it lands inside
// the audited tree, which the audit's own agents can write. It therefore
// detects accidental drift, not a module actively hiding its tracks. That
// limit is accepted and disclosed in every report header; a run auditing
// genuinely untrusted code lands its artifacts outside the repository (the
// guard's fallbackRoot), which is what the local-only guard already offers.

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  gitToplevelOf,
  isSecretName,
  probeGit,
  runGit,
  type FilesPlan,
} from './files-plan.js';
import {
  AUDIT_READ_MAX_BYTES,
  readFdCapped,
  readGuarded,
  streamSha256,
  writeFileGuarded,
} from './safe-read.js';

/** Callers are agent-authored and read whole into the sidecar: bound the
 *  read so a pathological path cannot OOM the capture. The same bound is the
 *  hash's, so a caller that is too big to archive is also too big to spend
 *  minutes hashing at every drift checkpoint. */
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
  let rel: string;
  try {
    rel = relative(realpathSync(toplevel), realpathSync(rootAbs))
      .split(sep)
      .join('/');
  } catch {
    // A TOCTOU delete/rename degrades to "no baseline" like a failed
    // probe, never a raw ENOENT out of the handler.
    return undefined;
  }
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
  /** A corrupt/truncated sidecar forced a fresh MID-RUN capture: the
   *  run-start baseline was reset and any drift before the re-capture is
   *  invisible — the skill stops on it like headUnknown. */
  recaptured?: string;
  /** HEAD had no commit at capture (git init without a commit, an orphan
   *  branch): drift-check treats "still unborn" as definitively unmoved
   *  instead of headUnknown, and the first landing commit as headMoved. */
  headUnborn?: boolean;
}

/** Registered callers the policy refused, by absolute path. They stay OUT of
 *  callerNames — a refused caller is not watched, because watching it would
 *  require the content read the refusal exists to prevent — and the skill
 *  surfaces them in the report header's walks record. */
export interface CallerRefusalRecord {
  caller: string;
  reason: CallerRefusal;
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
  /** Registered callers the scope/secret policy refused. Recorded so the
   *  refusal is visible in the archive and the report, never silent. */
  refusedCallers?: CallerRefusalRecord[];
}

/** Whether a registered caller may be content-read at all.
 *
 *  The caller channel is the one path into this module that takes an
 *  arbitrary absolute path from an agent mid-run — after the confirmation,
 *  so no gate the user saw covers it — and then content-COPIES it into the
 *  persistent sidecar and content-READS it at anchor resolution. Without a
 *  policy it is a hole straight through the walk's own invariants: the walk
 *  never reads a credential-shaped file and never leaves the audited
 *  repository, and a registration would do both.
 *
 *  Two rules, both mirroring the walk: nothing credential-shaped, and
 *  nothing outside the audited REPOSITORY. The repository — not the audited
 *  path — is the boundary because reaching outside the audited path is the
 *  whole point of the caller channel (1c traces the module's callers, which
 *  live elsewhere in the repo). Outside a worktree there is no repository to
 *  bound anything with, so containment does not apply there and the name
 *  rule stands alone; the sidecar records what it admitted either way. */
export type CallerRefusal = 'secret-shaped' | 'out-of-repo';

export function callerRefusal(
  caller: string,
  repoRoot: string | undefined,
): CallerRefusal | undefined {
  const normalized = caller.replace(/\\/g, '/');
  if (isSecretName(normalized)) return 'secret-shaped';
  if (repoRoot === undefined) return undefined;
  let real: string;
  try {
    real = realpathSync(caller);
  } catch {
    // Unresolvable (missing, or a dangling link): nothing to content-read,
    // and it cannot be proven contained. The name still rides in the
    // refusal record, so the registration is never silently dropped.
    return 'out-of-repo';
  }
  const rel = relative(repoRoot, real);
  const contained = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  return contained ? undefined : 'out-of-repo';
}

/** Hash-and-copy one registered caller. Callers arrive absolute and
 *  platform-native; the copy is keyed by the path with its root prefix
 *  turned into a path SEGMENT (a Windows `C:` becomes a `C` directory), so
 *  the join below the sidecar is valid on every platform and two callers
 *  that differ only in their drive letter cannot overwrite each other.
 *  Returns the hash, or undefined when the caller vanished or was
 *  unreadable — the name is still recorded by the caller. */
function recordCaller(sidecarDir: string, caller: string): string | undefined {
  // Stream-hash through a guarded open: callers are agent-authored — a
  // writer-less FIFO must not hang, a symlink must not baseline its target,
  // and the hash is bounded at the same cap as the copy, because it re-runs
  // synchronously at EVERY drift checkpoint (an unbounded one turns a large
  // caller into minutes of hashing per checkpoint).
  const hash = streamSha256(caller, CALLER_MAX_BYTES);
  if (hash === undefined) return undefined;
  const callersRoot = join(sidecarDir, 'callers');
  // `C:/x/y` → `C/x/y`, `/x/y` → `x/y`: the drive letter survives as a
  // segment instead of being stripped, so `C:/a/b.ts` and `D:/a/b.ts` no
  // longer collide on one archive path with the later copy winning.
  const dest = join(
    callersRoot,
    caller
      .replace(/\\/g, '/')
      .replace(/^([A-Za-z]):\//, '$1/')
      .replace(/^\//, ''),
  );
  // Caller paths are agent-authored: '..' segments must not normalize the
  // copy outside the sidecar. The hash still rides in callerHashes, so a
  // skipped copy never becomes a silent drop at drift-check time.
  const rel = relative(callersRoot, dest);
  if (rel.startsWith('..') || isAbsolute(rel)) return hash;
  // The copy is best-effort and capped — a multi-hundred-MB caller must
  // not exhaust the sidecar disk — and a failed copy (ENOSPC, a squatter,
  // oversize) must not discard the hash: that would turn a transient
  // error into permanent false drift.
  try {
    mkdirSync(dirname(dest), { recursive: true });
    if (!copyDestContained(dest, sidecarDir)) {
      throw new Error('copy destination escapes the sidecar root');
    }
    copyGuarded(caller, dest, CALLER_MAX_BYTES);
  } catch {
    // copy skipped: the hash stays in callerHashes.
  }
  return hash;
}

/** The copy destination's parent must RESOLVE inside the sidecar root:
 *  writeFileGuarded's O_NOFOLLOW guards only the final component, so a
 *  symlinked INTERMEDIATE directory under the sidecar (`callers`,
 *  `untracked/<dir>`) would otherwise carry the copy out of containment.
 *  Re-checked at every copy — the adversary writes the tree the capture
 *  fans out over, so a containment answer from capture start is stale by
 *  the time the extend re-run writes. */
function copyDestContained(dest: string, sidecarDir: string): boolean {
  let realParent: string;
  let realRoot: string;
  try {
    realParent = realpathSync(dirname(dest));
    realRoot = realpathSync(sidecarDir);
  } catch {
    return false;
  }
  const rel = relative(realRoot, realParent);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Open-and-copy with the same FIFO/regular-file/size discipline the other
 *  content reads apply: the fd-based gate covers the check-then-use window
 *  a stat-then-copy pair leaves open. */
function copyGuarded(src: string, dest: string, maxBytes: number): void {
  const fd = openSync(
    src,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) {
      throw new Error('not a copyable regular file');
    }
    // Bounded like readGuarded: growth between the gate and the read must
    // not land a copy larger than maxBytes. The DESTINATION gets the same
    // discipline as the source — it sits under a sidecar dir that may live
    // inside the audited tree.
    writeFileGuarded(
      dest,
      readFdCapped(fd, Math.min(st.size, maxBytes)),
      'a sidecar copy',
    );
  } finally {
    closeSync(fd);
  }
}

/** Tracked and staged changes, path-scoped so the sidecar never carries
 *  unrelated dirty content from elsewhere in the repository. Returns false
 *  when the probe fails without an answer. On an UNBORN HEAD `git diff
 *  HEAD` fails definitively (exit 128) and the arm would stay degraded for
 *  the whole run — every extend re-run retrying the same certain failure;
 *  the index-vs-worktree diff captures the same dirty state there. */
function captureDiffArm(
  rootAbs: string,
  sidecarDir: string,
  headUnborn: boolean,
): boolean {
  // :(literal): the audited directory name is user/repository-controlled —
  // a raw pathspec fnmatch-expands */[...]/? in it and pulls sibling dirt
  // into the capture (the magic already used by files-plan's ls-files).
  const literalRoot = `:(literal)${rootAbs}`;
  // --no-ext-diff and --no-textconv are the load-bearing flags here, not
  // formatting preferences: `git diff` otherwise RUNS programs named by the
  // AUDITED repository's own config — `diff.<driver>.command` (an external
  // diff driver) and `diff.<driver>.textconv` (a content filter), both
  // selected per path by that repository's .gitattributes. Auditing a
  // hostile checkout would execute its code as the auditor, at capture
  // time, before any finding exists. The two flags refuse both channels;
  // gitEnv's GIT_-family scrub covers the env side.
  const diffFlags = ['--no-ext-diff', '--no-textconv'];
  const diff = git(
    rootAbs,
    headUnborn
      ? ['diff', ...diffFlags, '--', literalRoot]
      : ['diff', ...diffFlags, 'HEAD', '--', literalRoot],
  );
  if (diff === null) return false;
  if (diff.length > 0) {
    writeFileGuarded(join(sidecarDir, 'diff.patch'), diff, 'the capture diff');
  }
  return true;
}

/** Untracked content copies: `git ls-files --others` WITHOUT
 *  --exclude-standard — the raw listing covers the gitignored-untracked
 *  class — filtered to the files the plan enumerates, so the capture
 *  inherits the enumeration's directory-name exclusions. Returns false
 *  when the listing fails or every enumerated copy does. */
function captureUntrackedArm(
  plan: FilesPlan,
  sidecarDir: string,
  rootAbs: string,
): boolean {
  const enumerated = new Set([
    ...plan.subjectFiles.map((f) => f.path),
    ...plan.testCorpus.map((f) => f.path),
  ]);
  const others = git(rootAbs, [
    'ls-files',
    '-z',
    '--others',
    '--',
    `:(literal)${rootAbs}`,
  ]);
  if (others === null) return false;
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
  let failed = 0;
  for (const rel of [...names].sort()) {
    if (!enumerated.has(rel)) continue;
    const src = join(rootAbs, rel);
    const dest = join(sidecarDir, 'untracked', rel);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      if (!copyDestContained(dest, sidecarDir)) {
        throw new Error('copy destination escapes the sidecar root');
      }
      // Open-gated copy: a writer-less FIFO swapped in between the
      // listing and the copy must not hang, and an oversize subject must
      // not exhaust the sidecar disk (every other read in this module
      // caps at AUDIT_READ_MAX_BYTES).
      copyGuarded(src, dest, AUDIT_READ_MAX_BYTES);
    } catch {
      // A file that vanishes, swaps to a non-regular shape, or exceeds
      // the cap between the listing and its copy is skipped; the capture
      // degrades instead of aborting.
      failed++;
    }
  }
  // ANY failed copy degrades the arm, exactly like a failed listing: a
  // silently partial sidecar must not publish as complete. (Readable
  // failures still received hash baselines above the arm, so drift
  // alignment survives — the marker covers the archived evidence set.)
  return failed === 0;
}

/** Write sidecar.json through the fd-based guard.
 *
 *  An lstat-then-write pair would be a check-then-use race, and this write
 *  is exactly where a race pays: the extend write runs MID-fan-out, with the
 *  sidecar's default landing inside the audited tree, so the audited agent
 *  can swap the path between the check and the open and redirect the whole
 *  sidecar JSON — or plant a writer-less FIFO and hang every retry of the
 *  remedy loadSidecar's own error prescribes. The gate has to be the open. */
function writeSidecarJson(path: string, sidecar: Sidecar): void {
  writeFileGuarded(path, JSON.stringify(sidecar, null, 2), 'the sidecar');
}

/** Union the refusal records of an extend re-run with the ones already
 *  archived: a caller refused at capture stays refused in the record even if
 *  a later re-run does not name it again. */
function mergeRefusals(
  existing: CallerRefusalRecord[] | undefined,
  fresh: CallerRefusalRecord[],
): CallerRefusalRecord[] | undefined {
  const byPath = new Map<string, CallerRefusalRecord>();
  for (const record of existing ?? []) byPath.set(record.caller, record);
  for (const record of fresh) byPath.set(record.caller, record);
  return byPath.size === 0 ? undefined : [...byPath.values()];
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

  // The containment boundary for agent-nominated callers, probed once.
  const repoRoot = gitToplevelOf(rootAbs);
  const refusedCallers: CallerRefusalRecord[] = [];
  const admittedCallers: string[] = [];
  for (const caller of callerPaths) {
    const reason = callerRefusal(caller, repoRoot);
    if (reason === undefined) admittedCallers.push(caller);
    else refusedCallers.push({ caller, reason });
  }

  // A re-run with --callers (1c's registration lands mid-fan-out) preserves
  // the run-start captures and only extends the caller set — the walked-file
  // baseline must stay the run-start content.
  let recaptured: string | undefined;
  const existingPath = join(sidecarDir, 'sidecar.json');
  if (existsSync(existingPath)) {
    try {
      const existing = loadSidecar(sidecarDir);
      existing.refusedCallers = mergeRefusals(
        existing.refusedCallers,
        refusedCallers,
      );
      for (const caller of admittedCallers) {
        // A name WITHOUT a hash was unreadable at capture — the transient
        // class is retryable here (this re-run is the only command that
        // can retry it), so retry instead of skipping forever into
        // phantom drift at every checkpoint.
        if (
          existing.callerNames.includes(caller) &&
          Object.hasOwn(existing.callerHashes, caller)
        ) {
          continue;
        }
        if (!existing.callerNames.includes(caller)) {
          existing.callerNames.push(caller);
        }
        const hash = recordCaller(sidecarDir, caller);
        if (hash !== undefined) existing.callerHashes[caller] = hash;
      }
      // An arm that degraded transiently at capture can be repaired here —
      // this re-run is the only command that can retry it. The walked-file
      // baselines stay preserved; only the failed arms run again. A
      // vcsProbeFailed capture skipped BOTH arms AND the HEAD/subtree
      // baselines: when the probe has recovered, re-capture those too —
      // clearing vcsProbeFailed while noVcs stayed true would silence the
      // re-arm (the unsafe direction).
      const probeFailed = existing.meta.vcsProbeFailed === true;
      const degraded =
        existing.meta.captureDegraded !== undefined &&
        existing.meta.captureDegraded.length > 0;
      // A capture whose toplevel probe SUCCEEDED but whose `rev-parse HEAD`
      // failed transiently sets neither flag, so without this arm its
      // missing headSha is unrecoverable: every checkpoint reports
      // headUnknown, and the mid-run retry the skill documents can never
      // repair it — the run over-stops until someone deletes sidecar.json.
      const headMissing =
        !existing.meta.noVcs &&
        existing.meta.headSha === undefined &&
        existing.meta.headUnborn !== true;
      if (probeFailed || degraded || headMissing) {
        const probe = probeGit(
          rootAbs,
          ['rev-parse', '--show-toplevel'],
          GIT_TIMEOUT_MS,
        );
        if (probe.ok) {
          if (probeFailed || headMissing) {
            existing.meta.noVcs = false;
            existing.meta.vcsProbeFailed = undefined;
            const headProbe = probeGit(
              rootAbs,
              ['rev-parse', 'HEAD'],
              GIT_TIMEOUT_MS,
            );
            if (headProbe.ok) {
              existing.meta.headSha = headProbe.out.trim();
            } else if (headProbe.unborn) {
              const ref = git(rootAbs, ['symbolic-ref', 'HEAD']);
              if (ref !== null && ref.trim() !== '') {
                existing.meta.headUnborn = true;
              }
            }
            const subtree = subtreeHashAt(rootAbs, probe.out.trim());
            if (subtree) existing.meta.subtreeHash = subtree;
            // Establishing HEAD/subtree baselines HERE means they describe
            // repair time, not run start: whatever moved in the blind window
            // between the two is now invisible to every later checkpoint.
            // The corrupt-sidecar path flags exactly this; so must this one,
            // or the archive presents a mid-run capture as a run-start one.
            existing.meta.recaptured ??=
              'the git baselines could not be captured at run start and were ' +
              're-established mid-run — drift before that point is invisible';
          }
          const arms: Array<'diff' | 'untracked'> = probeFailed
            ? ['diff', 'untracked']
            : [...(existing.meta.captureDegraded ?? [])];
          const still: Array<'diff' | 'untracked'> = [];
          for (const arm of arms) {
            const ok =
              arm === 'diff'
                ? captureDiffArm(
                    rootAbs,
                    sidecarDir,
                    existing.meta.headUnborn === true,
                  )
                : captureUntrackedArm(plan, sidecarDir, rootAbs);
            if (!ok) still.push(arm);
          }
          existing.meta.captureDegraded = still.length > 0 ? still : undefined;
        }
      }
      writeSidecarJson(existingPath, existing);
      return existing;
    } catch {
      // A capture killed mid-write leaves a truncated sidecar.json; without
      // this fall-through the remedy loadSidecar names — re-run snapshot,
      // which Step 4 does to extend the caller set — re-enters this same
      // branch and throws forever. A fresh capture rewrites the file, which
      // is all the recovery the corrupted one allows — but it RESETS the
      // run-start baseline mid-run, so the fresh sidecar says so: drift
      // before the re-capture is invisible and the skill stops on it.
      recaptured =
        'the previous sidecar.json was corrupt or truncated — the run-start baseline was re-captured mid-run';
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
  if (recaptured !== undefined) meta.recaptured = recaptured;
  if (!probe.ok && !probe.notRepo) {
    meta.vcsProbeFailed = true;
  }
  const captureDegraded: Array<'diff' | 'untracked'> = [];
  if (top !== null) {
    const headProbe = probeGit(rootAbs, ['rev-parse', 'HEAD'], GIT_TIMEOUT_MS);
    if (headProbe.ok) {
      meta.headSha = headProbe.out.trim();
    } else if (headProbe.unborn) {
      // An unborn HEAD (git init without a commit, an orphan branch) is a
      // DEFINITIVE state, not an unknown one: the branch ref exists, so
      // record it and let the checkpoint treat "still unborn" as unmoved.
      // The definitive unborn fatal (exit 128 + unknown revision) is the
      // gate — a transient rev-parse failure on a BORN HEAD must not
      // record headUnborn; without it headSha stays undefined and the
      // checkpoint reports headUnknown instead of passing on the silence.
      const ref = git(rootAbs, ['symbolic-ref', 'HEAD']);
      if (ref !== null && ref.trim() !== '') meta.headUnborn = true;
    }
    const subtree = subtreeHashAt(rootAbs, top.trim());
    if (subtree) meta.subtreeHash = subtree;
    if (!captureDiffArm(rootAbs, sidecarDir, meta.headUnborn === true)) {
      captureDegraded.push('diff');
    }
    if (!captureUntrackedArm(plan, sidecarDir, rootAbs)) {
      captureDegraded.push('untracked');
    }
  }

  // Object.create(null): walked names are filesystem-controlled — a file
  // named `__proto__` must get a baseline like any other.
  const hashes: Record<string, string> = Object.create(null);
  for (const file of [...plan.subjectFiles, ...plan.testCorpus]) {
    // Guarded read: a writer-less FIFO swapped into a walked path must not
    // hang the capture. A null (vanished, non-regular, oversized) leaves
    // the file without a baseline — reported deleted at the first
    // checkpoint: the absence is the signal.
    const content = readGuarded(join(rootAbs, file.path), AUDIT_READ_MAX_BYTES);
    if (content !== null) hashes[file.path] = sha256(content);
  }

  const callerHashes: Record<string, string> = Object.create(null);
  for (const caller of admittedCallers) {
    // An unreadable caller is recorded by name only.
    const hash = recordCaller(sidecarDir, caller);
    if (hash !== undefined) callerHashes[caller] = hash;
  }

  if (captureDegraded.length > 0) meta.captureDegraded = captureDegraded;
  const sidecar: Sidecar = {
    meta,
    hashes,
    callerHashes,
    callerNames: [...new Set(admittedCallers)],
    uncoverableNames: plan.uncoverable.map((u) => u.path),
  };
  if (refusedCallers.length > 0) sidecar.refusedCallers = refusedCallers;
  writeSidecarJson(join(sidecarDir, 'sidecar.json'), sidecar);
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

/** Far beyond any honest sidecar JSON — the plan's gates bound the walked
 *  set this artifact scales with — far below an OOM: a planted multi-GB
 *  sidecar.json must hit the over-cap branch and the friendly re-run
 *  error, not memory. */
const SIDECAR_READ_MAX_BYTES = 64 * 1024 * 1024;

export function loadSidecar(sidecarDir: string): Sidecar {
  const file = join(sidecarDir, 'sidecar.json');
  // Guarded read: the sidecar path is orchestrator-handled — a writer-less
  // FIFO in its place must not hang every downstream command, and the
  // audited agent can swap the file, so the read stays size-bounded.
  const content = readGuarded(file, SIDECAR_READ_MAX_BYTES);
  if (content === null) {
    throw new Error(
      `audit: cannot read sidecar ${file} — re-run \`qwen audit snapshot\`.`,
    );
  }
  const raw = content.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `audit: sidecar ${file} is corrupt or truncated — re-run \`qwen audit snapshot\`.`,
    );
  }
  // Valid JSON is not yet a Sidecar: a wrong-shape file ({} / {"meta":{}})
  // must hit the same friendly corruption error, not crash driftCheck with
  // a raw TypeError.
  const isPlainRecord = (v: unknown): boolean =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (
    !isPlainRecord(parsed) ||
    !isPlainRecord((parsed as Record<string, unknown>)['meta']) ||
    !isPlainRecord((parsed as Record<string, unknown>)['hashes']) ||
    !isPlainRecord((parsed as Record<string, unknown>)['callerHashes']) ||
    !Array.isArray((parsed as Record<string, unknown>)['callerNames']) ||
    !Array.isArray((parsed as Record<string, unknown>)['uncoverableNames'])
  ) {
    throw new Error(
      `audit: sidecar ${file} is corrupt or truncated — re-run \`qwen audit snapshot\`.`,
    );
  }
  return parsed as Sidecar;
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
    // Guarded read: a writer-less FIFO swapped into a walked path must
    // not hang the checkpoint.
    const content = readGuarded(abs, AUDIT_READ_MAX_BYTES);
    if (content === null) {
      // Unreadable or replaced by a directory/FIFO since the capture:
      // content that can no longer be aligned against the baseline is
      // drift.
      driftedFiles.push(file.path);
      continue;
    }
    const current = sha256(content);
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
    // Stream-hash like recordCaller, under the same bound: the two must
    // hash identically or every checkpoint reports phantom drift.
    const current = streamSha256(caller, CALLER_MAX_BYTES);
    if (current === undefined || current !== baseline) {
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
    const headProbe = probeGit(rootAbs, ['rev-parse', 'HEAD'], GIT_TIMEOUT_MS);
    if (sidecar.meta.headUnborn) {
      if (headProbe.ok) {
        // A resolvable HEAD means the first commit landed.
        headMoved = true;
      } else if (!headProbe.unborn) {
        // A FAILED probe is not "still unborn": without the definitive
        // unborn fatal, a moved HEAD under a broken git would pass clean
        // over the silence. The born branch maps the identical failure to
        // headUnknown; the unborn sibling does the same.
        headUnknown = true;
      }
      // Unborn-at-checkpoint with no HEAD: "did not exist, still does not
      // exist" is definitively unmoved.
    } else if (!headProbe.ok || sidecar.meta.headSha === undefined) {
      headUnknown = true;
    } else {
      headMoved = headProbe.out.trim() !== sidecar.meta.headSha;
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
