/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
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
import type { ReviewToolchainAdapter, ToolchainRunArgs } from './toolchain.js';

export interface MavenOwnership {
  reactorWide: boolean;
  modules: string[];
}

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
 * thousands of reports. Clean reports therefore roll up per project dir, and
 * the per-report evidence lines are capped: this block is appended AFTER the
 * command output was trimmed, so it carries its own bound.
 */
const MAX_FAILING_REPORT_LINES = 100;
const MAX_FAILURE_CASE_LINES = 200;
const MAX_CLEAN_ROLLUP_LINES = 100;

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
 * `.mvn/maven.config` carries the same class of cap: it is split on
 * whitespace, and an uncapped multi-megabyte config a PR commits is this
 * harness's own denial-of-service surface — measured at 37 MB the split cost
 * seconds of synchronous CPU and hundreds of MB of transient heap, scaling
 * linearly to GitHub's 100 MB per-file limit. An oversized config contributes
 * no settings inputs.
 */
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

/**
 * Cap the report sweep: it walks the worktree for `target/<report-dir>`
 * directories, and a PR controls how many directories exist. Past the cap the
 * sweep stops — a missed report costs evidence, never a wrong verdict, since
 * absent evidence can never certify a pass.
 */
const MAX_SCANNED_DIRS = 20_000;

/**
 * Cap how many fresh reports one run parses: the parse is synchronous,
 * outside any deadline, on files the PR's own tests can write during the
 * run (the mtime freshness filter accepts any writer). `MAX_REPORT_BYTES`
 * bounds each file, but nothing else bounded the COUNT — thousands of
 * 2 MiB reports are multi-GB of live strings and minutes of CPU past the
 * outer tool timeout. Past the cap the evidence block discloses the
 * omission like the other caps.
 */
const MAX_FRESH_REPORTS = 1_000;

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
 * Directories strictly beneath a `src/` tree are skipped. A POM there is test
 * data — maven-invoker ITs, archetype fixtures,
 * `src/test/resources/projects/*` — never a reactor member, so the file stays
 * owned by the enclosing real project.
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
  while (isInside(root, dir)) {
    const rel = toPosix(relative(root, dir)) || '.';
    // Strictly BENEATH `src/`: a real project located exactly AT a `src` path
    // is not test data.
    if (!/(?:^|\/)src\//.test(rel) && existsSync(join(dir, 'pom.xml'))) {
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
 * Every `<projectDir>/target/<report-dir>/*.xml` in the worktree.
 *
 * The sweep walks the tree rather than a list of reactor projects: which
 * projects are active is Maven's answer, not this adapter's, and a report
 * directory only exists where Maven actually ran. `isDirectory()` is false for
 * symlinks, so the walk never follows one out of the worktree or into a cycle.
 */
function reportPaths(root: string): string[] {
  const paths: string[] = [];
  const queue: string[] = [root];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_SCANNED_DIRS) {
    const dir = queue.pop() as string;
    scanned += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const child = join(dir, entry.name);
      if (entry.name !== 'target') {
        queue.push(child);
        continue;
      }
      // Never descend INTO `target`: it holds unpacked dependencies and
      // generated sources, and the only paths of interest sit one level down.
      for (const reportDir of REPORT_DIRS) {
        const reports = join(child, reportDir);
        let files: Dirent[];
        try {
          files = readdirSync(reports, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.isFile() && file.name.endsWith('.xml')) {
            paths.push(join(reports, file.name));
          }
        }
      }
    }
  }
  return paths;
}

function snapshotReports(root: string): ReportSnapshot {
  // Freshness is an mtime comparison, and some filesystems resolve mtimes at
  // 1s granularity: a report rewritten inside the same tick reads as stale and
  // is dropped. That degrades in the safe direction — absent test-count
  // evidence, never a wrong verdict — so no sub-second workaround is worth it.
  const mtimes = new Map<string, number>();
  for (const path of reportPaths(root)) {
    try {
      mtimes.set(path, statSync(path).mtimeMs);
    } catch {
      // The report disappeared while the snapshot was being taken.
    }
  }
  return { mtimes };
}

function xmlAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  // The lookbehind pins each name to a maximal word run: without it, a long
  // attribute-name run with no `=` backtracked the greedy name from every
  // start position — quadratic on PR-controlled report bytes.
  const re = /(?<![\w:.-])([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    attributes.set(match[1], match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function numberAttribute(
  attributes: Map<string, string>,
  name: string,
): number {
  const value = Number.parseInt(attributes.get(name) ?? '0', 10);
  if (!Number.isFinite(value)) return 0;
  // A malformed report's negative count must not cancel legitimate counts
  // from its neighbours when totals roll up across reports.
  return Math.max(0, value);
}

/** A start tag located by `xmlOpenTagHeaders`. */
interface XmlOpenTagHeader {
  /** Attribute run between the tag name and the closing `>`. */
  attributes: string;
  /** Offset of the opening `<` in the scanned text. */
  index: number;
  /** The full tag text; a self-closing tag ends `/>`. */
  text: string;
}

const XML_WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Quote-aware linear scan for `<name …>` start tags. A `>` is legal
 * unescaped inside a quoted attribute value (parameterized-test and
 * @DisplayName suite/case names carry them). The regex header walk this
 * replaces went quadratic on PR-controlled reports: one never-closed opener
 * made every later tag start scan to EOF (a 2 MiB report of `<testcase x `
 * openers measured minutes per file — a denial of service through the very
 * evidence this parser exists to read). Here each byte is examined once:
 * locate a `<name` start, then advance to the next `>` outside quotes. An
 * opener with no `>` before EOF ends the scan — the truncated-XML branch in
 * parseTestReport handles what was seen until then.
 */
function xmlOpenTagHeaders(xml: string, name: string): XmlOpenTagHeader[] {
  const tag = `<${name.toLowerCase()}`;
  // toLowerCase() can lengthen UTF-16 text (`İ` → `i` + U+0307), so offsets
  // located in a lowercased copy would misindex the original xml past the
  // first such character. Use the copy only while it stayed the same length;
  // otherwise scan the original case-insensitively.
  const lower = xml.toLowerCase();
  const indexOfTag =
    lower.length === xml.length
      ? (from: number): number => lower.indexOf(tag, from)
      : (from: number): number => {
          for (let i = from; i + tag.length <= xml.length; i += 1) {
            let matched = true;
            for (let j = 0; j < tag.length; j += 1) {
              if (xml[i + j].toLowerCase() !== tag[j]) {
                matched = false;
                break;
              }
            }
            if (matched) return i;
          }
          return -1;
        };
  const headers: XmlOpenTagHeader[] = [];
  let from = 0;
  for (;;) {
    const start = indexOfTag(from);
    if (start === -1) return headers;
    from = start + 1;
    // `\b` semantics: `<testsuite` must not match `<testsuites`.
    const next = xml[start + tag.length];
    if (next !== undefined && XML_WORD_CHAR.test(next)) continue;
    let quote: '"' | "'" | null = null;
    let end = -1;
    for (let i = start + tag.length; i < xml.length; i++) {
      const c = xml[i];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        end = i;
        break;
      }
    }
    if (end === -1) return headers;
    headers.push({
      attributes: xml.slice(start + tag.length, end),
      index: start,
      text: xml.slice(start, end + 1),
    });
    from = end + 1;
  }
}

const TESTCASE_CLOSE_RE = /<\/testcase\s*>/gi;

/**
 * Drop terminated `<![CDATA[ … ]]>` sections and `<!-- … -->` comments in
 * one linear pass: both are opaque text, never markup, and scanning a
 * commented-out or CDATA-wrapped suite (aggregate writers like jest-junit
 * and karma emit both) fabricated phantom suites and failure evidence. The
 * earlier marker wins — a marker inside the other kind is literal content,
 * consumed with it. An unterminated section stays verbatim: its content
 * then fails closed exactly as it did before this handling existed.
 */
function stripOpaqueSections(xml: string): string {
  if (!xml.includes('<![CDATA[') && !xml.includes('<!--')) return xml;
  const chunks: string[] = [];
  let i = 0;
  let chunkStart = 0;
  while (i < xml.length) {
    let closer: string | null = null;
    let markerLength = 0;
    if (xml.startsWith('<!--', i)) {
      closer = '-->';
      markerLength = 4;
    } else if (xml.startsWith('<![CDATA[', i)) {
      closer = ']]>';
      markerLength = 9;
    }
    if (closer === null) {
      i += 1;
      continue;
    }
    const end = xml.indexOf(closer, i + markerLength);
    if (end === -1) break;
    chunks.push(xml.slice(chunkStart, i));
    i = end + closer.length;
    chunkStart = i;
  }
  chunks.push(xml.slice(chunkStart));
  return chunks.join('');
}

function parseTestReport(root: string, path: string): MavenTestSummary | null {
  try {
    if (statSync(path).size > MAX_REPORT_BYTES) return null;
  } catch {
    return null;
  }
  let xml: string;
  try {
    xml = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  // CDATA and comment content is opaque text, never markup: test output
  // wrapped in `<system-out>` CDATA routinely CONTAINS XML samples, and
  // aggregate writers also emit commented-out markup; scanning either as
  // real fabricated phantom suites and failure evidence. Drop terminated
  // sections; an unterminated one stays as-is and fails closed as before.
  xml = stripOpaqueSections(xml);
  // Aggregate counts across EVERY suite in the file: aggregate JUnit writers
  // (jest-junit, karma reporters aimed at target/surefire-reports/ for
  // SonarQube) emit several `<testsuite>` elements, and reading only the
  // first undercounts later suites' failures to zero.
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  let suites = 0;
  for (const suite of xmlOpenTagHeaders(xml, 'testsuite')) {
    const attributes = xmlAttributes(suite.attributes);
    suites += 1;
    tests += numberAttribute(attributes, 'tests');
    failures += numberAttribute(attributes, 'failures');
    errors += numberAttribute(attributes, 'errors');
    skipped += numberAttribute(attributes, 'skipped');
  }
  if (suites === 0) return null;
  const failedCases: string[] = [];
  let droppedCases = 0;
  let consumedUntil = 0;
  for (const header of xmlOpenTagHeaders(xml, 'testcase')) {
    const bodyStart = header.index + header.text.length;
    let body = '';
    if (!header.text.endsWith('/>')) {
      // Closing tags are consumed forward-only: an opener whose body starts
      // before the last consumed close overlaps an already-attributed body —
      // malformed XML, and the pre-fix shape that re-found the same early
      // close for every later opener, quadratic over the whole file.
      if (bodyStart < consumedUntil) continue;
      TESTCASE_CLOSE_RE.lastIndex = bodyStart;
      const close = TESTCASE_CLOSE_RE.exec(xml);
      // A file truncated mid-case has no closing tag to attribute a body to;
      // every later opener has the same hole, so stop rather than rescan.
      if (!close) break;
      body = xml.slice(bodyStart, close.index);
      consumedUntil = close.index + close[0].length;
    }
    if (!/<(?:failure|error)\b/i.test(body)) continue;
    if (failedCases.length >= MAX_FAILURE_CASES_PER_REPORT) {
      // Keep counting but stop materializing: one report can carry tens of
      // thousands of failing cases, and the display cap in
      // appendTestSummaries only ever shows a bounded prefix — the
      // dropped count still joins the omission marker.
      droppedCases += 1;
      continue;
    }
    const testcaseAttributes = xmlAttributes(header.attributes);
    const className = decodeXml(testcaseAttributes.get('classname') ?? '');
    const name = decodeXml(testcaseAttributes.get('name') ?? 'unknown');
    failedCases.push(className ? `${className}#${name}` : name);
  }
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
): { summaries: MavenTestSummary[]; unparsed: number } {
  const fresh: string[] = [];
  for (const path of reportPaths(root)) {
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
  // the host's ICU/locale settings. Sorting BEFORE the parse cap keeps the
  // parsed subset deterministic (readdir order is not). All paths share
  // the same root prefix, so absolute and relative order agree.
  fresh.sort();
  const summaries: MavenTestSummary[] = [];
  for (const path of fresh.slice(0, MAX_FRESH_REPORTS)) {
    const summary = parseTestReport(root, path);
    if (summary) summaries.push(summary);
  }
  return { summaries, unparsed: Math.max(0, fresh.length - MAX_FRESH_REPORTS) };
}

/** Report paths are always `<projectDir>/target/<report-dir>/<file>` (see reportPaths). */
function projectDirOf(report: string): string {
  return dirname(dirname(dirname(report)));
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
  unparsedReports: number,
): CommandResult {
  if (summaries.length === 0 && unparsedReports === 0) return result;

  const clean = new Map<string, MavenTestSummary[]>();
  const failing: MavenTestSummary[] = [];
  for (const summary of summaries) {
    if (summary.failures > 0 || summary.errors > 0) {
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
    const totals = group.reduce(
      (sum, item) => ({
        tests: sum.tests + item.tests,
        skipped: sum.skipped + item.skipped,
      }),
      { tests: 0, skipped: 0 },
    );
    return {
      line:
        `[maven-test-report] ${project} (${group.length} report(s)): ` +
        `tests=${totals.tests}, failures=0, errors=0, skipped=${totals.skipped}`,
      // The group's per-report clamped passed total — what the omission
      // marker aggregates (see below).
      clampedPassed: group.reduce(
        (sum, item) => sum + Math.max(0, item.tests - item.skipped),
        0,
      ),
    };
  });
  const cleanLines = cleanGroups.map((group) => group.line);
  // One line per project dir: bounded by module count, but a 300-module
  // reactor still appends 300 lines AFTER the command output was trimmed, so
  // cap it like the failing-report and case blocks. The marker carries the
  // omitted counts so count adjudication still sees the whole run — a
  // truncated total once "corrected" a right author count to a wrong one.
  // They are per-report CLAMPED passed totals: the parser clamps per parsed
  // line, and clamping the marker's aggregated raw totals instead would let
  // one anomalous report (Surefire does not guarantee tests >= skipped)
  // cancel the passed counts of its batchmates — the exact cancellation the
  // per-report clamp prevents.
  if (cleanGroups.length > MAX_CLEAN_ROLLUP_LINES) {
    const omittedGroups = cleanGroups.slice(MAX_CLEAN_ROLLUP_LINES);
    cleanLines.length = MAX_CLEAN_ROLLUP_LINES;
    const passed = omittedGroups.reduce(
      (sum, group) => sum + group.clampedPassed,
      0,
    );
    cleanLines.push(
      `[maven-test-report] ${omittedGroups.length} more clean project rollup(s) omitted: ` +
        `tests=${passed}, failures=0, errors=0, skipped=0`,
    );
  }
  lines.push(...cleanLines);

  const reportLines = failing.map(
    (summary) =>
      `[maven-test-report] ${summary.report}: tests=${summary.tests}, ` +
      `failures=${summary.failures}, errors=${summary.errors}, skipped=${summary.skipped}`,
  );
  if (reportLines.length > MAX_FAILING_REPORT_LINES) {
    const omittedSummaries = failing.slice(MAX_FAILING_REPORT_LINES);
    reportLines.length = MAX_FAILING_REPORT_LINES;
    // Per-report clamped passed totals, for the same reason as the clean
    // marker above.
    const passed = omittedSummaries.reduce(
      (sum, item) =>
        sum +
        Math.max(0, item.tests - item.failures - item.errors - item.skipped),
      0,
    );
    reportLines.push(
      `[maven-test-report] ${omittedSummaries.length} more failing report(s) omitted: ` +
        `tests=${passed}, failures=0, errors=0, skipped=0`,
    );
  }
  lines.push(...reportLines);

  const caseLines = failing.flatMap((summary) =>
    summary.failedCases.map(
      (testcase) => `[maven-test-failure] ${summary.report}: ${testcase}`,
    ),
  );
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

  if (unparsedReports > 0) {
    lines.push(
      `[maven-test-report] ${unparsedReports} more fresh report(s) not parsed: ` +
        `the ${MAX_FRESH_REPORTS}-report evidence cap was reached`,
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
        /JAVA_HOME.*(?:not defined|incorrectly|invalid directory)/i.test(
          line,
        ) ||
        /Unable to locate a Java Runtime/i.test(line),
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

function hasFreshTestFailure(summaries: MavenTestSummary[]): boolean {
  return summaries.some(
    (summary) => summary.failures > 0 || summary.errors > 0,
  );
}

/**
 * Shell diagnostics for a wrapper that cannot start. `Permission denied` is
 * the missing executable bit; `bad interpreter` / `No such file or directory`
 * on the `./mvnw` line is a CRLF-committed shebang dying on Linux. bash >=
 * 5.2 reports the same death as `cannot execute: required file not found`
 * and dash as a bare `not found`; a `#!/usr/bin/env sh\r` shebang names
 * `/usr/bin/env`, not the wrapper, so that line gets its own alternant.
 * Win32 is known-uncovered: a broken `mvnw.cmd` (missing, CRLF, ACL) matches
 * none of these POSIX shapes and stays attributed to the diff.
 */
/**
 * Maven's rejection of a `-pl` selector naming a project it does not have in
 * the active reactor. This is the ONE piece of Maven's model this adapter
 * reads back, and it reads it from Maven rather than recomputing it: profile
 * activation, `<modules>` inheritance, and JDK-conditional membership all land
 * here already evaluated.
 */
const SELECTOR_REJECTED_RE =
  /Could not find the selected project in the reactor:\s*([^\n]*)/;

const WRAPPER_LAUNCH_FAILURE_RE =
  /(?:^|\n)(?:.*\.\/mvnw[^\n]*(?:Permission denied|bad interpreter|No such file or directory|cannot execute: required file not found|not found)|\/usr\/bin\/env:[^\n]*No such file or directory)(?:\n|$)/i;

function summaryTotals(summaries: MavenTestSummary[]) {
  return summaries.reduce(
    (sum, item) => ({
      tests: sum.tests + item.tests,
      failures: sum.failures + item.failures,
      errors: sum.errors + item.errors,
      skipped: sum.skipped + item.skipped,
    }),
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
 * cmd.exe variable expansion, which a `"…"` wrap does not stop.
 */
export function shellSelector(
  modules: string[],
  platform: string = process.platform,
): string | null {
  if (modules.length === 0) return null;
  if (modules.some((module) => /[,:%]/.test(module))) return null;
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
      if (statSync(join(root, 'mvnw.cmd')).size > 0) return 'mvnw.cmd';
    } catch {
      // absent
    }
    return 'mvn';
  }
  const wrapper = join(root, 'mvnw');
  try {
    accessSync(wrapper, constants.X_OK);
    // An EMPTY wrapper passes the existence/exec-bit gates, exits 0, and
    // the run would certify a build that never started — fall back to
    // system `mvn` exactly like the missing-bit case.
    if (statSync(wrapper).size === 0) return 'mvn';
    return './mvnw';
  } catch {
    return 'mvn';
  }
}

/**
 * Resolution inputs named by `.mvn/maven.config`: the launcher injects them
 * into the very command this adapter runs, so a settings or local-repository
 * location referenced there is a dependency input the PR can change.
 */
function mavenConfigDependencyInputs(root: string): string[] {
  const configPath = join(root, '.mvn', 'maven.config');
  let config: string;
  try {
    // Oversized configs fail closed like an unreadable one — the `.mvn/`
    // prefix still marks the config file itself as a dependency input in the
    // changed-files check. The isFile() gate matters as much as the size cap:
    // a symlink to /dev/zero or a FIFO reports size 0, passes the cap, and
    // hangs readFileSync forever.
    const stats = statSync(configPath);
    if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) return [];
    config = readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }
  const inputs: string[] = [];
  const tokens = config.split(/\s+/);
  const pairedFlags = new Set(['-s', '--settings', '-gs', '--global-settings']);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Maven 3.9's chained local repositories: EVERY entry is a local-
    // repository location. The two prefixes are disjoint —
    // `-Dmaven.repo.local.tail=` diverges from `-Dmaven.repo.local=` at
    // `.tail`, not `=` — so the check ordering does not matter; keep both.
    if (token.startsWith('-Dmaven.repo.local.tail=')) {
      for (const part of token
        .slice('-Dmaven.repo.local.tail='.length)
        .split(/[,|]/)) {
        if (!part) continue;
        const path = normalizedChangedPath(root, part);
        if (path !== null) inputs.push(path);
      }
      continue;
    }
    let value: string | undefined;
    if (pairedFlags.has(token)) value = tokens[i + 1];
    else if (token.startsWith('--settings='))
      value = token.slice('--settings='.length);
    else if (token.startsWith('--global-settings='))
      value = token.slice('--global-settings='.length);
    else if (token.startsWith('-Dmaven.repo.local='))
      value = token.slice('-Dmaven.repo.local='.length);
    // commons-cli also accepts the attached short forms (`-s<path>`): the
    // remainder of a token whose option bears an argument becomes the value.
    else if (/^-s.+/.test(token)) value = token.slice('-s'.length);
    else if (/^-gs.+/.test(token)) value = token.slice('-gs'.length);
    if (!value) continue;
    const path = normalizedChangedPath(root, value);
    if (path !== null) inputs.push(path);
  }
  return inputs;
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
  const settingsInputs = mavenConfigDependencyInputs(args.root);
  const dependencyInputsChanged = args.changedFiles.some((file) => {
    const path = normalizedChangedPath(args.root, file);
    if (path === null) return false;
    if (path.startsWith('.mvn/')) return true;
    if (executedWrapper !== null && path === executedWrapper) return true;
    if (
      settingsInputs.some(
        (input) => path === input || path.startsWith(`${input}/`),
      )
    ) {
      return true;
    }
    // ANY POM outside a `src/` fixture tree, whether or not Maven ends up
    // treating it as a reactor member. Which POMs feed resolution is the
    // effective model's answer — a `<parent>` file, an aggregator the diff
    // just activated, a POM the diff deleted — and guessing it here is the
    // approximation this adapter no longer makes. Over-counting only
    // withdraws an infrastructure carve-out, which files a failure against
    // the PR instead of the environment; under-counting ships the PR's own
    // breakage as someone else's outage.
    return /(?:^|\/)pom\.xml$/.test(path) && !/(?:^|\/)src\//.test(path);
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
  };
  // Disk preflight, mirroring the npm adapter: Maven resolves plugins and
  // dependencies inside the lifecycle command, and a run that dies on ENOSPC
  // leaves a full disk that fails every agent scheduled after this one.
  const free = freeDiskBytes(args.root);
  if (free !== null && free < INSTALL_MIN_FREE_BYTES) {
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
        `Insufficient disk space (${gib(free)}G free, need ~${gib(INSTALL_MIN_FREE_BYTES)}G): ` +
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
      timedOut: [],
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
      timedOut: [],
      note:
        `Insufficient disk space (${gib(freeForLifecycle)}G free, need ~${gib(BUILD_MIN_FREE_BYTES)}G): ` +
        `skipped \`${command}\` — the dependency warm-up consumed the headroom the ` +
        'preflight before it passed. This is an environment issue, not a code ' +
        'finding — report it as informational.',
    });
  }
  // A build-only run never reads the evidence, so it skips the snapshot too
  // — on a large reactor that is a readdir + statSync sweep of every
  // reports dir for nothing.
  const before = args.buildOnly ? null : snapshotReports(args.root);
  ranACommand = true;
  const executed = args.exec(
    command,
    args.root,
    Math.max(0, Math.min(perCommandMs, remainingMs())),
  );
  // Maven's own answer to "is this project in the active reactor". It is the
  // authority on profile activation, `<modules>` inheritance, and JDK-
  // conditional membership, and it rejects an unknown selector before
  // compiling anything — so a standalone or profile-inactive project costs one
  // fast failure here instead of a second reactor model in this file.
  const rejected = SELECTOR_REJECTED_RE.exec(executed.output);
  if (rejected) {
    return unsupportedReport(
      `Maven rejected the selected project(s) — ${rejected[1].trim()} — as not part of the active reactor. ` +
        'They are standalone or profile-inactive under the current profiles and JDK, so this run verified ' +
        'nothing and no other scope was guessed.',
    );
  }
  const fresh = before
    ? freshTestSummaries(args.root, before)
    : { summaries: [], unparsed: 0 };
  const summaries = fresh.summaries;
  const result = {
    ...appendTestSummaries(executed, summaries, fresh.unparsed),
    maven: mavenFacts,
  };
  const timedOut = result.timedOut ? [result.command] : [];
  // A fresh report recording failures outranks a green exit: surefire's
  // `testFailureIgnore` (or `-Dmaven.test.failure.ignore`) lets `mvn test`
  // exit 0 over failing tests, and the verdict must read the evidence.
  const freshFailures = hasFreshTestFailure(summaries);
  // Reports past the evidence cap were never parsed, so their failure
  // status is UNKNOWN: certifying a clean pass over them reads a failed
  // run green exactly as dropping them did. Fail closed instead.
  const evidenceCapped = fresh.unparsed > 0;
  // A zero exit is not a pass when Maven's own framing records errors it did
  // not fail on: a repo (or the PR itself) shipping `.mvn/maven.config` with
  // `-fn`/`--fail-never` makes Maven exit 0 over compilation, dependency
  // resolution, AND launch-class failures (a mid-command ENOSPC), and none
  // of those writes Surefire XML for `freshFailures` to see. Read the
  // output, or the run verifies nothing while reporting green.
  const swallowedFailure =
    result.exitCode === 0 &&
    !result.timedOut &&
    !freshFailures &&
    (isSourceFailure(result.output) ||
      isDependencyFailure(result.output) ||
      isLaunchFailure(result.output) ||
      isGoalFailure(result.output));
  const ok =
    result.exitCode === 0 &&
    !result.timedOut &&
    !freshFailures &&
    !swallowedFailure &&
    !evidenceCapped;
  // Every carve-out carries a diff-inputs exception: when the PR changed
  // the wrapper or the dependency inputs, the failure may be the diff's own
  // doing and must not be laundered into an environmental result.
  const acquisitionFailure =
    !ok &&
    !freshFailures &&
    !isSourceFailure(result.output) &&
    result.exitCode !== null &&
    ((isLaunchFailure(result.output) &&
      !executedWrapperChanged &&
      // maven-wrapper.properties feeds mvnw.cmd exactly as it feeds ./mvnw:
      // when the executed wrapper fell back to system `mvn` (no win32
      // wrapper in the tree), a config the diff changed is still suspect.
      !wrapperConfigChanged &&
      !(executable === 'mvn' && platformWrapperChanged)) ||
      (isDependencyFailure(result.output) && !dependencyInputsChanged) ||
      (executable === './mvnw' &&
        !executedWrapperChanged &&
        (result.exitCode === 126 || result.exitCode === 127) &&
        WRAPPER_LAUNCH_FAILURE_RE.test(result.output)));
  const recorded = acquisitionFailure
    ? { ...result, infrastructure: true }
    : swallowedFailure
      ? { ...result, swallowedFailure: true }
      : result;
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
    } else if (reactorWide) {
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
      'This is infrastructure evidence, not a source finding.';
  } else if (acquisitionFailure) {
    report.note =
      `\`${result.command}\` failed while acquiring or starting Maven, Java, plugins, or dependencies` +
      (result.exitCode === 0
        ? ' — a fail-never setting masked the failure with exit 0'
        : '') +
      '. This is infrastructure evidence, not a source finding.';
  } else if (!ok && result.exitCode === 0 && freshFailures) {
    const totals = summaryTotals(summaries);
    report.note =
      `\`${result.command}\` exited 0 but fresh Surefire/Failsafe reports record ` +
      `${totals.failures} failure(s) and ${totals.errors} error(s) — a testFailureIgnore-style ` +
      'setting is swallowing them. Treat these as test failures, not a pass.';
  } else if (!ok && result.exitCode === 0 && evidenceCapped) {
    report.note =
      `\`${result.command}\` exited 0, but ${fresh.unparsed} fresh Surefire/Failsafe report(s) ` +
      `exceeded the ${MAX_FRESH_REPORTS}-report evidence cap and were not parsed — their ` +
      'failure status is unknown, so the run is not certified as a pass.' +
      (swallowedFailure
        ? ' The output also records failures Maven did not fail on.'
        : '');
  } else if (!ok && result.exitCode === 0) {
    report.note =
      `\`${result.command}\` exited 0 but its output records failures Maven did not fail on — ` +
      'a fail-never setting (e.g. `-fn`/`--fail-never` in `.mvn/maven.config`) is swallowing ' +
      'them. Treat this as a failed run, not a pass.';
  } else if (!ok) {
    report.note =
      `\`${result.command}\` failed. Correlate compiler or test errors with the changed files; ` +
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
      `Maven test passed with fresh reports: ${totals.tests} tests, ${totals.failures} failures, ` +
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
      '(`,` and `:` change what the selector means to Maven; `%` expands in cmd.exe), so this ' +
      'run covered the full reactor instead of the changed modules and their upstream dependencies.';
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
  if (existsSync(join(args.root, 'package.json'))) {
    // A mixed root: npm's applies() refused the root package.json (an
    // unmodeled workspace glob, a zero-package glob, or no build/test
    // script), so Maven was selected ALONE — the npm half is unscopable
    // here, and a green Maven run must not certify it.
    report.note +=
      ' Mixed root: a root package.json exists that this run did not scope — ' +
      'files outside the Maven reactor (npm/frontend sources) were NOT verified.';
  }
  return report;
}

export const mavenToolchainAdapter: ReviewToolchainAdapter = {
  applies: (root) => existsSync(join(root, 'pom.xml')),
  run: runMavenToolchain,
};
