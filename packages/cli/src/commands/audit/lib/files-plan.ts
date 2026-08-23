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
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
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
import {
  AUDIT_READ_MAX_BYTES,
  readGuarded,
  writeFileGuarded,
} from './safe-read.js';

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
 *  hooks calibration module over the cap it must pass.
 *
 *  PROVENANCE, accepted as such: these are the AUTHOR-REPORTED rates of two
 *  runs whose raw records are not published in this repository, so they
 *  cannot be re-derived from anything a reader has. The estimate they feed
 *  is a calibrated guess, not a reproducible measurement — every report
 *  discloses that, and TOKEN_CAP, not the estimate, is the real bound. */
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
 *  content copy, walker read, or model payload ever sees them.
 *
 *  A name list alone cannot close this class — it is an open-ended guess at
 *  what a secret is called — so it is only the cheap PRE-filter here:
 *  isSecretShaped below also asks the content-side detector (secretContent),
 *  which runs inside the measurement pass that already reads the file
 *  locally, so a credential under an unguessed name still never reaches an
 *  agent, a content copy, or a model payload. */
const SECRET_FILE_RE =
  /(^|\/)(\.env|\.env\.[^/]+|[^/]+\.env|\.envrc|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials(\.json)?|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519|ed448|xmss)(\.pub)?|[^/]+\.(pem|key|p12|pfx|keystore|tfvars|tfstate(\.backup)?))$/i;

/** Filesystem names are byte strings: a trailing CR/LF (or any other control
 *  character) is legal in a filename and would slip every `$`-anchored clause
 *  above, so the membership test asks about the control-stripped spelling
 *  too. */
export function isSecretName(relPath: string): boolean {
  if (SECRET_FILE_RE.test(relPath)) return true;
  // eslint-disable-next-line no-control-regex
  const stripped = relPath.replace(/[\x00-\x1f\x7f]+/g, '');
  return stripped !== relPath && SECRET_FILE_RE.test(stripped);
}

/** The content-side half of the secret detector, evaluated on the prefix the
 *  measurement pass has already read.
 *
 *  Deliberately narrow, because a false positive silently drops a real
 *  subject from the audit: the file must BEGIN with a private-key armor
 *  line, which is the shape of an actual key file and of nothing else. A
 *  source file that merely quotes the armor — a secret scanner, a test
 *  fixture, this very module — carries it mid-file and stays a subject.
 *  (This repository has several such files, which is how the looser
 *  "anywhere in the first chunk" spelling was caught.) */
const SECRET_ARMOR_RE =
  /^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----\s*$/;

function startsWithKeyArmor(prefix: string): boolean {
  for (const line of prefix.split('\n')) {
    const trimmed = line.trim();
    // Skip the leading blank lines a key file may carry; the first line with
    // content decides. Anything else means this is not a bare key file.
    if (trimmed === '') continue;
    return SECRET_ARMOR_RE.test(trimmed);
  }
  return false;
}

// --- Enumeration -------------------------------------------------------------

/** Excluded from enumeration by directory name anywhere under the audited
 *  path, including under vendor/ and the path root: dependency installs,
 *  tooling output, and the tool's own artifact class — unless git tracks
 *  files inside the directory (see dirHasTrackedFiles). */
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

/** The name exclusion is a heuristic, and git's own tracking is the repo's
 *  verdict that it misfired: a name-excluded directory holding tracked files
 *  is source (this repo's packages/desktop/scripts/build is exactly one), so
 *  it is walked instead of silently dropped. Outside a worktree — or for an
 *  untracked directory — the heuristic stands. */
function dirHasTrackedFiles(dirAbs: string): boolean {
  // Git internals stay excluded unconditionally — a bare repository's
  // `<name>.git` included: a broken git must not fail-open into walking
  // them, and a tracked file inside one is a nested-repo artifact, not a
  // misfire of the name heuristic.
  if (isGitInternalsDirName(basename(dirAbs))) return false;
  const probe = probeGit(dirAbs, ['ls-files', '--', dirAbs], GIT_TIMEOUT_MS);
  if (probe.ok) return probe.out.trim().length > 0;
  // A probe without an answer (broken git, dubious ownership, timeout) has
  // established no tracking: the name exclusion stands, fail-closed like
  // the module's other guards — a fail-open here walked node_modules and
  // every other excluded dir on exactly the runs where nothing is verified.
  return false;
}

