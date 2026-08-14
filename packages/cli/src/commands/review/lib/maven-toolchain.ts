/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  opendirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  BuildTestReport,
  CommandResult,
  MavenCommandFacts,
} from '../build-test.js';
import {
  BUILD_MIN_FREE_BYTES,
  INSTALL_MIN_FREE_BYTES,
  freeDiskBytes,
  gib,
} from './disk.js';
import { shellQuotePath } from './shell-quote.js';
import { SaxesParser } from 'saxes';
import type { ReviewToolchainAdapter, ToolchainRunArgs } from './toolchain.js';

export interface MavenOwnership {
  reactorWide: boolean;
  modules: string[];
}

/**
 * SGR color sequences. Every classification regex in this file anchors on
 * Maven's `[INFO]`/`[ERROR]` framing, and a `-Dstyle.color=always` config
 * interleaves these codes BEFORE and BETWEEN tokens, defeating every
 * anchored predicate — so the executed output is stripped ONCE at
 * ingestion, before any classification or marker mining reads it.
 * `build-test`'s trim rescue shares this constant: same bytes, same answer.
 */
// eslint-disable-next-line no-control-regex -- ESC is the character under test
export const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Stable note markers, asserted by the test oracle. The prose around them
 * may be reworded freely; changing a marker is a deliberate contract edit —
 * one constant here, and every test that imports it follows. Each branch's
 * marker is distinct, so the assertions still discriminate which branch
 * produced the note (they only decouple from the surrounding wording).
 */
export const NOTE_INFRASTRUCTURE_EVIDENCE = 'infrastructure evidence';
export const NOTE_CORRELATE_ERRORS = 'Correlate compiler or test errors';
export const NOTE_MAVEN_TEST_PASSED = 'Maven test passed';

const REACTOR_WIDE_FILES = new Set(['pom.xml', 'mvnw', 'mvnw.cmd']);
/**
 * `failsafe-reports` is forward-looking today: this adapter only ever runs
 * `test` and `test-compile`, and Failsafe binds to `integration-test` /
 * `verify`, so any XML found there is filtered out as stale. The scan stays
 * — one readdir per project per snapshot — so the evidence is picked up if a
 * later change ever runs a Failsafe phase.
 */
const REPORT_DIRS = ['surefire-reports', 'failsafe-reports'];

/**
 * Surefire writes one XML per test class, so a green full-reactor run yields
 * thousands of reports. Clean AND failing reports therefore roll up per
 * project dir — one attributed line per project, so module attribution
 * survives any reactor size. The FAILING-side lines stay capped: that block
 * is appended AFTER the command output was trimmed, so it carries its own
 * bound; the cap preserves attribution (per-project rollups, not a
 * byte-order slice).
 */
const MAX_FAILING_REPORT_LINES = 100;
const MAX_FAILURE_CASE_LINES = 200;

/**
 * cmd.exe refuses command lines past 8191 characters, and containerized
 * execve enforces ARG_MAX. A POM change at a mid-level aggregator closes
 * over every aggregation AND inheritance descendant, and on the 200-400
 * module reactors this adapter targets the comma-joined `-pl` selector can
 * approach those limits — a command line the platform refuses to launch is
 * not a scope. Past the cap the run widens to the full reactor instead.
 * 4096 leaves headroom for the executable, flags, and environment.
 */
const MAX_SELECTOR_CHARS = 4096;

/**
 * Cap evidence files before reading them: Surefire/Failsafe XML is
 * PR-controlled (the PR's own tests can write into `target/surefire-reports/`
 * during the run, and the mtime freshness filter accepts any writer), so an
 * uncapped read of a multi-gigabyte file is this harness's own denial-of-
 * service surface. 2 MiB is far beyond any realistic per-class report; an
 * oversized file simply contributes no evidence.
 */
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/**
 * `.mvn/maven.config` carries the same class of cap: it is read line-based
 * (each non-empty, non-`#` line is ONE argument — an argument may carry a
 * space, e.g. `ci/my settings.xml`), and an uncapped multi-megabyte config
 * a PR commits is this harness's own denial-of-service surface — measured at
 * 37 MB the read/tokenize costs seconds of synchronous CPU and hundreds of
 * MB of transient heap, scaling linearly to GitHub's 100 MB per-file limit.
 * An oversized config contributes no settings inputs (and reads ambiguous).
 */
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

/**
 * Cap the report sweep: it walks the worktree for `target/<report-dir>`
 * directories, and a PR controls how many directories exist. Past the cap the
 * sweep stops and reports the truncation — a truncated sweep can miss failure
 * evidence, so the run refuses to certify a pass (see `evidenceCapped`).
 */
const MAX_SCANNED_DIRS = 20_000;

/**
 * Bound the enumeration of ONE directory as well as the sweep's scan count:
 * `readdirSync` materializes the full Dirent array at once, and a PR-
 * controlled wide fan-out (a single directory holding hundreds of thousands
 * of children) made that array the sweep's dominant memory cost. Entries are
 * streamed through `opendirSync` and reading stops past this bound; the
 * directory then counts as truncation, failing closed like the scan cap.
 */
const MAX_DIR_ENTRIES = 10_000;

/**
 * Cap the sweep's PATH accumulation itself: every other cap bounds ONE
 * dimension (scanned dirs, entries per dir, report bytes), but nothing
 * bounded their product — 20k scanned dirs x both report dirs x 10k entries
 * each accumulates hundreds of millions of paths, and snapshotReports +
 * freshTestSummaries statSync and retain every one. A PR controls how many
 * directories and report files exist, so the product is this harness's own
 * denial-of-service surface. Past the cap the sweep stops collecting and
 * reports truncation, failing closed like the other caps.
 */
const MAX_REPORT_PATHS = 20_000;

/**
 * Cap the failing cases one report accumulates, while building it: the
 * display caps in appendTestSummaries apply after every report was
 * materialized, and one report can carry tens of thousands of failing
 * `<testcase>` entries. The dropped count still joins the omission
 * marker, so count adjudication sees the truncation.
 */
const MAX_FAILURE_CASES_PER_REPORT = 200;

/**
 * Below this much remaining whole-call budget a Maven command is NOT
 * attempted — the same floor as the npm adapter, for the same reason: Maven
 * cannot boot and produce signal in a few hundred milliseconds, so an
 * "attempt" would manufacture a fake timeout where an honest disclosure says
 * exactly what happened.
 */
const BUDGET_MIN_ATTEMPT_MS = 15_000;

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

function normalizedChangedPath(
  root: string,
  changedFile: string,
): string | null {
  const absolute = resolve(root, changedFile);
  if (!isInside(root, absolute)) return null;
  return toPosix(relative(root, absolute));
}

function isDocumentationPath(path: string): boolean {
  // Anchored to the WHOLE relative path: a DIRECTORY named `README` must
  // not exempt its entire subtree — files of any extension — from
  // verification.
  if (/^README(?:\.[^/]*)?$/i.test(path)) return true;
  // The `src/` guard alone would skip a compilable file under a module's
  // `doc/` tree; a documentation path is a documentation EXTENSION first.
  if (path.startsWith('src/')) return false;
  if (!/\.(?:md|mdx|adoc|rst|txt)$/i.test(path)) return false;
  // Outside `src/`, the extension alone is not enough: a `.txt` can be a
  // resource wired into the artifact (maven-resources-plugin points at
  // arbitrary dirs), and skipping the build on it would be a fail-open in an
  // otherwise fail-closed design. Exempt only doc-shaped locations: a
  // `docs?/` or `site/` tree, or the module/root top level itself.
  const dir = dirname(path);
  return dir === '.' || /^(?:docs?|site)$/i.test(dir.split('/')[0]);
}

/**
 * Repository metadata that cannot change what Maven builds: VCS/CI config,
 * licenses, editor rules. Anything NOT recognized here still runs the reactor
 * — a root `checkstyle.xml` or build script affects the build, and failing
 * closed costs time while failing open ships an unverified diff.
 */
function isRepoMetadataPath(path: string): boolean {
  // `[^/]*` keeps the LICENSE/NOTICE extension run inside the final
  // segment: a DIRECTORY with one of those names must not exempt its
  // subtree from verification.
  return (
    /^(?:\.git(?:ignore|attributes|modules)|\.editorconfig|CODEOWNERS|LICENSE(?:\.[^/]*)?|NOTICE(?:\.[^/]*)?)$/.test(
      path,
    ) || path.startsWith('.github/')
  );
}

/**
 * The Maven project directory that owns a path: the nearest ancestor holding a
 * `pom.xml`.
 *
 * Directories strictly beneath a `src/` tree are skipped. A POM there is OFTEN
 * test data — maven-invoker ITs, archetype fixtures,
 * `src/test/resources/projects/*` — but a reactor can also aggregate a real
 * module there (`<module>src/core</module>`). The skip is principled only
 * for the test-data shapes (`src/test/`, `src/it/`); when the walk collapses
 * onto a POM it skipped, it fails closed — to the ROOT always (`-pl .`
 * compiles only the root), and elsewhere unless every skipped POM was a
 * test-data shape — because `-pl <target> -am` adds only UPSTREAM projects,
 * so a mis-collapsed target leaves the changed module untested under a green
 * verdict. Returning null escalates the path to a reactor-wide run instead.
 *
 * Whether the project this returns is ACTIVE under the current profiles, JDK,
 * and `<modules>` inheritance is deliberately NOT decided here: Maven decides
 * it, by accepting or rejecting the `-pl` selector this ownership produces
 * (see SELECTOR_REJECTED_RE). Approximating that answer from the POM text
 * means shipping a second, weaker model of the thing the very next command
 * evaluates for real.
 */
