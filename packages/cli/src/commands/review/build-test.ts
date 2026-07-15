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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  affectedWorkspaces,
  buildSetFor,
  hasUnmodeledWorkspaceGlob,
  readWorkspaceGlobs,
  readWorkspacePackages,
  type WorkspacePackage,
} from './lib/workspaces.js';

/** A command this run actually executed, and what it did. */
export interface CommandResult {
  command: string;
  /** `null` when the command was killed by the deadline. */
  exitCode: number | null;
  seconds: number;
  timedOut: boolean;
  /** Trimmed output: enough to correlate a failure with the diff. */
  output: string;
}

export interface BuildTestReport {
  /** `npm` when the workspace scoping applied; `unsupported` otherwise. */
  toolchain: 'npm' | 'unsupported';
  /** Workspace dirs the diff changed. */
  affected: string[];
  /** What was built, dependencies first — after any widening. */
  buildSet: string[];
  /** Packages the compiler asked for that the dependency graph had not predicted. */
  widenedWith: string[];
  install: CommandResult | null;
  build: CommandResult[];
  test: CommandResult[];
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

function trimOutput(s: string): string {
  if (s.length <= KEEP_HEAD + KEEP_TAIL) return s;
  return (
    s.slice(0, KEEP_HEAD) +
    `\n\n... [${s.length - KEEP_HEAD - KEEP_TAIL} characters omitted] ...\n\n` +
    s.slice(-KEEP_TAIL)
  );
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
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    // A build that asks a question is a build that hangs until the deadline.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildRunEnv(),
  });
  // `spawnSync` sets `error.code === 'ETIMEDOUT'` when the deadline fired — that is
  // the authoritative signal. The `SIGTERM`/null-status pair is only a fallback: it
  // also matches an external SIGTERM (a container stop), and it misses a non-default
  // `killSignal`. Check the authoritative one first.
  const timedOut =
    (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
    (r.signal === 'SIGTERM' && r.status === null);
  return {
    command,
    exitCode: r.status,
    seconds: Math.round((Date.now() - started) / 1000),
    timedOut,
    output: trimOutput(`${r.stdout ?? ''}${r.stderr ?? ''}`),
  };
}

/**
 * Workspace packages the compiler said it could not resolve.
 *
 * Only names that belong to a workspace of *this* repo are returned. A missing
 * third-party module is a broken install or a genuine defect in the diff — not
 * something a wider build set can fix — and widening on it would loop.
 */
export function unresolvedWorkspaceDeps(
  output: string,
  packages: WorkspacePackage[],
): string[] {
  const known = new Map(packages.map((p) => [p.name, p.dir]));
  const found = new Set<string>();
  // `error TS2307: Cannot find module '@qwen-code/webui' or its corresponding
  // type declarations.` — and the same shape from a bundler.
  const re = /Cannot find module '([^']+)'|Could not resolve "([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    // `@scope/pkg/sub` resolves against the package `@scope/pkg`.
    const base = name.startsWith('@')
      ? name.split('/').slice(0, 2).join('/')
      : name.split('/')[0];
    if (known.has(base)) found.add(base);
  }
  return [...found];
}

interface BuildTestArgs {
  plan: string;
  worktree: string;
  out?: string;
  timeout: number;
  install: boolean;
  /**
   * How to run a command. Injectable so the tests can build the states that are
   * hard to force out of real npm — chiefly the one that cost a live review: an
   * install that exits non-zero and leaves a working `node_modules` behind.
   */
  exec?: (command: string, cwd: string, timeoutMs: number) => CommandResult;
}

/** The changed files, from whichever plan report produced them. */
function changedFilesFrom(planPath: string): string[] {
  let report: { files?: Array<{ path?: unknown }> };
  try {
    report = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `build-test: cannot read the plan ${planPath}: ${(err as Error).message}`,
    );
  }
  const files = Array.isArray(report.files) ? report.files : [];
  return files
    .map((f) => f?.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
}

