/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Core logic for `qwen audit plan-files`: enumerate a directory of existing
// code into an audit plan, per docs/design/legacy-code-audit.md.
//
// This module is deliberately audit-owned: the design doc's reuse boundary
// has /audit importing nothing across command groups from commands/review/.
// The classification rules are re-expressed (not imported) because they
// diverge: vendor/ stays a subject here, test-shaped paths classify as test
// even under vendor/, and the build-output / dependency-install directory
// class is excluded at enumeration rather than classified generated.

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isGitIgnored, Storage } from '@qwen-code/qwen-code-core';
import { safeTarget } from '../../../utils/paths.js';

// --- Pinned constants (docs/design/legacy-code-audit.md) --------------------

/** Hard topology gate, subject arm: every classified kind except test. */
export const SUBJECT_LINES_GATE = 9_000;
/** Hard topology gate, test arm — applies only on tiers that run Agent 5. */
export const TEST_LINES_GATE = 18_000;
/** Low tier's own size gate (unmeasured first cut). */
export const LOW_SUBJECT_LINES_GATE = 2_000;
/** Medium/high priced-plan token ceiling, checked against the estimate top. */
export const TOKEN_CAP = 60_000_000;
/** The estimate's top is its floor times this headroom — the same factor the
 *  cap derives from, so the cap check reduces to "priced cost ≤ the largest
 *  measured arm". */
export const ESTIMATE_HEADROOM = 1.3;
/** Two-rate decomposition of the two measured fan-out runs (exact fit, n=2).
 *  Quoted to the precision the fit requires: coarser rounding prices the
 *  hooks calibration module over the cap it must pass. */
export const SUBJECT_TOKENS_PER_LINE = 2_607;
export const TEST_TOKENS_PER_LINE = 1_457;
/** A line longer than this cannot be returned whole by one read_file call
 *  (the default truncate-tool-output threshold); its tail is unreachable. */
export const MAX_LINE_CHARS = 25_000;
/** Reserved scratch-name prefix for verification probes' sibling copies.
 *  Stable and documented so residue from a killed run is recognizable. */
export const AUDIT_SCRATCH_PREFIX = '.qwen-audit-scratch-';
/** Low tier: findings cap (mirrors /review low), the angle floor, and the
 *  sweep floor, re-anchored from diff lines to subject lines. */
export const LOW_FINDING_CAP = 10;
export const LOW_ANGLE_FLOOR_LINES = 60;
export const LOW_SWEEP_FLOOR_LINES = 25;
/** 1c's per-node depth quota (unmeasured first cut). */
export const DEEP_READ_QUOTA = 10;
/** High tier: reverse-audit rounds fan out over file-group partitions sized
 *  at /review's chunk constant (an unmeasured first cut here), with this
 *  many rounds as the hard cap. */
export const FILE_GROUP_LINES = 400;
export const MAX_REVERSE_ROUNDS = 5;
/** Event-module detection heuristic (unmeasured first cut): enough
 *  emit/dispatch/subscribe-shaped call sites spread over enough files. */
export const EVENT_CALL_MIN = 8;
export const EVENT_FILE_MIN = 2;
/** Files above this size skip event detection — the heuristic stays bounded
 *  (the read it feeds is 1c's budget, not the enumeration). */
export const EVENT_SCAN_MAX_CHARS = 1_000_000;

const GIT_TIMEOUT_MS = 5_000;

// --- Classification (re-expressed from plan-diff's four kinds) --------------

export type PathKind = 'source' | 'test' | 'generated' | 'docs';

const TEST_RE =
  /(^|\/)(__tests__|__snapshots__|__mocks__|tests?|spec|integration-tests|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|(^|\/)src\/test\//;

/** The file-name clauses only: the directory clause of plan-diff's
 *  GENERATED_RE is handled at enumeration (excluded dirs / vendor rules),
 *  not here — vendor/ stays a subject, so it cannot classify generated. */
const GENERATED_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock(b)?|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock|NOTICES\.txt)$|\.snap$|\.min\.(js|css)$|\.map$/;

const DOCS_EXT = String.raw`\.(md|mdx|rst|txt|adoc)$`;
const DOCS_RE = new RegExp(
  `(^|/)(docs|doc|documentation|website)/.*${DOCS_EXT}` + `|^[^/]+${DOCS_EXT}`,
);

/** Classify an audit-relative POSIX path. Order matters: a generated
 *  snapshot under a test directory is generated, not a test. Test-shaped
 *  paths classify as test even under vendor/ (the vendor override). */
export function classifyAuditPath(path: string): PathKind {
  if (GENERATED_RE.test(path)) return 'generated';
  if (TEST_RE.test(path)) return 'test';
  if (DOCS_RE.test(path)) return 'docs';
  return 'source';
}

const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|pdf|zip|gz|tar|woff2?|ttf|otf|mp4|mov|wasm|exe|dll|so|dylib|o|obj|a|bin|pyc|class|jar)$/i;

