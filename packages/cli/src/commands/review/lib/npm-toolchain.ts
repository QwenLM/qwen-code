/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildTestReport, CommandResult } from '../build-test.js';
import {
  BUILD_MIN_FREE_BYTES,
  INSTALL_MIN_FREE_BYTES,
  freeDiskBytes,
  gib,
} from './disk.js';
import {
  affectedWorkspaces,
  buildSetFor,
  hasUnmodeledWorkspaceGlob,
  readRootPackage,
  readWorkspaceGlobs,
  readWorkspacePackages,
  reverseDependencyClosure,
  scriptFansOut,
  type WorkspacePackage,
} from './workspaces.js';
import { resolveTestScope, type TestScope } from './workspace-scope.js';
import type { ReviewToolchainAdapter, ToolchainRunArgs } from './toolchain.js';

/**
 * Below this much remaining whole-call budget a command is NOT attempted: npm
 * cannot boot and produce signal in a few hundred milliseconds, so an
 * "attempt" would manufacture a fake timeout (exitCode null, ok flips false)
 * where an honest notRun says exactly what happened. 15s covers an npm/vitest
 * cold start with headroom for a small suite.
 */
const BUDGET_MIN_ATTEMPT_MS = 15_000;

/**
 * A workspace dir is interpolated into a shell command line inside double
 * quotes. The dirs come from the REVIEWED repo's tree and root manifest —
 * PR-authored input — and POSIX shells expand `$()` and backticks even inside
 * double quotes, so an unescaped name is a command-injection path. Escape the
 * characters that stay live inside double quotes. (Safe names, which is every
 * real one, pass through unchanged.) POSIX scope only: on Windows `shell:
 * true` is cmd.exe, where backslash escapes are not honored and `%VAR%`
 * expands inside double quotes — a `"` cannot appear in a Windows dir name,
 * so the breakout surface there is narrower, but the escape is not a
 * cmd.exe-proof seal.
 */
function shellArg(dir: string): string {
  return `"${dir.replace(/[\\"$`]/g, '\\$&')}"`;
}

