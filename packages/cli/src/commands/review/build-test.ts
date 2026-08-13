/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review build-test`: run the project's own build and tests over the code
// the PR actually changed, and report what happened as data.
//
// Agent 7's brief was a paragraph. It named `npm run build`, then `npm test`, and
// set a 120-second timeout on each. Measured against the harness's own subagent
// transcripts — the record the agent does not write — that paragraph produced
// **139 command timeouts across 89 review sessions, 71 of them `npm run build`**.
// On this repo a cold full build takes 125 seconds. The deadline the skill set was
// five seconds short of the command the skill mandated, so *every* high-effort
// review spent two minutes proving nothing, and then spent several more model
// turns discovering the timeout, ruling it "environmental", and improvising a
// narrower command — which is the command it should have been handed.
//
// Three things are therefore decided here rather than in prose:
//
//   - **The scope.** A two-file PR in one package does not need the other fifteen
//     built. The plan report names every changed file; the root package.json names
//     the workspaces; the build set follows. For PR #6866 that is 6 packages, not
//     19 — 65 seconds, not 125.
//
//   - **The widening.** A workspace's declared dependencies UNDER-approximate what
//     its compile needs: `vscode-ide-companion` maps a tsconfig path straight into
//     `../cli/src`, so its typecheck compiles CLI sources and needs a package it
//     never declares. Modelling that statically over-approximates instead (all of
//     the CLI's dependencies get dragged in). So the set is not predicted — it is
//     *corrected*: build it, and when the compiler says `TS2307: Cannot find module
//     '@scope/pkg'` about a workspace package, add that package and try again.
//     It converges on the minimal correct set and needs to model nothing.
//
//   - **The deadline.** A command that runs out of time is an infrastructure
//     result, not a defect in the diff, and it is reported as one. A review must
//     never file "the build timed out" as a Critical against a PR.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { BUILD_MIN_FREE_BYTES, freeDiskBytes, gib } from './lib/disk.js';
import { gitOpt } from './lib/git.js';
import {
  affectedMavenModules,
  mavenModuleFor,
  modulesInheritingFrom,
  readMavenLayout,
} from './lib/maven.js';
import { npmToolchainAdapter } from './lib/npm-toolchain.js';
import {
  selectToolchainAdapter,
  type ReviewToolchainAdapter,
  type ToolchainRunArgs,
} from './lib/toolchain.js';
import { type TestScope } from './lib/workspace-scope.js';
import {
  affectedWorkspaces,
  hasUnmodeledWorkspaceGlob,
  readRootPackage,
  readWorkspaceGlobs,
  readWorkspacePackages,
  workspaceDirFor,
} from './lib/workspaces.js';

/**
 * The Maven adapter: scope `mvn` to the modules the diff touches, the same
 * deal the npm adapter gives workspaces (see `runMavenBuildTest`).
 *
 * Applies only where npm is ENTIRELY absent — no declared workspaces and no
 * root build/test script. npm owns a repo that declares it: a root pom.xml
 * beside a real npm project keeps the npm path, and the polyglot routing in
 * `runBuildTest` decides what a diff the npm scope cannot feel does there.
 * The Maven gate's invariant is the absence of npm, not the presence of a
 * pom: a Renovate/prettier stub package.json (no scripts) in a Maven
 * monorepo must not misroute the repo out of this adapter.
 */
const mavenToolchainAdapter: ReviewToolchainAdapter = {
  applies: (root: string) =>
    existsSync(join(root, 'pom.xml')) &&
    readWorkspaceGlobs(root).length === 0 &&
    readRootPackage(root) === null,
  run: (args: ToolchainRunArgs) => runMavenBuildTest(args),
};

/**
 * The root toolchains build-test can select. The registry exists so the next
 * one is a registration rather than another branch in this file. The two
 * `applies()` contracts are mutually exclusive — Maven applies only where
 * npm is entirely absent — so selection never sees both at one root.
 */
export const toolchainAdapters: readonly ReviewToolchainAdapter[] = [
  npmToolchainAdapter,
  mavenToolchainAdapter,
];

/** A command this run actually executed, and what it did. */
export interface CommandResult {
  command: string;
  /** `null` when the command was killed by the deadline. */
  exitCode: number | null;
  seconds: number;
  timedOut: boolean;
  /** Trimmed output: enough to correlate a failure with the diff. */
  output: string;
  /**
   * The deadline the command was actually given (ms) — the whole-call budget
   * shortens it below the per-command default, and the timeout note must
   * quote the number that fired, not the flag default.
   */
  deadlineMs?: number;
}

