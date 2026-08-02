/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BuildTestReport, CommandResult } from '../build-test.js';
import type { ReviewToolchainAdapter, ToolchainRunArgs } from './toolchain.js';

export interface MavenReactor {
  modules: string[];
  projectDirs: string[];
}

export interface MavenOwnership {
  reactorWide: boolean;
  modules: string[];
  unowned: string[];
  inactiveProjects: string[];
}

export type MavenReactorResult =
  | { reactor: MavenReactor; error?: never }
  | { reactor?: never; error: string };

const REACTOR_WIDE_FILES = new Set(['pom.xml', 'mvnw', 'mvnw.cmd']);
const REPORT_DIRS = ['surefire-reports', 'failsafe-reports'];

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
  const withoutComments = pom.replace(/<!--[\s\S]*?-->/g, '');
  if (withoutComments.includes('<!--') || withoutComments.includes('-->')) {
    return null;
  }

  const entries: string[] = [];
  const stack: string[] = [];
  let moduleText: string | null = null;
  const tokens = withoutComments.match(/<[^>]+>|[^<]+/g) ?? [];
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

    const opening = /^<\s*([\w:.-]+)(?:\s[^>]*)?\s*\/?>$/.exec(token);
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
    /\.(?:md|mdx|adoc|rst|txt)$/i.test(path)
  );
}

function nearestMavenProject(root: string, path: string): string | null {
  let dir = dirname(join(root, path));
  while (isInside(root, dir)) {
    if (existsSync(join(dir, 'pom.xml'))) {
      return toPosix(relative(root, dir)) || '.';
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
  const unowned: string[] = [];
  const inactiveProjects = new Set<string>();
  let reactorWide = false;
  const deepestFirst = [...reactor.modules].sort(
    (a, b) => b.split('/').length - a.split('/').length || b.length - a.length,
  );

  for (const changedFile of changedFiles) {
    const path = normalizedChangedPath(root, changedFile);
    if (path === null) {
      unowned.push(changedFile);
      continue;
    }
    if (REACTOR_WIDE_FILES.has(path) || path.startsWith('.mvn/')) {
      reactorWide = true;
      continue;
    }
    const owner = deepestFirst.find(
      (module) => path === module || path.startsWith(`${module}/`),
    );
    if (owner) {
      modules.add(owner);
      continue;
    }
    if (isDocumentationPath(path)) {
      unowned.push(changedFile);
      continue;
    }
    const nearestProject = nearestMavenProject(root, path);
    if (nearestProject && !reactor.projectDirs.includes(nearestProject)) {
      inactiveProjects.add(nearestProject);
    } else {
      reactorWide = true;
    }
  }

  return {
    reactorWide,
    modules: [...modules].sort(),
    unowned,
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
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.xml')) {
          paths.push(join(dir, entry.name));
        }
      }
    }
  }
  return paths;
}

function snapshotReports(root: string, reactor: MavenReactor): ReportSnapshot {
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
  return summaries.sort((a, b) => a.report.localeCompare(b.report));
}

function appendTestSummaries(
  result: CommandResult,
  summaries: MavenTestSummary[],
): CommandResult {
  if (summaries.length === 0) return result;
  const lines = summaries.flatMap((summary) => {
    const line =
      `[maven-test-report] ${summary.report}: tests=${summary.tests}, ` +
      `failures=${summary.failures}, errors=${summary.errors}, skipped=${summary.skipped}`;
    const failures = summary.failedCases.map(
      (testcase) => `[maven-test-failure] ${summary.report}: ${testcase}`,
    );
    return [line, ...failures];
  });
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

function isInfrastructureFailure(output: string): boolean {
  return /(?:Could not resolve dependencies|Failed to (?:collect|read artifact descriptor)|Could not transfer artifact|Non-resolvable parent POM|PluginResolutionException|DependencyResolutionException|No plugin found for prefix|Unknown host|Name or service not known|Temporary failure in name resolution|Connection (?:reset|refused|timed out)|PKIX path building failed|status code: (?:401|403|407|429|5\d\d)|(?:mvn|java): command not found|JAVA_HOME.*(?:not defined|incorrectly)|Unable to locate a Java Runtime)/i.test(
    output,
  );
}

function shellSelector(modules: string[]): string {
  const selector = modules.join(',');
  return /^[A-Za-z0-9_./,-]+$/.test(selector)
    ? selector
    : `'${selector.replace(/'/g, `'"'"'`)}'`;
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
        `The diff changes ${args.changedFiles.length} file(s), none of them inside a Maven module ` +
        'or reactor-wide Maven configuration. There is no Maven target to build or test — this is a complete answer.',
    });
  }

  const affected = ownership.reactorWide ? ['.'] : ownership.modules;
  const buildSet = ownership.reactorWide ? ['.'] : ownership.modules;
  const executable = existsSync(join(args.root, 'mvnw')) ? './mvnw' : 'mvn';
  const lifecycle = args.buildOnly ? 'test-compile' : 'test';
  const narrowing = ownership.reactorWide
    ? ''
    : ` -pl ${shellSelector(ownership.modules)} -am -amd`;
  const command = `${executable} --batch-mode --no-transfer-progress${narrowing} ${lifecycle}`;
  const before = snapshotReports(args.root, parsed.reactor);
  const executed = args.exec(command, args.root, args.timeout * 1000);
  const summaries = args.buildOnly
    ? []
    : freshTestSummaries(args.root, parsed.reactor, before);
  const result = appendTestSummaries(executed, summaries);
  const timedOut = result.timedOut ? [result.command] : [];
  const ok = result.exitCode === 0 && !result.timedOut;
  const report = mavenReport({
    affected,
    buildSet,
    widenedWith: [],
    install: null,
    build: args.buildOnly ? [result] : [],
    test: args.buildOnly ? [] : [result],
    ok,
    timedOut,
    note: '',
  });

  if (result.timedOut) {
    report.note =
      `\`${result.command}\` ran out of time (${args.timeout}s). This is an infrastructure result, ` +
      'not a defect in the diff — report it as informational.';
  } else if (!ok && isInfrastructureFailure(result.output)) {
    report.note =
      `\`${result.command}\` failed while acquiring or starting Maven, Java, plugins, or dependencies. ` +
      'This is infrastructure evidence, not a source finding.';
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
      'but produced no fresh Surefire/Failsafe XML, so test-count evidence is unavailable.';
  } else {
    const totals = summaries.reduce(
      (sum, item) => ({
        tests: sum.tests + item.tests,
        failures: sum.failures + item.failures,
        errors: sum.errors + item.errors,
        skipped: sum.skipped + item.skipped,
      }),
      { tests: 0, failures: 0, errors: 0, skipped: 0 },
    );
    report.note =
      `Maven test passed with fresh reports: ${totals.tests} tests, ${totals.failures} failures, ` +
      `${totals.errors} errors, ${totals.skipped} skipped across ${summaries.length} report(s).`;
  }
  return report;
}

export const mavenToolchainAdapter: ReviewToolchainAdapter = {
  applies: (root) => existsSync(join(root, 'pom.xml')),
  run: runMavenToolchain,
};