/** The build command for a dir: the root package takes no `--workspace`. */
function buildCommand(dir: string): string {
  return dir === '.'
    ? 'npm run build'
    : `npm run build --workspace=${shellArg(dir)}`;
}
/** The test command for a dir: the root package takes no `--workspace`. */
function testCommand(dir: string): string {
  return dir === '.' ? 'npm test' : `npm test --workspace=${shellArg(dir)}`;
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

function runNpmToolchain(args: ToolchainRunArgs): BuildTestReport {
  const { root, changedFiles: changed, exec } = args;
  const perCommandMs = args.timeout * 1000;
  // The whole-call wall-clock budget for the call, in milliseconds — measured
  // from the TOP of the run, so install and build time count against it. The
  // default keeps 30s of headroom under the 600-second tool timeout the brief
  // welds onto the call: the clock outside starts before node does, and the
  // report write must still fit. The floor is one command deadline: a tiny
  // --timeout must not turn the headroom into a negative budget that starves
  // every suite.
  const callBudgetMs =
    (args.budget ?? Math.max(args.timeout, args.timeout * 2 - 30)) * 1000;
  const runStarted = Date.now();
  /** Budget left for the whole call; every phase spends from it. */
  const remainingMs = (): number => callBudgetMs - (Date.now() - runStarted);
  /** The deadline a timed-out command was actually given, in whole seconds. */
  const deadlineSecs = (r: CommandResult): number =>
    Math.round((r.deadlineMs ?? perCommandMs) / 1000);

  // `unsupported`: build-test cannot safely scope this repo, so the agent's brief
  // falls back to its build/test precedence (installing dependencies first). `ok` is
  // true because nothing was found wrong — it is a handoff, not a failure.
  const unsupportedReport = (note: string): BuildTestReport => ({
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
  });

  const globs = readWorkspaceGlobs(root);
  let { packages, skipped } = readWorkspacePackages(root);

  // The root package, read once: it decides single-root mode below, and in a
  // workspace monorepo its own test suite is still a dependent the closure
  // must see (a root that declares a dependency on a changed workspace).
  const rootPkg = readRootPackage(root);

  // A workspace-less `package.json` with a build/test script is the most common npm
  // repo shape — treat the root as a single package so it keeps the install, the
  // deadline, and timeout-as-data, instead of dropping to a precedence list that no
  // longer installs. Its build/test commands take no `--workspace` (dir `.`).
  let singleRoot = false;
  const unmodeled = globs.length > 0 && hasUnmodeledWorkspaceGlob(globs);
  if (!unmodeled && globs.length === 0 && rootPkg) {
    packages = [rootPkg];
    singleRoot = true;
  }

  // `unsupported` when there is nothing to scope, OR when the layout uses a glob
  // shape the walker does not model (`packages/**`, `foo-*`, `*/lib`). The second
  // is load-bearing: without it, a diff inside an unmodeled workspace resolves to an
  // EMPTY affected set and the report says "no package to build" — a confident false
  // green for the review's one deterministic check. Falling back to the brief's
  // precedence list is the safe direction. The unmodeled check comes FIRST because
  // `packages/**` also makes `readWorkspacePackages` find nothing.
  if (
    unmodeled ||
    (!singleRoot && (globs.length === 0 || packages.length === 0))
  ) {
    return unsupportedReport(
      unmodeled
        ? 'This repo uses a workspace glob shape this command does not model ' +
            '(e.g. `**`, an inner `*`, or a `foo-*` prefix), so it cannot safely decide ' +
            'which packages the diff touches. Fall back to the build/test precedence in ' +
            'your brief, and give each command a deadline it can actually meet.'
        : globs.length > 0
          ? 'This repo declares npm workspaces, but none resolve to a package with a ' +
            'readable manifest, so there is nothing to scope. Fall back to the ' +
            'build/test precedence in your brief — installing dependencies first — ' +
            'and give each command a deadline it can actually meet.'
          : 'No npm package here to scope (no workspaces, and the root has no build/test ' +
            'script). Fall back to the build/test precedence in your brief — installing ' +
            'dependencies first — and give each command a deadline it can actually meet.',
    );
  }

  // A single-root repo builds and tests its one package whenever the diff changes
  // anything; a workspace repo maps the changed files to the workspaces they live in.
  const affected = singleRoot
    ? changed.length > 0
      ? ['.']
      : []
    : affectedWorkspaces(changed, globs);

  // The test scope, decided up front so the report can disclose it even when
  // there is nothing to run. Undefined for a single-root repo — its one suite
  // is its full suite, and its report must not change shape — and for a
  // build-only call: the merge-base probe runs no tests, and a testScope it
  // never executed would claim a decision the run did not make.
  // The root joins the graph whenever it is a package with a build or test
  // script — not only when it has a TEST suite. Its declared dependencies are
  // edges either way: a member that names the root as a dependency is reached
  // THROUGH the root, and a build-only root dropped from the graph takes every
  // such transitive dependent with it, silently. Which of the root's own
  // scripts run is decided separately (build loop: its `build`; test scope:
  // its `test`, unless it fans out over every workspace — see below).
  let testScope: TestScope | undefined =
    singleRoot || args.buildOnly
      ? undefined
      : resolveTestScope({
          changed,
          globs,
          packages,
          skipped,
          rootPackage: rootPkg,
          rootTestFansOut: rootPkg?.scripts.includes('test')
            ? scriptFansOut(rootPkg.scriptsText['test'])
            : false,
        });
  // The SAME graph feeds the build set, so the built set and the tested set
  // cannot drift apart — and it is the same graph for a build-only probe as
  // for the full run, or the merge-base probe measures a different tree than
  // the run it is the baseline for ("same set, same commands, same verdict").
  // The root goes FIRST: on a name collision a member must win (this repo's
  // root and packages/cli share the name `@qwen-code/qwen-code`).
  const scopeGraph = !singleRoot && rootPkg ? [rootPkg, ...packages] : packages;

  // With no affected workspace there is nothing to run at all. Three diffs land
  // here: an empty one; a build-only call (the merge-base probe), which measures
  // nothing about this PR's tests by design; and a diff the workspaces cannot
  // feel (the license family, or a member a negation excludes). Anything else
  // outside the workspaces is disclosed through testScope.caveat — there is no
  // full-suite fallback that could cover it (see the test phase below).
  if (affected.length === 0) {
    return {
      toolchain: 'npm',
      affected: [],
      buildSet: [],
      widenedWith: [],
      install: null,
      build: [],
      test: [],
      ...(testScope ? { testScope } : {}),
      ok: true,
      timedOut: [],
      note: args.buildOnly
        ? `The diff changes ${changed.length} file(s), none of them inside a ` +
          'workspace. There is no package to build, and tests are out of scope ' +
          'for a build-only probe.'
        : testScope?.caveat
          ? `The diff changes ${changed.length} file(s), none of them inside a ` +
            'workspace. There is no package to build and no test to run, but ' +
            `the scope decision recorded a caveat: ${testScope.caveat}.`
          : `The diff changes ${changed.length} file(s), none of them inside a ` +
            "workspace (nothing the workspaces' tests can feel). There is no " +
            'package to build and no test to run — this is a complete answer, ' +
            'not a skipped step.',
    };
  }

  // The dir→package map is built from the SCOPE GRAPH, not the workspace list
  // alone: when the root joins the graph, a member that names it as a
  // dependency puts `.` in the build set, and the root's own `build` must run
  // like any other package's — skipping it would compile dependents against
  // artifacts of the root that were never produced.
  const byDir = new Map(scopeGraph.map((p) => [p.dir, p]));

  // A changed dir the walker mapped to something that is NOT a package (a nested
  // package listed before a `*` that also claims its parent segment; a loose file
  // directly under a `packages/*` base) would be dropped from the build set without
  // a trace: zero commands, `ok: true`, "Everything passed" — the confident false
  // green this command exists to prevent. If any affected dir is not a known
  // package, the scoping cannot be trusted; hand the whole thing to the brief's
  // precedence rather than certify a build that never ran.
  const unmapped = affected.filter((d) => d !== '.' && !byDir.has(d));
  if (unmapped.length > 0) {
    return unsupportedReport(
      `The diff touches ${unmapped.join(', ')}, which the workspace globs map to no ` +
        'package (a nested package ordered before a `*`, or a loose file under a ' +
        'workspace base). Scoping cannot be trusted here, so fall back to the ' +
        'build/test precedence in your brief — installing dependencies first — rather ' +
        'than trust a scoped build that would silently skip it.',
    );
  }

  // No `testScope` in the initializer: every return that fires before the
  // test loop runs zero suites, and a scope on it would read as "the suites
  // ran" in the agent's brief. It is attached only once the scope executes.
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
  // directory. `npm ci` writes `node_modules/.package-lock.json` only once the tree
  // is fully materialised, so a partial tree — left by a timeout here, or by the
  // agent's own shell-tool kill one level up — has the directory but not the marker.
  // Gating on the directory would let every later run *skip* the install and build
  // against that partial tree; gating on the marker reinstalls it.
  //
  // But `npm ci` is only right for an npm repo. `workspaces` is also yarn/bun/pnpm
  // syntax, and those write no `package-lock.json`, so `npm ci` would fail-fast on
  // the missing lockfile and mislabel a perfectly usable `node_modules` as a failed
  // install. So install only when there IS a `package-lock.json` (an npm repo) whose
  // tree is incomplete; a non-npm repo that already has a tree is trusted — the build
  // is the authoritative signal, by this command's own argument.
  const npmLock = existsSync(join(root, 'package-lock.json'));
  const installComplete = (): boolean =>
    existsSync(join(root, 'node_modules', '.package-lock.json'));

  // A non-npm repo (yarn/bun/pnpm — `workspaces` is their syntax too) with no
  // installed tree cannot be installed here: `npm ci` needs the npm lockfile, and
  // building against absent dependencies fails with `Cannot find module` **inside the
  // PR's own changed files** — the false-Critical steer this command exists to
  // prevent. A review worktree is cold by construction, so this is the common case,
  // not an edge. Hand it to the brief, naming the tool to install with. (The warm
  // case — a tree already present — is trusted below and never reaches here.)
  if (args.install && !npmLock && !existsSync(join(root, 'node_modules'))) {
    const altLock = [
      ['yarn.lock', 'yarn install --frozen-lockfile'],
      ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
      ['bun.lockb', 'bun install --frozen-lockfile'],
      ['bun.lock', 'bun install --frozen-lockfile'],
    ].find(([f]) => existsSync(join(root, f)));
    return unsupportedReport(
      altLock
        ? `This is a ${altLock[0]} repo with no installed \`node_modules\`, so \`npm ci\` ` +
            `cannot install it. Run \`${altLock[1]}\` first, then fall back to the ` +
            'build/test precedence in your brief, each command with a deadline it can meet.'
        : 'There is no lockfile and no `node_modules` here, so nothing can be installed ' +
            'deterministically. Install dependencies first, then fall back to the ' +
            'build/test precedence in your brief.',
    );
  }
  if (args.install && npmLock && !installComplete()) {
    // Disk preflight. The deadline already treats "cannot finish in time" as an
    // infrastructure result and skips ahead with a disclosure; "cannot fit on
    // the disk" is the same class of result, discovered before the command runs
    // instead of 33 seconds into it. An `npm ci` that dies on ENOSPC is
    // strictly worse than one that never starts: it leaves a partial tree AND a
    // full disk that fails every agent scheduled after this one.
    const installCmd = 'npm ci --no-audit --no-fund';
    const free = freeDiskBytes(root);
    if (free !== null && free < INSTALL_MIN_FREE_BYTES) {
      results.ok = false;
      results.note =
        `Insufficient disk space (${gib(free)}G free, need ~${gib(INSTALL_MIN_FREE_BYTES)}G): ` +
        `skipped \`${installCmd}\`, so nothing could be built or tested. This ` +
        'is an environment issue, not a code finding — report it as ' +
        'informational.';
      return results;
    }
    if (remainingMs() < BUDGET_MIN_ATTEMPT_MS) {
      // The same floor as the build/test loops: a sub-second `npm ci` cannot
      // produce anything but a fake timeout, so skip and disclose instead.
      results.ok = false;
      results.note =
        `The whole-call budget was spent before the install could start ` +
        `(${args.budget != null ? `--budget ${args.budget}s` : 'default budget'}), ` +
        'so nothing could be built or tested. This is an infrastructure ' +
        'result, not a defect in the diff — report it as informational.';
      return results;
    }
    const install = exec(
      installCmd,
      root,
      Math.min(perCommandMs, remainingMs()),
    );
    results.install = install;
    if (install.timedOut) results.timedOut.push(install.command);
    // A timeout leaves a partial tree — remove it, so this is not mistaken next time
    // for a complete install to build against. `spawnSync`'s SIGTERM only kills the
    // direct shell; the orphaned `npm`/`node` grandchildren keep writing the tree, so
    // `rmSync` can race them and throw `ENOTEMPTY` — which must not replace the whole
    // report with a raw error. Best-effort with retries; the marker gate below still
    // decides the outcome.
    if (install.timedOut) {
      try {
        rmSync(join(root, 'node_modules'), {
          recursive: true,
          force: true,
          maxRetries: 3,
        });
      } catch {
        // Best effort — a partial tree left behind is caught by the marker gate.
      }
    }
    if (install.timedOut || !installComplete()) {
      results.ok = false;
      results.note = install.timedOut
        ? `\`${install.command}\` ran out of time (${deadlineSecs(install)}s) and left an ` +
          'incomplete `node_modules`, so nothing could be built or tested against it. ' +
          'This is an infrastructure result, not a defect in the diff — report it as ' +
          'informational.'
        : 'The install failed and left no usable `node_modules`, so nothing could be ' +
          'built or tested. This is an environment failure, not a defect in the diff — ' +
          'report it as informational.';
      return results;
    }
  }

  // The install exited non-zero but left a usable tree, so the run went
  // ahead: frame the failure on EVERY return from here on — the disk
  // preflight and build-failure returns below fire before the final one,
  // and without the framing the agent can file the install failure as an
  // additional Critical against the PR.
  const frameInstallFailure = (): void => {
    if (results.install && results.install.exitCode !== 0) {
      results.note =
        `\`${results.install.command}\` exited ${results.install.exitCode} but left a usable ` +
        '`node_modules`, so the run went ahead. ' +
        'The install failure is an environment/infrastructure result — report it as ' +
        'informational, never as a Critical, and never against this PR. ' +
        results.note;
    }
  };

  // The same preflight before the build phase, at a lower floor. A warm tree
  // skips the install (and its 3 GiB gate) entirely, but a compile that hits
  // ENOSPC mid-write fails with errors that read as defects in the diff — and
  // leaves the disk full for everything that runs after this command.
  const freeForBuild = freeDiskBytes(root);
  if (freeForBuild !== null && freeForBuild < BUILD_MIN_FREE_BYTES) {
    results.ok = false;
    results.note =
      `Insufficient disk space (${gib(freeForBuild)}G free, need ~${gib(BUILD_MIN_FREE_BYTES)}G): ` +
      'skipped the build and tests rather than fill the disk mid-compile. This ' +
      'is an environment issue, not a code finding — report it as informational.';
    frameInstallFailure();
    return results;
  }

  const alsoBuild: string[] = [];
  let set = buildSetFor(affected, scopeGraph);
  const built = new Set<string>();
  const widened = new Set<string>();
  // A root build that fans out over the workspaces (`npm run build
  // --workspaces`) is an aggregator: it produces no artifacts of its own, the
  // scoped loop already builds the members it drives, and as one bare command
  // it is exactly the whole-monorepo build this module exists to stop
  // running. Only a NON-fan-out root build — one that compiles the root's own
  // sources — is worth its deadline.
  const rootBuildRuns =
    !!rootPkg?.scripts.includes('build') &&
    !scriptFansOut(rootPkg.scriptsText['build']);
  // One predicate for both the loop skip and the reported set: a fan-out
  // root's build does not run — never in single-root mode, where the root is
  // the only package there is.
  const rootBuildSkipped = !singleRoot && !rootBuildRuns;
  const notBuilt: string[] = [];

  // Build, and let the compiler correct the set. Three widenings is generous: each
  // one is a package the graph could not have known about, and a fourth would mean
  // the graph is not wrong but absent. Every command spends from the same
  // whole-call budget as the tests — an unbounded build phase would hand the
  // outer shell kill a report the budget exists to save.
  for (let attempt = 0; attempt <= 3; attempt++) {
    let failure: CommandResult | null = null;

    for (const dir of set) {
      if (built.has(dir)) continue;
      const pkg = byDir.get(dir);
      if (!pkg?.scripts.includes('build')) {
        built.add(dir); // Nothing to build is not a failure to build.
        continue;
      }
      if (dir === '.' && rootBuildSkipped) {
        // Fan-out aggregator root: the members it drives are built by this
        // very loop; the bare `npm run build` would re-build all of them
        // inside one deadline (see above).
        built.add(dir);
        continue;
      }
      if (remainingMs() < BUDGET_MIN_ATTEMPT_MS) {
        // The budget is spent: stop building and disclose. Suites of unbuilt
        // packages must not run either — a suite against artifacts never
        // compiled manufactures failures the diff did not cause (the exact
        // lesson of the scoped-build/full-test cascade).
        notBuilt.push(
          ...set.filter(
            (d) => !built.has(d) && byDir.get(d)?.scripts.includes('build'),
          ),
        );
        break;
      }
      const r = exec(
        buildCommand(dir),
        root,
        Math.min(perCommandMs, remainingMs()),
      );
      results.build.push(r);
      if (r.timedOut) results.timedOut.push(r.command);
      if (r.exitCode !== 0) {
        failure = r;
        break;
      }
      built.add(dir);
    }

    if (!failure) break;

    // Did it fail because the set was too small — or mis-ordered? The declared graph
    // under-approximates whenever a package reaches into another's *sources* (a
    // tsconfig `paths` entry into `../cli/src/...` compiles that package's imports
    // without declaring a dependency), and the compiler names the package it could
    // not resolve. Filter on `!built.has(dir)`, not `!set.includes(dir)`: when BOTH
    // the needer and the undeclared-needed package are affected and the alphabet
    // ordered the needer first, the named package is already IN the set but not yet
    // built — re-seeding it into `alsoBuild` (which sorts first) fixes the order. The
    // attempt cap bounds the loop; a package that is truly missing is not in the map.
    //
    // A **timeout** must not enter this path. A build killed at the deadline leaves
    // partial output that can happen to contain a `Cannot find module` line, which
    // would look like a too-small build set and trigger a retry — another full
    // deadline, and another, up to the attempt cap. A timeout is infrastructure, not
    // a graph gap: report it and stop, the same way the install path does.
    const missing = failure.timedOut
      ? []
      : unresolvedWorkspaceDeps(failure.output, packages).filter((name) => {
          const dir = packages.find((p) => p.name === name)?.dir;
          return dir && !built.has(dir);
        });
    if (missing.length === 0 || failure.timedOut || attempt === 3) {
      results.ok = false;
      results.note = failure.timedOut
        ? `\`${failure.command}\` ran out of time (${deadlineSecs(failure)}s). That is an ` +
          'infrastructure result, not a defect in the diff — report it as informational.'
        : `\`${failure.command}\` failed. Correlate the errors below with the diff: a ` +
          'compile error in a file the PR changed is a Critical; one in a file it did not ' +
          'touch is a pre-existing failure, and belongs in the terminal, not on the PR.';
      results.buildSet = (
        rootBuildSkipped ? set.filter((d) => d !== '.') : set
      ).filter((d) => !notBuilt.includes(d));
      results.widenedWith = [...widened];
      frameInstallFailure();
      return results;
    }

    // Drop the failed attempt from the report. It is about to be retried with the
    // package it asked for, and it is **not evidence about this PR**: the build set
    // was too small, which is this command's mistake, not the author's. Left in
    // `build[]`, an agent told "a build failure in a changed file is a Critical"
    // reads `packages/vscode-ide-companion rc=2` and files exactly that — a public
    // blocker on a PR whose build passes. (A timed-out failure cannot reach here — it
    // is terminal above — so only `build[]`, never `timedOut`, can hold it.)
    results.build = results.build.filter((r) => r !== failure);

    for (const name of missing) widened.add(name);
    for (const name of missing) {
      const dir = packages.find((p) => p.name === name)?.dir;
      if (dir) alsoBuild.push(dir);
    }
    // As `alsoBuild`, never as `affected`. The compiler asked for this package
    // because something compiles *against* it; the PR did not change it, so its
    // consumers cannot have been broken by the PR and must not be built.
    set = buildSetFor(affected, scopeGraph, alsoBuild);
  }

  // The build set reports what was (to be) BUILT: a fan-out root whose build
  // was skipped — an aggregator the loop already covered member by member —
  // and packages the budget stopped before building must not linger in it, or
  // the report names builds that never ran.
  results.buildSet = (
    rootBuildSkipped ? set.filter((d) => d !== '.') : set
  ).filter((d) => !notBuilt.includes(d));
  results.widenedWith = [...widened];
  if (notBuilt.length > 0) results.notBuilt = [...notBuilt].sort();

  // Test what the diff can break: the changed workspaces plus their
  // reverse-dependency closure — exactly the suites that define a test script.
  // Testing the changed ones alone under-tests in the one way a compile cannot
  // catch: a behaviour change in `core` leaves every dependent compiling and
  // still fails their suites. The closure is a subset of the build set (which
  // adds compile-time dependencies on top), so every tested package was built
  // above, with everything it compiles against.
  //
  // When the scope decision recorded a caveat — a graph it could not fully
  // compute, a changed file outside every workspace, a closure past half the
  // testable suites — the scoped set still runs and the caveat discloses what
  // it may miss. There is NO fallback to the repo's root `npm test`: on a
  // large monorepo that command cannot finish inside a command deadline (this
  // repo's suite took 31 minutes in CI against a 300-second deadline, and a
  // third of recent diffs would have hit the fallback), so the fallback would
  // only ever report a timeout — zero signal framed as a failure. The scoped
  // set is the run that covers the diff — each command keeps its own deadline.
  //
  // Those per-command deadlines SUM, though, and a large closure can sum past
  // the whole-call ceiling the brief welds on (600s by default) — the outer
  // shell kill then discards the report entirely. So the loop below runs
  // against a whole-call budget that EVERY phase (install, builds, tests)
  // spends from: each command gets the smaller of its own deadline and what
  // remains. A suite killed at the budget boundary is a timeout — already
  // framed as infrastructure — and a partial attempt is signal where a
  // never-attempted suite is none. Below the floor an attempt cannot even
  // boot npm, so the suite goes to notRun instead of manufacturing a fake
  // timeout. A partial report is signal; a discarded one is the "71
  // timeouts, nothing verified" failure this command exists to end.
  const rootHasTest = !!rootPkg?.scripts.includes('test');
  const testDirs = args.buildOnly
    ? []
    : !testScope
      ? affected // single root: its one package, exactly as before scoping
      : testScope.workspaces;
  const runnable = (dir: string): boolean =>
    dir === '.' ? rootHasTest : !!byDir.get(dir)?.scripts.includes('test');
  // Affected first: the changed workspace's own suite is the highest-value
  // one and must be unstarvable — the dependents are the widening, and the
  // widening is what a budget should trim. (The closure is alphabetical, so
  // without this a `zebra` change would run `alpha`'s suite and starve its
  // own.)
  const affectedSet = new Set(affected);
  const runnableDirs = [
    ...testDirs.filter((d) => affectedSet.has(d) && runnable(d)),
    ...testDirs.filter((d) => !affectedSet.has(d) && runnable(d)),
  ];
  // Suites of packages the budget left UNBUILT cannot run — against artifacts
  // never compiled, their failures would be manufactured, not measured.
  const untestable =
    notBuilt.length > 0
      ? new Set(reverseDependencyClosure(notBuilt, scopeGraph))
      : new Set<string>();
  const notRun: string[] = [];
  for (let i = 0; i < runnableDirs.length; i++) {
    const dir = runnableDirs[i];
    if (untestable.has(dir)) {
      notRun.push(dir);
      continue;
    }
    const remaining = remainingMs();
    if (remaining < BUDGET_MIN_ATTEMPT_MS) {
      // Below the floor an "attempt" cannot even boot npm — it would
      // manufacture a fake timeout where an honest notRun says what happened.
      // Unfiltered: an untestable dir the budget also stopped must still
      // leave `testScope.workspaces` (which names what RAN), and no dir at
      // index >= i can already have been pushed.
      notRun.push(...runnableDirs.slice(i));
      break;
    }
    const r = exec(testCommand(dir), root, Math.min(perCommandMs, remaining));
    results.test.push(r);
    if (r.timedOut) results.timedOut.push(r.command);
    if (r.exitCode !== 0) results.ok = false;
  }

  // A budget stop is STRUCTURAL, not just prose: `testScope.workspaces` is
  // documented (and quoted by the agent's brief) as exactly the suites that
  // ran, so the trimmed suites leave it, and `notRun` names them. Sorted, so
  // both fields are stable and comparable.
  notRun.sort();
  const partialNote =
    [
      notBuilt.length > 0
        ? `the build phase reached the whole-call budget — not built: ` +
          notBuilt.join(', ')
        : '',
      notRun.length > 0
        ? `the whole-call budget (${Math.round(callBudgetMs / 1000)}s) was ` +
          `spent with ${notRun.length} suite(s) still to run — not run: ` +
          notRun.join(', ')
        : '',
    ]
      .filter(Boolean)
      .join('; ') || undefined;
  if (testScope && partialNote) {
    const ran = testScope.workspaces.filter((d) => !notRun.includes(d));
    testScope = {
      workspaces: ran,
      ...(notRun.length > 0 ? { notRun } : {}),
      caveat: testScope.caveat
        ? `${testScope.caveat}; ${partialNote}`
        : partialNote,
    };
  }

  // The scope was executed — only now may the report carry it. Every return
  // between the initializer and here ran zero test commands and must not
  // claim a scoping decision; the one exception, the nothing-to-run answer
  // above, carries the scope precisely because the empty scope IS the answer.
  if (testScope) results.testScope = testScope;

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
      // The tests sentence names the scope, because it is the agent's report
      // that has to be able to say what was and was not run: a scoped run
      // names its suites, and a caveat says what the scope may miss.
      let testsClause: string;
      if (args.buildOnly) {
        testsClause = '. Tests were not run (build-only).';
      } else if (!testScope) {
        testsClause =
          results.test.length === 0
            ? notRun.length > 0
              ? // The loop pushed the suite to notRun: the script exists.
                ', but the whole-call budget was spent before any suite could run.'
              : ', but the package defines no test script, so no tests ran.'
            : ' and ran the tests of the changed ones. Everything passed.';
      } else if (testScope.workspaces.length === 0) {
        testsClause = testScope.notRun?.length
          ? ', but the whole-call budget was spent before any suite could run.'
          : ', but no workspace in scope defines a test script, so no tests ran.';
      } else {
        // The scoped list is filtered to dependents WITH a test script; a
        // build-only dependent is built but never tested, so the note must
        // not claim every declared dependent was covered.
        testsClause =
          ` and ran the tests scoped to ${testScope.workspaces.join(', ')} — ` +
          'the changed workspaces and every workspace declared to depend on ' +
          'them that defines a test script. Everything passed.';
      }
      if (testScope?.caveat) testsClause += ` Caveat: ${testScope.caveat}.`;
      // The root is not a workspace: count it separately, or a 22-member repo
      // reports "of 23" — a number in a report whose thesis is honest numbers.
      // (A single-root repo's one package IS '.', and counts as the one.)
      const builtWorkspaces = results.buildSet.filter(
        (d) => singleRoot || d !== '.',
      ).length;
      const rootSuffix =
        !singleRoot && results.buildSet.includes('.') && !rootBuildSkipped
          ? ' (plus the root package)'
          : '';
      results.note =
        `Built ${builtWorkspaces} of ${packages.length} workspaces${rootSuffix} (the ${affected.length} the ` +
        `diff changes, plus what they compile against${
          widened.size
            ? `, plus ${[...widened].join(', ')} the compiler asked for`
            : ''
        })${testsClause}`;
    } else if (realFailures.length === 0) {
      results.note =
        `${failed.length} command(s) ran out of time (${deadlineSecs(failed[0])}s). A timeout is an ` +
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

  // A failure note must carry the caveat too — the note is what the brief
  // renders first, and "a test failed AND the budget dropped suites" must not
  // read as a plain failure. (The ok branch already appended it above.)
  if (results.testScope?.caveat && !results.note.includes('Caveat:')) {
    results.note += ` Caveat: ${results.testScope.caveat}.`;
  }

  // Single-root repos carry no testScope, so a budget stop is disclosed on
  // the note itself. (With a scope, the caveat above already says it.)
  if (partialNote && !results.testScope) {
    results.note = results.note
      ? `${results.note} ${partialNote}.`
      : partialNote;
  }

  // The build and test results below are real, and the install failure is
  // not a finding about this PR. (A `prepare` script that builds the whole
  // project, as this repo's does, fails on any pre-existing error anywhere
  // in it.)
  frameInstallFailure();
  return results;
}

export const npmToolchainAdapter: ReviewToolchainAdapter = {
  // A root package.json alone is not an npm build project — docs sites, husky,
  // and lint configs put one in Java repos. Apply only when runNpmToolchain can
  // actually scope something: MODELED workspaces that resolve to at least one
  // package, or a root build/test script. Mirroring the run-side gate here
  // matters at mixed roots: an unmodeled-glob declaration (`packages/**`,
  // `foo-*`) or a zero-package glob used to apply npm anyway, block a second
  // adapter's selection, and drop the repo to the very `unsupported` handoff
  // this guard exists to prevent — even though npm.run would immediately
  // concede unsupported and the other adapter alone would have succeeded.
  // When ZERO adapters
  // apply at an npm-shaped root, runBuildTest delegates here anyway so the
  // report carries runNpmToolchain's precise handoff note (the unmodeled-glob
  // gate below is that diagnostic path, not dead code).
  applies: (root) => {
    const globs = readWorkspaceGlobs(root);
    if (globs.length > 0) {
      return (
        !hasUnmodeledWorkspaceGlob(globs) &&
        readWorkspacePackages(root).packages.length > 0
      );
    }
    return readRootPackage(root) !== null;
  },
  run: runNpmToolchain,
};