export interface BuildTestReport {
  /**
   * `npm` when the workspace scoping applied, `maven` when the module
   * scoping did; `unsupported` when neither could scope the repo.
   */
  toolchain: 'npm' | 'maven' | 'unsupported';
  /** The workspace or module dirs the diff changed (`['.']` = unscoped root). */
  affected: string[];
  /** What was built, dependencies first — after any widening. */
  buildSet: string[];
  /**
   * Packages the whole-call budget stopped BEFORE their build ran, when that
   * happened. Structural for the same reason `notRun` is: a tree missing
   * these was never fully compiled, and consumers of this report
   * (`base-tree`'s availability gate) must be able to see that without
   * parsing prose.
   */
  notBuilt?: string[];
  /** Packages the compiler asked for that the dependency graph had not predicted. */
  widenedWith: string[];
  install: CommandResult | null;
  build: CommandResult[];
  test: CommandResult[];
  /**
   * What the test phase covered, so the review can state exactly what was and
   * was not run: `workspaces` lists exactly the suites the run executes, and
   * `caveat` — when present — says why that set may be incomplete. Only set
   * for workspace monorepos on a test-running call: a single-package repo's
   * one suite IS its full suite, and a build-only probe runs no tests, so
   * neither may claim a scoping decision it never made.
   */
  testScope?: TestScope;
  /**
   * True when every build and test command exited 0. An install that exits non-zero
   * but leaves a usable tree (a failed `prepare` hook) does NOT set this false — the
   * build below is the authoritative signal, and the `note` explains the install.
   */
  ok: boolean;
  /**
   * Commands killed by the deadline. These are NOT findings: a review must not
   * file "the build timed out" as a defect in someone's pull request.
   */
  timedOut: string[];
  /** Why the run did what it did, in one line — rendered into the agent's report. */
  note: string;
}

/** Output kept per command: the head and tail, which is where a failure names itself. */
const KEEP_HEAD = 2_000;
const KEEP_TAIL = 6_000;

/**
 * Did this spawn die on its deadline?
 *
 * Exported so `test-delta`'s rerun asks the SAME question rather than
 * re-deriving it — a copy there used `error.message.includes('ETIMEDOUT')`,
 * which misses an external SIGTERM and fed a silent "base is green".
 */
export function spawnTimedOut(r: {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
}): boolean {
  return (
    (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
    (r.signal === 'SIGTERM' && r.status === null)
  );
}

/** The module-resolution errors the widening loop reads to grow the build set. */
const MODULE_ERROR_RE = /Cannot find module '[^']+'|Could not resolve "[^"]+"/;

/**
 * Runner summary lines, rescued from a trimmed middle like module errors are.
 *
 * On a FAILING suite the failure details land in the tail and push the
 * `Tests  3 failed | 1132 passed` summary into the omitted middle — measured on
 * a live review of PR #8176, where `test-plan`'s count check found no summary
 * anywhere in an 8 000-char report of a 3-failure run. The summary is the one
 * line that says what the whole run amounted to; keep it.
 */
const RUNNER_SUMMARY_RE = /^\s*(?:Tests?|Test Files):?\s+\d/;

/** SGR color sequences — stripped per line before the summary test, because a
 *  real runner interleaves them BETWEEN tokens (`Tests\x1b[2m  \x1b[22m3 failed`),
 *  where no anchored pattern can step over them. The rescued line itself keeps
 *  its original bytes. */
// eslint-disable-next-line no-control-regex -- ESC is the character under test
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

export function trimOutput(s: string): string {
  if (s.length <= KEEP_HEAD + KEEP_TAIL) return s;
  const middle = s.slice(KEEP_HEAD, s.length - KEEP_TAIL);
  // Rescue module-resolution errors from the omitted middle. The widening loop
  // reads this trimmed output to decide what to add to the build set — a `Cannot
  // find module` line lost to trimming (a long TypeScript log can push one past the
  // head and before the tail) would end the widening early and surface a real
  // graph gap as a false build error. Report stays bounded; the signal survives.
  // CAPPED: the rescue exists to save a handful of summary/module-error lines,
  // and an uncapped predicate made the whole trim a no-op on 40k lines of
  // `Test <n>: …` prose (measured in review — 1.6 MB in, 1.6 MB out). Past the
  // cap the trim's bounded-output contract wins and the rest stays omitted.
  const RESCUE_MAX = 40;
  const rescued = middle
    .split('\n')
    .filter(
      (l) =>
        MODULE_ERROR_RE.test(l) ||
        RUNNER_SUMMARY_RE.test(l.replace(ANSI_SGR_RE, '')),
    )
    .slice(0, RESCUE_MAX);
  const omitted = s.length - KEEP_HEAD - KEEP_TAIL;
  const marker = rescued.length
    ? `\n\n... [${omitted} characters omitted; module-resolution errors and runner summaries kept] ...\n${rescued.join('\n')}\n\n`
    : `\n\n... [${omitted} characters omitted] ...\n\n`;
  return s.slice(0, KEEP_HEAD) + marker + s.slice(-KEEP_TAIL);
}

/**
 * The environment every build/test/install command runs under.
 *
 * `QWEN_SKIP_PREPARE` is the load-bearing entry, and it is exported and tested so
 * a future edit to this env cannot silently drop it. Without it, `npm ci` builds
 * the whole project through this repo's `prepare` hook — `npm run build` + `npm
 * run bundle` over every workspace, ~190s — which is entirely wasted, because this
 * command does its own *scoped* build right after. `prepare.js` reads this exact
 * flag, and its own comment names this exact case: "Release workflow jobs set this
 * when they run explicit build/bundle steps after npm ci." In a TUI A/B on PR
 * #6866 the install-time full build was the single largest thing left in Agent 7.
 * Harmless on any repo that does not read it.
 */
