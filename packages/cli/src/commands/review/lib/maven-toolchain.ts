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
import type { BuildTestReport, CommandResult } from '../build-test.js';
import { shellQuotePath } from './shell-quote.js';
import type { ReviewToolchainAdapter, ToolchainRunArgs } from './toolchain.js';

export interface MavenReactor {
  modules: string[];
  projectDirs: string[];
}

export interface MavenOwnership {
  reactorWide: boolean;
  modules: string[];
  inactiveProjects: string[];
}

export type MavenReactorResult =
  | { reactor: MavenReactor; error?: never }
  | { reactor?: never; error: string };

const REACTOR_WIDE_FILES = new Set(['pom.xml', 'mvnw', 'mvnw.cmd']);
/**
 * `failsafe-reports` is forward-looking today: this adapter only ever runs
 * `test` and `test-compile`, and Failsafe binds to `integration-test` /
 * `verify`, so any XML found there is filtered out as stale. The scan stays
 * so the evidence is picked up if a later change ever runs a Failsafe phase.
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

function moduleEntries(pom: string): string[] | null {
  // CDATA goes first: a `-->` inside one (antrun/checkstyle/xml-generation
  // config) would otherwise trip the leftover-comment guard below, and a
  // `<module>` inside one would be mistaken for markup.
  const withoutCdata = pom.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const withoutComments = withoutCdata.replace(/<!--[\s\S]*?-->/g, '');
  if (withoutComments.includes('<!--') || withoutComments.includes('-->')) {
    return null;
  }

  const entries: string[] = [];
  const stack: string[] = [];
  let moduleText: string | null = null;
  // Quote-aware: a `>` inside an attribute value is legal XML and occurs in
  // real plugin config; splitting the tag there fails the whole POM closed.
  const tokens =
    withoutComments.match(/<(?:"[^"]*"|'[^']*'|[^>"'])*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (moduleText !== null) moduleText += token;
      continue;
    }
    if (/^<\?(?:.|\n)*\?>$/.test(token) || /^<![^-]/.test(token)) continue;

    const closing = /^<\/\s*([\w:.-]+)\s*>$/.exec(token);
    if (closing) {
      const name = closing[1].split(':').at(-1) ?? '';
      if (stack.pop() !== name) return null;
      if (name === 'module' && moduleText !== null) {
        const entry = moduleText.trim();
        if (!entry || /[<$>{}&]/.test(entry)) return null;
        entries.push(entry);
        moduleText = null;
      }
      continue;
    }

    const opening =
      /^<\s*([\w:.-]+)(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?\s*\/?>$/.exec(token);
    if (!opening) return null;
    const name = opening[1].split(':').at(-1) ?? '';
    const selfClosing = /\/\s*>$/.test(token);
    if (
      name === 'module' &&
      stack.length === 2 &&
      stack[0] === 'project' &&
      stack[1] === 'modules'
    ) {
      if (selfClosing) return null;
      moduleText = '';
    } else if (moduleText !== null) {
      return null;
    }
    if (!selfClosing) stack.push(name);
  }
  return stack.length === 0 && moduleText === null ? entries : null;
}

export function readMavenReactor(root: string): MavenReactorResult {
  const reactorRoot = resolve(root);
  const rootPom = join(reactorRoot, 'pom.xml');
  if (!existsSync(rootPom)) {
    return { error: 'The repository root has no pom.xml.' };
  }

  const modules = new Set<string>();
  const projectDirs = new Set<string>(['.']);
  const visited = new Set<string>();

  const visit = (pomPath: string): string | null => {
    if (visited.has(pomPath)) return null;
    visited.add(pomPath);

    let pom: string;
    try {
      pom = readFileSync(pomPath, 'utf8');
    } catch (error) {
      return `Cannot read ${toPosix(relative(reactorRoot, pomPath))}: ${(error as Error).message}`;
    }
    const entries = moduleEntries(pom);
    if (!entries) {
      return `Cannot safely parse literal Maven modules from ${toPosix(relative(reactorRoot, pomPath))}.`;
    }

    const aggregatorDir = dirname(pomPath);
    for (const entry of entries) {
      if (isAbsolute(entry) || entry.includes('${') || entry.includes('@{')) {
        return `Maven module ${entry} in ${toPosix(relative(reactorRoot, pomPath))} is not a literal reactor-relative path.`;
      }
      const moduleDir = resolve(aggregatorDir, entry);
      if (!isInside(reactorRoot, moduleDir) || moduleDir === reactorRoot) {
        return `Maven module ${entry} in ${toPosix(relative(reactorRoot, pomPath))} escapes or aliases the reactor root.`;
      }
      const childPom = join(moduleDir, 'pom.xml');
      if (!existsSync(childPom)) {
        return `Maven module ${entry} in ${toPosix(relative(reactorRoot, pomPath))} has no child pom.xml.`;
      }
      const modulePath = toPosix(relative(reactorRoot, moduleDir));
      modules.add(modulePath);
      projectDirs.add(modulePath);
      const error = visit(childPom);
      if (error) return error;
    }
    return null;
  };

  const error = visit(rootPom);
  if (error) return { error };
  return {
    reactor: {
      modules: [...modules].sort(),
      projectDirs: [...projectDirs].sort(),
    },
  };
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
  return (
    path === 'README' ||
    /^README(?:\.|$)/i.test(path) ||
    /^docs?\//i.test(path) ||
    (!path.startsWith('src/') && /\.(?:md|mdx|adoc|rst|txt)$/i.test(path))
  );
}

/**
 * Repository metadata that cannot change what Maven builds: VCS/CI config,
 * licenses, editor rules. Anything NOT recognized here still runs the reactor
 * — a root `checkstyle.xml` or build script affects the build, and failing
 * closed costs time while failing open ships an unverified diff.
 */