function owningProject(root: string, path: string): string | null {
  let dir = dirname(join(root, path));
  let skippedPomBeneathSrc = false;
  let skippedTestDataOnly = true;
  while (isInside(root, dir)) {
    const rel = toPosix(relative(root, dir)) || '.';
    // Strictly BENEATH `src/`: a real project located exactly AT a `src` path
    // is not test data.
    if (/(?:^|\/)src\//.test(rel)) {
      if (existsSync(join(dir, 'pom.xml'))) {
        skippedPomBeneathSrc = true;
        // `src/test/` and `src/it/` trees are the principled fixture shapes
        // (invoker ITs, archetype test projects); any OTHER src/-nested POM
        // can be a real module a reactor aggregates (`<module>src/core</module>`).
        if (!/(?:^|\/)src\/(?:test|it)\//.test(rel)) {
          skippedTestDataOnly = false;
        }
      }
    } else if (existsSync(join(dir, 'pom.xml'))) {
      // Fail closed when the collapse cannot be trusted: at the ROOT a
      // skipped POM may be a real `<module>src/…</module>` and `-pl .`
      // would compile only the root, and anywhere else a skipped POM that
      // is not a test-data shape is the same risk — `-pl <target> -am`
      // adds only UPSTREAM projects, so the changed module would go
      // untested under a green verdict. Null escalates to reactor-wide.
      if (skippedPomBeneathSrc && (rel === '.' || !skippedTestDataOnly)) {
        return null;
      }
      return rel;
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  return null;
}

export function detectMavenOwnership(
  root: string,
  changedFiles: readonly string[],
  platform: string = process.platform,
): MavenOwnership {
  const modules = new Set<string>();
  let reactorWide = false;
  // A settings/repository file the config itself declares is a build input
  // no matter where it lives — the metadata exemption below must not
  // swallow it (a `-s .github/settings.xml` change redirects resolution).
  const configDeclaredInputs = new Set(
    analyzeMavenConfig(root).dependencyInputs,
  );
  // Every wrapper repo ships both platform variants, but only one is ever
  // executed: a change confined to the OTHER platform's wrapper cannot affect
  // this platform's run, so it neither escalates to reactor-wide nor falls
  // into the unowned catch-all (which would run the whole reactor to verify
  // nothing).
  const otherPlatformWrapper = platform === 'win32' ? 'mvnw' : 'mvnw.cmd';

  for (const changedFile of changedFiles) {
    const path = normalizedChangedPath(root, changedFile);
    if (path === null) continue;
    if (path === otherPlatformWrapper) continue;
    if (REACTOR_WIDE_FILES.has(path) || path.startsWith('.mvn/')) {
      reactorWide = true;
      continue;
    }
    // A settings/repository file the config itself declares is a build input
    // no matter where it lives or which project owns it — the
    // documentation/metadata exemptions below must not swallow it (a
    // `-s .github/settings.xml` change redirects resolution), so it
    // escalates to reactor-wide ahead of every ownership reading.
    if (configDeclaredInputs.has(path)) {
      reactorWide = true;
      continue;
    }
    const owner = owningProject(root, path);
    if (owner === null) {
      // Outside every Maven project. Documentation and repository metadata
      // cannot change what Maven builds; anything else can.
      if (!isDocumentationPath(path) && !isRepoMetadataPath(path)) {
        reactorWide = true;
      }
      continue;
    }
    // A project's own POM is parent config: Maven merges it into every project
    // that aggregates it or declares it as `<parent>`, and this adapter models
    // none of those edges — `-pl <owner> -am` would compile the aggregator and
    // test nothing that actually changed. A POM change runs the reactor and
    // lets Maven apply the real inheritance.
    if (path === (owner === '.' ? 'pom.xml' : `${owner}/pom.xml`)) {
      reactorWide = true;
      continue;
    }
    if (owner === '.') {
      if (isDocumentationPath(path) || isRepoMetadataPath(path)) continue;
      // Source owned by the root project scopes to `-pl . -am`: no other
      // module compiles the root artifact's own `src/`, and on the large
      // reactors this adapter targets a reactor-wide run can spend its whole
      // deadline proving nothing. Anything ELSE at the root (a build script, a
      // checkstyle config) can affect every module.
      if (path === 'src' || path.startsWith('src/')) modules.add('.');
      else reactorWide = true;
      continue;
    }
    // Documentation and metadata are judged MODULE-relatively, so the `src/`
    // guard means the module's own source tree: `core/README.md` is a no-op
    // run, but `core/src/test/resources/expected.txt` is test data and must
    // keep building.
    const inModule = path.slice(owner.length + 1);
    if (isDocumentationPath(inModule) || isRepoMetadataPath(inModule)) continue;
    modules.add(owner);
  }

  return { reactorWide, modules: [...modules].sort() };
}

interface ReportSnapshot {
  mtimes: Map<string, number>;
  /** The pre-run sweep stopped early: the freshness baseline is incomplete. */
  truncated: boolean;
}

interface MavenTestSummary {
  report: string;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  failedCases: string[];
  /** Failing cases dropped by MAX_FAILURE_CASES_PER_REPORT while parsing. */
  droppedCases: number;
}

/**
 * A directory's entries, streamed one at a time so a PR-controlled wide
 * fan-out cannot materialize an unbounded Dirent array. Reading stops past
 * MAX_DIR_ENTRIES and reports the truncation; an unreadable directory
 * returns null.
 */
function readDirBounded(
  dir: string,
): { entries: Dirent[]; truncated: boolean } | null {
  let handle;
  try {
    handle = opendirSync(dir);
  } catch {
    return null;
  }
  const entries: Dirent[] = [];
  let truncated = false;
  try {
    for (;;) {
      // Read BEFORE the cap check: a directory holding exactly
      // MAX_DIR_ENTRIES entries is read to exhaustion and must not report
      // truncation — the flag propagates to evidenceCapped and would
      // refuse certification of a fully-read green run.
      const entry = handle.readSync();
      if (entry === null) break;
      if (entries.length >= MAX_DIR_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } catch {
    // A mid-read throw (EIO/ESTALE on a network-backed worktree) is the
    // same epistemic state as an unreadable directory: join the fail-closed
    // truncation path instead of escaping the sweep.
    return null;
  } finally {
    // A failing close must not throw past both the truncation logic and the
    // return-null rescue — the fail-closed guarantee covers it too.
    try {
      handle.closeSync();
    } catch {
      truncated = true;
    }
  }
  return { entries, truncated };
}

/**
 * Every `<projectDir>/target/<report-dir>/*.xml` in the worktree.
 *
 * The sweep walks the tree rather than a list of reactor projects: which
 * projects are active is Maven's answer, not this adapter's, and a report
 * directory only exists where Maven actually ran. Symlinks are never
 * followed: a Dirent's `isDirectory()` is false for one, and the report-dir
 * read itself is gated on `lstatSync` (which does not resolve the link), so
 * neither the descent nor the direct listing can escape the worktree.
 *
 * `truncated` reports that the sweep stopped early — the scanned-directory
 * cap, the per-directory fan-out bound, an unreadable directory, or a queue
 * that outgrew the scan budget. A truncated sweep can miss failure evidence,
 * so the caller fails closed on it exactly like the fresh-report cap.
 */
export function reportPaths(
  root: string,
  maxScannedDirs: number = MAX_SCANNED_DIRS,
): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  const queue: string[] = [root];
  let scanned = 0;
  let truncated = false;
  let pathsCapped = false;
  while (queue.length > 0 && scanned < maxScannedDirs && !pathsCapped) {
    const dir = queue.pop() as string;
    scanned += 1;
    const listing = readDirBounded(dir);
    // An unreadable directory is the same epistemic state as the caps: the
    // sweep did not see everything, so it fails closed instead of skipping on.
    if (listing === null) {
      truncated = true;
      continue;
    }
    if (listing.truncated) truncated = true;
    for (const entry of listing.entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const child = join(dir, entry.name);
      if (entry.name !== 'target') {
        // A wide fan-out can enqueue far more directories than the scan
        // budget will ever pop; the backlog itself is the memory cost, so
        // stop enqueuing and count it as truncation. Not pinnable by a
        // behavior test: the end-of-loop `queue.length > 0` check sets the
        // same flag whenever this guard fires, and which paths survive the
        // LIFO pop depends on the filesystem's entry order — the bound is
        // the point, not the observable outcome.
        if (queue.length >= maxScannedDirs) {
          truncated = true;
          continue;
        }
        queue.push(child);
        continue;
      }
      // Never descend INTO `target`: it holds unpacked dependencies and
      // generated sources, and the only paths of interest sit one level down.
      for (const reportDir of REPORT_DIRS) {
        const reports = join(child, reportDir);
        // lstat does NOT follow a symlink: a symlinked report dir would
        // resolve outside the worktree and inject its stale reports as
        // fresh evidence.
        try {
          if (!lstatSync(reports).isDirectory()) continue;
        } catch (error) {
          // Absence (ENOENT/ENOTDIR) is 'no reports dir here'; any OTHER
          // error — EACCES on an unreadable `target`, chmod 000 within the
          // threat model this file grants — means the sweep did not see
          // everything and must fail closed like the sibling caps.
          if (
            (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
            (error as NodeJS.ErrnoException).code !== 'ENOTDIR'
          ) {
            truncated = true;
          }
          continue;
        }
        const files = readDirBounded(reports);
        if (files === null) {
          truncated = true;
          continue;
        }
        if (files.truncated) truncated = true;
        for (const file of files.entries) {
          if (paths.length >= MAX_REPORT_PATHS) {
            pathsCapped = true;
            break;
          }
          if (file.isFile() && file.name.endsWith('.xml')) {
            paths.push(join(reports, file.name));
          }
        }
        if (pathsCapped) break;
      }
      if (pathsCapped) break;
    }
  }
  if (pathsCapped) truncated = true;
  if (queue.length > 0) truncated = true;
  return { paths, truncated };
}

function snapshotReports(root: string): ReportSnapshot {
  // Freshness is an mtime comparison, and some filesystems resolve mtimes at
  // 1s granularity: a report rewritten inside the same tick reads as stale and
  // is dropped. That degrades in the safe direction — absent test-count
  // evidence, never a wrong verdict — so no sub-second workaround is worth it.
  const { paths, truncated } = reportPaths(root);
  const mtimes = new Map<string, number>();
  for (const path of paths) {
    try {
      mtimes.set(path, statSync(path).mtimeMs);
    } catch {
      // The report disappeared while the snapshot was being taken.
    }
  }
  return { mtimes, truncated };
}

/**
 * Parse one Surefire/Failsafe XML report with a STRICT XML parser (saxes):
 * well-formedness, CDATA, comments, entities, self-closing tags, and
 * nesting are the parser's job. This replaces a hand-rolled tag walk whose
 * surface kept growing one adversarial XML corner per review round —
 * the same anti-pattern the review skill once hit with a hand-rolled
 * CommonMark scanner and closed by adopting a real parser (#9020).
 *
 * The strictness IS the threat model: reports live in worktree files the PR
 * controls, so anything the parser rejects is unreadable verdict evidence —
 * fail-closed, joined with the other rejections, never read green. Content
 * the parser treats as text (a `<failure>` sample inside `<system-out>`,
 * CDATA-wrapped stdout, commented-out markup) can therefore never be read
 * as verdict markup, by construction.
 *
 * A bare multi-`<testsuite>` document with no root element is malformed XML
 * and rejects like any other shape; aggregate writers that wrap their
 * suites in a `<testsuites>` root parse normally and every suite counts.
 */
function parseTestReport(
  root: string,
  path: string,
): MavenTestSummary | 'no-suites' | null {
  let xml: string;
  try {
    // The size cap bounds parse cost on PR-controlled files; a reject here
    // joins the other fail-closed rejections upstream.
    if (statSync(path).size > MAX_REPORT_BYTES) return null;
    xml = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  // A BOM would trip the parser's grammar before the declaration; real
  // writers emit one, so strip it rather than fail-closing a valid report.
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);

  const parser = new SaxesParser();
  // saxes reports well-formedness errors through the error event and keeps
  // going; the first one condemns the whole report, and every handler
  // below stops acting once it fires.
  let malformed = false;
  parser.on('error', () => {
    malformed = true;
  });

  let suites = 0;
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  const failedCases: string[] = [];
  let droppedCases = 0;

  const countAttribute = (
    attributes: Record<string, string>,
    name: string,
  ): number => {
    const value = Number.parseInt(attributes[name] ?? '0', 10);
    // A malformed report's negative count must not cancel legitimate
    // counts from its neighbours when totals roll up across reports.
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  };

  // The testcase currently open, if any: `<failure>`/`<error>` elements
  // belong to it. saxes fires closetag for self-closing tags too, so the
  // stack cannot drift.
  const openCases: Array<{
    className: string;
    name: string;
    failing: boolean;
  }> = [];

  parser.on('opentag', (node) => {
    if (malformed) return;
    const name = node.name.toLowerCase();
    if (name === 'testsuite') {
      // Aggregate counts across EVERY suite in the file: aggregate JUnit
      // writers emit several `<testsuite>` elements under a `<testsuites>`
      // root, and reading only the first undercounts later failures.
      suites += 1;
      tests += countAttribute(node.attributes, 'tests');
      failures += countAttribute(node.attributes, 'failures');
      errors += countAttribute(node.attributes, 'errors');
      skipped += countAttribute(node.attributes, 'skipped');
    } else if (name === 'testcase') {
      openCases.push({
        className: node.attributes['classname'] ?? '',
        name: node.attributes['name'] ?? '',
        failing: false,
      });
    } else if (
      (name === 'failure' || name === 'error') &&
      openCases.length > 0
    ) {
      openCases[openCases.length - 1].failing = true;
    }
  });
  parser.on('closetag', (node) => {
    if (malformed) return;
    if (node.name.toLowerCase() !== 'testcase') return;
    const testcase = openCases.pop();
    if (testcase === undefined || !testcase.failing) return;
    if (failedCases.length >= MAX_FAILURE_CASES_PER_REPORT) {
      // Keep counting but stop materializing: one report can carry tens of
      // thousands of failing cases, and the display cap in
      // appendTestSummaries only ever shows a bounded prefix — the dropped
      // count still joins the omission marker.
      droppedCases += 1;
      return;
    }
    const caseName = testcase.name === '' ? 'unknown' : testcase.name;
    failedCases.push(
      testcase.className === ''
        ? caseName
        : `${testcase.className}#${caseName}`,
    );
  });

  parser.write(xml);
  parser.close();
  if (malformed) return null;
  // A file read IN FULL that carries zero <testsuite> elements contributes
  // no evidence and no gap — its failure status is provably known-empty,
  // unlike the rejections the caller counts.
  if (suites === 0) return 'no-suites';
  return {
    report: toPosix(relative(root, path)),
    tests,
    failures,
    errors,
    skipped,
    failedCases,
    droppedCases,
  };
}

function freshTestSummaries(
  root: string,
  before: ReportSnapshot,
): {
  summaries: MavenTestSummary[];
  rejected: number;
  truncated: boolean;
} {
  const fresh: string[] = [];
  const { paths, truncated } = reportPaths(root);
  for (const path of paths) {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const previous = before.mtimes.get(path);
    if (previous !== undefined && mtime <= previous) continue;
    fresh.push(path);
  }
  // Byte-order, not localeCompare: evidence-line order must not depend on
  // the host's ICU/locale settings (readdir order is not). All paths share
  // the same root prefix, so absolute and relative order agree.
  fresh.sort();
  const summaries: MavenTestSummary[] = [];
  // EVERY fresh report is parsed — a count cap once let failures ordered
  // past the cap certify green, because the parsed prefix read clean while
  // the unread remainder's failure status was unknown. The sweep's path cap
  // and the per-file size cap bound the cost; a parse the strict parser
  // REFUSES (oversized, unreadable, or malformed) is unknown evidence and
  // fails closed: a disclosed gap there is one a PR can weaponize to hide
  // a failing report. A zero-suite file read in full is the opposite —
  // known-empty, no gap.
  let rejected = 0;
  for (const path of fresh) {
    const parsed = parseTestReport(root, path);
    if (parsed === 'no-suites') continue;
    if (parsed) summaries.push(parsed);
    else rejected += 1;
  }
  return {
    summaries,
    rejected,
    // A truncated PRE-run sweep makes the freshness baseline incomplete (a
    // committed stale report the pre-walk missed reads as fresh), so both
    // truncations fail closed.
    truncated: truncated || before.truncated,
  };
}

/** Report paths are always `<projectDir>/target/<report-dir>/<file>` (see reportPaths). */
function projectDirOf(report: string): string {
  return dirname(dirname(dirname(report)));
}

/**
 * Marker lines are mined line-by-line from `output` by the classifiers and
 * by test-plan: a newline or control character in a PR-controlled report
 * path or case name would split the marker and forge a second line inside
 * the scanned output.
 */
function markerSafe(text: string): string {
  // U+2028/U+2029 are line terminators for the `m`-flag regexes that mine
  // these markers, so a PR-controlled name carrying one (saxes decodes
  // `&#8232;` to a real U+2028) could forge or split a marker line — strip
  // them with the ASCII controls.
  // eslint-disable-next-line no-control-regex -- control chars are what gets stripped
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '_');
}

/** Evidence the run could not read: rejected by the parser, or unseen past a truncated sweep. */
interface FreshEvidenceGaps {
  rejected: number;
  truncated: boolean;
}

/**
 * NOTE: the `[maven-test-report]`/`[maven-test-failure]` markers below are
 * text-mined by test-plan out of `output`, which is dominated by the PR's
 * own test stdout — like the npm console-summary parsing, they are NOT
 * tamper-proof. Verdicts that must survive a hostile PR belong in a
 * structured report field, not in mined text.
 */
function appendTestSummaries(
  result: CommandResult,
  summaries: MavenTestSummary[],
  gaps: FreshEvidenceGaps,
): CommandResult {
  if (summaries.length === 0 && gaps.rejected === 0 && !gaps.truncated) {
    return result;
  }

  const clean = new Map<string, MavenTestSummary[]>();
  const failing: MavenTestSummary[] = [];
  for (const summary of summaries) {
    if (summaryIsFailing(summary)) {
      failing.push(summary);
    } else {
      const project = projectDirOf(summary.report);
      const group = clean.get(project);
      if (group) group.push(summary);
      else clean.set(project, [summary]);
    }
  }

  const lines: string[] = [];
  const cleanGroups = [...clean.entries()].map(([project, group]) => {
    // The printed totals are the per-report CLAMPED passed sum, not raw
    // Σtests/Σskipped: test-plan parses counts per LINE with its own clamp,
    // and Surefire does not guarantee tests >= skipped within one report
    // (class-level @Disabled), so raw pre-aggregated totals would parse to
    // a different passed count than the clamped per-report truth.
    const clampedPassed = group.reduce(
      (sum, item) => sum + Math.max(0, item.tests - item.skipped),
      0,
    );
    return (
      `[maven-test-report] ${markerSafe(project)} (${group.length} report(s)): ` +
      `tests=${clampedPassed}, failures=0, errors=0, skipped=0`
    );
  });
  const cleanLines = cleanGroups;
  // One line per project dir, UNcapped: bounded by module count, and every
  // project keeps its own attributed line — a cap here once dropped module
  // attribution past the bound, mis-ruling a scoped count claim whose
  // module landed in the omitted tail.
  lines.push(...cleanLines);

  // One line per PROJECT dir, like the clean rollup: per-report lines
  // collapsed into a byte-order slice that lost ALL module attribution past
  // the cap — an upstream module's hundred failing reports pushed the claimed
  // module's one past the bound, its failure vanished from every line
  // test-plan attributes with, and the `-am` carve-out discarded the run.
  // The rollup keeps attribution to the module count, and the failure count
  // is floored at the body evidence like the failing bucket itself.
  const failedCount = (summary: MavenTestSummary): number =>
    Math.max(
      summary.failures + summary.errors,
      summary.failedCases.length + summary.droppedCases,
    );
  const failingByProject = new Map<string, MavenTestSummary[]>();
  for (const summary of failing) {
    const project = projectDirOf(summary.report);
    const group = failingByProject.get(project);
    if (group) group.push(summary);
    else failingByProject.set(project, [summary]);
  }
  const reportLines = [...failingByProject.entries()].map(
    ([project, group]) => {
      const failures = group.reduce((sum, item) => sum + failedCount(item), 0);
      // Per-report CLAMPED passed totals, for the same count-preservation
      // reason as the clean rollup: test-plan clamps per parsed LINE, and
      // Surefire does not guarantee tests >= failures + skipped within one
      // report (class-level @Disabled, rerunFailingTestsCount reruns), so
      // raw pre-aggregated totals would let one anomalous report cancel its
      // batchmates' passed counts. Emitting tests = passed + failures with
      // skipped zeroed makes the line clamp parse back to `passed` while
      // `failures` stays non-zero for failureInsideClaim attribution.
      const passed = group.reduce(
        (sum, item) =>
          sum + Math.max(0, item.tests - failedCount(item) - item.skipped),
        0,
      );
      return (
        `[maven-test-report] ${markerSafe(project)} (${group.length} failing report(s)): ` +
        `tests=${passed + failures}, failures=${failures}, errors=0, skipped=0`
      );
    },
  );
  if (reportLines.length > MAX_FAILING_REPORT_LINES) {
    const omittedProjects = [...failingByProject.entries()].slice(
      MAX_FAILING_REPORT_LINES,
    );
    reportLines.length = MAX_FAILING_REPORT_LINES;
    const omittedSummaries = omittedProjects.flatMap(([, group]) => group);
    // Per-report clamped passed totals and zeroed failure fields, for the
    // same count-preservation reason as the clean marker above.
    const passed = omittedSummaries.reduce(
      (sum, item) =>
        sum + Math.max(0, item.tests - failedCount(item) - item.skipped),
      0,
    );
    reportLines.push(
      `[maven-test-report] ${omittedProjects.length} more failing project rollup(s) omitted: ` +
        `tests=${passed}, failures=0, errors=0, skipped=0`,
    );
    // The case lines below carry their own cap, so BOTH attribution
    // channels can drop the same module's evidence on a wide-enough
    // reactor: keep one module-prefixed failure marker per omitted
    // project, or the `-am` carve-out in test-plan discards a run that
    // failed inside the claim and reads it unchecked where a narrower
    // reactor contradicts.
    for (const [project, group] of omittedProjects) {
      const failures = group.reduce((sum, item) => sum + failedCount(item), 0);
      reportLines.push(
        `[maven-test-failure] ${project === '.' ? '' : `${markerSafe(project)}/`}target/: ` +
          `${failures} failure(s) past the ${MAX_FAILING_REPORT_LINES}-project rollup cap`,
      );
    }
  }
  lines.push(...reportLines);

  const caseLines = failing.flatMap((summary) => {
    const cases = summary.failedCases.map(
      (testcase) =>
        `[maven-test-failure] ${markerSafe(summary.report)}: ${markerSafe(testcase)}`,
    );
    // The invariant test-plan's guards key on: failures>0 ⇒ at least one
    // [maven-test-failure] line. A report whose <testsuite> header records
    // failures with no failing <testcase> body emits none — hold the
    // invariant with a fallback line rather than letting the failure
    // vanish from the mined text.
    if (cases.length === 0 && summary.droppedCases === 0) {
      cases.push(
        `[maven-test-failure] ${markerSafe(summary.report)}: ${summary.failures} ` +
          `failure(s), ${summary.errors} error(s) recorded without case detail`,
      );
    }
    return cases;
  });
  // The per-report parse cap dropped cases BEFORE this point; their count
  // joins the omission marker so count adjudication sees the truncation.
  const droppedCases = failing.reduce(
    (sum, summary) => sum + summary.droppedCases,
    0,
  );
  const totalCaseLines = caseLines.length + droppedCases;
  if (totalCaseLines > MAX_FAILURE_CASE_LINES) {
    const omitted = totalCaseLines - MAX_FAILURE_CASE_LINES;
    caseLines.length = Math.min(caseLines.length, MAX_FAILURE_CASE_LINES);
    caseLines.push(
      `[maven-test-failure] ${omitted} more failing case(s) omitted`,
    );
  }
  lines.push(...caseLines);

  if (gaps.rejected > 0) {
    lines.push(
      `[maven-test-report] ${gaps.rejected} fresh report(s) could not be parsed ` +
        '(oversized or unreadable): their failure status is unknown',
    );
  }
  if (gaps.truncated) {
    lines.push(
      '[maven-test-report] the report sweep was truncated (a scan cap was ' +
        'reached, a directory could not be read, or the report-path ' +
        'accumulation cap was reached), so some fresh reports may be unseen',
    );
  }

  return { ...result, output: `${result.output}\n${lines.join('\n')}`.trim() };
}

function unsupportedReport(note: string): BuildTestReport {
  return {
    toolchain: 'unsupported',
    affected: [],
    buildSet: [],
    widenedWith: [],
    install: null,
    build: [],
    test: [],
    ok: true,
    timedOut: [],
    note,
  };
}

/**
 * How a non-clean best-effort dependency warm-up ended. The timeout note
 * quotes the deadline that was actually applied — the whole-call budget
 * shortens it below the `--timeout` flag — not the flag default.
 */
function warmUpOutcome(
  install: CommandResult,
  deadlineSeconds: number,
): string {
  return (
    `Dependency warm-up (\`${install.command}\`) ` +
    (install.timedOut
      ? `ran out of time (${deadlineSeconds}s)`
      : install.exitCode === null
        ? 'ended without an exit code (a spawn failure or signal outside the deadline)'
        : `exited ${install.exitCode}`)
  );
}

function mavenReport(
  fields: Omit<BuildTestReport, 'toolchain'>,
): BuildTestReport {
  return { toolchain: 'maven', ...fields };
}

/**
 * Maven-framed disk exhaustion. The line-level form is exported so
 * `build-test`'s output trim rescues it from the omitted middle — the
 * classification below runs on that trimmed output, and an ENOSPC line
 * lost to the trim would file a disk failure against the PR (or, under
 * fail-never, read the run green).
 */
const DISK_FAILURE_LINE_RE = /^\[(?:ERROR|FATAL)\].*No space left on device/i;

export function isDiskFailureLine(line: string): boolean {
  return DISK_FAILURE_LINE_RE.test(line);
}

/**
 * Shell and JVM launch diagnostics. The runner-missing and JAVA_HOME forms
 * are printed bare by the shell or the mvn launcher — never with Maven
 * framing — so requiring `[ERROR]` there would miss the real thing. The
 * unframed scan therefore stops at the first Maven-framed line: these
 * diagnostics precede any Maven output, and once Maven is talking, a test
 * printing `mvn: command not found` in its own stdout must not launder a
 * source failure into infrastructure. `No space left on device` is different:
 * a test exercising a disk-full path can print it in its own stdout at any
 * point, so only Maven's own `[ERROR]`/`[FATAL]` framing tells the outage
 * from test output — the same argument DEPENDENCY_FAILURE_LINE_RE encodes.
 */
function isLaunchFailure(output: string): boolean {
  const lines = output.split('\n');
  const prelude: string[] = [];
  for (const line of lines) {
    if (/^\[(?:INFO|WARNING|ERROR|FATAL)\]/.test(line)) break;
    prelude.push(line);
  }
  return (
    prelude.some(
      (line) =>
        /(?:mvn|java): (?:command )?not found/i.test(line) ||
        /command not found: (?:mvn|java)(?:\.cmd)?\b/i.test(line) ||
        /(?:mvn|java)(?:\.cmd)?'? is not recognized as an internal or external command/i.test(
          line,
        ) ||
        /The term '?(?:mvn|java)'? is not recognized/i.test(line) ||
        /Unknown command: (?:mvn|java)\b/i.test(line) ||
        /JAVA_HOME.*(?:not defined|not found|incorrectly|invalid directory)/i.test(
          line,
        ) ||
        /Unable to locate a Java Runtime/i.test(line) ||
        // Wrapper bootstrap failures: the distribution download dies before
        // Maven's JVM starts, so these wordings can only appear in the
        // unframed prelude — the canonical cold-worktree acquisition
        // failure, and every review worktree is cold. The wordings are the
        // ones the real wrappers emit (apache/maven-wrapper and takari both
        // try wget BEFORE curl): apache prints the SHA-256 message verbatim
        // on a checksum mismatch, and downloader errors carry curl's
        // `curl: (N)` or wget's `wget: …` shapes.
        /Failed to validate Maven (?:distribution|wrapper)/i.test(line) ||
        /Maven distribution.*(?:checksum|corrupt|compromised|invalid)/i.test(
          line,
        ) ||
        /Failed to download Maven distribution/i.test(line) ||
        // The checksum-tool message both wrapper generations print when a
        // checksum was requested and neither sha256sum nor shasum exists.
        /^Checksum validation was requested but neither/i.test(line) ||
        // The curl fallback's die message — `curl --silent` suppresses
        // curl's own `curl: (N)` line, so the wrapper's die wording is the
        // only one on hosts without wget (every macOS host, slim Linux
        // containers).
        /^curl: Failed to fetch/i.test(line) ||
        /^(?:curl: \(\d+\)|wget: )/.test(line),
    ) || lines.some(isDiskFailureLine)
  );
}

/**
 * Dependency/network/plugin failures count only when Maven itself frames them:
 * a test that fails printing `Connection refused` in its stdout is a source
 * finding, not a network outage, and free-text matching cannot tell the two
 * apart. Maven's own error lines carry the `[ERROR]`/`[FATAL]` prefix. The
 * line-level form is exported so `build-test`'s output trim rescues these from
 * the omitted middle — the classification below runs on that trimmed output,
 * and a marker lost to the trim would file a network outage against the PR.
 */
const DEPENDENCY_FAILURE_LINE_RE =
  /^\[(?:ERROR|FATAL)\].*(?:Could not resolve dependencies|Failed to (?:collect|read artifact descriptor)|Could not transfer artifact|Could not find artifact|Failure to find|Non-resolvable parent POM|Non-resolvable import POM|PluginResolutionException|DependencyResolutionException|No plugin found for prefix|Unknown host|Name or service not known|Temporary failure in name resolution|Connection (?:reset|refused|timed out)|PKIX path building failed|status code: (?:401|403|407|429|5\d\d))/i;

export function isDependencyFailureLine(line: string): boolean {
  return DEPENDENCY_FAILURE_LINE_RE.test(line);
}

function isDependencyFailure(output: string): boolean {
  return output.split('\n').some(isDependencyFailureLine);
}

/**
 * Compile and test failure markers Maven itself prints once a run reaches
 * building or executing code. A dependency outage can share the output with
 * them (a flaky mirror, or an upstream module pulled in by `-am`), and the
 * acquisition carve-out must not launder the source failure into an
 * infrastructure result: a compile failure writes no Surefire XML, so
 * `freshFailures` cannot see it. `[ERROR]`-framed and line-level like
 * DEPENDENCY_FAILURE_LINE_RE, for the same trim-rescue reason.
 *
 * The line shapes cover the JVM compilers Maven hosts: Java's `.java:[l,c]`,
 * Kotlin's `.kt: (l, c):`, Scala's `.scala:l:`, Groovy's `.groovy: l:`, plus
 * the compiler-plugin goal framing a failed compile ends with.
 */
const SOURCE_FAILURE_LINE_RE =
  /^\[(?:ERROR|FATAL)\](?: COMPILATION ERROR| There are test failures| .*\.java:\[\d+,\d+\]| .*\.kts?: ?\(\d+, ?\d+\)| .*\.scala:\d+| .*\.groovy: ?\d+| Failed to execute goal .*Compilation failure)/i;

export function isSourceFailureLine(line: string): boolean {
  return SOURCE_FAILURE_LINE_RE.test(line);
}

function isSourceFailure(output: string): boolean {
  return output.split('\n').some(isSourceFailureLine);
}

/**
 * Maven's framing for ANY failed goal. Under fail-never Maven exits 0 over
 * every plugin failure, and the class predicates above only recognize the
 * compile/dependency/launch shapes: a checkstyle, enforcer, spotless, or
 * jacoco-check goal failure matches none of them, and the zero exit would
 * read green. Kept OUT of SOURCE_FAILURE_LINE_RE: a dependency failure's
 * `Failed to execute goal on project …` framing must keep reaching the
 * dependency class, and the acquisition carve-out negates only the narrow
 * source predicate — this wider one feeds the swallowed-failure check.
 */
const GOAL_FAILURE_LINE_RE = /^\[(?:ERROR|FATAL)\] Failed to execute goal /i;

export function isGoalFailureLine(line: string): boolean {
  return GOAL_FAILURE_LINE_RE.test(line);
}

function isGoalFailure(output: string): boolean {
  return output.split('\n').some(isGoalFailureLine);
}

/**
 * Surefire's marker that a skip setting suppressed the entire test phase.
 * Printed for `-DskipTests`, `-Dmaven.test.skip=true`, and POM-configured
 * `<skipTests>` alike — the one line that distinguishes "tested, zero
 * reports" from "never tested at all".
 */
const TESTS_SKIPPED_LINE_RE = /^\[INFO\] Tests are skipped\./;

export function isTestsSkippedLine(line: string): boolean {
  return TESTS_SKIPPED_LINE_RE.test(line);
}

/**
 * Maven-framed framing predicate shared by the never-ran and bootstrap
 * checks: once any `[INFO]`/`[WARNING]`/`[ERROR]`/`[FATAL]` line exists,
 * Maven's JVM ran.
 */
const MAVEN_FRAMED_LINE_RE = /^\[(?:INFO|WARNING|ERROR|FATAL)\]/;

function hasMavenFramedLine(output: string): boolean {
  return output.split('\n').some((line) => MAVEN_FRAMED_LINE_RE.test(line));
}

/**
 * Surefire prints a framed `Tests run: N, Failures: M, Errors: K` summary
 * per module (and again under `Results:`) even under `testFailureIgnore`,
 * when the exit code is 0. A FAILING module is `[ERROR]`-framed (verified on
 * Maven 3.8.7 / Surefire 3.2.5, both the per-test-set and the Results line),
 * a green one `[INFO]` — anchoring on `[INFO]` alone made the cross-check
 * dead against real failing output. The report sweep can miss reports
 * written to a non-default `<reportsDirectory>`, so the stdout summary is
 * the cross-check that keeps a relocated failing report from certifying
 * green. The line-level form is exported so `build-test`'s output trim
 * rescues these from the omitted middle — the classification and the
 * cross-check both run on that trimmed output.
 */
const SUREFIRE_SUMMARY_LINE_RE =
  /^\[(?:INFO|ERROR|FATAL)\] Tests run: \d+, Failures: (\d+), Errors: (\d+)/;

export function isSurefireSummaryLine(line: string): boolean {
  return SUREFIRE_SUMMARY_LINE_RE.test(line);
}

/**
 * A Surefire stdout summary recording failures. The line-level form exists
 * for the same reason its siblings do: `build-test`'s trim rescue keeps
 * these lines ahead of benign matches, and the exit-0 cross-check reads
 * them from the trimmed output.
 */
export function isFailingSurefireSummaryLine(line: string): boolean {
  const match = SUREFIRE_SUMMARY_LINE_RE.exec(line);
  return match !== null && (Number(match[1]) > 0 || Number(match[2]) > 0);
}

function hasStdoutTestFailure(output: string): boolean {
  return output.split('\n').some(isFailingSurefireSummaryLine);
}

/**
 * A report is failing on its header counts OR its body evidence: a report
 * whose `failures="0" errors="0"` attributes contradict its `<failure>`/
 * `<error>` testcase bodies (a green-wash the file's threat model admits —
 * PR-writable reports rewritten after the run) is failing, and the parsed
 * proof of failure is not discarded.
 */
function summaryIsFailing(summary: MavenTestSummary): boolean {
  return (
    summary.failures > 0 ||
    summary.errors > 0 ||
    summary.failedCases.length > 0 ||
    summary.droppedCases > 0
  );
}

function hasFreshTestFailure(summaries: MavenTestSummary[]): boolean {
  return summaries.some(summaryIsFailing);
}

/**
 * Maven's rejection of a `-pl` selector naming a project it does not have in
 * the active reactor. This is the ONE piece of Maven's model this adapter
 * reads back, and it reads it from Maven rather than recomputing it: profile
 * activation, `<modules>` inheritance, and JDK-conditional membership all land
 * here already evaluated.
 */
const SELECTOR_REJECTED_RE =
  /^\[(?:ERROR|FATAL)\] Could not find the selected project in the reactor:\s*([^\n]*)/m;

function summaryTotals(summaries: MavenTestSummary[]) {
  return summaries.reduce(
    (sum, item) => {
      const headerFailed = item.failures + item.errors;
      const bodyFailed = item.failedCases.length + item.droppedCases;
      return {
        tests: sum.tests + item.tests,
        // Body evidence is authoritative like the failing bucket's: a
        // zeroed header over failing bodies still reports a non-zero total.
        failures:
          sum.failures + item.failures + Math.max(0, bodyFailed - headerFailed),
        errors: sum.errors + item.errors,
        skipped: sum.skipped + item.skipped,
      };
    },
    { tests: 0, failures: 0, errors: 0, skipped: 0 },
  );
}

/**
 * The `-pl` argument for a module set, or null when it cannot be handed to a
 * shell safely — the caller then widens to the full reactor.
 *
 * These are directory names read off disk, so the character gate lives here:
 * nothing upstream filters them any more. `,` separates `-pl` arguments and
 * `:` makes Maven read a selector as `[groupId]:artifactId` coordinates
 * instead of a path, so both change the MEANING of the selector; `%` is
 * cmd.exe variable expansion, which a `"…"` wrap does not stop. A LEADING
 * `-` makes Maven's commons-cli re-read the value as an option (`-pl -rf`
 * dies with 'Missing argument for option: pl'), and a leading `!` is
 * Maven's exclusion operator — quoting preserves the value but not the
 * semantics, so both widen to the full reactor like the rest.
 */
export function shellSelector(
  modules: string[],
  platform: string = process.platform,
): string | null {
  if (modules.length === 0) return null;
  if (
    modules.some(
      (module) =>
        /[,:%]/.test(module) ||
        module.startsWith('-') ||
        module.startsWith('!'),
    )
  ) {
    return null;
  }
  const selector = modules.join(',');
  if (/^[A-Za-z0-9_./,-]+$/.test(selector)) return selector;
  // The command runs through cmd.exe on Windows, where POSIX quoting is
  // literal. With `%` rejected above, the remaining hazards are `"` and `|`,
  // and a Windows filename can contain neither — so the wrap holds.
  return platform === 'win32' ? `"${selector}"` : shellQuotePath(selector);
}

/**
 * The wrapper a platform can actually execute. Every wrapper repo ships both
 * `mvnw` and `mvnw.cmd`; `./mvnw` is not runnable under win32 `cmd.exe`. On
 * POSIX a wrapper without the executable bit (a `core.fileMode=false`
 * checkout) falls back to the system `mvn` rather than dying with exit 126
 * and turning the whole run into an infrastructure handoff that verifies
 * nothing.
 */
export function mavenExecutable(
  root: string,
  platform: string = process.platform,
): string {
  if (platform === 'win32') {
    try {
      const stats = statSync(join(root, 'mvnw.cmd'));
      // isFile() matters like its size gate: a DIRECTORY named `mvnw.cmd`
      // passes existence and size checks but cannot execute.
      if (stats.isFile() && stats.size > 0) return 'mvnw.cmd';
    } catch {
      // absent
    }
    return 'mvn';
  }
  const wrapper = join(root, 'mvnw');
  try {
    accessSync(wrapper, constants.X_OK);
    const stats = statSync(wrapper);
    // An EMPTY wrapper passes the existence/exec-bit gates, exits 0, and
    // the run would certify a build that never started — fall back to
    // system `mvn` exactly like the missing-bit case. A DIRECTORY named
    // `mvnw` is searchable (passes X_OK) but dies exit 126 on execution —
    // same fallback, same reason as the isFile() gate in
    // mavenConfigDependencyInputs.
    if (!stats.isFile() || stats.size === 0) return 'mvn';
    return './mvnw';
  } catch {
    return 'mvn';
  }
}

/**
 * The argument tokens of `.mvn/maven.config`. Maven reads it line-by-line —
 * each non-empty, non-`#` line is ONE argument (MavenCli:
 * `Files.lines(...).filter(arg -> !arg.isEmpty() && !arg.startsWith("#"))`),
 * no whitespace splitting: an argument can carry a space (`ci/my
 * settings.xml`), and a `#` line is a comment even when its text names
 * flags. Mirror that reader; whitespace tokenizing recorded a truncated path
 * for spaced arguments and tokenized comments into inputs.
 */
function mavenConfigTokens(root: string): string[] | null {
  const configPath = join(root, '.mvn', 'maven.config');
  let config: string;
  try {
    // Oversized configs fail closed like an unreadable one — the `.mvn/`
    // prefix still marks the config file itself as a dependency input in the
    // changed-files check. The isFile() gate matters as much as the size cap:
    // a symlink to /dev/zero or a FIFO reports size 0, passes the cap, and
    // hangs readFileSync forever.
    const stats = statSync(configPath);
    if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) return null;
    config = readFileSync(configPath, 'utf8');
  } catch (error) {
    // No config file is a legitimate, readable state (no facts, no
    // ambiguity). A config that EXISTS but cannot be tokenized (read error
    // on a regular file under the cap) is the ambiguous state — Maven reads
    // the same file with no cap and honors its exit-0-changing flags, so we
    // must distrust a bare exit 0 over it. `statSync` threw for a missing
    // path; distinguish via the code.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return null;
  }
  // Maven reads the file with Files.lines, whose readLine semantics
  // terminate a line on \n, \r\n, OR a lone \r — split on all three, or a
  // CR-only config mashes several arguments into one token and bypasses the
  // classification below (a scope-altering flag read as inert releases).
  return config
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Everything the verdict reads from `.mvn/maven.config`, classified by ONE
 * spec-referenced tokenizer: the settings/local-repository locations Maven's
 * launcher injects into this run (dependency inputs), the settings that
 * change what exit 0 means (fail-never, testFailureIgnore), the settings
 * that silence or redirect the stdout channel (quiet, log-file), skip-tests
 * settings — and whether any token defied classification.
 *
 * Ambiguity fails CLOSED: when the tokenizer cannot confidently read the
 * config, the verdict proceeds as if fail-never/testFailureIgnore were set
 * and distrusts a bare exit 0. Arg-parsing imprecision can then only ever
 * be stricter, never release.
 */
interface MavenConfigFacts {
  quiet: boolean;
  failNever: boolean;
  testFailureIgnore: boolean;
  skipTests: boolean;
  /** `-Dmaven.main.skip` — compilation itself is skipped. */
  mainSkip: boolean;
  logFile: boolean;
  ambiguous: boolean;
  dependencyInputs: string[];
}

function analyzeMavenConfig(root: string): MavenConfigFacts {
  const facts: MavenConfigFacts = {
    quiet: false,
    failNever: false,
    testFailureIgnore: false,
    skipTests: false,
    mainSkip: false,
    logFile: false,
    ambiguous: false,
    dependencyInputs: [],
  };
  const addInput = (value: string | undefined): void => {
    if (!value) return;
    const path = normalizedChangedPath(root, value);
    if (path !== null) facts.dependencyInputs.push(path);
  };
  // commons-cli accepts these spellings of two settings that change what
  // exit 0 means; keep them beside the tokenizer that classifies them.
  const quietFlags = new Set(['-q', '--quiet', '-quiet']);
  const failNeverFlags = new Set(['-fn', '--fail-never', '-fail-never']);
  // Flags that take the NEXT config line as their value (Maven reads the
  // file line-by-line and hands each line to commons-cli as one argument).
  const settingsFlags = new Set([
    '-s',
    '--settings',
    '-settings',
    '-gs',
    '--global-settings',
    '-global-settings',
  ]);
  const logFileFlags = new Set(['-l', '--log-file', '-log-file']);
  // Paired flags that do NOT change scope or exit-0 semantics (thread count
  // only). Scope-altering paired flags are NOT consumed here — see the
  // scope-altering sets below.
  const otherPairedFlags = new Set(['-T', '--threads']);
  // Scope-altering flags must not read as inert: `-pl moduleA` in a
  // PR-writable config makes Maven build only `moduleA` while the harness
  // believes it ran the reactor, certifying green over modules whose tests
  // never ran — a RELEASE, inverting the invariant that imprecision can only
  // be stricter. So any scope-altering flag makes the config ambiguous
  // (fail closed).
  const scopeAlteringPaired = new Set([
    '-pl',
    '--projects',
    '-rf',
    '--resume-from',
    '-P',
    '--activate-profiles',
  ]);
  const scopeAlteringValueless = new Set(['-N', '--non-recursive']);
  // Valueless flags commons-cli knows: classified so they do not trip the
  // ambiguity fail-closed below. Not exhaustive — an unknown flag is
  // exactly the shape ambiguity exists to catch.
  const valuelessFlags = new Set([
    '-ff',
    '--fail-fast',
    '-fae',
    '--fail-at-end',
    '-B',
    '--batch-mode',
    '-ntp',
    '--no-transfer-progress',
    '-o',
    '--offline',
    '-U',
    '--update-snapshots',
    '-e',
    '--errors',
    '-X',
    '--debug',
    '-N',
    '--non-recursive',
    '-am',
    '--also-make',
    '-amd',
    '--also-make-dependents',
    '-llr',
    '--legacy-local-repository',
    '-legacy-local-repository',
    // commons-cli single-dash long spelling; starts with `-l` but redirects
    // nothing, so it must not read as an attached log-file value.
    '-lax-checksums',
    '--lax-checksums',
  ]);
  const classifyDefine = (property: string): void => {
    // Maven 3.9's chained local repositories: EVERY entry is a local-
    // repository location. The two prefixes are disjoint —
    // `-Dmaven.repo.local.tail=` diverges from `-Dmaven.repo.local=` at
    // `.tail`, not `=`. Maven splits the tail property on COMMA only
    // (DefaultRepositorySystemSessionFactory: `localRepoTail.split(",")`);
    // a `|` is part of a path here, not a separator.
    if (property.startsWith('maven.repo.local.tail=')) {
      for (const part of property
        .slice('maven.repo.local.tail='.length)
        .split(',')) {
        if (!part) continue;
        addInput(part);
      }
      return;
    }
    // Maven defaults a VALUELESS define to `true`, and
    // `-Dmaven.repo.local`/`-Dmaven.repo.local.tail` with no `=` redirect
    // the local repository to `<worktree>/true` — so the bare spellings are
    // dependency inputs too; requiring the `=` let them slip past.
    if (
      property === 'maven.repo.local.tail' ||
      property.startsWith('maven.repo.local.tail=')
    ) {
      const value =
        property === 'maven.repo.local.tail'
          ? 'true'
          : property.slice('maven.repo.local.tail='.length);
      for (const part of value.split(',')) {
        if (!part) continue;
        addInput(part);
      }
      return;
    }
    if (
      property === 'maven.repo.local' ||
      property.startsWith('maven.repo.local=')
    ) {
      addInput(
        property === 'maven.repo.local'
          ? 'true'
          : property.slice('maven.repo.local='.length),
      );
      return;
    }
    // A bare property (no `=`) defaults to true in Maven.
    if (/^maven\.test\.failure\.ignore(=true)?$/i.test(property)) {
      facts.testFailureIgnore = true;
      return;
    }
    if (/^(skipTests|maven\.test\.skip(?:\.exec)?)(=true)?$/i.test(property)) {
      facts.skipTests = true;
      return;
    }
    // Properties that can filter execution down to ZERO tests: `-Dtest=…` /
    // `-Dit.test=…` select classes by pattern, and
    // `-Dsurefire.failIfNoSpecifiedTests=false` suppresses the "no tests
    // matched" failure — together they let a run execute nothing and exit 0.
    // They change what exit 0 means exactly like skipTests, so classify them
    // the same way (strict: distrust a bare exit 0 over a PR-writable test
    // filter).
    if (
      /^(test|it\.test)=/.test(property) ||
      /^surefire\.failIfNoSpecifiedTests(=false)?$/i.test(property)
    ) {
      facts.skipTests = true;
      return;
    }
    // The zero-test selection filters: `-Dgroups=…`/`-DexcludedGroups=…`
    // select tests by JUnit category and `-Dsurefire.includesFile=…`/
    // `-Dsurefire.excludesFile=…` by file list; a value matching nothing
    // runs ZERO tests and exits 0 with no reports and no skip marker. Same
    // strict classification as the other test filters.
    if (
      /^(groups|excludedGroups)=/.test(property) ||
      /^surefire\.(includes|excludes)File=/.test(property)
    ) {
      facts.skipTests = true;
      return;
    }
    // `-Dmaven.main.skip=true` (maven-compiler-plugin's documented skip
    // property) skips COMPILATION ITSELF — in build-only mode that is the
    // very work the run exists to verify, so record it as a compile-skip
    // fact the build-only verdict distrusts.
    if (/^maven\.main\.skip(=true)?$/i.test(property)) {
      facts.mainSkip = true;
      return;
    }
  };
  const tokens = mavenConfigTokens(root);
  // A config that EXISTS but cannot be tokenized (oversized, not a regular
  // file, unreadable) is ambiguous: Maven reads it with no cap and honors
  // its exit-0-changing flags, so we must distrust a bare exit 0 over it.
  if (tokens === null) {
    facts.ambiguous = true;
    return facts;
  }
  for (let i = 0; i < tokens.length; i += 1) {
    let token = tokens[i];
    // commons-cli pairs a value-less `-D` with the NEXT line exactly like
    // the attached spelling — join the pair so defines see one shape.
    if (
      (token === '-D' || token === '--define' || token === '-define') &&
      tokens[i + 1] !== undefined
    ) {
      token = `-D${tokens[i + 1]}`;
      i += 1;
    }
    if (quietFlags.has(token)) {
      facts.quiet = true;
      continue;
    }
    if (failNeverFlags.has(token)) {
      facts.failNever = true;
      continue;
    }
    // Scope-altering flags fail closed to ambiguous (see the sets above).
    if (scopeAlteringPaired.has(token)) {
      facts.ambiguous = true;
      i += 1;
      continue;
    }
    if (scopeAlteringValueless.has(token)) {
      facts.ambiguous = true;
      continue;
    }
    // Attached scope-altering spellings (`-pl<mod>`, `-P<profile>`,
    // `-rf<mod>`, and the `--…=…` forms).
    if (
      /^(-pl|-P|-rf|--projects|--resume-from|--activate-profiles).+/.test(token)
    ) {
      facts.ambiguous = true;
      continue;
    }
    if (settingsFlags.has(token) || logFileFlags.has(token)) {
      const value = tokens[i + 1];
      i += 1;
      if (settingsFlags.has(token)) addInput(value);
      else facts.logFile = true;
      continue;
    }
    if (otherPairedFlags.has(token)) {
      i += 1;
      continue;
    }
    // The attached thread-count spellings (`-T1C`, `--threads=1C`) carry
    // their value in-token — consume them inert like the paired form, or
    // they fall through to the ambiguity catch-all and distrust a bare
    // exit 0 over the common attached spelling.
    if (/^-T.+/.test(token) || /^--threads=.+/.test(token)) {
      continue;
    }
    // Attached define spellings: `-D…`, `--define=…`, `-define=…`, and the
    // short form's `=` separator (`-D=…`, which commons-cli strips).
    if (token.startsWith('-D')) {
      classifyDefine(token.slice(2).replace(/^=/, ''));
      continue;
    }
    if (token.startsWith('--define=')) {
      classifyDefine(token.slice('--define='.length));
      continue;
    }
    if (token.startsWith('-define=')) {
      classifyDefine(token.slice('-define='.length));
      continue;
    }
    // Attached settings/log-file spellings — checked BEFORE the
    // attached-short regexes, because `-settings=…` also starts with `-s`.
    if (token.startsWith('--settings=')) {
      addInput(token.slice('--settings='.length));
      continue;
    }
    if (token.startsWith('--global-settings=')) {
      addInput(token.slice('--global-settings='.length));
      continue;
    }
    if (token.startsWith('-settings=')) {
      addInput(token.slice('-settings='.length));
      continue;
    }
    if (token.startsWith('-global-settings=')) {
      addInput(token.slice('-global-settings='.length));
      continue;
    }
    if (token.startsWith('--log-file=') || token.startsWith('-log-file=')) {
      facts.logFile = true;
      continue;
    }
    // Known valueless flags win over the attached-short regexes:
    // `-legacy-local-repository` starts with `-l` but is the single-dash
    // long spelling commons-cli matches before the `-l` short option, so it
    // must not read as an attached log-file value.
    if (valuelessFlags.has(token)) continue;
    // commons-cli also accepts the attached short forms (`-s<path>`): the
    // remainder of a token whose option bears an argument becomes the
    // value; the `=` of an attached `-s=<path>` is part of the separator
    // and stripped for single-char short options.
    if (/^-gs.+/.test(token)) {
      addInput(token.slice('-gs'.length).replace(/^=/, ''));
      continue;
    }
    if (/^-s.+/.test(token)) {
      addInput(token.slice('-s'.length).replace(/^=/, ''));
      continue;
    }
    if (/^-l.+/.test(token)) {
      facts.logFile = true;
      continue;
    }
    if (!token.startsWith('-')) continue; // goals and bare values are inert
    // A flag this tokenizer cannot classify: fail closed.
    facts.ambiguous = true;
  }
  return facts;
}

function runMavenToolchain(args: ToolchainRunArgs): BuildTestReport {
  const perCommandMs = args.timeout * 1000;
  /** The deadline a command was actually given, in whole seconds — the
   * whole-call budget shortens it below the flag default, and timeout
   * notes must quote the number that fired. */
  const deadlineSecs = (r: CommandResult): number =>
    Math.round((r.deadlineMs ?? perCommandMs) / 1000);
  // The floor never exceeds the caller's own per-command deadline: a run
  // whose whole budget is one short deadline still gets that attempt,
  // exactly as it did before budgeting existed.
  const attemptFloorMs = Math.min(BUDGET_MIN_ATTEMPT_MS, perCommandMs);
  // The whole-call budget the npm adapter runs under, for the same reason:
  // the warm-up and the lifecycle command SUM against the outer tool
  // timeout, and a cold reactor whose warm-up takes the whole sum leaves
  // the lifecycle command nothing — or the outer kill discards the report.
  // It is wall clock from the TOP of the call, like the npm adapter's and
  // the toolchain.ts contract: ownership detection and the report sweep are
  // PR-controlled work too — a wide worktree costs real time before the first
  // exec — and charging only exec time let that work run uncounted while the
  // commands were still granted the full budget, summing past the outer tool
  // timeout whose kill discards the report.
  const callBudgetMs =
    (args.budget ?? Math.max(args.timeout, args.timeout * 2 - 30)) * 1000;
  const callStartedAt = Date.now();
  let ranACommand = false;
  /** Budget left for the whole call; every phase spends from it. */
  const remainingMs = (): number => callBudgetMs - (Date.now() - callStartedAt);
  /**
   * Whether a command may still be attempted. The floor never exceeds the
   * caller's own per-command deadline: a run whose whole budget is one
   * short deadline still gets that attempt, exactly as it did before
   * budgeting existed — so the FIRST attempt keys on the granted budget,
   * not the remainder (pre-command parsing spends a few milliseconds of
   * wall clock, and comparing the floor to the remainder would starve a
   * budget that equals one short deadline, including the zero-deadline
   * edge the spawn boundary coerces to 1ms). Later attempts key on what
   * remains.
   */
  const enoughForAttempt = (): boolean =>
    ranACommand
      ? remainingMs() >= attemptFloorMs
      : callBudgetMs >= attemptFloorMs;
  const ownership = detectMavenOwnership(args.root, args.changedFiles);
  if (!ownership.reactorWide && ownership.modules.length === 0) {
    return mavenReport({
      affected: [],
      buildSet: [],
      widenedWith: [],
      install: null,
      build: [],
      test: [],
      ok: true,
      timedOut: [],
      note:
        `The diff changes ${args.changedFiles.length} file(s), but none of them needs a Maven build ` +
        'or test (documentation, repository metadata, or nothing inside a Maven module). There is no ' +
        'Maven target to run — this is a complete answer.',
    });
  }

  const executable = mavenExecutable(args.root);
  // The wrapper is the script AND its configuration:
  // `.mvn/wrapper/maven-wrapper.properties` names the distribution the script
  // downloads and executes, so a diff touching it controls what `./mvnw`
  // runs exactly as one touching the script does.
  const wrapperConfigChanged = args.changedFiles.some((file) => {
    const path = normalizedChangedPath(args.root, file);
    return path !== null && path.startsWith('.mvn/wrapper/');
  });
  const wrapperChanged =
    wrapperConfigChanged ||
    args.changedFiles.some((file) => {
      const path = normalizedChangedPath(args.root, file);
      return path === 'mvnw' || path === 'mvnw.cmd';
    });
  // Every wrapper repo ships both platform variants, but only ONE is ever
  // executed here: a diff touching only the other platform's wrapper cannot
  // affect this run, so the carve-out suppressions below key on the file
  // this platform executes, not on either wrapper.
  const executedWrapper =
    executable === './mvnw'
      ? 'mvnw'
      : executable === 'mvnw.cmd'
        ? 'mvnw.cmd'
        : null;
  const executedWrapperChanged =
    executedWrapper !== null &&
    (wrapperConfigChanged ||
      args.changedFiles.some(
        (file) => normalizedChangedPath(args.root, file) === executedWrapper,
      ));
  // The platform-preferred wrapper, whether or not it was executed: when the
  // diff deletes it (or drops its executable bit), mavenExecutable falls back
  // to system `mvn`, executedWrapper is null, and the fallback's launch death
  // is the diff's own doing, not an environmental result.
  const platformWrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
  const platformWrapperChanged = args.changedFiles.some(
    (file) => normalizedChangedPath(args.root, file) === platformWrapper,
  );
  // The dependency carve-out below must not file a PR-caused breakage as
  // environmental: when the diff changed a POM, `.mvn/**`, the settings or
  // repository locations `.mvn/maven.config` references, or the executed
  // wrapper (which can redirect the local repository or settings), the
  // resolution failure may be the diff's own doing.
  //
  // All config facts come from ONE tokenizer pass (see analyzeMavenConfig):
  // dependency inputs, the settings that change what exit 0 means
  // (fail-never / testFailureIgnore), the settings that silence or redirect
  // the stdout channel (quiet / log-file), skip-tests settings, and an
  // ambiguity flag that fails the verdict closed.
  const configFacts = analyzeMavenConfig(args.root);
  // Distrust a bare exit 0: fail-never and testFailureIgnore let Maven exit
  // 0 over failures, and an UNREADABLE config grammar is assumed to carry
  // them too (the tokenizer's fail-closed direction — imprecision can only
  // ever be stricter, never release).
  const distrustExit0 =
    configFacts.failNever ||
    configFacts.testFailureIgnore ||
    configFacts.ambiguous;
  const dependencyInputsChanged = args.changedFiles.some((file) => {
    const path = normalizedChangedPath(args.root, file);
    if (path === null) return false;
    if (path.startsWith('.mvn/')) return true;
    if (executedWrapper !== null && path === executedWrapper) return true;
    if (
      configFacts.dependencyInputs.some(
        (input) => path === input || path.startsWith(`${input}/`),
      )
    ) {
      return true;
    }
    // ANY POM outside test-data shapes, whether or not Maven ends up
    // treating it as a reactor member. Which POMs feed resolution is the
    // effective model's answer — a `<parent>` file, an aggregator the diff
    // just activated, a POM the diff deleted — and guessing it here is the
    // approximation this adapter no longer makes. Over-counting only
    // withdraws an infrastructure carve-out, which files a failure against
    // the PR instead of the environment; under-counting ships the PR's own
    // breakage as someone else's outage. The exclusion therefore covers only
    // the fixture locations (`src/test/`, `src/it/` — invoker ITs, archetype
    // projects): a reactor CAN aggregate a real module under a bare `src/`
    // path (`<module>src/core</module>` — the same premise the ownership
    // walk fails closed on), and that POM feeds resolution like any other.
    return (
      /(?:^|\/)pom\.xml$/.test(path) && !/(?:^|\/)src\/(?:test|it)\//.test(path)
    );
  });
  const lifecycle = args.buildOnly ? 'test-compile' : 'test';
  // `-am` builds the changed modules plus their upstream closure. `-amd`
  // (downstream) selects the whole reactor on exactly the repos this adapter
  // was built for, and a run that spends its whole deadline proving nothing
  // is the failure this command exists to avoid — downstream coverage stays
  // the project's CI matrix, as with the npm adapter's scope.
  const selector = ownership.reactorWide
    ? null
    : shellSelector(ownership.modules);
  const selectorOverflow =
    selector !== null && selector.length > MAX_SELECTOR_CHARS;
  // A module directory a shell selector cannot carry safely widens the run
  // rather than narrowing it wrongly.
  const selectorUnsafe = !ownership.reactorWide && selector === null;
  const reactorWide =
    ownership.reactorWide || selectorOverflow || selectorUnsafe;
  const affected = reactorWide ? ['.'] : ownership.modules;
  const buildSet = reactorWide ? ['.'] : ownership.modules;
  // `selector` is non-null whenever `reactorWide` is false: a null selector
  // sets `selectorUnsafe`, which sets `reactorWide`. Read it through a local
  // so the narrowing can never interpolate a null into the command line.
  const narrowing =
    reactorWide || selector === null ? '' : ` -pl ${selector} -am`;
  const command = `${executable} --batch-mode --no-transfer-progress${narrowing} ${lifecycle}`;
  // The same three values the command line was just rendered from. They ride
  // on the recorded result so `test-plan` can settle a claim against what
  // this run scoped without parsing the rendering back into its inputs.
  const mavenFacts: MavenCommandFacts = {
    lifecycle,
    modules: narrowing === '' ? null : ownership.modules,
    alsoMake: narrowing !== '',
    globalSkip: configFacts.skipTests,
  };
  // Disk preflight, mirroring the npm adapter: Maven resolves plugins and
  // dependencies inside the lifecycle command, and a run that dies on ENOSPC
  // leaves a full disk that fails every agent scheduled after this one.
  // The 3 GiB install floor applies to the warm-up that downloads; a
  // --no-install run's contract in this file is "assume warm, fetch
  // nothing", so it gets the lifecycle's own 1 GiB build floor instead —
  // the second preflight below already admits the same command at it.
  const entryFloorBytes = args.install
    ? INSTALL_MIN_FREE_BYTES
    : BUILD_MIN_FREE_BYTES;
  const free = freeDiskBytes(args.root);
  if (free !== null && free < entryFloorBytes) {
    return mavenReport({
      affected,
      buildSet,
      widenedWith: [],
      install: null,
      build: [],
      test: [],
      ok: false,
      timedOut: [],
      note:
        `Insufficient disk space (${gib(free)}G free, need ~${gib(entryFloorBytes)}G): ` +
        `skipped \`${command}\`. Maven resolves dependencies inside the lifecycle ` +
        'command, so nothing could be built or tested. This is an environment ' +
        'issue, not a code finding — report it as informational.',
    });
  }
  // Dependency warm-up on its own deadline. A review worktree is cold by
  // construction, and Maven resolves dependencies and plugins INSIDE the
  // lifecycle command, sharing the single deadline with compilation and the
  // tests — a cold resolve on the large reactors this adapter targets can
  // spend the whole budget downloading and verify nothing, exactly the
  // timeout-as-infrastructure outcome the command exists to prevent.
  // `dependency:go-offline` is best-effort: it has known gaps (some plugin
  // dependencies resolve lazily), and the lifecycle command resolves what it
  // missed exactly as before. Unlike a partial `node_modules`, a partial
  // local repository is content-addressed and resumable — never worse than
  // none — so no warm-up outcome blocks the lifecycle run. Gated on the same
  // install flag as `npm ci`: `--no-install` means "assume warm, fetch
  // nothing".
  let install: CommandResult | null = null;
  if (args.install && enoughForAttempt()) {
    ranACommand = true;
    install = args.exec(
      `${executable} --batch-mode --no-transfer-progress${narrowing} dependency:go-offline -q`,
      args.root,
      Math.max(0, Math.min(perCommandMs, remainingMs())),
    );
  }
  if (!enoughForAttempt()) {
    // "Was spent" needs a consumer: name the floor instead when the
    // grant itself was below it from the start.
    let note =
      !ranACommand && callBudgetMs < attemptFloorMs
        ? `The granted budget (${Math.round(callBudgetMs / 1000)}s) is below the ` +
          `${Math.round(attemptFloorMs / 1000)}s minimum a Maven attempt needs, so nothing ` +
          'could be started, built, or tested. This is an infrastructure result, ' +
          'not a defect in the diff — report it as informational.'
        : `The whole-call budget (${Math.round(callBudgetMs / 1000)}s) was spent ` +
          `before \`${command}\` could start, so nothing could be built or tested. ` +
          'This is an infrastructure result, not a defect in the diff — report it as informational.';
    if (install) {
      note +=
        ` ${warmUpOutcome(install, deadlineSecs(install))} — the budget it consumed ` +
        'is what stopped the lifecycle command.';
    }
    return mavenReport({
      affected,
      buildSet,
      widenedWith: [],
      install,
      build: [],
      test: [],
      ok: false,
      timedOut: install?.timedOut ? [install.command] : [],
      note,
    });
  }
  // The warm-up is the phase that fills the disk — re-check the floor
  // before the lifecycle command, mirroring the npm adapter's SECOND
  // preflight: a cold reactor's dependency:go-offline can consume the
  // headroom the pre-warm-up check passed, and a lifecycle that dies on
  // ENOSPC leaves a full disk that fails every agent scheduled after it.
  const freeForLifecycle = freeDiskBytes(args.root);
  if (freeForLifecycle !== null && freeForLifecycle < BUILD_MIN_FREE_BYTES) {
    return mavenReport({
      affected,
      buildSet,
      widenedWith: [],
      install,
      build: [],
      test: [],
      ok: false,
      timedOut: install?.timedOut ? [install.command] : [],
      note:
        `Insufficient disk space (${gib(freeForLifecycle)}G free, need ~${gib(BUILD_MIN_FREE_BYTES)}G): ` +
        `skipped \`${command}\` — ` +
        (install
          ? 'the dependency warm-up consumed the headroom the preflight before it passed.'
          : 'free space fell below the build floor between the preflight and the lifecycle command.') +
        ' This is an environment issue, not a code finding — report it as informational.',
    });
  }
  // A build-only run never reads the evidence, so it skips the snapshot too
  // — on a large reactor that is a readdir + statSync sweep of every
  // reports dir for nothing.
  const before = args.buildOnly ? null : snapshotReports(args.root);
  ranACommand = true;
  const executedRaw = args.exec(
    command,
    args.root,
    Math.max(0, Math.min(perCommandMs, remainingMs())),
  );
  // Strip SGR once, before ANY classification reads the output: every
  // predicate below anchors on Maven's `[INFO]`/`[ERROR]` framing, and a
  // `-Dstyle.color=always` in `.mvn/maven.config` interleaves color codes
  // that defeat all of them — colored bytes would launder a failed compile
  // into a green verdict.
  const executed = {
    ...executedRaw,
    output: executedRaw.output.replace(ANSI_SGR_RE, ''),
  };
  // Maven's own answer to "is this project in the active reactor". It is the
  // authority on profile activation, `<modules>` inheritance, and JDK-
  // conditional membership, and it rejects an unknown selector before
  // compiling anything — so a standalone or profile-inactive project costs one
  // fast failure here instead of a second reactor model in this file.
  const rejected = SELECTOR_REJECTED_RE.exec(executed.output);
  const fresh = before
    ? freshTestSummaries(args.root, before)
    : { summaries: [], rejected: 0, truncated: false };
  const summaries = fresh.summaries;
  const hasReports = summaries.length > 0;
  const result = {
    ...appendTestSummaries(executed, summaries, {
      rejected: fresh.rejected,
      truncated: fresh.truncated,
    }),
    maven: mavenFacts,
  };
  // The report-level contract names EVERY command killed by its deadline —
  // the npm adapter pushes its install command, and a non-empty `timedOut`
  // is the brief's infrastructure signal, so a warm-up timeout must not
  // read as if nothing timed out.
  const timedOut = [
    ...(install?.timedOut ? [install.command] : []),
    ...(result.timedOut ? [result.command] : []),
  ];
  // A fresh report recording failures outranks a green exit: surefire's
  // `testFailureIgnore` (or `-Dmaven.test.failure.ignore`) lets `mvn test`
  // exit 0 over failing tests, and the verdict must read the evidence.
  const freshFailures = hasFreshTestFailure(summaries);
  // This exit-0 shape carries NONE of the classification flags recorded
  // below — swallowedFailure/testsSuppressed/neverRan all key on the
  // ABSENCE of fresh failing reports, and evidenceCapped keys on unread
  // evidence — yet the verdict is ok:false. Record the shape itself so
  // test-delta's failure filter and test-plan's count mining read it as a
  // failed run instead of reporting the all-clear over it.
  const swallowedReports =
    result.exitCode === 0 && !result.timedOut && freshFailures;
  // A genuine selector rejection fail-fasts BEFORE any test runs, at every
  // exit code and under every fail mode — so it never coexists with fresh
  // reports. When reports exist the wording was echoed by test stdout, and
  // discarding the run would hide captured evidence (genuine failures, or
  // the very green the forged line claims to protect) behind an unsupported
  // handoff. The same holds when fresh reports exist but were REJECTED or
  // the sweep/trim was capped: those are the evidence states the machine
  // below fails closed on via `evidenceCapped`, and an echoed rejection line
  // must not discard them into an unsupported handoff either.
  if (
    rejected &&
    summaries.length === 0 &&
    fresh.rejected === 0 &&
    !fresh.truncated &&
    result.rescueOverflow !== true
  ) {
    return unsupportedReport(
      `Maven rejected the selected project(s) — ${rejected[1].trim()} — as not part of the active reactor. ` +
        'They are standalone or profile-inactive under the current profiles and JDK, so this run verified ' +
        'nothing and no other scope was guessed.',
    );
  }
  // Evidence the run could not read fails CLOSED — a rejected parse
  // (oversized, unreadable, or malformed XML the strict parser refused) and
  // a truncated sweep (freshness baseline incomplete) are gaps a PR can
  // weaponize to hide a failing report, and the trim's rescue cap dropping
  // failure-evidence lines is the same epistemic state: classification read
  // an output whose verdict-relevant lines may be gone.
  const evidenceCapped =
    fresh.rejected > 0 || fresh.truncated || result.rescueOverflow === true;
  // --- The verdict state machine ---
  // Three authoritative signals only: the exit code, the parsed report
  // elements, and the config settings that change what exit 0 means
  // (fail-never/testFailureIgnore, or an ambiguous config grammar assumed
  // to carry them). Green requires POSITIVE structural evidence — exit 0
  // and no parsed failing element — never the mere absence of a failure
  // wording. The human-stdout scrapers (source/dependency/launch/goal
  // wording, `Tests run:` summaries) are a FALLBACK for runs that produced
  // no reports; with reports present the structured signals judge, and the
  // scrapers can only ever CONVICT under a distrusted exit 0 — arg-parsing
  // imprecision can only be stricter, never release.
  // A skip setting (`-DskipTests`/`-Dmaven.test.skip=true` in
  // `.mvn/maven.config`, or a POM `<skipTests>`) lets `mvn test` exit 0
  // having executed ZERO tests, and Surefire's skip path emits none of the
  // framed errors the scrapers scan for — without this check a run that
  // tested nothing is certified green, and Test Plan count claims become
  // uncontradictable. The config spelling and the stdout marker both feed
  // it. The marker is NOT gated on the absence of reports: a module-local
  // skip writes no reports while `-am` upstream modules do, and any "Tests
  // are skipped." line inside the run's own scope means part of that scope
  // was not tested. Build-only runs have no test phase, so skip settings
  // are irrelevant to them.
  const testsSuppressed =
    !args.buildOnly &&
    (configFacts.skipTests ||
      result.output.split('\n').some((line) => isTestsSkippedLine(line)));
  // A build-only run has no test phase, but `-Dmaven.main.skip` skips the
  // COMPILATION ITSELF — the very work the run exists to verify — while
  // still exiting 0. Distrust a bare exit 0 over it exactly like a
  // suppressed test phase, or the run certifies green having compiled
  // nothing.
  const compileSuppressed = args.buildOnly && configFacts.mainSkip;
  const stdoutTestFailures = hasStdoutTestFailure(result.output);
  // A NON-EMPTY wrapper can still exit 0 without launching Maven (a stub
  // `#!/bin/sh` edit keeps the exec bit): zero fresh reports AND zero
  // Maven-framed output means the build never started — "never ran", not
  // "tested nothing". A diff-modified wrapper CONTROLS the output channel
  // (a stub can echo framed lines), and a `-q`/`--quiet` or `-l`/`--log-
  // file` setting silences or redirects it — with no reports on disk, none
  // of those states can prove a build started, so all read unverified. An
  // UNMODIFIED wrapper's evidence still decides: fresh reports or framed
  // output show a build demonstrably ran — a plain `.mvn/wrapper/` bump
  // runs the whole reactor green and must not read as never run — while a
  // silent stub still fails this check.
  const neverRan =
    result.exitCode === 0 &&
    !result.timedOut &&
    !testsSuppressed &&
    // A build-only run's evidence is the compile's exit code — it skips the
    // report snapshot, so `hasReports` is structurally false; the
    // quiet/log-file/wrapper signals must not misread it as "never ran".
    !args.buildOnly &&
    !hasReports &&
    (executedWrapperChanged ||
      configFacts.quiet ||
      configFacts.logFile ||
      !hasMavenFramedLine(result.output));
  const swallowedFailure =
    result.exitCode === 0 &&
    !result.timedOut &&
    !freshFailures &&
    (testsSuppressed ||
      compileSuppressed ||
      // No reports: the stdout channel is the only evidence left, so the
      // scrapers judge — surefire's `Tests run:` summaries survive a
      // relocated `<reportsDirectory>` the sweep cannot see, and framed
      // errors a fail-never setting swallowed live nowhere else.
      (!hasReports &&
        (stdoutTestFailures ||
          isSourceFailure(result.output) ||
          isDependencyFailure(result.output) ||
          isLaunchFailure(result.output) ||
          isGoalFailure(result.output))) ||
      // Distrusted exit 0 (fail-never/testFailureIgnore set, or the config
      // grammar unreadable): exit-code semantics are broken, so framed
      // failure evidence convicts even beside clean reports. Surefire
      // echoes test stdout verbatim, so this arm stays conviction-only and
      // restricted to the wordings a real fail-never build frames — the
      // strict direction.
      (distrustExit0 &&
        hasReports &&
        (stdoutTestFailures ||
          isSourceFailure(result.output) ||
          isGoalFailure(result.output))));
  const ok =
    result.exitCode === 0 &&
    !result.timedOut &&
    !freshFailures &&
    !swallowedFailure &&
    !evidenceCapped &&
    !neverRan;
  // Environmental classification for a failing run. When reports exist the
  // structured evidence says tests RAN — the non-zero exit is attributed to
  // the PR side (over-attribution, never an environmental wash). With no
  // reports, the scrapers classify acquisition deaths: `-pl <mod> -am`
  // builds AND tests the upstream modules first, so the first `[INFO]
  // Running` line prints long before the changed module is even resolved,
  // and a dependency-resolution, launch, or disk death after it is still
  // the run's own death — cutting at the first test phase once filed a
  // transient registry outage (and a mid-command ENOSPC) as a defect in the
  // PR. Every carve-out carries a diff-inputs exception: when the PR
  // changed the wrapper or the dependency inputs, the failure may be the
  // diff's own doing and must not be laundered into an environmental
  // result.
  const acquisitionFailure =
    !ok &&
    !freshFailures &&
    !hasReports &&
    // Capped evidence can launder a source failure into infrastructure:
    // the trim's rescue cap drops lines positionally, so dependency-flavored
    // lines can survive while a source-class line is lost — and the
    // dependency arm below would then match. `ok` already refuses capped
    // runs; the acquisition classification must not read them either. Fail
    // toward over-attribution — the direction this machine's own comment
    // mandates.
    !evidenceCapped &&
    !isSourceFailure(result.output) &&
    // Executed failing tests record themselves in the stdout summaries even
    // when the sweep misses their XML: dependency-flavored assertion text
    // (`Connection refused`, `Unknown host`) otherwise matches the
    // dependency matcher and launders a genuine test failure into an
    // infrastructure result.
    !stdoutTestFailures &&
    result.exitCode !== null &&
    ((isLaunchFailure(result.output) &&
      !executedWrapperChanged &&
      !(executable === 'mvn' && platformWrapperChanged)) ||
      (isDependencyFailure(result.output) && !dependencyInputsChanged) ||
      // Shape-classified, not wording-classified: bash/dash localize
      // these diagnostics under a non-English LANG, so the match keys on
      // the structure — an unmodified wrapper dying at a launch exit code
      // with no Maven-framed output — like the silent bootstrap arm below.
      (executable === './mvnw' &&
        !executedWrapperChanged &&
        (result.exitCode === 126 || result.exitCode === 127) &&
        !hasMavenFramedLine(result.output)) ||
      // The system-`mvn` twin of the shape arm: the wording regexes above
      // only match English, contradicting the shape arm's own localization
      // rationale. A diff that removed the platform wrapper answers for
      // the fallback's launch death, so the carve-out stays suppressed
      // there exactly like the wrapper arm.
      (executable === 'mvn' &&
        !platformWrapperChanged &&
        (result.exitCode === 126 || result.exitCode === 127) &&
        !hasMavenFramedLine(result.output)) ||
      // Wrapper bootstrap download deaths with NO wording to match: wget
      // (both wrapper generations try it before curl) runs `--quiet` in the
      // distribution download, so a DNS failure exits 4 and a server error
      // exits 8 with an EMPTY unframed output; the curl fallback dies on
      // its codes 6/7/22/28 (resolve, connect, HTTP error, timeout) the
      // same way. If Maven's JVM had started, framed output would exist —
      // its absence pins the death to bootstrap.
      (executedWrapper !== null &&
        !executedWrapperChanged &&
        [4, 6, 7, 8, 22, 28].includes(result.exitCode) &&
        !hasMavenFramedLine(result.output)));
  const recorded = {
    ...result,
    // These flags are how test-plan and test-delta see the adapter's exit-0
    // ok:false outcomes: a run carrying ANY of them must not settle a Test
    // Plan claim, and test-delta must not report the all-clear over it.
    // They are set independently — a swallowed failure under a fail-never
    // setting can coincide with capped evidence (the no-reports swallowed
    // arm plus a rescue-overflow trim are reachable together).
    // `infrastructure`, by contrast, cannot coincide with `evidenceCapped`:
    // acquisitionFailure gates on `!evidenceCapped`.
    ...(acquisitionFailure ? { infrastructure: true } : {}),
    ...(swallowedFailure ? { swallowedFailure: true } : {}),
    ...(evidenceCapped ? { evidenceCapped: true } : {}),
    ...(testsSuppressed ? { testsSuppressed: true } : {}),
    ...(neverRan ? { neverRan: true } : {}),
    ...(swallowedReports ? { swallowedReports: true } : {}),
  };
  const report = mavenReport({
    affected,
    buildSet,
    widenedWith: [],
    install,
    build: args.buildOnly ? [recorded] : [],
    test: args.buildOnly ? [] : [recorded],
    ok,
    timedOut,
    note: '',
  });

  if ((result.timedOut || result.exitCode === null) && freshFailures) {
    // A deadline kill or spawn death does not retroactively excuse the test
    // failures Surefire/Failsafe already recorded: name the interruption as
    // infrastructure, but keep the captured regressions as test evidence.
    const totals = summaryTotals(summaries);
    const cause = result.timedOut
      ? `ran out of time (${deadlineSecs(result)}s)`
      : 'ended without an exit code (a spawn failure or signal outside the deadline)';
    report.note =
      `\`${result.command}\` ${cause} — that part is infrastructure. But fresh ` +
      `Surefire/Failsafe reports written before it record ${totals.failures} ` +
      `failure(s) and ${totals.errors} error(s): treat those as test failures, ` +
      'not as a pass or as purely environmental.';
  } else if (
    (result.timedOut || result.exitCode === null) &&
    stdoutTestFailures
  ) {
    // The sibling arm's principle, applied to stdout evidence: the
    // interruption does not retroactively excuse the failures Surefire's
    // framed summaries already recorded — name them instead of asserting a
    // purely informational result.
    const cause = result.timedOut
      ? `ran out of time (${deadlineSecs(result)}s)`
      : 'ended without an exit code (a spawn failure or signal outside the deadline)';
    report.note =
      `\`${result.command}\` ${cause} — that part is infrastructure. But its ` +
      'captured output records Surefire test failures (`Tests run: …` summaries ' +
      'with non-zero Failures/Errors): treat those as test failures, not as ' +
      'purely environmental.';
  } else if (
    (result.timedOut || result.exitCode === null) &&
    (isSourceFailure(result.output) || isGoalFailure(result.output))
  ) {
    // The sibling arms' principle, applied to source/goal evidence: under
    // fail-never/fail-at-end a PR-caused compile or goal failure does not
    // end the build — it runs on to the deadline, and the interruption
    // must not launder the captured failure into pure infrastructure.
    const cause = result.timedOut
      ? `ran out of time (${deadlineSecs(result)}s)`
      : 'ended without an exit code (a spawn failure or signal outside the deadline)';
    report.note =
      `\`${result.command}\` ${cause} — that part is infrastructure. But its ` +
      'captured output records source or goal failures (`[ERROR]`-framed ' +
      'compile or plugin-goal errors) the run never exited on: correlate them ' +
      'with the changed files before treating this as purely environmental.';
  } else if (result.timedOut) {
    report.note =
      `\`${result.command}\` ran out of time (${deadlineSecs(result)}s). This is an infrastructure result, ` +
      'not a defect in the diff — report it as informational.';
    if (selectorOverflow) {
      report.note +=
        ' The scope widened to reactor-wide because the changed-module `-pl` selector exceeded ' +
        `${MAX_SELECTOR_CHARS} characters; on large reactors that scope usually cannot finish ` +
        'within this deadline, so re-running it at the same scope will spend the same budget ' +
        'for the same result.';
    } else if (selectorUnsafe) {
      report.note +=
        ' The scope widened to reactor-wide because a changed module directory carries a ' +
        'character a `-pl` selector cannot express; on large reactors that scope usually cannot ' +
        'finish within this deadline, so re-running it at the same scope will spend the same ' +
        'budget for the same result.';
    } else if (ownership.reactorWide) {
      report.note +=
        ' The scope is reactor-wide because the diff changes inputs every module inherits; ' +
        'on large reactors that scope usually cannot finish within this deadline, so re-running ' +
        'it at the same scope will spend the same budget for the same result.';
    }
  } else if (result.exitCode === null) {
    // A spawn-level death (output past maxBuffer, an outside signal) leaves no
    // exit code and nothing to correlate — infrastructure, like a timeout.
    report.note =
      `\`${result.command}\` ended without an exit code (a spawn failure or signal outside the deadline). ` +
      `This is ${NOTE_INFRASTRUCTURE_EVIDENCE}, not a source finding.`;
  } else if (acquisitionFailure) {
    report.note =
      `\`${result.command}\` failed while acquiring or starting Maven, Java, plugins, or dependencies` +
      (result.exitCode === 0
        ? ' — a fail-never setting masked the failure with exit 0'
        : '') +
      `. This is ${NOTE_INFRASTRUCTURE_EVIDENCE}, not a source finding.`;
  } else if (!ok && result.exitCode === 0 && freshFailures) {
    const totals = summaryTotals(summaries);
    // A fail-never setting produces the identical shape (exit 0 over failing
    // reports), so name the actual cause instead of hardcoding one — the
    // same distinction the generic exit-0 arm's cascade makes.
    const swallowCause = configFacts.failNever
      ? 'a fail-never setting (`-fn`/`--fail-never`)'
      : 'a testFailureIgnore-style setting';
    report.note =
      `\`${result.command}\` exited 0 but fresh Surefire/Failsafe reports record ` +
      `${totals.failures} failure(s) and ${totals.errors} error(s) — ${swallowCause} ` +
      'is swallowing them. Treat these as test failures, not a pass.';
  } else if (!ok && result.exitCode === 0 && evidenceCapped) {
    const gapReasons: string[] = [];
    if (fresh.rejected > 0) {
      gapReasons.push(
        `${fresh.rejected} fresh report(s) could not be parsed (oversized, ` +
          'unreadable, or malformed XML the strict parser refused)',
      );
    }
    if (fresh.truncated) {
      gapReasons.push(
        'the report sweep was truncated, so some fresh reports may be unseen',
      );
    }
    if (result.rescueOverflow === true) {
      gapReasons.push(
        'the output trim dropped failure-evidence lines past its rescue cap',
      );
    }
    report.note =
      `\`${result.command}\` exited 0, but ${gapReasons.join('; ')} — their ` +
      'failure status is unknown, so the run is not certified as a pass.' +
      (swallowedFailure
        ? ' The output also records failures Maven did not fail on.'
        : '');
  } else if (!ok && result.exitCode === 0 && compileSuppressed) {
    report.note =
      `\`${result.command}\` exited 0 but compilation was suppressed: a ` +
      '`-Dmaven.main.skip` setting in `.mvn/maven.config` skips the compile ' +
      'mojos a build-only run exists to verify, so nothing was compiled. ' +
      'Treat this as an unverified run, not a pass.';
  } else if (!ok && result.exitCode === 0 && testsSuppressed) {
    const suppressionSource = configFacts.skipTests
      ? 'a skip setting (`-DskipTests`/`-Dmaven.test.skip`) in `.mvn/maven.config`'
      : 'Maven reporting `Tests are skipped.` — a skip setting (`-DskipTests`/' +
        '`-Dmaven.test.skip` in `.mvn/maven.config` or a POM `<skipTests>`)';
    // Word the scope honestly: a module-local skip coexists with fresh
    // passing reports from other in-scope modules, so "skipped every test"
    // is false whenever any report shows a test DID run.
    report.note = hasReports
      ? `\`${result.command}\` exited 0 with part of the scope suppressed: ${suppressionSource} ` +
        'skipped tests for part of the scope, so that part was not tested ' +
        '(other modules ran, per the appended reports). ' +
        'Treat this as an unverified run, not a pass.'
      : `\`${result.command}\` exited 0 with the test phase suppressed: ${suppressionSource} ` +
        'skipped every test, so nothing was tested. ' +
        'Treat this as an unverified run, not a pass.';
  } else if (!ok && result.exitCode === 0 && neverRan) {
    const cause = executedWrapperChanged
      ? 'the wrapper this run executed is changed by the diff, so it controls the output ' +
        'channel and any framed lines in it prove nothing'
      : configFacts.logFile
        ? 'a `-l`/`--log-file` setting in `.mvn/maven.config` redirected the build output ' +
          'to a file, so the stdout channel proves nothing'
        : configFacts.quiet
          ? 'a `-q`/`--quiet` (or single-dash `-quiet`) setting in `.mvn/maven.config` ' +
            'suppressed every line Maven prints'
          : 'no fresh reports and no Maven output at all, so the build never ran ' +
            '(an empty or stub wrapper passes the launch gates and exits 0)';
    report.note =
      `\`${result.command}\` exited 0 without verifiable evidence that a build ran — ` +
      `${cause}. Treat this as an unverified run, not a pass.`;
  } else if (!ok && result.exitCode === 0) {
    const distrustedCause = configFacts.failNever
      ? 'a fail-never setting (e.g. `-fn`/`--fail-never` in `.mvn/maven.config`)'
      : configFacts.testFailureIgnore
        ? 'a testFailureIgnore-style setting (`-Dmaven.test.failure.ignore`)'
        : configFacts.ambiguous
          ? 'an unreadable `.mvn/maven.config` (unrecognized arguments — assumed to ' +
            'swallow failures, the strict direction)'
          : 'a testFailureIgnore-style surefire setting, though echoed test output prints the same lines';
    report.note =
      `\`${result.command}\` exited 0 but the evidence records failures the exit code did ` +
      `not fail on — ${distrustedCause}. Treat this as a failed run, not a pass.`;
  } else if (!ok) {
    report.note =
      `\`${result.command}\` failed. ${NOTE_CORRELATE_ERRORS} with the changed files; ` +
      'fresh module-qualified Surefire/Failsafe summaries are appended when available.';
  } else if (args.buildOnly) {
    report.note =
      `Maven compiled ${reactorWide ? 'the full reactor' : ownership.modules.join(', ')}. ` +
      'Tests were not run (build-only).';
  } else if (summaries.length === 0) {
    report.note =
      `Maven tested ${reactorWide ? 'the full reactor' : ownership.modules.join(', ')} successfully, ` +
      'but produced no fresh Surefire/Failsafe XML (reports written to a non-default directory are not seen here), ' +
      'so test-count evidence is unavailable.';
  } else {
    const totals = summaryTotals(summaries);
    report.note =
      `${NOTE_MAVEN_TEST_PASSED} with fresh reports: ${totals.tests} tests, ${totals.failures} failures, ` +
      `${totals.errors} errors, ${totals.skipped} skipped across ${summaries.length} report(s).`;
  }
  if (!reactorWide) {
    report.note +=
      ' Scope: this run covered the changed modules and their upstream dependencies only ' +
      '(`-pl … -am`); downstream dependents were NOT built — a POM or API change can break ' +
      "modules this run never compiled, and that coverage stays with the project's CI.";
  } else if (selectorOverflow) {
    report.note +=
      ` Scope: the changed-module \`-pl\` selector exceeded ${MAX_SELECTOR_CHARS} characters — ` +
      'a command line platforms may refuse to launch — so this run covered the full reactor ' +
      'instead of the changed modules and their upstream dependencies.';
  } else if (selectorUnsafe) {
    report.note +=
      ' Scope: a changed module directory carries a character a `-pl` selector cannot express ' +
      '(`,` and `:` change what the selector means to Maven; `%` expands in cmd.exe; a leading ' +
      '`-` or `!` reads as an option or an exclusion), so this run covered the full reactor ' +
      'instead of the changed modules and their upstream dependencies.';
  }
  if (install && (install.timedOut || install.exitCode !== 0)) {
    report.note +=
      ` ${warmUpOutcome(install, deadlineSecs(install))} — it is best-effort, and the ` +
      'lifecycle outcome above stands on its own.';
  }
  if (wrapperChanged && !executedWrapperChanged) {
    report.note +=
      executable === 'mvn'
        ? ' Note: the diff changes the Maven wrapper, but this run used the system ' +
          '`mvn` instead of it, so the wrapper change itself was not exercised.'
        : ` Note: the diff changes the Maven wrapper, but this run executed \`${executable}\`, ` +
          'so the wrapper change itself was not exercised.';
  }
  if (ok && executedWrapperChanged) {
    // The run certified green, but the wrapper it executed is one the diff
    // itself changed. Fresh failing reports still override a green exit, so
    // this only fires over structurally clean evidence — yet the wrapper is
    // the very program that LAUNCHED the build, and a diff-controlled
    // launcher could pin versions, inject settings, or skip work. Name the
    // caveat next to the green verdict instead of silently trusting it.
    report.note +=
      ' Note: this run is green, but it executed a Maven wrapper the diff itself ' +
      'changed — a diff-controlled launcher could inject settings or skip work, ' +
      'so confirm the wrapper change is benign before relying on this verdict.';
  }
  if (isRegularFile(join(args.root, 'package.json'))) {
    // A mixed root: npm's applies() refused the root package.json (an
    // unmodeled workspace glob, a zero-package glob, or no build/test
    // script), so Maven was selected ALONE — the npm half is unscopable
    // here, and a green Maven run must not certify it. The isFile() gate
    // matters: a DIRECTORY named `package.json` fails npm's applies() too
    // (EISDIR swallowed to no manifests), so the caveat would be false.
    report.note +=
      ' Mixed root: a root package.json exists that this run did not scope — ' +
      'files outside the Maven reactor (npm/frontend sources) were NOT verified.';
  }
  return report;
}

/** Existence AND regular file: a DIRECTORY carrying the name passes
 *  existsSync but is not a manifest — the same gate mavenExecutable and
 *  the config tokenizer apply. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const mavenToolchainAdapter: ReviewToolchainAdapter = {
  applies: (root) => isRegularFile(join(root, 'pom.xml')),
  run: runMavenToolchain,
};