/** Credential-shaped names are enumerated but NEVER content-read: the walk
 *  deliberately ignores .gitignore, so the gitignored-secret class lands in
 *  scope — recording the names surfaces them at the confirmation while no
 *  content copy, walker read, or model payload ever sees them. */
const SECRET_FILE_RE =
  /(^|\/)(\.env|\.env\.[^/]+|\.npmrc|\.netrc|credentials\.json|id_rsa[^/]*|[^/]+\.(pem|key|p12|pfx|keystore|tfstate))$/i;

// --- Enumeration -------------------------------------------------------------

/** Excluded from enumeration by directory name anywhere under the audited
 *  path, including under vendor/ and the path root: dependency installs,
 *  tooling output, and the tool's own artifact class. Never audit subjects. */
const ALWAYS_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  '.venv',
  '__pycache__',
  'coverage',
  '.next',
  'out',
  '.gradle',
  'obj',
  'Pods',
  '.tox',
  '.qwen',
  'venv',
  'env',
  'virtualenv',
]);
/** Build output: excluded everywhere except under vendor/, where a published
 *  package ships its runnable code in dist/ and the path choice is
 *  authoritative. `bundle` is excluded in both positions: Bundler installs
 *  (vendor/bundle) and JS-bundler output (top-level bundle/) are both
 *  third-party lines, never audit subjects. */
const BUILD_OUTPUT_DIRS = new Set(['dist', 'build', 'bundle']);

function isExcludedDirName(name: string, underVendor: boolean): boolean {
  if (ALWAYS_EXCLUDED_DIRS.has(name)) return true;
  if (name === 'bundle' && underVendor) return true; // vendor/bundle (Bundler)
  if (BUILD_OUTPUT_DIRS.has(name) && !underVendor) return true;
  return false;
}

export type UncoverableReason =
  | 'over-cap-lines'
  | 'non-text'
  | 'secret-shaped'
  | 'symlink'
  | 'non-regular'
  | 'unreadable';

export interface AuditFileEntry {
  /** Relative to the audited root, POSIX separators. */
  path: string;
  kind: PathKind;
  lines: number;
  chars: number;
}

export interface UncoverableEntry {
  path: string;
  kind: PathKind;
  reason: UncoverableReason;
  /** Counted toward the gate arms; 0 for entries that carry no code lines
   *  (never content-read, or non-text). */
  lines: number;
}

export interface ResidueEntry {
  path: string;
  mtimeMs: number;
}

export interface EventDetection {
  detected: boolean;
  callSites: number;
  files: number;
}