function isRepoMetadataPath(path: string): boolean {
  return (
    /^(?:\.git(?:ignore|attributes|modules)|\.editorconfig|CODEOWNERS|LICENSE(?:\..*)?|NOTICE(?:\..*)?)$/.test(
      path,
    ) || path.startsWith('.github/')
  );
}

/**
 * A POM under a known project's `src/` tree is test data — maven-invoker ITs,
 * archetype fixtures, `src/test/resources/projects/*` — never a reactor member,
 * and no profile activates one. Reading it as a project boundary would fail the
 * whole diff closed over a fixture, so keep walking: the file stays owned by the
 * enclosing project.
 */
function isUnderTestSourceTree(
  rel: string,
  projectDirs: readonly string[],
): boolean {
  return projectDirs.some((projectDir) => {
    const src = projectDir === '.' ? 'src' : `${projectDir}/src`;
    return rel === src || rel.startsWith(`${src}/`);
  });
}

function nearestMavenProject(
  root: string,
  path: string,
  projectDirs: readonly string[],
): string | null {
  let dir = dirname(join(root, path));
  while (isInside(root, dir)) {
    if (existsSync(join(dir, 'pom.xml'))) {
      const rel = toPosix(relative(root, dir)) || '.';
      if (!isUnderTestSourceTree(rel, projectDirs)) return rel;
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  return null;
}

export function detectMavenOwnership(
  root: string,
  changedFiles: readonly string[],
  reactor: MavenReactor,
): MavenOwnership {
  const modules = new Set<string>();
  const inactiveProjects = new Set<string>();
  let reactorWide = false;
  const deepestFirst = [...reactor.modules].sort(
    (a, b) => b.split('/').length - a.split('/').length || b.length - a.length,
  );

  for (const changedFile of changedFiles) {
    const path = normalizedChangedPath(root, changedFile);
    if (path === null) continue;
    if (REACTOR_WIDE_FILES.has(path) || path.startsWith('.mvn/')) {
      reactorWide = true;
      continue;
    }
    const owner = deepestFirst.find(
      (module) => path === module || path.startsWith(`${module}/`),
    );
    if (owner) {
      if (path === `${owner}/pom.xml`) {
        // A module POM is the parent config of every module aggregated
        // beneath it: the descendants inherit what changed, and `-am` alone
        // would compile only the aggregator and test nothing.
        modules.add(owner);
        for (const module of reactor.modules) {
          if (module.startsWith(`${owner}/`)) modules.add(module);
        }
        continue;
      }
      // Documentation is judged relative to the owning module so the `src/`
      // guard means the MODULE's source tree: `core/README.md` is a no-op
      // run, but `core/src/test/resources/expected.txt` is test data and
      // must keep building.
      if (!isDocumentationPath(path.slice(owner.length + 1))) {
        const nearestProject = nearestMavenProject(
          root,
          path,
          reactor.projectDirs,
        );
        if (nearestProject && !reactor.projectDirs.includes(nearestProject)) {
          inactiveProjects.add(nearestProject);
        } else {
          modules.add(owner);
        }
      }
      continue;
    }
    // The project check outranks the documentation exemption: a changed path
    // that BELONGS to an out-of-reactor project fails closed no matter its
    // extension, as step 5 of the ownership rules mandates. Root-level docs
    // still fall through — the root project '.' is always in the reactor.
    const nearestProject = nearestMavenProject(root, path, reactor.projectDirs);
    if (nearestProject && !reactor.projectDirs.includes(nearestProject)) {
      inactiveProjects.add(nearestProject);
      continue;
    }
    if (isDocumentationPath(path) || isRepoMetadataPath(path)) continue;
    reactorWide = true;
  }

  return {
    reactorWide,
    modules: [...modules].sort(),
    inactiveProjects: [...inactiveProjects].sort(),
  };
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
}

function reportPaths(root: string, reactor: MavenReactor): string[] {
  const paths: string[] = [];
  for (const projectDir of reactor.projectDirs) {
    for (const reportDir of REPORT_DIRS) {
      const dir = join(root, projectDir, 'target', reportDir);
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.xml')) {
          paths.push(join(dir, entry.name));
        }
      }
    }
  }
  return paths;
}