export function buildRunEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    CI: '1',
    npm_config_yes: 'true',
    QWEN_SKIP_PREPARE: '1',
  };
}

function run(command: string, cwd: string, timeoutMs: number): CommandResult {
  const started = Date.now();
  // spawnSync validates `timeout` as an unsigned integer: the adapters'
  // budget arithmetic can hand it a fractional value (a decimal --timeout
  // or --budget), which throws ERR_OUT_OF_RANGE and kills the whole call
  // with no report, or zero, which arms no kill timer at all. Coerce once
  // at the one boundary every command crosses.
  const deadlineMs = Math.max(1, Math.round(timeoutMs));
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: deadlineMs,
    maxBuffer: 64 * 1024 * 1024,
    // A build that asks a question is a build that hangs until the deadline.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildRunEnv(),
  });
  // `spawnSync` sets `error.code === 'ETIMEDOUT'` when the deadline fired — that is
  // the authoritative signal. The `SIGTERM`/null-status pair is only a fallback: it
  // also matches an external SIGTERM (a container stop), and it misses a non-default
  // `killSignal`. Check the authoritative one first.
  const timedOut = spawnTimedOut(r);
  return {
    command,
    exitCode: r.status,
    seconds: Math.round((Date.now() - started) / 1000),
    timedOut,
    output: trimOutput(`${r.stdout ?? ''}${r.stderr ?? ''}`),
    deadlineMs,
  };
}

export { unresolvedWorkspaceDeps } from './lib/npm-toolchain.js';

interface BuildTestArgs {
  plan: string;
  worktree: string;
  out?: string;
  timeout: number;
  install: boolean;
  /**
   * Build, then stop — do not run the changed workspaces' tests.
   *
   * For the merge-base tree an A/B probe compares against. Base's tests were
   * green before this PR existed and running them measures nothing about it;
   * what the probe needs from that tree is a compiled `dist/` to run against,
   * and paying for the suite twice is the difference between an A/B a reviewer
   * will use and one they will skip. Defaults false, so the PR-side call is
   * unchanged.
   */
  buildOnly?: boolean;
  /**
   * Whole-call wall-clock budget in seconds (default: 2× `timeout` − 30s of
   * headroom for process startup and the report write, floored at one
   * per-command deadline). Measured from the top of the call — install and
   * build time count against it. The closure's per-command deadlines SUM, and
   * a large one sums past the tool timeout the brief welds onto the call —
   * whose outer kill discards the report. Each suite is attempted with
   * whatever of this budget remains (a suite killed at the boundary is
   * reported as a timeout — infrastructure, not a finding); only suites never
   * attempted are named in `notRun`.
   */
  budget?: number;
  /**
   * How to run a command. Injectable so the tests can build the states that are
   * hard to force out of real npm — chiefly the one that cost a live review: an
   * install that exits non-zero and leaves a working `node_modules` behind.
   */
  exec?: (command: string, cwd: string, timeoutMs: number) => CommandResult;
}

