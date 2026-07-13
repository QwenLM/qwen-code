/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review test-efficacy`: does the diff's new test actually gate the
// diff's new behaviour?
//
// Agent 5 and the test-coverage matrix ask whether a test EXISTS and whether
// its assertions look like they check something. Neither question can catch the
// two ways a test ships without protecting anything:
//
//   1. UNREACHABLE — the project's test command never runs the file. On PR
//      #6486 the new test lived in `integration-tests/`, which is not an npm
//      workspace, so `npm test --workspaces` never collected it; and its CI job
//      (`Integration Tests (CLI, No Sandbox)`) was skipped. The test executed
//      nowhere, in CI or in review, and nothing noticed.
//   2. INERT — it runs, it passes, and it would still pass with the source
//      change reverted. #6486's did: it drove a kitty CSI-u sequence into a PTY
//      that never negotiated the kitty protocol, so the keypress was discarded
//      before it could reach the handler under test. The test could only ever
//      have caught a startup crash.
//
// Both are decidable without judgment, which is why they live here in TypeScript
// rather than in a review agent's prompt. Findings carry `Source: [test]` and
// are pre-confirmed like Agent 7's — they are the outcome of running commands,
// not of reading code.
//
// The revert probe is the load-bearing half, and its trap is the third outcome:
// reverting the source can make the test fail to COMPILE (it imports a symbol
// the new code introduced). That failure is not evidence the test gates
// anything, and calling it "gated" would be exactly the false assurance this
// command exists to remove. So `gated` requires a real assertion failure, and
// everything else that is not a clean pass is `inconclusive`.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
} from 'node:fs';
import { dirname, join, isAbsolute, sep } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

export type ProbeVerdict = 'gated' | 'inert' | 'inconclusive';

export interface FileEntry {
  path: string;
  kind: string;
}

/**
 * Does `npm test --workspaces` reach this file?
 *
 * A test outside every workspace glob is collected by nothing. This is the
 * whole of the #6486 unreachability finding, and it needs no execution at all —
 * just the root `package.json`.
 *
 * Globs here are npm workspace globs, not full minimatch: a trailing `/*` means
 * "one path segment", a leading `!` excludes. Anything fancier is treated as a
 * literal prefix, which errs toward calling a file REACHABLE — the safe
 * direction, since a false "unreachable" finding would be posted to a PR.
 */