function snapshotReports(root: string, reactor: MavenReactor): ReportSnapshot {
  // Freshness is an mtime comparison, and some filesystems resolve mtimes at
  // 1s granularity: a report rewritten inside the same tick reads as stale and
  // is dropped. That degrades in the safe direction — absent test-count
  // evidence, never a wrong verdict — so no sub-second workaround is worth it.
  const mtimes = new Map<string, number>();
  for (const path of reportPaths(root, reactor)) {
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
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
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
  return Number.isFinite(value) ? value : 0;
}

function parseTestReport(root: string, path: string): MavenTestSummary | null {
  let xml: string;
  try {
    xml = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const suite = /<testsuite\b([^>]*)>/i.exec(xml);
  if (!suite) return null;
  const attributes = xmlAttributes(suite[1] ?? '');
  const failedCases: string[] = [];
  const testcase = /<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/gi;
  let match: RegExpExecArray | null;
  while ((match = testcase.exec(xml)) !== null) {
    const body = match[2] ?? '';
    if (!/<(?:failure|error)\b/i.test(body)) continue;
    const testcaseAttributes = xmlAttributes(match[1] ?? '');
    const className = decodeXml(testcaseAttributes.get('classname') ?? '');
    const name = decodeXml(testcaseAttributes.get('name') ?? 'unknown');
    failedCases.push(className ? `${className}#${name}` : name);
  }
  return {
    report: toPosix(relative(root, path)),
    tests: numberAttribute(attributes, 'tests'),
    failures: numberAttribute(attributes, 'failures'),
    errors: numberAttribute(attributes, 'errors'),
    skipped: numberAttribute(attributes, 'skipped'),
    failedCases,
  };
}

function freshTestSummaries(
  root: string,
  reactor: MavenReactor,
  before: ReportSnapshot,
): MavenTestSummary[] {
  const summaries: MavenTestSummary[] = [];
  for (const path of reportPaths(root, reactor)) {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const previous = before.mtimes.get(path);
    if (previous !== undefined && mtime <= previous) continue;
    const summary = parseTestReport(root, path);
    if (summary) summaries.push(summary);
  }
  // Byte-order, not localeCompare: evidence-line order must not depend on
  // the host's ICU/locale settings.
  return summaries.sort((a, b) =>
    a.report < b.report ? -1 : a.report > b.report ? 1 : 0,
  );
}

/** Report paths are always `<projectDir>/target/<report-dir>/<file>` (see reportPaths). */
function projectDirOf(report: string): string {
  return dirname(dirname(dirname(report)));
}

function appendTestSummaries(
  result: CommandResult,
  summaries: MavenTestSummary[],
): CommandResult {
  if (summaries.length === 0) return result;

  const clean = new Map<string, MavenTestSummary[]>();
  const failing: MavenTestSummary[] = [];
  for (const summary of summaries) {
    if (summary.failures > 0 || summary.errors > 0) {
      failing.push(summary);
    } else {
      const project = projectDirOf(summary.report);
      clean.set(project, [...(clean.get(project) ?? []), summary]);
    }
  }

  const lines: string[] = [];
  const cleanLines: string[] = [];
  for (const [project, group] of clean) {
    const totals = group.reduce(
      (sum, item) => ({
        tests: sum.tests + item.tests,
        skipped: sum.skipped + item.skipped,
      }),
      { tests: 0, skipped: 0 },
    );
    cleanLines.push(
      `[maven-test-report] ${project} (${group.length} report(s)): ` +
        `tests=${totals.tests}, failures=0, errors=0, skipped=${totals.skipped}`,
    );
  }
  // One line per project dir: bounded by module count, but a 300-module
  // reactor still appends 300 lines AFTER the command output was trimmed, so
  // cap it like the failing-report and case blocks.
  if (cleanLines.length > MAX_CLEAN_ROLLUP_LINES) {
    const omitted = cleanLines.length - MAX_CLEAN_ROLLUP_LINES;
    cleanLines.length = MAX_CLEAN_ROLLUP_LINES;
    cleanLines.push(
      `[maven-test-report] ${omitted} more clean project rollup(s) omitted`,
    );
  }
  lines.push(...cleanLines);

  const reportLines = failing.map(
    (summary) =>
      `[maven-test-report] ${summary.report}: tests=${summary.tests}, ` +
      `failures=${summary.failures}, errors=${summary.errors}, skipped=${summary.skipped}`,
  );
  if (reportLines.length > MAX_FAILING_REPORT_LINES) {
    const omitted = reportLines.length - MAX_FAILING_REPORT_LINES;
    reportLines.length = MAX_FAILING_REPORT_LINES;
    reportLines.push(
      `[maven-test-report] ${omitted} more failing report(s) omitted`,
    );
  }
  lines.push(...reportLines);

  const caseLines = failing.flatMap((summary) =>
    summary.failedCases.map(
      (testcase) => `[maven-test-failure] ${summary.report}: ${testcase}`,
    ),
  );
  if (caseLines.length > MAX_FAILURE_CASE_LINES) {
    const omitted = caseLines.length - MAX_FAILURE_CASE_LINES;
    caseLines.length = MAX_FAILURE_CASE_LINES;
    caseLines.push(
      `[maven-test-failure] ${omitted} more failing case(s) omitted`,
    );
  }
  lines.push(...caseLines);

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

function mavenReport(
  fields: Omit<BuildTestReport, 'toolchain'>,
): BuildTestReport {
  return { toolchain: 'maven', ...fields };
}

/** Shell- and JVM-level facts that need no Maven framing to be recognized. */
function isLaunchFailure(output: string): boolean {
  return /(?:mvn|java): (?:command )?not found|(?:mvn|java)(?:\.cmd)?'? is not recognized as an internal or external command|No space left on device|JAVA_HOME.*(?:not defined|incorrectly)|Unable to locate a Java Runtime/i.test(
    output,
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
  /^\[(?:ERROR|FATAL)\].*(?:Could not resolve dependencies|Failed to (?:collect|read artifact descriptor)|Could not transfer artifact|Non-resolvable parent POM|PluginResolutionException|DependencyResolutionException|No plugin found for prefix|Unknown host|Name or service not known|Temporary failure in name resolution|Connection (?:reset|refused|timed out)|PKIX path building failed|status code: (?:401|403|407|429|5\d\d))/i;

export function isDependencyFailureLine(line: string): boolean {
  return DEPENDENCY_FAILURE_LINE_RE.test(line);
}

function isDependencyFailure(output: string): boolean {
  return output.split('\n').some(isDependencyFailureLine);
}

function hasFreshTestFailure(summaries: MavenTestSummary[]): boolean {
  return summaries.some(
    (summary) => summary.failures > 0 || summary.errors > 0,
  );
}

/**
 * Shell diagnostics for a wrapper that cannot start. `Permission denied` is
 * the missing executable bit; `bad interpreter` / `No such file or directory`
 * on the `./mvnw` line is a CRLF-committed shebang dying on Linux.
 */
const WRAPPER_LAUNCH_FAILURE_RE =
  /(?:^|\n).*\.\/mvnw[^\n]*(?:Permission denied|bad interpreter|No such file or directory)(?:\n|$)/i;

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

export function shellSelector(
  modules: string[],
  platform: string = process.platform,
): string {
  const selector = modules.join(',');
  if (/^[A-Za-z0-9_./,-]+$/.test(selector)) return selector;
  // The command runs through cmd.exe on Windows, where POSIX quoting is
  // literal and a `"…"` wrap does not stop %VAR% expansion or an embedded
  // quote. That stays safe only because readMavenReactor rejects any module
  // entry whose pom.xml is missing from disk (the existsSync gate), and a
  // Windows filename cannot contain `"` or `|` — do not remove that gate.
  return platform === 'win32' ? `"${selector}"` : shellQuotePath(selector);
}

/**
 * The wrapper a platform can actually execute. Every wrapper repo ships both
 * `mvnw` and `mvnw.cmd`; `./mvnw` is not runnable under win32 `cmd.exe`. On
 * POSIX a wrapper without the executable bit (a `core.fileMode=false`
 * checkout) falls back to the system `mvn` rather than dying with exit 126
 * and steering a launch failure at the PR.
 */
export function mavenExecutable(
  root: string,
  platform: string = process.platform,
): string {
  if (platform === 'win32') {
    return existsSync(join(root, 'mvnw.cmd')) ? 'mvnw.cmd' : 'mvn';
  }
  try {
    accessSync(join(root, 'mvnw'), constants.X_OK);
    return './mvnw';
  } catch {
    return 'mvn';
  }
}

function runMavenToolchain(args: ToolchainRunArgs): BuildTestReport {
  const parsed = readMavenReactor(args.root);
  if (!parsed.reactor) {
    return unsupportedReport(
      `${parsed.error} Maven reactor ownership cannot be determined safely, so no partial verification was run.`,
    );
  }
  const ownership = detectMavenOwnership(
    args.root,
    args.changedFiles,
    parsed.reactor,
  );
  if (ownership.inactiveProjects.length > 0) {
    return unsupportedReport(
      `The diff changes Maven project(s) outside the root reactor: ${ownership.inactiveProjects.join(', ')}. ` +
        'They may be standalone or profile-inactive under the current reactor, so no root-scoped Maven command was guessed.',
    );
  }
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

  const affected = ownership.reactorWide ? ['.'] : ownership.modules;
  const buildSet = ownership.reactorWide ? ['.'] : ownership.modules;
  const executable = mavenExecutable(args.root);
  const wrapperChanged = args.changedFiles.some(
    (file) => normalizedChangedPath(args.root, file) === 'mvnw',
  );
  // The dependency carve-out below must not file a PR-caused breakage as
  // environmental: when the diff changed POMs or `.mvn/**`, the resolution
  // failure may be the diff's own doing.
  const dependencyInputsChanged = args.changedFiles.some((file) => {
    const path = normalizedChangedPath(args.root, file);
    return (
      path !== null &&
      (path === 'pom.xml' ||
        path.endsWith('/pom.xml') ||
        path.startsWith('.mvn/'))
    );
  });
  const lifecycle = args.buildOnly ? 'test-compile' : 'test';
  // `-am` builds the changed modules plus their upstream closure. `-amd`
  // (downstream) selects the whole reactor on exactly the repos this adapter
  // was built for, and a run that spends its whole deadline proving nothing
  // is the failure this command exists to avoid — downstream coverage stays
  // the project's CI matrix, as with the npm adapter's scope.
  const narrowing = ownership.reactorWide
    ? ''
    : ` -pl ${shellSelector(ownership.modules)} -am`;
  const command = `${executable} --batch-mode --no-transfer-progress${narrowing} ${lifecycle}`;
  // A build-only run never reads the evidence, so it skips the snapshot too
  // — on a large reactor that is a readdir + statSync sweep of every
  // reports dir for nothing.
  const before = args.buildOnly
    ? null
    : snapshotReports(args.root, parsed.reactor);
  const executed = args.exec(command, args.root, args.timeout * 1000);
  const summaries = before
    ? freshTestSummaries(args.root, parsed.reactor, before)
    : [];
  const result = appendTestSummaries(executed, summaries);
  const timedOut = result.timedOut ? [result.command] : [];
  // A fresh report recording failures outranks a green exit: surefire's
  // `testFailureIgnore` (or `-Dmaven.test.failure.ignore`) lets `mvn test`
  // exit 0 over failing tests, and the verdict must read the evidence.
  const freshFailures = hasFreshTestFailure(summaries);
  const ok = result.exitCode === 0 && !result.timedOut && !freshFailures;
  const acquisitionFailure =
    !ok &&
    !freshFailures &&
    result.exitCode !== null &&
    (isLaunchFailure(result.output) ||
      (isDependencyFailure(result.output) && !dependencyInputsChanged) ||
      (executable === './mvnw' &&
        !wrapperChanged &&
        (result.exitCode === 126 || result.exitCode === 127) &&
        WRAPPER_LAUNCH_FAILURE_RE.test(result.output)));
  const recorded = acquisitionFailure
    ? { ...result, infrastructure: true }
    : result;
  const report = mavenReport({
    affected,
    buildSet,
    widenedWith: [],
    install: null,
    build: args.buildOnly ? [recorded] : [],
    test: args.buildOnly ? [] : [recorded],
    ok,
    timedOut,
    note: '',
  });

  if (result.timedOut) {
    report.note =
      `\`${result.command}\` ran out of time (${args.timeout}s). This is an infrastructure result, ` +
      'not a defect in the diff — report it as informational.';
  } else if (result.exitCode === null) {
    // A spawn-level death (output past maxBuffer, an outside signal) leaves no
    // exit code and nothing to correlate — infrastructure, like a timeout.
    report.note =
      `\`${result.command}\` ended without an exit code (a spawn failure or signal outside the deadline). ` +
      'This is infrastructure evidence, not a source finding.';
  } else if (acquisitionFailure) {
    report.note =
      `\`${result.command}\` failed while acquiring or starting Maven, Java, plugins, or dependencies. ` +
      'This is infrastructure evidence, not a source finding.';
  } else if (!ok && result.exitCode === 0) {
    const totals = summaryTotals(summaries);
    report.note =
      `\`${result.command}\` exited 0 but fresh Surefire/Failsafe reports record ` +
      `${totals.failures} failure(s) and ${totals.errors} error(s) — a testFailureIgnore-style ` +
      'setting is swallowing them. Treat these as test failures, not a pass.';
  } else if (!ok) {
    report.note =
      `\`${result.command}\` failed. Correlate compiler or test errors with the changed files; ` +
      'fresh module-qualified Surefire/Failsafe summaries are appended when available.';
  } else if (args.buildOnly) {
    report.note =
      `Maven compiled ${ownership.reactorWide ? 'the full reactor' : ownership.modules.join(', ')}. ` +
      'Tests were not run (build-only).';
  } else if (summaries.length === 0) {
    report.note =
      `Maven tested ${ownership.reactorWide ? 'the full reactor' : ownership.modules.join(', ')} successfully, ` +
      'but produced no fresh Surefire/Failsafe XML (reports written to a non-default directory are not seen here), ' +
      'so test-count evidence is unavailable.';
  } else {
    const totals = summaryTotals(summaries);
    report.note =
      `Maven test passed with fresh reports: ${totals.tests} tests, ${totals.failures} failures, ` +
      `${totals.errors} errors, ${totals.skipped} skipped across ${summaries.length} report(s).`;
  }
  if (!ownership.reactorWide) {
    report.note +=
      ' Scope: this run covered the changed modules and their upstream dependencies only ' +
      '(`-pl … -am`); downstream dependents were NOT built — a POM or API change can break ' +
      "modules this run never compiled, and that coverage stays with the project's CI.";
  }
  return report;
}

export const mavenToolchainAdapter: ReviewToolchainAdapter = {
  applies: (root) => existsSync(join(root, 'pom.xml')),
  run: runMavenToolchain,
};