/** `.git` is the literal name of a working repository's internals, but a
 *  BARE repository is conventionally named `<something>.git` — and it holds
 *  the same object store, packed refs, and hooks. The walk's own invariant is
 *  unconditional ("git internals are never subjects"), so the suffix belongs
 *  in the test, not just the literal name. */
function isGitInternalsDirName(name: string): boolean {
  return name === '.git' || name.toLowerCase().endsWith('.git');
}

function isExcludedDirName(name: string, underVendor: boolean): boolean {
  if (ALWAYS_EXCLUDED_DIRS.has(name)) return true;
  if (isGitInternalsDirName(name)) return true;
  if (name === 'bundle' && underVendor) return true; // vendor/bundle (Bundler)
  if (BUILD_OUTPUT_DIRS.has(name) && !underVendor) return true;
  return false;
}

/** True when `child` is `parent` or sits under it, compared on resolved
 *  paths. */
function isAtOrUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The tool's own artifact home, resolved once per walk. `.qwen` is already
 *  name-excluded, but QWEN_HOME is user-settable and guard-check itself
 *  hands out in-worktree fallback roots: a run whose in-repo landing was
 *  refused relocates its report, sidecar, plan, and findings under
 *  `QWEN_HOME/audits/<hash>/`, and the NEXT audit of the enclosing tree
 *  would enumerate that as source — the previous run's findings become
 *  subjects (self-contaminated findings), under whatever directory name
 *  QWEN_HOME happens to have. Resolve the real home instead of guessing its
 *  name. */
function globalArtifactRoot(): string | undefined {
  try {
    return realpathSync(Storage.getGlobalQwenDir());
  } catch {
    // Not created yet (or unreadable): nothing on disk to collide with.
    return undefined;
  }
}