export function isWorkspaceMember(
  filePath: string,
  workspaceGlobs: string[],
): boolean {
  const norm = filePath.replace(/^\.\//, '');
  const matches = (glob: string): boolean => {
    const g = glob.replace(/^!/, '').replace(/\/$/, '');
    if (g.endsWith('/*')) {
      const base = g.slice(0, -2);
      if (!norm.startsWith(`${base}/`)) return false;
      // `packages/*` owns `packages/cli/**`, not `packages/channels/base/**`
      // — but the latter is listed explicitly, and negation is handled below.
      return true;
    }
    return norm === g || norm.startsWith(`${g}/`);
  };
  // npm evaluates the globs IN ORDER — a positive glob listed after a negation
  // re-includes what the negation excluded. So walk them in order and let the
  // last match win; a two-pass filter (all negations, then all positives) would
  // let a negation win wherever it sat and file a false `unreachable`.
  let member = false;
  for (const g of workspaceGlobs) {
    if (!matches(g)) continue;
    member = !g.startsWith('!');
  }
  return member;
}

export interface EfficacyPlan {
  /** Test files the diff adds or changes that the test command never collects. */
  unreachable: string[];
  /** Test files worth probing — they are reachable, so they can be run. */
  probes: string[];
  /** Production files to revert to base for the probe. */
  revert: string[];
}

/**
 * Test-support data a test file imports: fixtures, mocks, snapshots. Reverting
 * one is both meaningless (it holds no behaviour) and destructive — this PR
 * ships `__fixtures__/pr-6486-comment-4942713150.md`, and deleting it makes
 * `pr-context.test.ts` fail to load, an inconclusive probe caused by the probe
 * itself.
 *
 * The discriminator is the **directory**, not the extension. An earlier cut
 * whitelisted executable extensions, which also dropped runtime-loaded sources
 * that a test genuinely gates: an executable skill prompt
 * (`packages/core/src/skills/**\/SKILL.md`), a settings-schema JSON a test
 * validates against. Those are production source and must stay revertable;
 * only test-support data under a fixtures/mocks/snapshots path is excluded.
 */
const FIXTURE_DIR_RE =
  /(^|\/)(__fixtures__|__mocks__|__snapshots__|fixtures)\//;

/**
 * Split the diff into what to report and what to run.
 *
 * A diff with no source changes has nothing to gate, so it gets no probe: a
 * test-only PR (a new test for old code) must not be told its tests are inert.
 */
export function planTestEfficacy(
  files: FileEntry[],
  workspaceGlobs: string[],
): EfficacyPlan {
  const tests = files.filter((f) => f.kind === 'test').map((f) => f.path);
  // `kind === 'source'` is the diff-plan bucket for "not test/doc/generated",
  // which sweeps in test-support data a test imports. Reverting a fixture is
  // meaningless and destructive (a test that loads it then fails), so exclude
  // the fixture/mock directories — but keep everything else, including
  // runtime-loaded prompts and config a test genuinely gates.
  const revert = files
    .filter((f) => f.kind === 'source' && !FIXTURE_DIR_RE.test(f.path))
    .map((f) => f.path);
  const unreachable = tests.filter(
    (t) => !isWorkspaceMember(t, workspaceGlobs),
  );
  const reachable = tests.filter((t) => isWorkspaceMember(t, workspaceGlobs));
  return {
    unreachable,
    probes: revert.length > 0 ? reachable : [],
    revert,
  };
}

interface VitestAssertion {
  status?: string;
}
interface VitestFileResult {
  /** Absolute path of the test file this result belongs to. */
  name?: string;
  assertionResults?: VitestAssertion[];
}
interface VitestJson {
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: VitestFileResult[];
}

/**
 * Rule on the revert probe, **per test file**.
 *
 * Per-file, not per-run, and that distinction is load-bearing. One `vitest run`
 * covers every probe at once, but a run-level verdict lets one honest test cover
 * for a useless one: the gating test fails, the run reports failures, and the
 * inert test sitting beside it is scored `gated` too. Every inert test with a
 * working sibling would be invisible — which is the exact defect this command
 * exists to find. (Found by running it, not by unit-testing it. The unit tests
 * for the run-level classifier all passed.) `testResults[].name` carries the
 * file, so the mapping is available; use it.
 *
 * The three-way asymmetry is deliberate:
 *
 * - `inert` — this file's tests PASSED with the source change reverted. They do
 *   not gate the change. This is a finding.
 * - `gated` — at least one ASSERTION in this file failed. It caught the revert;
 *   it is doing its job. Requires a real assertion failure, never a bare
 *   non-zero exit: reverting source routinely breaks a test's own compile (it
 *   imports a symbol the diff introduced), and a compile error proves nothing
 *   about whether the test would catch a behavioural regression.
 * - `inconclusive` — everything else: the file collected nothing, an
 *   import/type error, unparseable output. Do NOT let this read as `gated`; a
 *   review that mistakes "it errored" for "it caught the bug" is back where it
 *   started.
 */
export function classifyProbeRun(
  exitCode: number,
  stdout: string,
  probes: string[],
  stderr = '',
): Array<{ file: string; verdict: ProbeVerdict; detail: string }> {
  let parsed: VitestJson | undefined;
  const start = stdout.indexOf('{');
  if (start >= 0) {
    try {
      parsed = JSON.parse(stdout.slice(start)) as VitestJson;
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed) {
    // The runner's own error is the only thing that explains this, and dropping
    // it leaves an `inconclusive` nobody can act on.
    const why = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    return probes.map((file) => ({
      file,
      verdict: 'inconclusive' as const,
      detail: `runner produced no parseable JSON (exit ${exitCode})${why ? `: ${why}` : ''}`,
    }));
  }

  const byFile = parsed.testResults ?? [];
  return probes.map((file) => {
    // `testResults[].name` is absolute; the probe path is repo-relative. Match
    // on a path-separator boundary, so `src/a.test.ts` cannot be satisfied by
    // `/w/vendor/other-src/a.test.ts` — a bare `endsWith` would take the wrong
    // file's verdict and never say so.
    const result = byFile.find(
      (r) => (r.name ?? '').endsWith(`/${file}`) || r.name === file,
    );
    const assertions = result?.assertionResults ?? [];
    const failed = assertions.filter((a) => a.status === 'failed').length;
    const passed = assertions.filter((a) => a.status === 'passed').length;

    if (!result || assertions.length === 0) {
      return {
        file,
        verdict: 'inconclusive' as const,
        detail: `collected no tests with the source reverted (run exit ${exitCode}) — likely a compile or import error, which is not evidence either way`,
      };
    }
    if (failed > 0) {
      return {
        file,
        verdict: 'gated' as const,
        detail: `${failed} assertion(s) failed with the source reverted — this test catches the change`,
      };
    }
    if (passed === 0) {
      // Collected, but nothing failed AND nothing passed — every test skipped
      // (`it.skip`, an unmet `describe.runIf`). A file that ran no assertions
      // proves nothing; calling that `inert` would report "still passed" about
      // tests that never executed.
      return {
        file,
        verdict: 'inconclusive' as const,
        detail: `${assertions.length} test(s) collected but none executed with the source reverted (all skipped) — not evidence either way`,
      };
    }
    return {
      file,
      verdict: 'inert' as const,
      detail: `all ${passed} test(s) still PASSED with the source change reverted — this test does not gate the change`,
    };
  });
}

interface TestEfficacyArgs {
  report: string;
  worktree: string;
  base: string;
  out: string;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  // `git` not on PATH leaves `status` null and `stderr` undefined, which the
  // status check below would report as `failed: ` — an error message with no
  // error in it. The runner spawn already guards this; so does this one now.
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
}

/** Run git and return trimmed stdout; throws on spawn failure or non-zero. */
function gitOut(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

/**
 * Does this path exist at the given rev? A non-zero exit is a legitimate "no"
 * (git prints nothing), but a spawn *failure* (`r.error`, e.g. git missing) is
 * not evidence of absence — surface it rather than reading it as "not present".
 */
function existsAtRev(cwd: string, rev: string, path: string): boolean {
  const r = spawnSync('git', ['cat-file', '-e', `${rev}:${path}`], { cwd });
  if (r.error) throw r.error;
  return r.status === 0;
}
/**
 * Remove `join(worktree, relPath)` without following a PR-controlled symlink.
 *
 * `rmSync` follows symlinks in the path PREFIX, and the revert set is
 * PR-controlled: a diff that turns `dir` into a symlink to an outside directory
 * and has the probe delete `dir/victim` would make `rmSync` follow `dir` and
 * delete the outside file — a real P0 a reviewer reproduced. The lexical
 * `escapes the worktree` guard cannot catch it, because `dir/victim` is lexically
 * inside the tree; the escape happens at runtime through the link.
 *
 * So walk every component from the worktree root down and refuse if any
 * ANCESTOR is a symlink — the target must be reachable through real directories
 * only. The final component being a symlink is fine: `rmSync` unlinks the link
 * itself, not what it points at, which is exactly what reverting an added
 * symlink should do. A missing component means there is nothing to remove
 * (`force` rm is already a no-op there), so return quietly.
 */
export function safeRmWithin(worktree: string, relPath: string): void {
  const parts = relPath.split(/[/\\]+/).filter((s) => s && s !== '.');
  let cur = worktree;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return;
    }
    if (st.isSymbolicLink() && i < parts.length - 1) {
      throw new Error(
        `refusing to delete through a symlink: ${relPath} ` +
          `(ancestor ${parts.slice(0, i + 1).join('/')} is a symlink)`,
      );
    }
  }
  rmSync(cur, { force: true });
}

const existsAtBase = (cwd: string, base: string, path: string) =>
  existsAtRev(cwd, base, path);
/** A file the PR DELETED does not exist at HEAD — restoring it means removing it. */
const existsAtHead = (cwd: string, path: string) =>
  existsAtRev(cwd, 'HEAD', path);

async function runTestEfficacy(args: TestEfficacyArgs): Promise<void> {
  const { report, worktree, base, out } = args;
  const plan = JSON.parse(readFileSync(report, 'utf8')) as {
    files?: FileEntry[];
  };
  const rootPkg = JSON.parse(
    readFileSync(`${worktree}/package.json`, 'utf8'),
  ) as { workspaces?: string[] };
  const globs = rootPkg.workspaces ?? [];

  const { unreachable, probes, revert } = planTestEfficacy(
    plan.files ?? [],
    globs,
  );

  // The report JSON is untrusted input, and `revert` paths become both git
  // pathspecs and `join(worktree, …)` filesystem targets we check out and
  // delete. Reject anything that is not a plain repository-relative path — an
  // absolute path, or one that normalises outside the worktree (`../`, or a
  // `a/../../b` that looks clean per-segment) — before it can point the
  // checkout/delete at a file outside the tree.
  for (const p of revert) {
    const norm = join(worktree, p);
    const root = join(worktree, '.');
    if (isAbsolute(p) || (norm !== root && !norm.startsWith(root + sep))) {
      throw new Error(
        `refusing to run: revert path escapes the worktree: ${JSON.stringify(p)}`,
      );
    }
  }

  const results: Array<{
    file: string;
    verdict: ProbeVerdict;
    detail: string;
  }> = [];
  let restoreFailure: string | undefined;

  if (probes.length > 0 && revert.length > 0) {
    // The probe checks out base over the revert set and deletes added files,
    // then restores HEAD. That is safe on the ephemeral worktree the /review
    // pipeline builds, but this is a public command that accepts any
    // `--worktree`: on a tree with uncommitted edits to a revert-set file, the
    // checkout would discard them with no undo. Refuse a dirty revert set
    // rather than eat someone's work.
    // `gitOut` throws on spawn failure (via the `git()` guard), so a `git`
    // that could not run fails the probe rather than silently reading as a
    // clean tree — the fail-OPEN outcome would defeat the whole guard, which
    // exists to prevent data loss.
    // `--ignored` too: a revert-set path can be gitignored at HEAD (a generated
    // or locally-recreated file), and a plain `status --porcelain` says nothing
    // about it — the base checkout would then overwrite a file the user has and
    // git will not restore.
    const dirty = revert.filter(
      (p) =>
        gitOut(worktree, 'status', '--porcelain', '--ignored', '--', p).length >
        0,
    );
    if (dirty.length > 0) {
      throw new Error(
        `refusing to run: the worktree has uncommitted changes to files this probe would revert (${dirty.join(', ')}). ` +
          `Commit or stash them first — the probe checks out base over these files and could not restore your edits.`,
      );
    }
  }

  if (probes.length > 0 && revert.length > 0) {
    // "Revert to base" is two operations, not one. A file the PR MODIFIED is
    // checked out from base; a file the PR ADDED did not exist at base, and
    // `git checkout <base> -- <newfile>` does not quietly skip it — it fails
    // with `pathspec ... did not match any file(s) known to git`. That throw
    // used to escape past `writeFileSync` and discard the whole report,
    // `unreachable` findings included, on every PR that adds a source file.
    // Which is most of them.
    const modified: string[] = [];
    const added: string[] = [];
    for (const p of revert) {
      (existsAtBase(worktree, base, p) ? modified : added).push(p);
    }
    try {
      if (modified.length > 0) {
        git(worktree, 'checkout', base, '--', ...modified);
      }
      // An added file's base state is "absent". Removing it is the honest
      // revert; the probe usually then fails to compile, which is
      // `inconclusive` — not a verdict, but an honest one.
      for (const p of added) safeRmWithin(worktree, p);

      const r = spawnSync(
        'npx',
        ['vitest', 'run', '--reporter=json', ...probes],
        {
          cwd: worktree,
          encoding: 'utf8',
          timeout: 300_000,
          // Vitest's JSON reporter on a large suite easily exceeds spawnSync's
          // 1 MiB default stdout buffer, which returns ENOBUFS and turns every
          // probe `inconclusive`. Match the 64 MiB ceiling the gh wrapper uses.
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      // `r.error` is set — and `r.status` is null — when the process never ran
      // (npx missing) or was killed (the timeout above fires SIGTERM). Ignoring
      // it reports those as "the runner produced no parseable JSON", which
      // blames the runner's output for a run that produced none.
      if (r.error) throw r.error;
      if (r.signal) {
        throw new Error(
          `runner killed by ${r.signal}${r.signal === 'SIGTERM' ? ' (probe timed out after 300s)' : ''}`,
        );
      }
      results.push(
        ...classifyProbeRun(
          r.status ?? 1,
          `${r.stdout ?? ''}`,
          probes,
          `${r.stderr ?? ''}`,
        ),
      );
    } catch (e) {
      // The probe could not be set up or run. That is not evidence about any
      // test — record it and keep going, so the report (and the unreachable
      // findings, which needed no probe at all) still reaches the caller.
      const detail = `probe could not run: ${e instanceof Error ? e.message : String(e)}`;
      results.push(
        ...probes.map((file) => ({
          file,
          verdict: 'inconclusive' as const,
          detail,
        })),
      );
    } finally {
      // Always put the worktree back — the review's later steps read this tree
      // and must see the PR's code, not the base's. This restores deleted files
      // too. A restore failure must not mask the probe's own outcome (hence the
      // catch), but it must not be swallowed either: the tree is now sitting on
      // BASE code, and every agent that reads it afterwards reviews the wrong
      // source. That is the loudest thing this command can have to say.
      //
      // Restore is also two operations, for the mirror-image reason the revert
      // was. A file the PR DELETED does not exist at HEAD either, and
      // `git checkout HEAD -- <deleted> <other>` fails on the bad pathspec and
      // restores NOTHING — so one deleted source file used to leave the whole
      // revert set sitting on base code, plus a resurrected copy of the file the
      // PR removed. Delete what HEAD does not have; check out what it does.
      const atHead: string[] = [];
      const notAtHead: string[] = [];
      for (const p of revert) {
        (existsAtHead(worktree, p) ? atHead : notAtHead).push(p);
      }
      try {
        if (atHead.length > 0) {
          git(worktree, 'checkout', 'HEAD', '--', ...atHead);
        }
        if (notAtHead.length > 0) {
          // `git checkout <base> -- <path>` writes the INDEX as well as the
          // working tree, so removing the file leaves a staged phantom add
          // behind (`AD` in `git status`). Reset those index entries to HEAD —
          // where the path does not exist, which is exactly the state we want.
          for (const p of notAtHead) safeRmWithin(worktree, p);
          git(worktree, 'reset', '-q', 'HEAD', '--', ...notAtHead);
        }
      } catch (e) {
        restoreFailure = `WORKTREE NOT RESTORED — it is still on base code for: ${revert.join(', ')}. Every later step of this review reads the wrong source. Run \`git checkout HEAD -- ${atHead.join(' ')}\` in ${worktree} before continuing. (${e instanceof Error ? e.message : String(e)})`;
      }
    }
  }

  const findings = [
    ...unreachable.map((f) => ({
      file: f,
      kind: 'unreachable' as const,
      message: `\`${f}\` is outside every npm workspace, so the project's test command never collects it. It did not run in this review, and it does not gate this change. Confirm it runs in CI — and check \`ciStatus.skippedCheckNames\`, because the job that would run it is exactly the kind that gets skipped.`,
    })),
    ...results
      .filter((r) => r.verdict === 'inert')
      .map((r) => ({
        file: r.file,
        kind: 'inert' as const,
        message: `\`${r.file}\`: ${r.detail}. It passes whether or not the change is present, so it cannot catch a regression in it.`,
      })),
  ];

  const result = {
    unreachable,
    probed: results,
    inconclusive: results.filter((r) => r.verdict === 'inconclusive'),
    findings,
    restoreFailure,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  writeStdoutLine(
    `Wrote test-efficacy report to ${out} (${unreachable.length} unreachable, ${results.length} probed, ${findings.length} finding(s))`,
  );
  for (const f of findings) {
    writeStdoutLine(`  [test] ${f.kind}: ${f.file}`);
  }
  if (restoreFailure) {
    // Loud, on stderr, AND a non-zero exit. The worktree is now on base code,
    // so every later review step reads the wrong source; a line in a JSON
    // field the workflow does not consume would let it proceed anyway (the
    // fail-open the whole guard exists to prevent). The report is already
    // written, so the caller still has the findings — it just cannot mistake
    // this for a clean run.
    writeStderrLine(`ERROR: ${restoreFailure}`);
    process.exitCode = 1;
  }
}

export const testEfficacyCommand: CommandModule = {
  command: 'test-efficacy <report>',
  describe:
    "Check whether the diff's new tests actually gate its new behaviour (unreachable + revert probe)",
  builder: (yargs) =>
    yargs
      .positional('report', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the fetch-pr / plan-diff report JSON',
      })
      .option('worktree', {
        type: 'string',
        demandOption: true,
        describe: 'Worktree to probe in',
      })
      .option('base', {
        type: 'string',
        demandOption: true,
        describe: 'Base SHA to revert source files to',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path',
      }),
  handler: async (argv) => {
    await runTestEfficacy(argv as unknown as TestEfficacyArgs);
  },
};