export interface AuditCollection {
  /** Walked audit subjects: every classified kind except test, minus the
   *  uncoverable set. */
  subjects: AuditFileEntry[];
  /** Walked test files — Agent 5's corpus, never audit subjects. */
  testCorpus: AuditFileEntry[];
  /** Enumerated but never walked: recorded by name, content never handed to
   *  an agent. Symlinks and non-regular files are never even opened. */
  uncoverable: UncoverableEntry[];
  /** Directories excluded by name, audit-relative POSIX paths. */
  excludedDirs: string[];
  /** Files matching the reserved scratch prefix — possible residue from a
   *  killed prior run. They stay walked subjects; the plan cannot verify
   *  provenance, so it surfaces them and keeps them in scope by default. */
  residue: ResidueEntry[];
  eventDetection: EventDetection;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

interface WalkResult {
  files: string[];
  excludedDirs: string[];
  structuralUncoverable: Array<{
    path: string;
    reason: 'symlink' | 'non-regular' | 'unreadable';
  }>;
}

/** Recursive filesystem walk — not `git ls-files`: vendored code arrives
 *  uncommitted and gitignored, and ls-files enumerates zero files on exactly
 *  that target. Symlinks are never followed (lstat); directory symlinks are
 *  never descended, so a self-link cannot hang the walk. */
export function walkAuditTree(rootAbs: string): WalkResult {
  const files: string[] = [];
  const excludedDirs: string[] = [];
  const structuralUncoverable: WalkResult['structuralUncoverable'] = [];
  // The vendor context derives from the whole path, not just the root's own
  // name: starting the walk at vendor/bundle or vendor/pkg/dist must apply
  // the same rules a walk that DESCENDS into vendor/ would apply there, or
  // the verdicts depend on the start point (gems walked at one start,
  // dist/build kept at another).
  const rootUnderVendor = toPosix(rootAbs).split('/').includes('vendor');
  if (isExcludedDirName(basename(rootAbs), rootUnderVendor)) {
    return { files, excludedDirs: ['.'], structuralUncoverable };
  }
  const walk = (dirAbs: string, rel: string, underVendor: boolean): void => {
    let entries: string[];
    try {
      entries = readdirSync(dirAbs);
    } catch {
      // One unreadable directory must not abort the whole enumeration:
      // record it and continue with the rest of the tree.
      structuralUncoverable.push({
        path: rel === '' ? '.' : rel,
        reason: 'unreadable',
      });
      return;
    }
    for (const entry of entries) {
      const entryAbs = join(dirAbs, entry);
      const childRel = rel === '' ? entry : `${rel}/${entry}`;
      let stat: Stats;
      try {
        stat = lstatSync(entryAbs);
      } catch {
        // An entry that vanishes between readdir and lstat — or a directory
        // readable but not searchable — records as uncoverable, same as an
        // unreadable directory: enumeration never aborts on one entry.
        structuralUncoverable.push({ path: childRel, reason: 'unreadable' });
        continue;
      }
      if (stat.isSymbolicLink()) {
        structuralUncoverable.push({ path: childRel, reason: 'symlink' });
        continue;
      }
      if (entry === '.git' && !stat.isDirectory()) {
        // A linked worktree's .git is a regular file (the gitdir: pointer);
        // structural metadata, never an audit subject.
        continue;
      }
      if (stat.isDirectory()) {
        if (isExcludedDirName(entry, underVendor)) {
          excludedDirs.push(childRel);
          continue;
        }
        walk(entryAbs, childRel, underVendor || entry === 'vendor');
        continue;
      }
      if (!stat.isFile()) {
        // FIFO / socket / device: a read-open on a writer-less FIFO blocks
        // indefinitely and no deadline covers enumeration reads.
        structuralUncoverable.push({ path: childRel, reason: 'non-regular' });
        continue;
      }
      files.push(childRel);
    }
  };
  walk(rootAbs, '', rootUnderVendor);
  files.sort();
  excludedDirs.sort();
  return { files, excludedDirs, structuralUncoverable };
}

// A continuing identifier must start uppercase: past-tense and stem-prefix
// calls (`fired(`, `emitted(`) are not event-API call sites.
const EVENT_CALL_RE =
  /\b(?:emit|dispatch|publish|subscribe|addEventListener|fire|trigger)(?:[A-Z]\w*)?\s*\(|\.on\s*\(|\.once\s*\(/g;

/** Comments and string literals mention keywords without calling anything;
 *  matching them steers 1c's deep-read budget at nonexistent events. The
 *  strip is a heuristic (the detection is one), not a language parser. */
function stripCommentsAndStrings(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(
      /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
      '""',
    );
}

interface FileMeasure {
  lines: number;
  chars: number;
  maxLine: number;
  hasNul: boolean;
}

const MEASURE_CHUNK_CHARS = 64 * 1024;

/** Measure a file WITHOUT materializing it: chunked reads count lines,
 *  chars, the longest line, and NUL presence in O(chunk) memory, so a
 *  multi-hundred-MB fixture cannot OOM the enumeration. Returns null when
 *  the file vanished or is unreadable. */
function measureFile(abs: string): FileMeasure | null {
  let fd: number;
  try {
    fd = openSync(abs, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(MEASURE_CHUNK_CHARS);
    let chars = 0;
    let newlines = 0;
    let maxLine = 0;
    let currentLine = 0;
    let hasNul = false;
    let lastWasNewline = false;
    let read: number;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) {
      // A multi-byte character split across chunks decodes to a replacement
      // character: +-1 on a line length, never on newline/NUL detection.
      const text = buf.toString('utf8', 0, read);
      chars += text.length;
      if (text.includes('\0')) hasNul = true;
      for (const ch of text) {
        if (ch === '\n') {
          newlines++;
          if (currentLine > maxLine) maxLine = currentLine;
          currentLine = 0;
        } else {
          currentLine++;
        }
      }
      lastWasNewline = text.endsWith('\n');
    }
    if (currentLine > maxLine) maxLine = currentLine;
    // wc-style: a trailing newline terminates the last line, it does not add
    // one.
    const lines = chars === 0 ? 0 : newlines + (lastWasNewline ? 0 : 1);
    return { lines, chars, maxLine, hasNul };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Enumerate, classify, and measure every file under rootAbs. */
export function collectAuditFiles(rootAbs: string): AuditCollection {
  const { files, excludedDirs, structuralUncoverable } = walkAuditTree(rootAbs);
  const subjects: AuditFileEntry[] = [];
  const testCorpus: AuditFileEntry[] = [];
  const uncoverable: UncoverableEntry[] = [];
  const residue: ResidueEntry[] = [];
  let eventCallSites = 0;
  const eventFiles = new Set<string>();

  for (const item of structuralUncoverable) {
    uncoverable.push({
      path: item.path,
      kind: classifyAuditPath(item.path),
      reason: item.reason,
      lines: 0,
    });
  }

  for (const relPath of files) {
    const kind = classifyAuditPath(relPath);
    const entryAbs = join(rootAbs, relPath);
    if (basename(relPath).startsWith(AUDIT_SCRATCH_PREFIX)) {
      try {
        residue.push({ path: relPath, mtimeMs: statSync(entryAbs).mtimeMs });
      } catch {
        // Vanished between the walk and the stat; the content read below
        // records it like any other vanished file.
      }
    }
    // Secret-shaped names are recorded by name and never content-read.
    if (SECRET_FILE_RE.test(relPath)) {
      uncoverable.push({
        path: relPath,
        kind,
        reason: 'secret-shaped',
        lines: 0,
      });
      continue;
    }
    // Binary-extension files are never opened: nothing downstream reads
    // them, and the content can be arbitrarily large.
    if (BINARY_EXT_RE.test(relPath)) {
      uncoverable.push({ path: relPath, kind, reason: 'non-text', lines: 0 });
      continue;
    }
    const measured = measureFile(entryAbs);
    if (measured === null) {
      uncoverable.push({ path: relPath, kind, reason: 'unreadable', lines: 0 });
      continue;
    }
    // NUL is scanned over the WHOLE content — a windowed scan let late-NUL
    // binaries escape — and non-text entries record zero lines: raw 0x0A
    // bytes are not code lines and must not steer the gate arms.
    if (measured.hasNul) {
      uncoverable.push({ path: relPath, kind, reason: 'non-text', lines: 0 });
      continue;
    }
    if (measured.maxLine > MAX_LINE_CHARS) {
      uncoverable.push({
        path: relPath,
        kind,
        reason: 'over-cap-lines',
        lines: measured.lines,
      });
      continue;
    }
    const entry: AuditFileEntry = {
      path: relPath,
      kind,
      lines: measured.lines,
      chars: measured.chars,
    };
    if (kind === 'test') {
      testCorpus.push(entry);
    } else {
      subjects.push(entry);
      if (measured.chars <= EVENT_SCAN_MAX_CHARS) {
        let content: string | null = null;
        try {
          content = readFileSync(entryAbs, 'utf8');
        } catch {
          // Vanished between the measure and the read; the hash stage
          // reports it like any other vanished file.
        }
        if (content !== null) {
          const matches = stripCommentsAndStrings(content).match(EVENT_CALL_RE);
          if (matches && matches.length > 0) {
            eventCallSites += matches.length;
            eventFiles.add(relPath);
          }
        }
      }
    }
  }

  return {
    subjects,
    testCorpus,
    uncoverable,
    excludedDirs,
    residue,
    eventDetection: {
      detected:
        eventCallSites >= EVENT_CALL_MIN && eventFiles.size >= EVENT_FILE_MIN,
      callSites: eventCallSites,
      files: eventFiles.size,
    },
  };
}

// --- Git-geometry refusals ----------------------------------------------------

/** The one git probe helper for the audit command group: argv-form
 *  execFileSync under a caller-chosen deadline. Consolidated so a future
 *  fix to process invocation lands in one place. */
export function runGit(
  root: string,
  args: string[],
  timeoutMs: number,
): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function git(root: string, args: string[]): string | null {
  return runGit(root, args, GIT_TIMEOUT_MS);
}

/** A git probe that distinguishes the three outcomes a guard needs:
 *  success, DEFINITIVELY not a worktree (git's own exit-128 answer), and
 *  failure-without-answer (timeout, transient error, missing binary).
 *  Collapsing the third into the second lets a guard pass vacuously on
 *  exactly the runs where it cannot verify anything. */
export type GitProbe =
  | { ok: true; out: string }
  | { ok: false; notRepo: boolean };

export function probeGit(
  root: string,
  args: string[],
  timeoutMs: number,
): GitProbe {
  try {
    return {
      ok: true,
      out: execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      }),
    };
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    return { ok: false, notRepo: status === 128 };
  }
}

export interface GitGeometry {
  inWorktree: boolean;
  /** Repository toplevel, when in a worktree. */
  root?: string;
  /** The probe failed without a definitive not-a-worktree answer. Guards
   *  must treat this as exposed, not as a vacuous pass. */
  probeFailed?: boolean;
}

export function gitGeometry(rootAbs: string): GitGeometry {
  const probe = probeGit(
    rootAbs,
    ['rev-parse', '--show-toplevel'],
    GIT_TIMEOUT_MS,
  );
  if (probe.ok) return { inWorktree: true, root: probe.out.trim() };
  if (probe.notRepo) return { inWorktree: false };
  return { inWorktree: false, probeFailed: true };
}

/** v1 refuses to audit a submodule: no drift arm covers content inside one.
 *  Returns the refusal reason, or null when the path is clear. Outside any
 *  worktree there is no gitlink to hit, so the check passes vacuously. */
export function submoduleRefusal(rootAbs: string): string | null {
  const probe = probeGit(
    rootAbs,
    ['rev-parse', '--show-toplevel'],
    GIT_TIMEOUT_MS,
  );
  if (!probe.ok) {
    // Definitively outside a worktree passes vacuously; a FAILED probe
    // cannot rule out a gitlink and refuses instead of passing on the
    // silence.
    return probe.notRepo
      ? null
      : 'the git worktree probe failed — cannot rule out a submodule';
  }
  const top = probe.out;
  // git reports the symlink-resolved toplevel (macOS /var → /private/var);
  // resolve both sides before computing the relative path.
  const toplevel = realpathSync(top.trim());
  const realRoot = realpathSync(rootAbs);
  const superproject = git(rootAbs, [
    'rev-parse',
    '--show-superproject-working-tree',
  ]);
  if (superproject && superproject.trim() !== '') {
    return 'the audited path resolves inside a submodule — no drift coverage inside submodules in v1';
  }
  const rel = toPosix(relative(toplevel, realRoot));
  // -z is load-bearing: paths arrive verbatim (no C-quoting), and this parse
  // has no unquoting logic.
  const listing = git(toplevel, ['ls-files', '-s', '-z']);
  if (listing === null) return null;
  const gitlinks = listing
    .split('\0')
    .filter((line) => line.startsWith('160000 '))
    // Split at the FIRST tab only: a gitlink path may itself contain tabs.
    .map((line) => line.slice(line.indexOf('\t') + 1))
    .filter((p) => p.length > 0);
  for (const link of gitlinks) {
    const atOrUnder = rel === '' || link === rel || link.startsWith(`${rel}/`);
    const isAncestor = rel.startsWith(`${link}/`);
    if (atOrUnder || isAncestor) {
      return `a submodule sits at ${link} — no drift coverage inside submodules in v1`;
    }
  }
  return null;
}

// --- Local-only guard ----------------------------------------------------------

export const AUDITS_DIR = join('.qwen', 'audits');
export const AUDIT_TMP_DIR = join('.qwen', 'tmp');

export type GuardStatus =
  | 'ok'
  | 'unprotected'
  | 'tracked'
  | 'no-worktree'
  | 'git-failed';

export interface GuardDirReport {
  dir: string;
  /** The representative file path the ignore probe ran against. */
  representative: string;
  ignored: boolean;
  /** Force-added tracked files the index probe found under the dir. */
  trackedFiles: string[];
  status: GuardStatus;
}

export interface GuardReport {
  dirs: GuardDirReport[];
  /** Where artifacts land when an in-repo landing is unsafe. */
  fallbackRoot: string;
}

function guardDir(
  projectRoot: string,
  geometry: GitGeometry,
  dir: string,
  representativeFiles: string[],
): GuardDirReport {
  const gitRoot = geometry.root ?? null;
  if (!gitRoot) {
    return {
      dir,
      representative: join(dir, representativeFiles[0]),
      ignored: false,
      trackedFiles: [],
      // A FAILED probe is exposed, not a vacuous pass: the guard cannot
      // certify what it could not ask about.
      status: geometry.probeFailed ? 'git-failed' : 'no-worktree',
    };
  }
  // check-ignore cannot answer for a path THROUGH a symlink ('beyond a
  // symbolic link' fatal). The dir's trailing components may not exist yet
  // (probes run before the first write), so resolve the LEADING components
  // one by one and probe the physical equivalent.
  let probeDir = toPosix(dir);
  const parts = dir.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const prefixAbs = join(projectRoot, parts.slice(0, i).join('/'));
    let prefixStat: Stats;
    try {
      prefixStat = lstatSync(prefixAbs);
    } catch {
      break; // absent component: nothing deeper can be a link yet
    }
    if (!prefixStat.isSymbolicLink()) continue;
    let target: string;
    try {
      target = realpathSync(prefixAbs);
    } catch {
      // Dangling link: nothing can land through it in the repo, but
      // artifacts cannot land here either — expose it so the fallback
      // landing engages.
      return {
        dir,
        representative: join(dir, representativeFiles[0]),
        ignored: false,
        trackedFiles: [],
        status: 'unprotected',
      };
    }
    const rel = relative(realpathSync(gitRoot), target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      // The link points outside the worktree: the artifacts physically
      // land where git can never commit them.
      return {
        dir,
        representative: join(dir, representativeFiles[0]),
        ignored: true,
        trackedFiles: [],
        status: 'ok',
      };
    }
    probeDir = toPosix(join(rel, ...parts.slice(i)));
    break;
  }
  // The artifacts land under the invocation cwd, which may be a subdirectory
  // of the worktree — probe paths must be toplevel-relative. Both sides are
  // realpath'd: git reports the symlink-resolved toplevel.
  const prefix = toPosix(
    relative(realpathSync(gitRoot), realpathSync(projectRoot)),
  );
  const prefixDir = prefix === '' ? '' : `${prefix}/`;
  // Probe every artifact name shape actually written and take the worst
  // verdict: re-includes can be name-selective, so one exposed shape is an
  // exposed directory.
  let ignored = true;
  let representative = join(dir, representativeFiles[0]);
  for (const file of representativeFiles) {
    const probe = `${prefixDir}${toPosix(join(probeDir, file))}`;
    if (!isGitIgnored(gitRoot, probe)) {
      ignored = false;
      representative = join(dir, file);
      break;
    }
  }
  // :(literal): the prefix may start with ':' (a legal directory name),
  // which git would otherwise parse as pathspec magic and answer empty.
  const trackedOut = git(gitRoot, [
    'ls-files',
    '--',
    `:(literal)${prefixDir}${probeDir}/`,
  ]);
  const trackedFiles = (trackedOut ?? '')
    .split('\n')
    .filter((p) => p.length > 0)
    .slice(0, 20);
  const status: GuardStatus =
    trackedFiles.length > 0 ? 'tracked' : ignored ? 'ok' : 'unprotected';
  return { dir, representative, ignored, trackedFiles, status };
}

function auditTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Probe both module-derived directories (.qwen/audits, .qwen/tmp) so the
 *  report, plan, and prompt records can never land in version control.
 *  Probes use the name shapes actually written, ALL carrying the CURRENT
 *  timestamp so a date- or ts-keyed re-include cannot escape the probe —
 *  the dated report form, the sidecar, and one representative per tmp
 *  artifact class — because check-ignore answers per path name and
 *  re-includes can be name-selective. Fresh answers by construction: the
 *  shared helper carries no memo, so a remedy re-check observes the flip. */
export function checkLocalOnlyGuard(
  projectRoot: string,
  reportFileName: string,
): GuardReport {
  const geometry = gitGeometry(projectRoot);
  const ts = auditTimestamp(new Date());
  return {
    dirs: [
      guardDir(projectRoot, geometry, AUDITS_DIR, [
        `${ts}-${reportFileName}`,
        `audit-${ts}.sidecar`,
      ]),
      guardDir(projectRoot, geometry, AUDIT_TMP_DIR, [
        `audit-args-${ts}.json`,
        `audit-raw-args-${ts}.txt`,
        `audit-plan-${ts}.json`,
        `audit-callers-${ts}.json`,
        `audit-findings-low-${ts}.md`,
        `audit-findings-1a-${ts}.md`,
      ]),
    ],
    fallbackRoot: Storage.getAuditFallbackDir(projectRoot),
  };
}

/** The .git/info/exclude remedy: append ignore rules for both module-derived
 *  directories to the common-dir exclude file (answers in a plain checkout
 *  and a linked worktree alike, and does not dirty the tracked .gitignore).
 *  Returns the exclude file path written. */
export function applyExcludeRemedy(projectRoot: string): string {
  const commonDir = git(projectRoot, ['rev-parse', '--git-common-dir']);
  if (!commonDir) {
    throw new Error('audit: not inside a git worktree — no exclude file.');
  }
  const excludeFile = join(
    resolve(projectRoot, commonDir.trim()),
    'info',
    'exclude',
  );
  const existing = (() => {
    try {
      return readFileSync(excludeFile, 'utf8');
    } catch {
      return '';
    }
  })();
  // Anchor the rules where the artifacts land: the invocation cwd, which may
  // be a subdirectory of the worktree.
  const top = git(projectRoot, ['rev-parse', '--show-toplevel']);
  const prefix = top
    ? toPosix(relative(realpathSync(top.trim()), realpathSync(projectRoot)))
    : '';
  if (/[*?[\]\\]/.test(prefix)) {
    throw new Error(
      'audit: the landing prefix contains gitignore pattern syntax — an ' +
        'exclude rule can never match it. Use the fallback landing instead.',
    );
  }
  const anchor = prefix === '' ? '' : `/${prefix}`;
  const rules = [`${anchor}/.qwen/audits/`, `${anchor}/.qwen/tmp/`];
  const existingRules = new Set(
    existing
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
  const missing = rules.filter((r) => !existingRules.has(r));
  if (missing.length > 0) {
    mkdirSync(dirname(excludeFile), { recursive: true });
    writeFileSync(
      excludeFile,
      `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}# qwen audit: keep audit artifacts out of version control\n${missing.join('\n')}\n`,
      'utf8',
    );
  }
  return excludeFile;
}

// --- Roster, estimate, plan ----------------------------------------------------

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

/** Effort → roster. Low runs no fan-out: a single reader sub-agent instead. */
export function rosterForEffort(effort: AuditEffort): AuditRoleId[] {
  if (effort === 'low') return [];
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

export interface TokenEstimate {
  floorTokens: number;
  topTokens: number;
}

/** The two-rate decomposition: subject and test lines priced separately
 *  (Agent 5 reads the test corpus whole, so both gate arms feed the price).
 *  The top applies the same 1.3× headroom the cap derives from. */
export function estimateTokens(
  subjectLines: number,
  testLines: number,
): TokenEstimate {
  const floor =
    subjectLines * SUBJECT_TOKENS_PER_LINE + testLines * TEST_TOKENS_PER_LINE;
  return {
    floorTokens: Math.round(floor),
    topTokens: Math.round(floor * ESTIMATE_HEADROOM),
  };
}

export interface LowTierConfig {
  /** Surviving angles after dropping B (removed behaviour — merged code has
   *  no deletions): A and C at the floor, D/E/F unlocked by size. */
  angles: string[];
  angleFloorApplied: boolean;
  sweep: boolean;
  findingCap: number;
}

export function lowTierConfig(subjectLines: number): LowTierConfig {
  const angleFloorApplied = subjectLines < LOW_ANGLE_FLOOR_LINES;
  return {
    angles: angleFloorApplied ? ['A', 'C'] : ['A', 'C', 'D', 'E', 'F'],
    angleFloorApplied,
    sweep: subjectLines >= LOW_SWEEP_FLOOR_LINES,
    findingCap: LOW_FINDING_CAP,
  };
}

/** Directory-shaped file-group partitions of the subject set, sized at
 *  FILE_GROUP_LINES — the high tier's reverse-audit territory granularity,
 *  re-anchored from /review's chunk constant to the plan-files set. Path
 *  order keeps siblings in a directory together. A single file larger than
 *  the target stands alone; its auditor pages. */
export function tileFileGroups(subjects: AuditFileEntry[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentLines = 0;
  const flush = (): void => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
      currentLines = 0;
    }
  };
  for (const file of subjects) {
    if (file.lines > FILE_GROUP_LINES) {
      flush();
      groups.push([file.path]);
      continue;
    }
    if (currentLines + file.lines > FILE_GROUP_LINES) {
      flush();
    }
    current.push(file.path);
    currentLines += file.lines;
  }
  flush();
  return groups;
}

export type RefusalReason =
  | 'empty-subjects'
  | 'all-uncoverable'
  | 'subject-gate'
  | 'test-gate'
  | 'low-gate'
  | 'token-cap'
  | 'submodule';

export interface PlanRefusal {
  kind: 'audit-refusal';
  reason: RefusalReason;
  message: string;
}

export class AuditRefusal extends Error {
  constructor(readonly refusal: PlanRefusal) {
    super(refusal.message);
    this.name = 'AuditRefusal';
  }
}

export interface FilesPlan {
  kind: 'audit-plan';
  targetPathAbsolute: string;
  effort: AuditEffort;
  subjectFiles: AuditFileEntry[];
  testCorpus: AuditFileEntry[];
  uncoverable: UncoverableEntry[];
  excludedDirs: string[];
  residue: ResidueEntry[];
  /** Gate-arm totals: uncoverable files are line-counted into both arms. */
  subjectLines: number;
  testLines: number;
  eventModule: EventDetection;
  /** Null at low: the priced estimate is the fan-out rate, which would
   *  overquote a single-context read by an order of magnitude. */
  estimate: TokenEstimate | null;
  roster: AuditRoleId[];
  lowTier: LowTierConfig | null;
  deepReadQuota: number;
  /** High tier only: reverse-audit territory partitions of the subject set. */
  fileGroups: string[][] | null;
  /** High tier only, disclosed at the confirmation: (roster + file-group
   *  count × the 5-round cap) × 2 — the doubling covers the whiff relaunch
   *  every roster agent and every auditor may receive. Verification shards
   *  are uncountable at plan time and stay out of the bound. */
  agentBound: number | null;
  artifacts: {
    reportSlug: string;
    fallbackRoot: string;
  };
}

function refuse(reason: RefusalReason, message: string): never {
  throw new AuditRefusal({ kind: 'audit-refusal', reason, message });
}

/** Build the audit plan or throw AuditRefusal. Gates are hard bounds: over
 *  either arm, v1 refuses at plan time and asks for a narrower path. */
export function buildFilesPlan(
  rootAbs: string,
  targetPath: string,
  effort: AuditEffort,
  collection: AuditCollection,
): FilesPlan {
  const submodule = submoduleRefusal(rootAbs);
  if (submodule) {
    refuse('submodule', `audit: ${submodule}. Audit a path outside it.`);
  }

  const { subjects, testCorpus, uncoverable, excludedDirs, residue } =
    collection;
  const subjectLines =
    subjects.reduce((n, f) => n + f.lines, 0) +
    uncoverable
      .filter((u) => u.kind !== 'test')
      .reduce((n, u) => n + u.lines, 0);
  const testLines =
    testCorpus.reduce((n, f) => n + f.lines, 0) +
    uncoverable
      .filter((u) => u.kind === 'test')
      .reduce((n, u) => n + u.lines, 0);

  if (
    subjects.length === 0 &&
    uncoverable.filter((u) => u.kind !== 'test').length === 0
  ) {
    if (
      excludedDirs.length > 0 &&
      testCorpus.length === 0 &&
      uncoverable.length === 0
    ) {
      refuse(
        'empty-subjects',
        `audit: only excluded directories under ${targetPath} (${excludedDirs.join(', ')}) — no subject files. Excluded by name: ${[...ALWAYS_EXCLUDED_DIRS].join(', ')}, plus dist/build outside vendor/.`,
      );
    }
    refuse(
      'empty-subjects',
      `audit: no subject files under ${targetPath}. Tests route out of the subject set; docs and generated files stay subjects — check the path.`,
    );
  }
  if (subjects.length === 0) {
    refuse(
      'all-uncoverable',
      `audit: only uncoverable subjects under ${targetPath} (${uncoverable.map((u) => `${u.path}: ${u.reason}`).join('; ')}) — nothing can be walked.`,
    );
  }
  if (subjectLines > SUBJECT_LINES_GATE) {
    refuse(
      'subject-gate',
      `audit: ${subjectLines} subject lines exceeds the ${SUBJECT_LINES_GATE}-line gate. v1 has no above-gate branch — audit coherent sub-paths as separate bounded runs.`,
    );
  }
  if (effort === 'low' && subjectLines > LOW_SUBJECT_LINES_GATE) {
    const atMedium = estimateTokens(subjectLines, testLines);
    // The remedy must not bounce into the next refusal: medium applies the
    // test-line gate low never checks, so advise it only when medium would
    // actually accept the module.
    const mediumRefuses =
      atMedium.topTokens > TOKEN_CAP
        ? `the priced estimate (${atMedium.floorTokens}–${atMedium.topTokens} tokens) exceeds the ${TOKEN_CAP} cap`
        : testLines > TEST_LINES_GATE
          ? `${testLines} test lines exceed the ${TEST_LINES_GATE}-line test gate`
          : null;
    refuse(
      'low-gate',
      mediumRefuses
        ? `audit: ${subjectLines} subject lines exceeds low's ${LOW_SUBJECT_LINES_GATE}-line gate, and at medium ${mediumRefuses} — narrow the path.`
        : `audit: ${subjectLines} subject lines exceeds low's ${LOW_SUBJECT_LINES_GATE}-line gate — run --effort medium instead.`,
    );
  }
  if (effort !== 'low' && testLines > TEST_LINES_GATE) {
    refuse(
      'test-gate',
      `audit: ${testLines} test lines exceeds the ${TEST_LINES_GATE}-line gate (Agent 5 reads the corpus whole). Narrow the path.`,
    );
  }
  const estimate =
    effort === 'low' ? null : estimateTokens(subjectLines, testLines);
  if (estimate && estimate.topTokens > TOKEN_CAP) {
    refuse(
      'token-cap',
      `audit: priced estimate ${estimate.floorTokens}–${estimate.topTokens} tokens exceeds the ${TOKEN_CAP} cap at the top. No tier change is the remedy (the priced cost is a function of line counts alone) — audit coherent sub-paths as separate bounded runs.`,
    );
  }

  const roster = rosterForEffort(effort);
  const fileGroups = effort === 'high' ? tileFileGroups(subjects) : null;
  return {
    kind: 'audit-plan',
    targetPathAbsolute: rootAbs,
    effort,
    subjectFiles: subjects,
    testCorpus,
    uncoverable,
    excludedDirs,
    residue,
    subjectLines,
    testLines,
    eventModule: collection.eventDetection,
    estimate,
    roster,
    // Keyed on the WALKED total, not the gate arm: the arm also line-counts
    // never-walked uncoverable files, which would silently undo the floor's
    // budget shrink for a small module padded by binaries.
    lowTier:
      effort === 'low'
        ? lowTierConfig(subjects.reduce((n, f) => n + f.lines, 0))
        : null,
    deepReadQuota: DEEP_READ_QUOTA,
    fileGroups,
    agentBound:
      fileGroups === null
        ? null
        : (roster.length + fileGroups.length * MAX_REVERSE_ROUNDS) * 2,
    artifacts: {
      reportSlug: safeTarget(targetPath),
      fallbackRoot: '', // filled by the CLI, which knows the project root
    },
  };
}

export function resolveAuditRoot(targetPath: string): string {
  if (targetPath.trim() === '') {
    throw new Error('audit: no directory path given.');
  }
  const abs = resolve(targetPath);
  // throwIfNoEntry suppresses only ENOENT/ENOTDIR; an untraversable
  // ancestor (EACCES) or a symlink loop (ELOOP) still threw the raw system
  // error out of the dedicated path-validation entry.
  let stat: Stats | undefined;
  try {
    stat = statSync(abs, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  if (!stat) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `audit: ${targetPath} is a file, not a directory. Single files are ` +
        `already covered by /review <file-path> — use that instead.`,
    );
  }
  // Realpath the root: the path-scoped git calls in sidecar.ts must see the
  // resolved path, or a symlinked target silently drops the captures.
  return realpathSync(abs);
}