export type UncoverableReason =
  | 'over-cap-lines'
  | 'over-cap-bytes'
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
  // The vendor context derives from the root's path RELATIVE TO THE
  // REPOSITORY: an ancestor named `vendor` outside the repo (the checkout's
  // location on disk) must not flip vendor mode for the whole walk. Starting
  // the walk at vendor/bundle or vendor/pkg/dist inside the repo still
  // applies the same rules a walk that DESCENDS into vendor/ would apply
  // there, or the verdicts depend on the start point (gems walked at one
  // start, dist/build kept at another). Outside any worktree there is no
  // repo boundary to respect, so the whole path keeps carrying the context.
  let rootUnderVendor: boolean;
  const geometry = gitGeometry(rootAbs);
  if (geometry.inWorktree && geometry.root !== undefined) {
    try {
      // git reports the symlink-resolved toplevel; resolve both sides
      // before comparing (the walk entry point may arrive un-resolved).
      const rel = toPosix(
        relative(realpathSync(geometry.root), realpathSync(rootAbs)),
      );
      rootUnderVendor = rel.split('/').includes('vendor');
    } catch {
      rootUnderVendor = toPosix(rootAbs).split('/').includes('vendor');
    }
  } else {
    rootUnderVendor = toPosix(rootAbs).split('/').includes('vendor');
  }
  // A root INSIDE an artifact class is the same self-contamination from
  // the other direction: auditing .qwen/tmp or .qwen/audits walks the
  // previous run's findings and plan as subjects, and a .git child walks
  // git internals — the descent exclusion above never fires for them.
  const rootSegments = toPosix(rootAbs).split('/');
  for (let i = 0; i < rootSegments.length; i++) {
    const insideArtifacts =
      rootSegments[i] === '.qwen' &&
      (rootSegments[i + 1] === 'audits' || rootSegments[i + 1] === 'tmp');
    if (insideArtifacts || (isGitInternalsDirName(rootSegments[i]) && i > 0)) {
      return { files, excludedDirs: ['.'], structuralUncoverable };
    }
  }
  // The same self-contamination through the OTHER artifact home: a fallback
  // landing under a user-set QWEN_HOME that sits inside the audited tree.
  const artifactRoot = globalArtifactRoot();
  const rootReal = (() => {
    try {
      return realpathSync(rootAbs);
    } catch {
      return rootAbs;
    }
  })();
  if (artifactRoot !== undefined && isAtOrUnder(artifactRoot, rootReal)) {
    return { files, excludedDirs: ['.'], structuralUncoverable };
  }
  if (
    isExcludedDirName(basename(rootAbs), rootUnderVendor) &&
    !dirHasTrackedFiles(rootAbs)
  ) {
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
        // The command group's own artifact directories never become audit
        // subjects, even when the tracked-files override descends into
        // .qwen: re-auditing would ingest the previous run's findings,
        // plan, and raw args (self-contaminated findings), and the walk
        // deliberately ignores ignore status there.
        if (
          (entry === 'audits' || entry === 'tmp') &&
          basename(dirAbs) === '.qwen'
        ) {
          excludedDirs.push(childRel);
          continue;
        }
        // The artifact home reached by DESCENT rather than by being the
        // walk root: a QWEN_HOME inside the audited tree carries the
        // relocated artifacts of the previous run under any directory name.
        if (artifactRoot !== undefined) {
          let entryReal: string;
          try {
            entryReal = realpathSync(entryAbs);
          } catch {
            entryReal = entryAbs;
          }
          if (isAtOrUnder(artifactRoot, entryReal)) {
            excludedDirs.push(childRel);
            continue;
          }
        }
        if (isExcludedDirName(entry, underVendor)) {
          if (!dirHasTrackedFiles(entryAbs)) {
            excludedDirs.push(childRel);
            continue;
          }
          // Tracked content overrides the name heuristic: fall through and
          // walk it.
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
 *  strip is a heuristic (the detection is one), not a language parser.
 *  Single pass in source order: a string literal starting before a comment
 *  marker consumes the marker as literal content (a URL's `//`), never the
 *  other way around. */
function stripCommentsAndStrings(content: string): string {
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    const next = i + 1 < n ? content[i + 1] : '';
    if (ch === '/' && next === '/') {
      const end = content.indexOf('\n', i + 2);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // '#' comments (Python/shell): only at line start or after whitespace,
    // so a JS private field (`this.#x`) keeps its member name.
    if (ch === '#' && (i === 0 || /\s/.test(content[i - 1]))) {
      const end = content.indexOf('\n', i + 1);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i++;
      while (i < n && content[i] !== ch) {
        i += content[i] === '\\' ? 2 : 1;
      }
      i++; // closing quote (or past EOF for an unterminated literal)
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

interface FileMeasure {
  lines: number;
  chars: number;
  maxLine: number;
  hasNul: boolean;
  size: number;
  /** Credential material found in the measured prefix — the content-side
   *  half of the secret detector. The measurement read is local and
   *  bounded; nothing downstream ever sees the content of a file this
   *  flags. */
  hasSecretContent: boolean;
}

const MEASURE_CHUNK_CHARS = 64 * 1024;

/** Measure a file WITHOUT materializing it: chunked reads count lines,
 *  chars, the longest line, and NUL presence in O(chunk) memory, so a
 *  multi-hundred-MB fixture cannot OOM the enumeration. Returns null when
 *  the file vanished or is unreadable. */
function measureFile(abs: string): FileMeasure | null {
  let fd: number;
  try {
    // O_NONBLOCK + O_NOFOLLOW + the fstat gate below: the walk completes for
    // the whole tree before any measurement, so a file swapped for a
    // writer-less FIFO in between must not hang the open, and one swapped
    // for a symlink must not measure (or hash) an out-of-tree target — the
    // walk-time lstat cannot speak for the open moment, and the fd's own
    // fstat would describe the symlink's target.
    fd = openSync(
      abs,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
  try {
    // Re-check the opened fd: the walk-time lstat regular-file gate spans
    // the whole enumeration window and cannot speak for the open moment.
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const buf = Buffer.allocUnsafe(MEASURE_CHUNK_CHARS);
    let chars = 0;
    let newlines = 0;
    let maxLine = 0;
    let currentLine = 0;
    let hasNul = false;
    let hasSecretContent = false;
    let lastWasNewline = false;
    let read: number;
    // Bounded by the read cap, not by EOF: an over-cap file is excluded from
    // the walk anyway (the caller's over-cap-bytes arm), so measuring it
    // whole only buys the enumeration a multi-GB scan — and a live appender
    // would drag the loop to an EOF that keeps receding. The prefix counts
    // still place the file on the correct side of every gate.
    let budget = Math.min(stat.size, AUDIT_READ_MAX_BYTES);
    while (
      budget > 0 &&
      (read = readSync(fd, buf, 0, Math.min(buf.length, budget), null)) > 0
    ) {
      budget -= read;
      // A multi-byte character split across chunks decodes to a replacement
      // character: +-1 on a line length, never on newline/NUL detection.
      const text = buf.toString('utf8', 0, read);
      chars += text.length;
      if (text.includes('\0')) hasNul = true;
      // A key file's armor is its first line, so only the FIRST chunk is
      // ever examined: the detector stays O(1) per file and cannot be
      // steered by anything further in.
      if (chars === text.length && startsWithKeyArmor(text)) {
        hasSecretContent = true;
      }
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
    return {
      lines,
      chars,
      maxLine,
      hasNul,
      hasSecretContent,
      size: fstatSync(fd).size,
    };
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
    if (isSecretName(relPath)) {
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
    // bytes are not code lines and must not steer the gate arms. Checked
    // BEFORE the size cap so an over-cap binary records non-text/zero
    // instead of its raw 0x0A count.
    if (measured.hasNul) {
      uncoverable.push({ path: relPath, kind, reason: 'non-text', lines: 0 });
      continue;
    }
    // Credential MATERIAL under a name no list anticipated: the measurement
    // read above is local and bounded, and this is the last point before the
    // file could become an agent payload, a content copy, or an event-scan
    // read. Zero lines, like every other never-walked secret.
    if (measured.hasSecretContent) {
      uncoverable.push({
        path: relPath,
        kind,
        reason: 'secret-shaped',
        lines: 0,
      });
      continue;
    }
    // Anchor resolution reads capped at AUDIT_READ_MAX_BYTES: a subject
    // over the cap is a citation target whose anchors can never resolve,
    // so the plan excludes it up front instead of refusing at write time.
    if (measured.size > AUDIT_READ_MAX_BYTES) {
      uncoverable.push({
        path: relPath,
        kind,
        reason: 'over-cap-bytes',
        lines: measured.lines,
      });
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
        // Guarded read: the walk-to-read window spans the whole
        // enumeration, so a FIFO swapped in must not hang the scan.
        const content = readGuarded(entryAbs, AUDIT_READ_MAX_BYTES);
        if (content !== null) {
          const matches = stripCommentsAndStrings(
            content.toString('utf8'),
          ).match(EVENT_CALL_RE);
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

/** Drop the WHOLE `GIT_`-prefixed environment family, the way core's shared
 *  isGitIgnored probe does, rather than enumerating the channels that are
 *  known to matter today.
 *
 *  Enumerating loses: the repository selectors (GIT_DIR, GIT_WORK_TREE,
 *  GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR) redirect `-C`;
 *  GIT_CEILING_DIRECTORIES defeats discovery so a live worktree reads as
 *  "definitively not a worktree" and every guard passes vacuously; the
 *  pathspec family (GIT_LITERAL_PATHSPECS and its glob/icase siblings)
 *  silently empties the `:(literal)` pathspecs the tracked-file arm and the
 *  sidecar capture both depend on — an empty answer degrades to "nothing
 *  tracked, nothing dirty" with no marker; and the config channels
 *  (GIT_CONFIG_*) can inject any setting at all. One rule covers today's
 *  channels and tomorrow's. GIT_CONFIG_NOSYSTEM is then set explicitly:
 *  /etc/gitconfig is neither the repository's nor the user's answer, and
 *  inheriting the ambient value would let host policy speak for the audited
 *  tree. LC_ALL pins the C locale: probeGit matches git's ENGLISH fatal
 *  text, and git localizes it under an ambient locale. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['LC_ALL'] = 'C';
  return env;
}

interface GitSpawn {
  ok: boolean;
  out: string;
  stderr: string;
  /** Null when the spawn itself failed (missing binary, timeout kill). */
  status: number | null;
}

/** The one process invocation for every git probe in the audit command
 *  group: argv-form execFileSync under a caller-chosen deadline, with the
 *  repository-selecting env scrubbed. Consolidated so a future fix to
 *  process invocation lands in one place. */
function spawnGit(root: string, args: string[], timeoutMs: number): GitSpawn {
  try {
    // -c core.fsmonitor=false: a repo-local core.fsmonitor NAMES A PROGRAM,
    // and git runs it for the index-refreshing commands the capture and the
    // plan-time probes spawn — attacker-chosen code executing as the
    // auditor against a hostile checkout (the module's stated purpose).
    // --no-ext-diff/--no-textconv close the diff-driver channels at the
    // diff arm itself; the env scrub cannot reach a config channel, so the
    // command-line override lands here, in front of every subcommand.
    const out = execFileSync(
      'git',
      ['-c', 'core.fsmonitor=false', '-C', root, ...args],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: gitEnv(),
      },
    );
    return { ok: true, out, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { status?: number | null; stderr?: unknown } | null;
    const stderr =
      typeof e?.stderr === 'string'
        ? e.stderr
        : Buffer.isBuffer(e?.stderr)
          ? e.stderr.toString('utf8')
          : '';
    return {
      ok: false,
      out: '',
      stderr,
      status: typeof e?.status === 'number' ? e.status : null,
    };
  }
}

export function runGit(
  root: string,
  args: string[],
  timeoutMs: number,
): string | null {
  const spawn = spawnGit(root, args, timeoutMs);
  return spawn.ok ? spawn.out : null;
}

function git(root: string, args: string[]): string | null {
  return runGit(root, args, GIT_TIMEOUT_MS);
}

/** A git probe that distinguishes the three outcomes a guard needs:
 *  success, DEFINITIVELY not a worktree (git's own answer), and
 *  failure-without-answer (timeout, transient error, missing binary).
 *  Collapsing the third into the second lets a guard pass vacuously on
 *  exactly the runs where it cannot verify anything. */
export type GitProbe =
  | { ok: true; out: string }
  | { ok: false; notRepo: boolean; unborn: boolean };

export function probeGit(
  root: string,
  args: string[],
  timeoutMs: number,
): GitProbe {
  const spawn = spawnGit(root, args, timeoutMs);
  if (spawn.ok) return { ok: true, out: spawn.out };
  // Git exits 128 for fatals beyond "not a git repository" (dubious
  // ownership, corrupt config): only git's own message is definitive, a
  // bare exit code is not. The unborn arm keys on rev-parse's definitive
  // unborn fatal the same way.
  const notRepo =
    spawn.status === 128 && /not a git repository/i.test(spawn.stderr);
  const unborn = spawn.status === 128 && /unknown revision/i.test(spawn.stderr);
  return { ok: false, notRepo, unborn };
}

export interface GitGeometry {
  inWorktree: boolean;
  /** Repository toplevel, when in a worktree. */
  root?: string;
  /** The probe failed without a definitive not-a-worktree answer. Guards
   *  must treat this as exposed, not as a vacuous pass. */
  probeFailed?: boolean;
}

/** The audited path's repository toplevel, symlink-resolved — or undefined
 *  outside a worktree (or when the probe could not answer). The containment
 *  boundary every agent-nominated path is held to. */
export function gitToplevelOf(rootAbs: string): string | undefined {
  const probe = probeGit(
    rootAbs,
    ['rev-parse', '--show-toplevel'],
    GIT_TIMEOUT_MS,
  );
  if (!probe.ok) return undefined;
  try {
    return realpathSync(probe.out.trim());
  } catch {
    return undefined;
  }
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
  // resolve both sides before computing the relative path. A TOCTOU
  // delete/rename between the probe and the resolution degrades like a
  // failed probe instead of throwing a raw ENOENT out of the handler.
  let toplevel: string;
  let realRoot: string;
  try {
    toplevel = realpathSync(top.trim());
    realRoot = realpathSync(rootAbs);
  } catch {
    return 'the audited path could not be resolved — cannot rule out a submodule';
  }
  const superproject = git(rootAbs, [
    'rev-parse',
    '--show-superproject-working-tree',
  ]);
  if (superproject === null) {
    return 'the superproject probe failed — cannot rule out a submodule';
  }
  if (superproject.trim() !== '') {
    return 'the audited path resolves inside a submodule — no drift coverage inside submodules in v1';
  }
  const rel = toPosix(relative(toplevel, realRoot));
  // -z is load-bearing: paths arrive verbatim (no C-quoting), and this parse
  // has no unquoting logic.
  const listing = git(toplevel, ['ls-files', '-s', '-z']);
  if (listing === null) {
    return 'the gitlink enumeration failed — cannot rule out a submodule';
  }
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
  let resolvedViaSymlink = false;
  const parts = probeDir.split('/');
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
    // toPosix: on Windows relative() emits '..\\other', which fails all
    // three checks and would trap symlink-outside setups at exit 5 forever.
    const rel = toPosix(relative(realpathSync(gitRoot), target));
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
      // The link points outside THIS worktree. ('..' alone or a leading
      // '../' — a repo-relative name that merely STARTS with '..' is a
      // legal in-repo entry and keeps probing.) That lands artifacts where
      // THIS repo can never commit them — but inside ANOTHER repository a
      // plain `git add -A` publishes them, so certify ok only when the
      // target is definitively outside every worktree; a probe without an
      // answer fails closed like every other guard arm.
      const targetGeometry = gitGeometry(target);
      if (targetGeometry.inWorktree || targetGeometry.probeFailed) {
        return {
          dir,
          representative: join(dir, representativeFiles[0]),
          ignored: false,
          trackedFiles: [],
          status: 'unprotected',
        };
      }
      return {
        dir,
        representative: join(dir, representativeFiles[0]),
        ignored: true,
        trackedFiles: [],
        status: 'ok',
      };
    }
    probeDir = toPosix(join(rel, ...parts.slice(i)));
    resolvedViaSymlink = true;
    break;
  }
  // The artifacts land under the invocation cwd, which may be a subdirectory
  // of the worktree — probe paths must be toplevel-relative. Both sides are
  // realpath'd: git reports the symlink-resolved toplevel.
  const prefix = toPosix(
    relative(realpathSync(gitRoot), realpathSync(projectRoot)),
  );
  // The symlink branch rewrites probeDir to a toplevel-relative PHYSICAL
  // path: the cwd-relative prefix is already inside it and must not be
  // prepended again (a double-prefixed probe asks about a path that does
  // not exist).
  const prefixDir = resolvedViaSymlink || prefix === '' ? '' : `${prefix}/`;
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
  // -z is load-bearing: paths arrive verbatim (no C-quoting of non-ASCII
  // names), mirroring submoduleRefusal's parse.
  const trackedOut = git(gitRoot, [
    'ls-files',
    '-z',
    '--',
    `:(literal)${prefixDir}${probeDir}/`,
  ]);
  const trackedFiles = (trackedOut ?? '')
    .split('\0')
    .filter((p) => p.length > 0)
    .slice(0, 20);
  const status: GuardStatus =
    trackedFiles.length > 0 ? 'tracked' : ignored ? 'ok' : 'unprotected';
  return { dir, representative, ignored, trackedFiles, status };
}

/** The next CALENDAR date, in the report name's `YYYY-MM-DD` shape.
 *
 *  Not `now + 24h`: on a DST fall-back day the local day is 25 hours long,
 *  so that instant is still INSIDE today for the first wall-clock hour and
 *  the true next date never gets probed — in every DST timezone, once a
 *  year. Incrementing the day field lets the Date constructor do the
 *  calendar arithmetic (month and year rollover included). */
export function nextCalendarDate(from: Date): string {
  const next = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate() + 1,
    12, // midday: immune to a DST shift moving the instant across midnight
  );
  return auditTimestamp(next).split('-').slice(0, 3).join('-');
}

export function auditTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** The artifact name shapes a guard must probe for one timestamp: the
 *  dated report form and the sidecar under .qwen/audits, and one
 *  representative per tmp artifact class — check-ignore answers per path
 *  name and re-includes can be name-selective, so every shape written is
 *  a shape probed. Shared with guard-check's fallback-landing probes: the
 *  relocation lands this same set at the fallback root. */
export function guardProbeShapes(
  reportFileName: string,
  ts: string,
): { audits: string[]; tmp: string[] } {
  return {
    audits: [
      `${ts}-${reportFileName}`,
      // The sidecar is a DIRECTORY (sidecar.json, diff.patch, untracked
      // copies): git applies a trailing-slash re-include only to paths it
      // knows are directories, so a file-shaped probe never sees it —
      // probe the child file the snapshot actually writes.
      `audit-${ts}.sidecar/sidecar.json`,
    ],
    tmp: [
      `audit-args-${ts}.json`,
      `audit-raw-args-${ts}.txt`,
      `audit-plan-${ts}.json`,
      `audit-callers-${ts}.json`,
      // The report draft (Step 7's check-anchors input) carries every
      // finding's verbatim anchor snippets; SKILL.md pins its name.
      `audit-draft-${ts}.md`,
      // The findings manifest carries the same verbatim snippets in
      // machine-readable form — the gate's actual input — so it is exactly
      // as committable and gets its own probe.
      `audit-findings-${ts}.json`,
      // One representative per findings shape the skill writes: the
      // low-tier reader plus every roster role of the high tier (which
      // contains the medium roster), plus the reserved specialist shape
      // (SKILL.md constrains specialist findings to it).
      ...['low', ...rosterForEffort('high')].map(
        (role) => `audit-findings-${role}-${ts}.md`,
      ),
      `audit-findings-specialist-01-${ts}.md`,
    ],
  };
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
  extraTs?: string,
): GuardReport {
  const geometry = gitGeometry(projectRoot);
  const ts = auditTimestamp(new Date());
  const shapes = guardProbeShapes(reportFileName, ts);
  // The artifacts actually sitting in the directories keep the ts they were
  // written under: a checkpoint probing only its own instant's names never
  // asks about a plan-ts-named file, so a name-selective re-include keyed
  // to the plan ts would escape every checkpoint. Probe the caller's
  // recovered past ts too, whenever it is known.
  if (extraTs !== undefined && extraTs !== ts) {
    const extra = guardProbeShapes(reportFileName, extraTs);
    shapes.audits.push(...extra.audits);
    shapes.tmp.push(...extra.tmp);
  }
  // Runs are hours-long: the report is written at write time, so its
  // date can legitimately roll past the probe instant — probe the next
  // calendar date's report shape too.
  const nextDate = nextCalendarDate(new Date());
  return {
    dirs: [
      guardDir(projectRoot, geometry, AUDITS_DIR, [
        ...shapes.audits,
        `${nextDate}-000000-${reportFileName}`,
      ]),
      guardDir(projectRoot, geometry, AUDIT_TMP_DIR, shapes.tmp),
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
  const commonDirAbs = resolve(projectRoot, commonDir.trim());
  // A `.git` that is a REGULAR FILE holding `gitdir: <elsewhere>` re-homes
  // the common dir: git answers with the pointed-at repository, and the
  // remedy would append rules to a foreign repository's exclude file. The
  // write has to be attributable to the repository this path really belongs
  // to before it lands.
  //
  // Path containment cannot decide it — a legitimate LINKED WORKTREE also
  // has its common dir outside its own toplevel, which is exactly the shape
  // a planted pointer imitates. What separates them is registration: a
  // linked worktree's git dir sits under `<common>/worktrees/`, while a
  // planted pointer makes this tree look like the foreign repository's MAIN
  // worktree — and a main worktree's git dir IS its common dir, which must
  // then sit inside the toplevel.
  const top = git(projectRoot, ['rev-parse', '--show-toplevel']);
  const gitDir = git(projectRoot, ['rev-parse', '--absolute-git-dir']);
  if (!top || !gitDir) {
    throw new Error(
      'audit: the worktree probes failed — cannot verify which repository ' +
        'the exclude file belongs to. Use the fallback landing.',
    );
  }
  let commonReal: string;
  let topReal: string;
  let gitDirReal: string;
  try {
    commonReal = realpathSync(commonDirAbs);
    topReal = realpathSync(top.trim());
    gitDirReal = realpathSync(gitDir.trim());
  } catch {
    throw new Error(
      'audit: the repository paths could not be resolved — refusing to write ' +
        'an exclude file that cannot be attributed. Use the fallback landing.',
    );
  }
  const isLinkedWorktree =
    gitDirReal !== commonReal &&
    isAtOrUnder(join(commonReal, 'worktrees'), gitDirReal);
  if (!isLinkedWorktree && !isAtOrUnder(topReal, commonReal)) {
    throw new Error(
      `audit: the repository's common dir (${commonReal}) is neither inside ` +
        `the audited worktree (${topReal}) nor registered as one of its ` +
        'worktrees — a planted `.git` pointer can re-home this write to ' +
        'another repository. Use the fallback landing.',
    );
  }
  const excludeFile = join(commonReal, 'info', 'exclude');
  const existingBuf = readGuarded(excludeFile, AUDIT_READ_MAX_BYTES);
  // A symlinked, FIFO, or oversized exclude file reads as absent above; the
  // guarded write below then refuses rather than following the link.
  const existing = existingBuf === null ? '' : existingBuf.toString('utf8');
  // Anchor the rules where the artifacts land: the invocation cwd, which may
  // be a subdirectory of the worktree. topReal is the same toplevel the
  // attribution check above resolved — one probe, one answer.
  const prefix = toPosix(relative(topReal, realpathSync(projectRoot)));
  // \n/\r are the exclude format's line delimiter: a prefix carrying one
  // would write malformed rules instead of refusing.
  if (/[*?[\]\\\n\r]/.test(prefix)) {
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
    // Guarded: a symlink planted at info/exclude would redirect this write
    // into an arbitrary host file — and the appended `existing` content
    // would rewrite that file with its own contents plus the rules.
    writeFileGuarded(
      excludeFile,
      `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}# qwen audit: keep audit artifacts out of version control\n${missing.join('\n')}\n`,
      'the exclude file',
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

/** The report slug's maximum length, applied at the WRITER.
 *
 *  guard-check re-validates the slug before interpolating it into probe
 *  paths, and a slug it rejects costs the run its relocation credit — exit 5
 *  at every checkpoint, in a configuration the gate's own contract promises
 *  to clear. So the writer must only ever emit names that validator accepts:
 *  the length bound and the leading-character rule both live here, and
 *  isSafeReportSlug is the same rule read back. */
export const REPORT_SLUG_MAX_CHARS = 200;

/** safeTarget flattens a path to one filename component, but its output
 *  space is WIDER than a probe path can carry: it keeps a leading `-` (which
 *  reads as an option when the name reaches a command line) and imposes no
 *  length bound (a deep absolute path flattens past any filesystem's
 *  component limit). Narrow it here, at the single place plan slugs are
 *  born, so the plan and every consumer agree by construction. */
export function auditReportSlug(targetPath: string): string {
  const flat = safeTarget(targetPath).replace(/^[-._]+/, '');
  const capped = flat.slice(0, REPORT_SLUG_MAX_CHARS);
  return capped === '' ? 'target' : capped;
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
  /** High tier only: reverse-audit territory partitions of the subject set. */
  fileGroups: string[][] | null;
  /** High tier only, disclosed at the confirmation: (roster + file-group
   *  count × the 5-round cap) × 2 — the doubling covers the whiff relaunch
   *  every roster agent and every auditor may receive. Verification shards
   *  are uncountable at plan time and stay out of the bound. */
  agentBound: number | null;
  artifacts: {
    reportSlug: string;
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
        `audit: only excluded directories under ${targetPath} (${excludedDirs.join(', ')}) — no subject files. Excluded by name: ${[...ALWAYS_EXCLUDED_DIRS].join(', ')}, plus dist/build outside vendor/, and bundle everywhere.`,
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
    // The arms mirror medium's actual refusal order (the test-line gate
    // fires before the token cap), so the message names the refusal a
    // tier change would really hit.
    const mediumRefuses =
      testLines > TEST_LINES_GATE
        ? `${testLines} test lines exceed the ${TEST_LINES_GATE}-line test gate`
        : atMedium.topTokens > TOKEN_CAP
          ? `the priced estimate (${atMedium.floorTokens}–${atMedium.topTokens} tokens) exceeds the ${TOKEN_CAP} cap`
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
    fileGroups,
    agentBound:
      fileGroups === null
        ? null
        : (roster.length + fileGroups.length * MAX_REVERSE_ROUNDS) * 2,
    artifacts: {
      reportSlug: auditReportSlug(targetPath),
    },
  };
}

export function resolveAuditRoot(targetPath: string): string {
  if (targetPath.trim() === '') {
    throw new Error('audit: no directory path given.');
  }
  const abs = resolve(targetPath);
  // throwIfNoEntry suppresses only ENOENT/ENOTDIR; an untraversable
  // ancestor (EACCES) or a symlink loop (ELOOP) carries its own
  // diagnostic — both paths EXIST, and "does not exist" would send the
  // user chasing a checkout problem instead.
  let stat: Stats | undefined;
  try {
    stat = statSync(abs, { throwIfNoEntry: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new Error(`Path is a symbolic link loop: ${targetPath}`);
    }
    throw new Error(`Path cannot be accessed: ${targetPath}`);
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
  try {
    return realpathSync(abs);
  } catch {
    // Vanished between the stat and the realpath (concurrent rotation):
    // the clean missing-path diagnostic, never a raw stack out of the
    // yargs handler.
    throw new Error(`Path does not exist: ${targetPath}`);
  }
}