export function runBuildTest(args: BuildTestArgs): BuildTestReport {
  const root = resolve(args.worktree);
  const perCommandMs = args.timeout * 1000;
  const exec = args.exec ?? run;
  const changed = changedFilesFrom(args.plan);

  const globs = readWorkspaceGlobs(root);
  const packages = readWorkspacePackages(root);

  // `unsupported` when there is nothing to scope, OR when the layout uses a glob
  // shape the walker does not model (`packages/**`, `foo-*`, `*/lib`). The second
  // is the load-bearing addition: without it, a diff inside an unmodeled workspace
  // resolves to an EMPTY affected set and the report says "no package to build" — a
  // confident false green for the review's one deterministic check. Falling back to
  // the brief's precedence list is the safe direction.
  // The unmodeled-glob check comes FIRST: `packages/**` also makes
  // `readWorkspacePackages` find nothing, so ordering it after the empty-packages
  // check would mislabel it "no workspaces here" instead of naming the real reason.
  const unmodeled = globs.length > 0 && hasUnmodeledWorkspaceGlob(globs);
  if (unmodeled || globs.length === 0 || packages.length === 0) {
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
      note: unmodeled
        ? 'This repo uses a workspace glob shape this command does not model ' +
          '(e.g. `**`, an inner `*`, or a `foo-*` prefix), so it cannot safely decide ' +
          'which packages the diff touches. Fall back to the build/test precedence in ' +
          'your brief, and give each command a deadline it can actually meet.'
        : 'No npm workspaces here, so there is nothing to scope. Fall back to the ' +
          'build/test precedence in your brief, and give each command a deadline it can actually meet.',
    };
  }

  const affected = affectedWorkspaces(changed, globs);
  if (affected.length === 0) {
    return {
      toolchain: 'npm',
      affected: [],
      buildSet: [],
      widenedWith: [],
      install: null,
      build: [],
      test: [],
      ok: true,
      timedOut: [],
      note:
        `The diff changes ${changed.length} file(s), none of them inside a workspace ` +
        '(docs, root config, CI). There is no package to build and no test to run — ' +
        'this is a complete answer, not a skipped step.',
    };
  }

  const byDir = new Map(packages.map((p) => [p.dir, p]));
  const results: BuildTestReport = {
    toolchain: 'npm',
    affected,
    buildSet: [],
    widenedWith: [],
    install: null,
    build: [],
    test: [],
    ok: true,
    timedOut: [],
    note: '',
  };

  // The install. It lives here, not in the orchestrator, because nothing before
  // this command needs `node_modules`: the eleven diff-reading agents read the
  // diff and grep the source. Run from the orchestrator it blocks the fan-out;
  // run here it overlaps the other agents, which are still reading.
  //
  // A non-zero exit is NOT the end of the run, and finding that out cost a live
  // review. `npm ci` executes the project's `prepare` lifecycle script, and this
  // repo's runs `npm run build` and `npm run bundle` — the whole monorepo. On the
  // PR under review that build hit a **pre-existing** type error in a package the
  // diff does not touch, `npm ci` exited 1, and this command gave up having built
  // and tested nothing: the one deterministic signal a review has, withheld
  // because an unrelated package failed to compile during an install.
  //
  // The packages were installed. `node_modules` was on disk. So the test is not
  // the exit code, it is whether the tree we need is there — and the scoped build
  // below is the authoritative answer anyway. Report the install failure, and
  // carry on to ask the question the review actually came to ask.
  //
  // A **timeout** is the exception, and it is not the same case. A `prepare` hook
  // that fails leaves a *complete* `node_modules` and only the post-install build
  // broken; a timeout kills `npm ci` mid-download and leaves a **partial** tree.
  // Building against that produces "module not found" errors that look like defects
  // in the diff and are not — so a timed-out install aborts, exactly like an install
  // that left no tree at all.
  //
  // Whether to install is gated on npm's **completeness marker**, not the bare
  // directory. `npm ci` (and `install`) write `node_modules/.package-lock.json` only
  // once the tree is fully materialised, so a partial tree — left by a timeout here,
  // or by the agent's own shell-tool kill one level up — has the directory but not
  // the marker. Gating on the directory would let every later run *skip* the install
  // and build against that partial tree; gating on the marker reinstalls it.
  const installComplete = (): boolean =>
    existsSync(join(root, 'node_modules', '.package-lock.json'));
  if (args.install && !installComplete()) {
    const install = exec('npm ci --no-audit --no-fund', root, perCommandMs);
    results.install = install;
    if (install.timedOut) results.timedOut.push(install.command);
    // A timeout leaves a partial tree — remove it, so this is not mistaken next time
    // for a complete install to build against.
    if (install.timedOut) {
      rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    }
    if (install.timedOut || !installComplete()) {
      results.ok = false;
      results.note = install.timedOut
        ? `\`${install.command}\` ran out of time (${args.timeout}s) and left an ` +
          'incomplete `node_modules` (now removed), so nothing could be built or tested ' +
          'against it. This is an infrastructure result, not a defect in the diff — ' +
          'report it as informational.'
        : 'The install failed and left no usable `node_modules`, so nothing could be ' +
          'built or tested. This is an environment failure, not a defect in the diff — ' +
          'report it as informational.';
      return results;
    }
  }

  const alsoBuild: string[] = [];
  let set = buildSetFor(affected, packages);
  const built = new Set<string>();
  const widened = new Set<string>();

  // Build, and let the compiler correct the set. Three widenings is generous: each
  // one is a package the graph could not have known about, and a fourth would mean
  // the graph is not wrong but absent.
  for (let attempt = 0; attempt <= 3; attempt++) {
    let failure: CommandResult | null = null;

    for (const dir of set) {
      if (built.has(dir)) continue;
      const pkg = byDir.get(dir);
      if (!pkg?.scripts.includes('build')) {
        built.add(dir); // Nothing to build is not a failure to build.
        continue;
      }
      const r = exec(`npm run build --workspace=${dir}`, root, perCommandMs);
      results.build.push(r);
      if (r.timedOut) results.timedOut.push(r.command);
      if (r.exitCode !== 0) {
        failure = r;
        break;
      }
      built.add(dir);
    }

    if (!failure) break;

    // Did it fail because the set was too small? The declared graph under-
    // approximates whenever a package reaches into another's *sources* — a
    // tsconfig `paths` entry pointing at `../cli/src/...` compiles that package's
    // imports without ever declaring a dependency on them.
    const missing = unresolvedWorkspaceDeps(failure.output, packages).filter(
      (name) => {
        const dir = packages.find((p) => p.name === name)?.dir;
        return dir && !set.includes(dir);
      },
    );
    if (missing.length === 0 || attempt === 3) {
      results.ok = false;
      results.note = failure.timedOut
        ? `\`${failure.command}\` ran out of time (${args.timeout}s). That is an ` +
          'infrastructure result, not a defect in the diff — report it as informational.'
        : `\`${failure.command}\` failed. Correlate the errors below with the diff: a ` +
          'compile error in a file the PR changed is a Critical; one in a file it did not ' +
          'touch is a pre-existing failure, and belongs in the terminal, not on the PR.';
      results.buildSet = set;
      results.widenedWith = [...widened];
      return results;
    }

    // Drop the failed attempt from the report. It is about to be retried with the
    // package it asked for, and it is **not evidence about this PR**: the build set
    // was too small, which is this command's mistake, not the author's. Left in
    // `build[]`, an agent told "a build failure in a changed file is a Critical"
    // reads `packages/vscode-ide-companion rc=2` and files exactly that — a public
    // blocker on a PR whose build passes. Drop it from `timedOut` too: a build that
    // both ran out of time and named a missing workspace package would otherwise
    // survive the retry only in `timedOut`, and an `ok: true` report would still
    // instruct the agent to note an infrastructure event that did not happen.
    results.build = results.build.filter((r) => r !== failure);
    results.timedOut = results.timedOut.filter((c) => c !== failure.command);

    for (const name of missing) widened.add(name);
    for (const name of missing) {
      const dir = packages.find((p) => p.name === name)?.dir;
      if (dir) alsoBuild.push(dir);
    }
    // As `alsoBuild`, never as `affected`. The compiler asked for this package
    // because something compiles *against* it; the PR did not change it, so its
    // consumers cannot have been broken by the PR and must not be built.
    set = buildSetFor(affected, packages, alsoBuild);
  }

  results.buildSet = set;
  results.widenedWith = [...widened];

  // Test only what changed. `npm test` at the root runs every workspace in
  // parallel and does not finish; the packages the diff did not touch cannot have
  // been broken by it, and their tests were green before this PR and will be green
  // after it.
  for (const dir of affected) {
    const pkg = byDir.get(dir);
    if (!pkg?.scripts.includes('test')) continue;
    const r = exec(`npm test --workspace=${dir}`, root, perCommandMs);
    results.test.push(r);
    if (r.timedOut) results.timedOut.push(r.command);
    if (r.exitCode !== 0) results.ok = false;
  }

  if (!results.note) {
    const failed = [...results.build, ...results.test].filter(
      (r) => r.exitCode !== 0,
    );
    // A timeout is a failure (its exitCode is null), but it is NOT a defect in the
    // diff, and the note must not tell the agent to correlate it with one — the
    // brief says timeouts are infrastructure, and an agent trusts the data over its
    // instructions. So a test that runs out of time gets the same infrastructure
    // framing the build-timeout path already gives, not the "a failure is a Critical"
    // message meant for a real compile/assertion failure.
    const realFailures = failed.filter((r) => !r.timedOut);
    if (results.ok) {
      results.note =
        `Built ${results.buildSet.length} of ${packages.length} workspaces (the ${affected.length} the ` +
        `diff changes, plus what they compile against${
          widened.size
            ? `, plus ${[...widened].join(', ')} the compiler asked for`
            : ''
        }) and ran the tests of the changed ones. Everything passed.`;
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

  // The install exited non-zero but left a usable tree, so the run went ahead. Say
  // so — the build and test results below are real, and the install failure is not
  // a finding about this PR. (A `prepare` script that builds the whole project,
  // as this repo's does, fails on any pre-existing error anywhere in it.)
  if (results.install && results.install.exitCode !== 0) {
    results.note =
      `\`${results.install.command}\` exited ${results.install.exitCode} but left a usable ` +
      '`node_modules`, so the build and test below ran anyway and their results stand. ' +
      'The install failure is an environment/infrastructure result — report it as ' +
      'informational, never as a Critical, and never against this PR. ' +
      results.note;
  }
  return results;
}

export const buildTestCommand: CommandModule = {
  command: 'build-test',
  describe:
    'Build and test the workspaces the diff changes (and what they compile ' +
    'against), with a deadline the commands can actually meet',
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
        describe: "The PR worktree to build in (never the user's checkout)",
      })
      .option('out', {
        type: 'string',
        describe: 'Write the JSON report here',
      })
      .option('timeout', {
        type: 'number',
        default: 600,
        describe:
          'Per-command deadline in seconds. The old 120s was five seconds short ' +
          "of this repo's own cold build, so every review timed out.",
      })
      .option('install', {
        type: 'boolean',
        default: true,
        describe: 'Run `npm ci` first when node_modules is absent',
      }),
  handler: (argv) => {
    const args = argv as unknown as BuildTestArgs;
    const report = runBuildTest(args);
    if (args.out) {
      writeFileSync(args.out, JSON.stringify(report, null, 2));
    }
    writeStdoutLine(JSON.stringify(report, null, 2));
  },
};