/** The changed files, from whichever plan report produced them. */
function changedFilesFrom(planPath: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `build-test: cannot read the plan ${planPath}: ${(err as Error).message}`,
    );
  }
  // A plan that parses to `null`, a number, or an array would otherwise reach
  // `report.files` and throw a raw `TypeError` past the descriptive-error path the
  // neighbouring cases get. Name the real problem instead.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `build-test: the plan ${planPath} is not a JSON object (got ` +
        `${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}).`,
    );
  }
  const report = parsed as { files?: Array<{ path?: unknown }> };
  const files = Array.isArray(report.files) ? report.files : [];
  return files
    .map((f) => f?.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * A layout build-test can scope from: workspace globs, a root package with a
 * build/test script, or a pom.
 */
function hasScopableLayout(dir: string): boolean {
  return (
    readWorkspaceGlobs(dir).length > 0 ||
    readRootPackage(dir) !== null ||
    existsSync(join(dir, 'pom.xml'))
  );
}

/**
 * The tree to actually build in. A local review's `--worktree` is the agent's
 * cwd, and on monorepos the workspace is often a SUBDIRECTORY of the repo —
 * while the plan's file paths are repo-root-relative (`capture-local` labels
 * from the repo root). Scoping from the subdirectory matches nothing and
 * reports a confident "nothing to build" for a diff that changes real modules
 * — the false green this command exists to prevent. Re-anchor to the repo
 * root when the tree sits strictly inside one AND the root itself carries a
 * scopable layout; a standalone project nested in a repo whose root has none
 * keeps its own root and the deterministic single-package build it always
 * had. A PR worktree IS its own repo root (`rev-parse --show-toplevel` in a
 * linked worktree returns the worktree), so this never moves a PR review;
 * non-git trees stay as given.
 */
export function rebaseToRepoRoot(worktree: string): string {
  const root = resolve(worktree);
  const topLevel = gitOpt('-C', root, 'rev-parse', '--show-toplevel');
  if (!topLevel) return root;
  try {
    const top = realpathSync(resolve(topLevel));
    const here = realpathSync(root);
    if (here !== top && here.startsWith(top + sep) && hasScopableLayout(top)) {
      return top;
    }
  } catch {
    // An unreadable path keeps the tree as given.
  }
  return root;
}

/**
 * The nearest npm project strictly INSIDE the repo root that owns
 * `filePath` — a directory with its own package.json carrying a build/test
 * script. Such a project runs its own build; neither the root npm scope nor
 * `mvn -pl` executes it, so a diff inside it must not be certified by
 * either toolchain.
 */
function nestedNpmProjectOf(root: string, filePath: string): string | null {
  let dir = dirname(filePath.replace(/^\.\//, ''));
  while (dir !== '.' && dir !== '') {
    if (readRootPackage(join(root, dir))) return dir;
    dir = dirname(dir);
  }
  return null;
}

/**
 * True when some directory strictly between `filePath` and the repo root
 * holds a pom.xml — a Maven project the root layout does not model.
 */
function hasNestedAncestorPom(root: string, filePath: string): boolean {
  let dir = dirname(filePath.replace(/^\.\//, ''));
  while (dir !== '.' && dir !== '') {
    if (existsSync(join(root, dir, 'pom.xml'))) return true;
    dir = dirname(dir);
  }
  return false;
}

/**
 * True when `filePath` sits under a pom.xml strictly BELOW the module that
 * owns it (or below the repo root when no module owns it) — a nested
 * project the reactor walk does not model, whose own build `mvn -pl` never
 * runs.
 */
function hasUnmodeledNestedPom(
  root: string,
  filePath: string,
  modules: string[],
): boolean {
  const owner = mavenModuleFor(filePath, modules);
  let dir = dirname(filePath.replace(/^\.\//, ''));
  while (dir !== '.' && dir !== '' && dir !== owner) {
    if (existsSync(join(root, dir, 'pom.xml'))) return true;
    dir = dirname(dir);
  }
  return false;
}

/**
 * Does the Maven model claim this file — a pom, a reactor-global build
 * input (`mvnw`, `mvnw.cmd`, `.mvn/` config), or a path inside a modeled
 * module?
 */
function isMavenOwnedFile(f: string, modules: string[]): boolean {
  const norm = f.replace(/^\.\//, '');
  return (
    norm === 'pom.xml' ||
    norm.endsWith('/pom.xml') ||
    norm === 'mvnw' ||
    norm === 'mvnw.cmd' ||
    norm.startsWith('.mvn/') ||
    mavenModuleFor(norm, modules) !== null
  );
}

/**
 * `unsupported`: build-test cannot safely scope this repo, so the agent's brief
 * falls back to its build/test precedence (installing dependencies first). `ok` is
 * true because nothing was found wrong — it is a handoff, not a failure.
 */
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

const FALLBACK_DEADLINE_NOTE =
  'Fall back to the build/test precedence in your brief, and give each ' +
  'command a deadline it can actually meet.';

/**
 * The cross-toolchain routing gate. Selection by ROOT layout alone cannot see
 * polyglot repos — a diff the selected npm scope cannot feel (files no
 * workspace claims, or a single-root diff Maven owns) would be certified
 * green by an npm build that never compiles it. Walk the same layout facts
 * the npm adapter uses and, BEFORE delegating, route the Maven-only diffs to
 * the Maven run and hand the mixed or unmodeled ones off. Returns null when
 * the selected adapter's own run is the right next step.
 */
function routePolyglotDiff(
  root: string,
  changed: string[],
  runArgs: ToolchainRunArgs,
): BuildTestReport | null {
  const globs = readWorkspaceGlobs(root);
  const rootPkg = readRootPackage(root);
  const unmodeled = globs.length > 0 && hasUnmodeledWorkspaceGlob(globs);
  const singleRoot = !unmodeled && globs.length === 0 && rootPkg !== null;
  const hasPom = existsSync(join(root, 'pom.xml'));

  // npm cannot scope this root at all. Without a root pom the selection
  // below and the npm adapter's own diagnostic handoff are the right path;
  // a repo npm is entirely absent from routes to the Maven adapter through
  // selection (`globs.length === 0` here is the load-bearing invariant that
  // rules out every workspace repo, declared-or-not); and a repo that
  // DECLARES workspaces keeps the npm handoff even when the globs are
  // unmodeled or resolve to nothing — the changed workspace file would map
  // to no Maven module and report a false "nothing to build".
  if (
    unmodeled ||
    (!singleRoot &&
      (globs.length === 0 ||
        readWorkspacePackages(root).packages.length === 0))
  ) {
    if (!hasPom || globs.length === 0) return null;
    return unsupportedReport(
      unmodeled
        ? 'This repo uses a workspace glob shape this command does not model ' +
            '(e.g. `**`, an inner `*`, or a `foo-*` prefix), so it cannot safely decide ' +
            'which packages the diff touches. ' +
            FALLBACK_DEADLINE_NOTE
        : 'No npm package here to scope (no workspaces, and the root has no build/test ' +
            'script). Fall back to the build/test precedence in your brief — installing ' +
            'dependencies first — and give each command a deadline it can actually meet.',
    );
  }

  const affected = singleRoot
    ? changed.length > 0
      ? ['.']
      : []
    : affectedWorkspaces(changed, globs);

  // Nothing npm owns changed. Before certifying "nothing to build", ask
  // whether a Maven layout or a nested project claims a file the npm build
  // would never compile: certifying here is the polyglot false green this
  // command exists to prevent.
  if (affected.length === 0 && changed.length > 0) {
    if (hasPom) {
      const layout = readMavenLayout(root);
      if (
        !layout.unmodeled &&
        affectedMavenModules(changed, layout.modules).length > 0
      ) {
        return runMavenBuildTest(runArgs);
      }
      return unsupportedReport(
        'A root pom.xml is present, but the diff maps to no workspace and to no ' +
          'Maven module this command can safely scope — a Maven layout also ' +
          'claims this repo (or cannot be ruled out). ' +
          FALLBACK_DEADLINE_NOTE,
      );
    }
    const stray = changed.find(
      (f) =>
        nestedNpmProjectOf(root, f) !== null || hasNestedAncestorPom(root, f),
    );
    if (stray !== undefined) {
      return unsupportedReport(
        `The diff touches ${stray} under a nested project no workspace builds ` +
          '(it carries its own package.json or pom.xml). ' +
          FALLBACK_DEADLINE_NOTE,
      );
    }
  }

  // The empty-affected gate's twin for diffs that ALSO change workspace
  // files: files no workspace owns are invisible to the npm build below, so
  // certifying the npm half alone is the same polyglot false green. One
  // toolchain runs per call — hand the mixed diff off.
  if (!singleRoot) {
    const unclaimed = changed.filter(
      (f) => workspaceDirFor(f, globs) === null,
    );
    if (unclaimed.length > 0) {
      if (hasPom) {
        return unsupportedReport(
          'The diff mixes workspace files and files no workspace owns, and a root ' +
            'pom.xml is present — this command runs one toolchain per call, so the ' +
            'npm build below would certify green without compiling the Maven side. ' +
            'Fall back to the build/test precedence in your brief — building both ' +
            'halves — and give each command a deadline it can actually meet.',
        );
      }
      const stray = unclaimed.find(
        (f) =>
          nestedNpmProjectOf(root, f) !== null || hasNestedAncestorPom(root, f),
      );
      if (stray !== undefined) {
        return unsupportedReport(
          `The diff mixes workspace files and ${stray}, which belongs to a ` +
            'nested project no workspace builds (its own package.json or pom.xml). ' +
            FALLBACK_DEADLINE_NOTE,
        );
      }
    }
  }

  // The root package claims every file by containment, but polyglot repos
  // can carry a root pom.xml too, and a nested project of either toolchain
  // builds itself. The root npm build would certify green while compiling
  // none of that code: route a diff only Maven owns to the Maven run, and
  // hand off a mixed diff or one a nested project claims.
  if (singleRoot) {
    if (hasPom) {
      const layout = readMavenLayout(root);
      const claimed = changed.filter((f) =>
        isMavenOwnedFile(f, layout.modules),
      );
      if (claimed.length > 0) {
        if (!layout.unmodeled && claimed.length === changed.length) {
          return runMavenBuildTest(runArgs);
        }
        return unsupportedReport(
          'Both an npm root package and a Maven layout claim parts of this diff ' +
            '(or the Maven layout cannot be safely modeled), and this command ' +
            'runs one toolchain per call. Fall back to the build/test precedence ' +
            'in your brief — building both halves — and give each command a ' +
            'deadline it can actually meet.',
        );
      }
      const strayPom = changed.find((f) =>
        hasUnmodeledNestedPom(root, f, layout.modules),
      );
      if (strayPom !== undefined) {
        return unsupportedReport(
          `The diff touches ${strayPom} under a nested pom.xml the reactor model ` +
            'does not place, so the root npm build would certify green without ' +
            'compiling it. ' +
            FALLBACK_DEADLINE_NOTE,
        );
      }
    } else if (changed.length > 0) {
      const stray = changed.find(
        (f) =>
          nestedNpmProjectOf(root, f) !== null || hasNestedAncestorPom(root, f),
      );
      if (stray !== undefined) {
        return unsupportedReport(
          `The diff touches ${stray} under a nested project the root package ` +
            'does not build (its own package.json or pom.xml). ' +
            FALLBACK_DEADLINE_NOTE,
        );
      }
    }
  }

  return null;
}

export function runBuildTest(args: BuildTestArgs): BuildTestReport {
  // yargs `type: 'number'` coerces `--timeout abc` to NaN rather than
  // rejecting it; NaN defeats every budget-floor comparison and reaches
  // spawnSync as an invalid deadline — ERR_OUT_OF_RANGE with no report.
  // Reject both flags at the one boundary every call crosses.
  if (!Number.isFinite(args.timeout)) {
    throw new Error(
      `build-test: --timeout must be a finite number of seconds (got ${String(args.timeout)}).`,
    );
  }
  if (args.budget !== undefined && !Number.isFinite(args.budget)) {
    throw new Error(
      `build-test: --budget must be a finite number of seconds (got ${String(args.budget)}).`,
    );
  }
  const root = rebaseToRepoRoot(args.worktree);
  const changedFiles = changedFilesFrom(args.plan);
  const runArgs: ToolchainRunArgs = {
    root,
    changedFiles,
    timeout: args.timeout,
    install: args.install,
    buildOnly: args.buildOnly,
    budget: args.budget,
    exec: args.exec ?? run,
  };

  const routed = routePolyglotDiff(root, changedFiles, runArgs);
  if (routed) return routed;

  const { adapter, applicable } = selectToolchainAdapter(
    root,
    toolchainAdapters,
  );
  if (!adapter) {
    if (applicable.length > 1) {
      // Unreachable with the current adapters — Maven applies only where npm
      // is entirely absent — and deliberately kept: the selection contract is
      // "exactly one, or nothing", and the next adapter must land in a file
      // that already refuses to guess between them rather than one that has
      // to grow the branch.
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
        note:
          'More than one toolchain applies at the repository root. build-test will ' +
          'not guess which one owns this diff, so it ran nothing — report the ' +
          'ambiguity as a handoff instead of substituting ad hoc build or test ' +
          'commands.',
      };
    }
    // A root package.json marks an npm-shaped repo that npm's own gate refused
    // (an unmodeled workspace glob, workspaces that resolve to no package, or
    // no root build/test script). Delegate the handoff to the npm adapter so
    // the report carries its precise reason instead of the generic one — an
    // agent told "no npm project here" about a repo that IS one gets a worse
    // steer than the shape it cannot scope named. run() returns its
    // unsupported report before executing any command on every root where
    // applies() is false.
    if (existsSync(join(root, 'package.json'))) {
      return npmToolchainAdapter.run(runArgs);
    }
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
      note:
        'No supported npm project here to scope. Fall back to the ' +
        'build/test precedence in your brief — installing dependencies first — ' +
        'and give each command a deadline it can actually meet.',
    };
  }
  return adapter.run(runArgs);
}

/**
 * The Maven path: scope `mvn` to the modules the diff touches, the same
 * deal the npm path gives workspaces. `-am` puts the modules and everything
 * they compile against into the reactor, so resolution never depends on what
 * happens to be installed in the local repository — a scoped build must not
 * fail on an artifact the PR cannot have broken. Dependents are NOT built
 * (see the design doc): `-amd` would pull projects whose own dependencies may
 * sit outside the reactor, manufacturing resolution failures that read as
 * defects in the diff.
 */
function runMavenBuildTest(args: ToolchainRunArgs): BuildTestReport {
  const { root, changedFiles: changed, exec } = args;
  const perCommandMs = args.timeout * 1000;
  const unsupportedMaven = (note: string): BuildTestReport =>
    unsupportedReport(note);

  const layout = readMavenLayout(root);
  if (layout.unmodeled) {
    return unsupportedMaven(
      'This Maven repo declares a module this command cannot model (an ' +
        'outside-the-basedir or shell-unsafe entry, a module directory with no ' +
        'pom.xml, an entry the parser cannot see, or nesting past its depth cap), ' +
        'so it cannot safely decide which modules the diff touches. ' +
        FALLBACK_DEADLINE_NOTE,
    );
  }

  // The gate that routes here looks at the ROOT layout only — it never asks
  // whether the diff itself is Maven. A changed file inside a nested npm
  // project, or under a pom.xml the reactor walk does not model, would be
  // certified green by an `mvn -pl` scope that never builds it. Hand the
  // repo to the fallback whenever a changed file sits inside such a project.
  const nestedClaim = changed.find((f) => {
    if (nestedNpmProjectOf(root, f) !== null) return true;
    // A changed pom.xml is the widening logic's own input — its dir is
    // modeled there (descendants, inheritors, or the unplaceable-pom
    // fallback) — so only non-pom files can belong to an unmodeled nested
    // project here.
    const norm = f.replace(/^\.\//, '');
    return (
      norm !== 'pom.xml' &&
      !norm.endsWith('/pom.xml') &&
      hasUnmodeledNestedPom(root, f, layout.modules)
    );
  });
  if (nestedClaim !== undefined) {
    return unsupportedMaven(
      `The diff touches ${nestedClaim}, which belongs to a nested project this ` +
        'Maven scope does not build (its own package.json, or a pom.xml the ' +
        'reactor walk does not model). mvn would certify green without ever ' +
        'building it. ' +
        FALLBACK_DEADLINE_NOTE,
    );
  }

  // The wrapper pins the Maven version the repo expects. On POSIX prefer it
  // only when it is ALSO executable: one committed without the exec bit
  // (common in repos authored on Windows) exits every command 126 Permission
  // denied, which would misroute into the "correlate with the diff" framing
  // instead of falling back to a `mvn` that works. On Windows there is no
  // exec bit to gate on — Node synthesizes the mode without it — and `./mvnw`
  // is a shell script cmd cannot run, so the pinned wrapper there is
  // `mvnw.cmd`, used when present.
  let mvn = 'mvn';
  if (process.platform === 'win32') {
    if (existsSync(join(root, 'mvnw.cmd'))) mvn = 'mvnw.cmd';
  } else if (existsSync(join(root, 'mvnw'))) {
    try {
      if (statSync(join(root, 'mvnw')).mode & 0o111) mvn = './mvnw';
    } catch {
      // An unreadable wrapper falls back to `mvn`, same as an absent one.
    }
  }

  // The root pom (dependencyManagement, plugin config) and the wrapper and
  // `.mvn/` config beside it (arg files, JVM flags, extensions) can change
  // what EVERY module compiles, so a change to any of them disables scoping —
  // the npm root-package analogue. A NESTED pom is the same case for the
  // modules under it AND the modules inheriting from it: `-pl` on an
  // aggregator alone would compile nothing (packaging pom, no sources) while
  // `-am` pulls only UPSTREAM — the modules that inherit the change would
  // never build, a confident false green. Widen to every module under it and
  // every module naming it as `<parent>`. A nested pom the model cannot
  // place — not itself a module, nothing under it, nothing inheriting it —
  // disables scoping entirely: an inheritance chain through it is invisible
  // to the walk, and guessing green is what this command exists to prevent.
  // A zero-module pom is a single-module project: any change is the whole
  // project. A file under no module is the Maven docs/root-config case and
  // builds nothing.
  const isReactorGlobalInput = (norm: string): boolean =>
    norm === 'pom.xml' ||
    norm === 'mvnw' ||
    norm === 'mvnw.cmd' ||
    norm.startsWith('.mvn/');
  let reactorGlobalChanged = false;
  for (const f of changed) {
    if (isReactorGlobalInput(f.replace(/^\.\//, ''))) {
      reactorGlobalChanged = true;
      break;
    }
  }
  // A separate pass, and only when a reactor-global input did not already
  // take the whole reactor: collecting in the same loop that `break`s would
  // leave the set partially populated.
  const pomWidened = new Set<string>();
  let unplaceablePom = false;
  if (!reactorGlobalChanged) {
    for (const f of changed) {
      const norm = f.replace(/^\.\//, '');
      if (!norm.endsWith('/pom.xml')) continue;
      const dir = norm.slice(0, -'/pom.xml'.length);
      const isModule = layout.modules.includes(dir);
      const descendants = layout.modules.filter((m) =>
        m.startsWith(`${dir}/`),
      );
      const inheritors = modulesInheritingFrom(layout, dir);
      if (!isModule && descendants.length === 0 && inheritors.length === 0) {
        unplaceablePom = true;
        break;
      }
      for (const m of [...descendants, ...inheritors]) pomWidened.add(m);
    }
  }
  let affected: string[];
  if (layout.modules.length === 0) {
    affected = changed.length > 0 ? ['.'] : [];
  } else if (reactorGlobalChanged || unplaceablePom) {
    affected = ['.'];
  } else {
    affected = affectedMavenModules(changed, layout.modules);
    if (pomWidened.size > 0) {
      affected = [...new Set([...affected, ...pomWidened])].sort();
    }
  }

  const results: BuildTestReport = {
    toolchain: 'maven',
    affected,
    buildSet: [...affected],
    widenedWith: [],
    install: null,
    build: [],
    test: [],
    ok: true,
    timedOut: [],
    note: '',
  };

  if (affected.length === 0) {
    results.note =
      `The diff changes ${changed.length} file(s), none of them inside a Maven ` +
      'module (docs, root config, CI). There is nothing to build and no test to ' +
      'run — this is a complete answer, not a skipped step.';
    return results;
  }

  // The same disk preflight as the npm build phase: a compile that hits ENOSPC
  // mid-write fails with errors that read as defects in the diff.
  const free = freeDiskBytes(root);
  if (free !== null && free < BUILD_MIN_FREE_BYTES) {
    results.ok = false;
    results.note =
      `Insufficient disk space (${gib(free)}G free, need ~${gib(BUILD_MIN_FREE_BYTES)}G): ` +
      'skipped the build and tests rather than fill the disk mid-compile. This ' +
      'is an environment issue, not a code finding — report it as informational.';
    return results;
  }

  const scoped = affected[0] !== '.';
  const scope = scoped ? ` -pl ${affected.join(',')} -am` : '';
  const buildCmd = `${mvn} -B${scope} compile`;

  const b = exec(buildCmd, root, perCommandMs);
  results.build.push(b);
  if (b.timedOut) results.timedOut.push(b.command);
  // A module declared only under an inactive profile is captured by the
  // layout walk but is not in the DEFAULT reactor `-pl` selects against, so
  // Maven refuses the selection itself. That is a scoping mistake, not a
  // compile error — the correlate-with-diff framing below would push a
  // Critical for it. Hand the repo to the fallback instead.
  if (
    b.exitCode !== 0 &&
    !b.timedOut &&
    b.output.includes('Could not find the selected project in the reactor')
  ) {
    return unsupportedMaven(
      '`mvn -pl` could not find a selected module in the default reactor — it ' +
        'is declared only under a profile that is not active by default, so the ' +
        'module scoping cannot be trusted. ' +
        FALLBACK_DEADLINE_NOTE,
    );
  }
  if (b.exitCode !== 0) {
    results.ok = false;
    results.note = b.timedOut
      ? `\`${b.command}\` ran out of time (${args.timeout}s). That is an ` +
        'infrastructure result, not a defect in the diff — report it as informational.'
      : `\`${b.command}\` failed. Correlate the errors below with the diff: a ` +
        'compile error in a file the PR changed is a Critical; one in a file it did not ' +
        'touch is a pre-existing failure, and belongs in the terminal, not on the PR.';
    return results;
  }

  if (!args.buildOnly) {
    const testCmd = `${mvn} -B${scope} test`;
    const t = exec(testCmd, root, perCommandMs);
    results.test.push(t);
    if (t.timedOut) results.timedOut.push(t.command);
    if (t.exitCode !== 0) results.ok = false;
  }

  if (!results.note) {
    const failed = [...results.build, ...results.test].filter(
      (r) => r.exitCode !== 0,
    );
    const realFailures = failed.filter((r) => !r.timedOut);
    const testClause = args.buildOnly
      ? ' Tests were not run (build-only).'
      : scoped
        ? ' Tests ran over that same reactor — the selected modules plus what ' +
          '`-am` added. Everything passed.'
        : ' Tests ran over the whole reactor. Everything passed.';
    if (results.ok) {
      results.note = scoped
        ? `Scoped the build to ${affected.length} of ${layout.modules.length} Maven ` +
          `module(s) — ${affected.join(', ')} — with \`-am\` adding what they compile ` +
          `against.${testClause}`
        : `The diff changes a reactor-global build input (the root pom, the mvnw ` +
          `wrapper, or .mvn config), a pom this command cannot place in the ` +
          `module graph, or the repo is one Maven module — so the whole reactor ` +
          `built.${testClause}`;
    } else if (realFailures.length === 0) {
      results.note =
        `${failed.length} command(s) ran out of time (${args.timeout}s). A timeout is an ` +
        'infrastructure result, not a defect in the diff — report it as informational.';
    } else {
      results.note =
        `${realFailures.length} command(s) failed. Correlate each error with the diff: a failure in a ` +
        'file the PR changed is a Critical; one in a file it did not touch is pre-existing.' +
        (failed.length > realFailures.length
          ? ' (Commands that timed out are infrastructure, not findings.)'
          : '');
    }
  }
  return results;
}

export const buildTestCommand: CommandModule = {
  command: 'build-test',
  describe:
    'Build and test the packages the diff changes (npm workspaces or Maven ' +
    'modules, and what they compile against), testing the changed npm ' +
    'workspaces plus their dependents, with a deadline the commands can ' +
    'actually meet',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe:
          'Path to the plan report from fetch-pr / plan-diff / capture-local',
      })
      .option('worktree', {
        type: 'string',
        demandOption: true,
        describe:
          'The tree to build in — the PR worktree for a PR review, or the project ' +
          'root for a local review. Never a PR-mode build of the main checkout.',
      })
      .option('out', {
        type: 'string',
        describe: 'Write the JSON report here',
      })
      .option('timeout', {
        type: 'number',
        default: 300,
        describe:
          'Per-command deadline in seconds. Kept strictly below the 600s (600000ms) ' +
          "tool timeout the agent's brief welds onto the whole call, so a single hung " +
          "command's own deadline fires — and build-test reports it as data — before " +
          'the outer shell kill would discard the report. Commands that would SUM ' +
          'past the whole call are stopped and disclosed instead — see --budget.',
      })
      .option('budget', {
        type: 'number',
        describe:
          'Whole-call wall-clock budget in seconds, measured from the top of ' +
          'the call — install and build time count against it (default: 2× ' +
          '--timeout minus 30s of headroom for process startup and the report ' +
          'write). Each suite is attempted with whatever of the budget ' +
          'remains — a suite killed at the boundary is a timeout, reported as ' +
          'infrastructure — and only suites never attempted are named notRun. ' +
          'A partial report survives where the outer shell kill would discard ' +
          'the whole one.',
      })
      .option('install', {
        type: 'boolean',
        default: true,
        describe:
          'Fetch dependencies first: `npm ci` when node_modules is absent',
      })
      .option('build-only', {
        type: 'boolean',
        default: false,
        describe:
          "Build, then stop — skip the changed workspaces' tests. For the " +
          'merge-base tree an A/B probe compares against, whose suite says ' +
          'nothing about this PR.',
      }),
  handler: (argv) => {
    const args = argv as unknown as BuildTestArgs;
    try {
      const report = runBuildTest(args);
      if (args.out) {
        writeFileSync(args.out, JSON.stringify(report, null, 2));
      }
      writeStdoutLine(JSON.stringify(report, null, 2));
    } catch (err) {
      // `changedFilesFrom` throws a descriptive message on a missing/unreadable/
      // invalid plan. Surface that message and exit cleanly, rather than letting a
      // raw stack trace reach the agent as the whole of Agent 7's result.
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};
