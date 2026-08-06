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
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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

const GIT_TIMEOUT_MS = 5_000;

// --- Classification (re-expressed from plan-diff's four kinds) --------------

export type PathKind = 'source' | 'test' | 'generated' | 'docs';

const TEST_RE =
  /(^|\/)(__tests__|__snapshots__|__mocks__|tests?|spec|integration-tests|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|(^|\/)src\/test\//;

/** The file-name clauses only: the directory clause of plan-diff's
 *  GENERATED_RE is handled at enumeration (excluded dirs / vendor rules),
 *  not here — vendor/ stays a subject, so it cannot classify generated. */
const GENERATED_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock(b)?|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock|NOTICES\.txt)$|\.snap$|\.min\.(js|css)$/;

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
]);
/** Build output: excluded everywhere except under vendor/, where a published
 *  package ships its runnable code in dist/ and the path choice is
 *  authoritative. */
const BUILD_OUTPUT_DIRS = new Set(['dist', 'build']);

function isExcludedDirName(name: string, underVendor: boolean): boolean {
  if (ALWAYS_EXCLUDED_DIRS.has(name)) return true;
  if (name === 'bundle' && underVendor) return true; // vendor/bundle (Bundler)
  if (BUILD_OUTPUT_DIRS.has(name) && !underVendor) return true;
  return false;
}

export type UncoverableReason =
  | 'over-cap-lines'
  | 'non-text'
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
  /** Counted toward the gate arms; 0 for entries never content-read. */
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
    reason: 'symlink' | 'non-regular';
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
  const rootUnderVendor = toPosix(rootAbs)
    .split('/')
    .slice(0, -1)
    .includes('vendor');
  if (isExcludedDirName(basename(rootAbs), rootUnderVendor)) {
    return { files, excludedDirs: ['.'], structuralUncoverable };
  }
  const walk = (dirAbs: string, rel: string, underVendor: boolean): void => {
    for (const entry of readdirSync(dirAbs)) {
      const entryAbs = join(dirAbs, entry);
      const childRel = rel === '' ? entry : `${rel}/${entry}`;
      const stat = lstatSync(entryAbs);
      if (stat.isSymbolicLink()) {
        structuralUncoverable.push({ path: childRel, reason: 'symlink' });
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

const EVENT_CALL_RE =
  /\b(?:emit|dispatch|publish|subscribe|addEventListener|fire|trigger)[A-Z]?\w*\s*\(|\.on\s*\(/g;

function countLines(content: string): number {
  if (content === '') return 0;
  // wc-style: a trailing newline terminates the last line, it does not add one.
  const lines = content.split('\n').length;
  return content.endsWith('\n') ? lines - 1 : lines;
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
      residue.push({ path: relPath, mtimeMs: statSync(entryAbs).mtimeMs });
    }
    let content: string;
    try {
      content = readFileSync(entryAbs, 'utf8');
    } catch {
      uncoverable.push({ path: relPath, kind, reason: 'unreadable', lines: 0 });
      continue;
    }
    const lines = countLines(content);
    let maxLine = 0;
    for (const line of content.split('\n')) {
      if (line.length > maxLine) maxLine = line.length;
    }
    const nonText =
      BINARY_EXT_RE.test(relPath) || content.slice(0, 8192).includes('\0');
    if (nonText) {
      uncoverable.push({ path: relPath, kind, reason: 'non-text', lines });
      continue;
    }
    if (maxLine > MAX_LINE_CHARS) {
      uncoverable.push({
        path: relPath,
        kind,
        reason: 'over-cap-lines',
        lines,
      });
      continue;
    }
    const entry: AuditFileEntry = {
      path: relPath,
      kind,
      lines,
      chars: content.length,
    };
    if (kind === 'test') {
      testCorpus.push(entry);
    } else {
      subjects.push(entry);
      const matches = content.match(EVENT_CALL_RE);
      if (matches && matches.length > 0) {
        eventCallSites += matches.length;
        eventFiles.add(relPath);
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

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

export interface GitGeometry {
  inWorktree: boolean;
  /** Repository toplevel, when in a worktree. */
  root?: string;
}

export function gitGeometry(rootAbs: string): GitGeometry {
  const top = git(rootAbs, ['rev-parse', '--show-toplevel']);
  if (!top) return { inWorktree: false };
  return { inWorktree: true, root: top.trim() };
}

/** v1 refuses to audit a submodule: no drift arm covers content inside one.
 *  Returns the refusal reason, or null when the path is clear. Outside any
 *  worktree there is no gitlink to hit, so the check passes vacuously. */
export function submoduleRefusal(rootAbs: string): string | null {
  const top = git(rootAbs, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
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
  const listing = git(toplevel, ['ls-files', '-s']);
  if (listing === null) return null;
  const gitlinks = listing
    .split('\n')
    .filter((line) => line.startsWith('160000 '))
    .map((line) => line.split('\t')[1])
    .filter((p) => p !== undefined && p.length > 0);
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

export type GuardStatus = 'ok' | 'unprotected' | 'tracked' | 'no-worktree';

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
  gitRoot: string | null,
  dir: string,
  representativeFile: string,
): GuardDirReport {
  const representative = join(dir, representativeFile);
  if (!gitRoot) {
    return {
      dir,
      representative,
      ignored: false,
      trackedFiles: [],
      status: 'no-worktree',
    };
  }
  const ignored = isGitIgnored(gitRoot, toPosix(representative));
  const trackedOut = git(gitRoot, ['ls-files', '--', `${toPosix(dir)}/`]);
  const trackedFiles = (trackedOut ?? '')
    .split('\n')
    .filter((p) => p.length > 0)
    .slice(0, 20);
  const status: GuardStatus =
    trackedFiles.length > 0 ? 'tracked' : ignored ? 'ok' : 'unprotected';
  return { dir, representative, ignored, trackedFiles, status };
}

/** Probe both module-derived directories (.qwen/audits, .qwen/tmp) so the
 *  report, plan, and prompt records can never land in version control.
 *  Fresh answers by construction: the shared helper carries no memo, so a
 *  remedy re-check observes the flip. */
export function checkLocalOnlyGuard(
  projectRoot: string,
  reportFileName: string,
): GuardReport {
  const geometry = gitGeometry(projectRoot);
  return {
    dirs: [
      guardDir(projectRoot, geometry.root ?? null, AUDITS_DIR, reportFileName),
      guardDir(
        projectRoot,
        geometry.root ?? null,
        AUDIT_TMP_DIR,
        'qwen-audit-plan.json',
      ),
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
  const rules = ['/.qwen/audits/', '/.qwen/tmp/'];
  const missing = rules.filter((r) => !existing.includes(r));
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
    auditsDir: string;
    tmpDir: string;
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
    if (excludedDirs.length > 0) {
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
    refuse(
      'low-gate',
      `audit: ${subjectLines} subject lines exceeds low's ${LOW_SUBJECT_LINES_GATE}-line gate — run --effort medium instead.`,
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
    lowTier: effort === 'low' ? lowTierConfig(subjectLines) : null,
    deepReadQuota: DEEP_READ_QUOTA,
    fileGroups,
    agentBound:
      fileGroups === null
        ? null
        : (roster.length + fileGroups.length * MAX_REVERSE_ROUNDS) * 2,
    artifacts: {
      auditsDir: AUDITS_DIR,
      tmpDir: AUDIT_TMP_DIR,
      reportSlug: safeTarget(targetPath),
      fallbackRoot: '', // filled by the CLI, which knows the project root
    },
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
