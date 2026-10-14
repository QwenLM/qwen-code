/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Witness tests for issue #12460. `permissions/destructive-commands.ts` has
 * carried a session-commit registry (`registerSessionCommit` /
 * `isAmendOfSessionCommit` / `clearSessionCommits`) since the amend guard
 * landed, but nothing in production called `registerSessionCommit`: the
 * "commit was made by the agent in this session" exemption was unreachable
 * and Auto mode blocked *every* `git commit --amend`.
 *
 * The rows cross the wiring layer, not the primitive (calling
 * `registerSessionCommit` directly was green before the fix): a real
 * `git commit` runs through `ShellToolInvocation.execute()` in a real temp
 * repo, then the guard is asked whether the follow-up amend is allowed. The
 * fake `ShellExecutionService` really runs commands via `spawnSync`, so
 * `getGitHeadSync` / `getGitHead` see genuine HEADs, not stubbed SHAs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Config } from '../config/config.js';
import { ApprovalMode, deriveApprovalModeConfig } from '../config/config.js';
import {
  getShellAbortReasonKind,
  isSignalTermination,
  type ShellExecutionConfig,
  type ShellExecutionResult,
  type ShellExecuteOptions,
} from '../services/shellExecutionService.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { CommitAttributionService } from '../services/commitAttribution.js';
import { ShellTool } from './shell.js';
import { ToolNames } from './tool-names.js';
import { evaluateAutoMode } from '../permissions/autoMode.js';
import {
  clearSessionCommits,
  isDestructiveCommand,
} from '../permissions/destructive-commands.js';

// Runs the command for real in the requested cwd, shaped like
// `ShellExecutionService.execute`'s result: a seam only so the test does not
// need a loadable node-pty; no git state is faked.
const realExecute = vi.hoisted(() => vi.fn());

// Spread the real module and override only the executor: a re-implemented
// `isSignalTermination` / `getShellAbortReasonKind` (twelve lines of
// `shell.test.ts`) drifts, since production reads `kind` as an *own* property
// in a try/catch so a prototype-only or throwing `kind` cannot reach the
// background branch, which a copy from memory misses. Still PTY-free:
// `utils/getPty.ts` imports only `./errors.js` at module level and loads
// `@lydell/node-pty` lazily inside `loadPty()`.
vi.mock('../services/shellExecutionService.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../services/shellExecutionService.js')
  >()),
  ShellExecutionService: { execute: realExecute },
}));

const AMEND_COMMAND = 'git commit --amend --no-edit';
const USER_PROMPT = 'please amend that commit';
const COMMIT_FEATURE = 'git add feature.txt && git commit -m "feature"';
type RepoOpts = Partial<
  Record<'email' | 'name' | 'seed' | 'subject' | 'config', string>
>;

// The fake executor spawns `/bin/bash -c`, absent on Windows: `spawnSync`
// would ENOENT, no commit would land, and the exemption rows would fail for
// reasons unrelated to the code under test. Gated like the repo's other
// real-bash suites (packages/cli/src/commands/review/drive.test.ts).
describe.skipIf(process.platform === 'win32')(
  'ShellTool session commit tracking (issue #12460)',
  () => {
    let repoDir: string;
    let shellTool: ShellTool;
    let mockConfig: Config;
    let mockAbortSignal: AbortSignal;
    // true: the fake executor resolves the handle `promoted: true` (Ctrl+B)
    // and reports the settle via `postPromote.onSettle`; the command still
    // really runs.
    let simulatePromote = false;
    // true: the settle is captured in `firePromoteSettle` for the row to fire,
    // the shape of a real Ctrl+B promote of a still-running command and the
    // only one reaching registration via `promoteArtifacts.onSettleWired`
    // rather than the `settleQueued` drain.
    let deferPromoteSettle = false;
    let firePromoteSettle: (() => void) | null = null;
    // Temp dirs a row creates (other repos, a copied `git.exe`); removed in
    // `afterEach`.
    let tempDirs: string[];

    /** Guard verdict: `null`, or `{ blocked: true, reason }` when blocking. */
    function amendVerdict(): ReturnType<typeof isDestructiveCommand> {
      return isDestructiveCommand(AMEND_COMMAND, USER_PROMPT, repoDir);
    }

    /** Runs `git <args>` bypassing ShellTool; returns trimmed stdout. */
    function rawGit(args: string, cwd = repoDir): string {
      return execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim();
    }

    function headSha(cwd = repoDir): string {
      return rawGit('rev-parse HEAD', cwd);
    }

    function lastLog(format: string, cwd = repoDir): string {
      return rawGit(`log -1 --pretty=${format}`, cwd);
    }

    /** Writes `file` in `dir` and commits it outside the shell tool. */
    function rawCommit(
      file: string,
      text: string,
      subject: string,
      dir = repoDir,
    ) {
      fs.writeFileSync(path.join(dir, file), text);
      rawGit(`add ${file}`, dir);
      rawGit(`commit -q -m "${subject}"`, dir);
    }

    /** `git init`, `config` if given, repo-local identity, one seed commit. */
    function initRepo(dir: string, opts: RepoOpts = {}): string {
      const { seed = 'seed\n', subject = 'initial commit' } = opts;
      rawGit('init -q --initial-branch=main', dir);
      if (opts.config) rawGit(`config ${opts.config}`, dir);
      rawGit(`config user.email ${opts.email ?? 'agent@example.com'}`, dir);
      rawGit(`config user.name ${opts.name ?? 'Agent'}`, dir);
      rawGit('config commit.gpgsign false', dir);
      rawCommit('seed.txt', seed, subject, dir);
      return dir;
    }

    /** A temp dir that is not a repository; removed in `afterEach`. */
    function makeScratchDir(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    }

    // A second real repo so rows can pin that a commit landing *there* is
    // never registered against `repoDir`.
    function makeOtherRepo(): string {
      return initRepo(makeScratchDir('qwen-12514-other-'), {
        email: 'other@example.com',
        name: 'Other',
        seed: 'other seed\n',
        subject: 'other seed',
      });
    }

    /** Writes `feature.txt`, staging it when `stage`; returns the HEAD before. */
    function writeFeature(stage = false): string {
      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');
      if (stage) rawGit('add feature.txt');
      return headSha();
    }

    async function runShellCommand(command: string) {
      const invocation = shellTool.build({ command, is_background: false });
      return invocation.execute(mockAbortSignal);
    }

    // Load-bearing check: the run took the Ctrl+B handoff, not the plain
    // foreground path (which registers anyway); a deferred run shows no
    // settle, i.e. it took the deferred branch, not the queued drain.
    async function runPromoted(command: string, deferSettle = false) {
      simulatePromote = true;
      deferPromoteSettle = deferSettle;
      const result = await runShellCommand(command);
      expect(result.llmContent).toContain(
        deferSettle ? 'Status: running' : 'promoted to background as',
      );
      return result;
    }

    /** HEAD moved off `preHead` onto the `feature` commit. */
    function expectFeatureHead(preHead: string): void {
      expect(headSha()).not.toBe(preHead);
      expect(lastLog('%s')).toBe('feature');
    }

    /** Subject + trailer assertions shared by the loose-spelling rows. */
    function expectFeatureCommitLanded(preHead: string): void {
      expectFeatureHead(preHead);
      // Trailer alignment (#12514 constraint): for the spellings driven here,
      // a commit that earns the amend exemption also earns the Co-authored-by
      // trailer. Alignment between the two walks, not an invariant: a commit
      // inside a `bash -c` wrapper registers while the rewriter is a
      // deliberate no-op (`findAttributableCommitSegment`), and a `cd` behind
      // a noise keyword suppresses both (the never-executing-branch row).
      expect(lastLog('%B')).toContain(
        'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>',
      );
    }

    // Runs `command` (staging `feature.txt` first when `stage`); the commit
    // must land and the follow-up amend of it be exempt.
    async function expectRegisters(command: string, stage = true) {
      const preHead = writeFeature(stage);
      await runShellCommand(command);
      expectFeatureCommitLanded(preHead);
      expect(amendVerdict()).toBeNull();
    }

    /** A commit with nothing staged: HEAD must not move, nothing registers. */
    async function expectFailedCommitBlocked(
      command: string,
      run: (command: string) => Promise<unknown> = runShellCommand,
    ) {
      const preHead = headSha();
      await run(command);
      expect(headSha()).toBe(preHead);
      expect(amendVerdict()?.blocked).toBe(true);
    }

    // `cd <other> && git commit` is `hasCommit` but not attributable in our
    // cwd: the commit lands in the other repo and our registry stays empty.
    async function expectOtherRepoCommitBlocked(
      run: (command: string) => Promise<unknown>,
    ) {
      const otherDir = makeOtherRepo();
      fs.writeFileSync(path.join(otherDir, 'work.txt'), 'work\n');
      const repoHeadBefore = headSha();
      await run(
        `cd ${otherDir} && git add work.txt && git commit -m "other work"`,
      );
      // The commit really landed — in the OTHER repository.
      expect(lastLog('%s', otherDir)).toBe('other work');
      expect(headSha()).toBe(repoHeadBefore);
      expect(amendVerdict()?.blocked).toBe(true);
    }

    // Earns the amend exemption through the shell tool, so later steps start
    // from a populated registry (an empty one makes "blocked again" pass for
    // the wrong reason).
    async function commitAndAssertExempt(): Promise<void> {
      writeFeature();
      await runShellCommand(COMMIT_FEATURE);
      expect(amendVerdict()).toBeNull();
    }

    /** A real Config over `repoDir` in `mode`, trusted unless told not to. */
    function realConfigIn(mode: ApprovalMode, trusted = true): Config {
      const config = makeFakeConfig({
        targetDir: repoDir,
        cwd: repoDir,
        approvalMode: mode,
      });
      if (trusted) vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
      return config;
    }

    beforeEach(() => {
      vi.clearAllMocks();
      clearSessionCommits();
      CommitAttributionService.resetInstance();
      simulatePromote = false;
      deferPromoteSettle = false;
      firePromoteSettle = null;
      tempDirs = [];
      // Real repos and commits: a machine-wide hook manager (`core.hooksPath`
      // in host/system gitconfig — husky, lefthook, pre-commit) would run the
      // host's pre-commit hook in the temp repo, fail on the host's linters
      // and error every row in `beforeEach`. Same scrub as
      // `memory/team-memory-sync.test.ts`; it also covers the fake executor's
      // env-less `spawnSync`. The asserted identity is repo-local and survives.
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');

      realExecute.mockImplementation(
        async (
          commandToExecute: string,
          cwd: string,
          onOutputEvent: (event: { type: 'data'; chunk: string }) => void,
          _signal: AbortSignal,
          _usePty: boolean,
          _config: ShellExecutionConfig,
          options?: ShellExecuteOptions,
        ) => {
          const spawned = spawnSync('/bin/bash', ['-c', commandToExecute], {
            cwd,
            encoding: 'utf-8',
            timeout: 30000,
          });
          const output = `${spawned.stdout ?? ''}${spawned.stderr ?? ''}`;
          if (output.length > 0) {
            onOutputEvent({ type: 'data', chunk: output });
          }
          const result: ShellExecutionResult = {
            rawOutput: Buffer.from(output),
            output,
            exitCode: spawned.status,
            signal: null,
            error: null,
            aborted: false,
            pid: 4242,
            executionMethod: 'child_process',
          };
          if (simulatePromote) {
            // Ctrl+B shape: the handle resolves `promoted: true` and the child
            // stays with the caller. spawnSync already finished it, so settling
            // now models a child exiting before `handlePromotedForeground`
            // finishes wiring: it lands in `settleQueued` and drains
            // synchronously, keeping the witness deterministic. Deferred, the
            // child outlives `execute()` and registration goes via
            // `onSettleWired`.
            const settle = () =>
              options?.postPromote?.onSettle?.({
                exitCode: spawned.status,
                signal: null,
                endTime: Date.now(),
              });
            if (deferPromoteSettle) firePromoteSettle = settle;
            else settle();
            return {
              pid: 4242,
              result: Promise.resolve({ ...result, promoted: true }),
            };
          }
          return { pid: 4242, result: Promise.resolve(result) };
        },
      );

      repoDir = initRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-12460-')));

      mockConfig = {
        getCoreTools: vi.fn().mockReturnValue([]),
        getPermissionsAllow: vi.fn().mockReturnValue([]),
        getPermissionsAsk: vi.fn().mockReturnValue([]),
        getPermissionsDeny: vi.fn().mockReturnValue([]),
        getDebugMode: vi.fn().mockReturnValue(false),
        getTargetDir: vi.fn().mockReturnValue(repoDir),
        getSessionId: vi.fn().mockReturnValue('test-session'),
        getWorkspaceContext: vi
          .fn()
          .mockReturnValue(createMockWorkspaceContext(repoDir)),
        storage: {
          getUserSkillsDirs: vi.fn().mockReturnValue([]),
          getProjectTempDir: vi.fn().mockReturnValue(repoDir),
          getProjectDir: vi.fn().mockReturnValue(repoDir),
        },
        getTruncateToolOutputThreshold: vi.fn().mockReturnValue(0),
        getTruncateToolOutputLines: vi.fn().mockReturnValue(0),
        isTruncateToolOutputThresholdExplicit: vi.fn().mockReturnValue(false),
        getPermissionManager: vi.fn().mockReturnValue(undefined),
        getLlmClient: vi.fn(),
        getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
        isInteractive: vi.fn().mockReturnValue(true),
        getGitCoAuthor: vi.fn().mockReturnValue({
          commit: true,
          pr: true,
          name: 'Qwen-Coder',
          email: 'qwen-coder@alibabacloud.com',
        }),
        getShouldUseNodePtyShell: vi.fn().mockReturnValue(false),
        getShellDefaultTimeoutMs: vi.fn().mockReturnValue(undefined),
        getShellHeartbeatIntervalMs: vi.fn().mockReturnValue(undefined),
        getBackgroundShellRegistry: vi.fn().mockReturnValue({
          register: vi.fn(),
          get: vi.fn(),
          getAll: vi.fn().mockReturnValue([]),
          cancel: vi.fn(),
          complete: vi.fn(),
          fail: vi.fn(),
        }),
      } as unknown as Config;

      shellTool = new ShellTool(mockConfig);
      mockAbortSignal = new AbortController().signal;
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      clearSessionCommits();
      CommitAttributionService.resetInstance();
      for (const dir of [repoDir, ...tempDirs]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('registers a commit the shell tool really landed, so the follow-up amend is exempt', async () => {
      // Sanity: with an empty registry the guard blocks the amend. That is
      // the pre-fix behaviour for *every* amend, and it must stay true for
      // commits the agent did not make (see the regressions below).
      expect(amendVerdict()?.blocked).toBe(true);

      const preHead = writeFeature();
      await runShellCommand(COMMIT_FEATURE);

      // The commit must genuinely land, or the test would be observing a
      // stubbed HEAD rather than real git state.
      expect(realExecute).toHaveBeenCalled();
      expectFeatureHead(preHead);

      // Witness for #12460: the agent's own commit is registered, so the guard
      // returns null. Pre-fix `registerSessionCommit` had no production caller
      // and every amend was `blocked: true`.
      expect(amendVerdict()).toBeNull();
    });

    it('registers a commit spelled behind shell control-flow keywords (issue #12514)', async () => {
      // #12514-B: `splitCommands` has no shell grammar, so `if true; then git
      // commit -m "x"; fi` yields `then git commit -m "x"`, whose tokens[0] is
      // `then`: the strict recogniser (`program === 'git'` at tokens[0]) never
      // fires, while the guard's token scan still blocks the amend. Pre-fix
      // that amend of the agent's own commit was blocked with the false
      // reason "the target commit was not made by the agent in this session".
      await expectRegisters('if true; then git commit -m "feature"; fi');
    });

    it('registers a commit spelled with an absolute git binary path (issue #12514)', async () => {
      // #12514-B: tokens[0] === '/usr/bin/git' defeats the strict recogniser
      // and no keyword skipping helps; the program must be matched on its
      // basename (`getCommandRoot` convention). Resolved so the row does not
      // depend on where git lives on the runner.
      const gitPath = execSync('command -v git', { encoding: 'utf-8' }).trim();
      expect(path.isAbsolute(gitPath)).toBe(true);
      await expectRegisters(`${gitPath} commit -m "feature"`);
    });

    it('registers a commit spelled with a leading `time` keyword (issue #12514)', async () => {
      // #12514-B: `time git commit` is a single segment (no control operator),
      // so this exercises the noise-keyword skip without splitCommands.
      await expectRegisters('time git commit -m "feature"');
    });

    it('registers a commit spelled with a Windows `.exe` git path (issue #12514)', async () => {
      // #12514-B: `"C:\Program Files\Git\cmd\git.exe" commit` is what Windows
      // sessions produce; recognition is purely textual (no `process.platform`
      // branch), so a copy of git at `<tmp>/git.exe` runs the row here. Without
      // the suffix strip `programBasename` yields `git.exe`, no loose `git`
      // branch fires and the commit lands unregistered; `GIT_AMEND_PATTERN`
      // never matches a `.exe` amend, so the block fires on exactly this mix
      // (absolute `.exe` commit, then a bare `git commit --amend`).
      const gitPath = execSync('command -v git', { encoding: 'utf-8' }).trim();
      const exePath = path.join(makeScratchDir('qwen-12514-exe-'), 'git.exe');
      fs.copyFileSync(fs.realpathSync(gitPath), exePath);
      fs.chmodSync(exePath, 0o755);
      await expectRegisters(`${exePath} commit -m "feature"`);
    });

    it('does not register when a loosely-spelled commit never landed', async () => {
      // Fail-closed pin for the loose recogniser: the spelling is recognised
      // (so preHead is captured), but nothing is staged, the commit fails,
      // HEAD never moves, and nothing may register.
      await expectFailedCommitBlocked(
        'if true; then git commit -m "nothing staged"; fi',
      );
    });

    it('does not register a foreground commit that a `cd` segment lands in another repository', async () => {
      // Regression pin: the loose recogniser must keep the cwd-shift guard.
      await expectOtherRepoCommitBlocked(runShellCommand);
    });

    // R1-11: `COMMIT_RECOGNITION_LEADING_NOISE` feeds the one helper both
    // recognisers call, so a row per token pins registration and the trailer
    // rewrite at once. Each token leads the segment carrying `git commit`
    // (after a `git add` segment), the only position where it is
    // load-bearing. `for`, `fi`, `done` and `}` are absent: a closer is always
    // followed by `;`, a newline or an operator (all split by `splitCommands`)
    // and `for` needs `name [in words]` first, so none can lead a
    // commit-bearing segment in valid shell; they stay in the set as the
    // structural pairs of `if`/`do`/`{`.
    it.each([
      ['if', 'if git commit -m "feature"; then echo ok; fi'],
      [
        'elif',
        'if false; then echo no; elif git commit -m "feature"; then echo ok; fi',
      ],
      ['else', 'if false; then echo no; else git commit -m "feature"; fi'],
      ['while', 'while git commit -m "feature"; do break; done'],
      ['until', 'until git commit -m "feature"; do break; done'],
      ['do', 'for i in 1; do git commit -m "feature"; done'],
      ['{', '{ git commit -m "feature"; }'],
      // `!` inverts the exit status, so this chain exits non-zero even
      // though the commit lands; registration is not exit-code gated.
      ['!', '! git commit -m "feature"'],
    ])(
      'registers a commit whose segment leads with the noise token `%s` (issue #12514)',
      (_token, segment) =>
        expectRegisters(`git add feature.txt && ${segment}`, false),
    );

    it('gives the trailer to a later in-cwd commit after a redirected `git -C <other> commit`', async () => {
      // R1-16(b): `gitCommitContext` latches its cwd-shift only on a NON-commit
      // `git -C …` (the `else if (changesCwd && !hasCommit)` arm), so it calls
      // the second commit attributable and registers it. The trailer walk must
      // not latch where registration does not, or the commit earns the
      // exemption while carrying no provenance marker at all.
      const otherDir = makeOtherRepo();
      fs.writeFileSync(path.join(otherDir, 'work.txt'), 'other work\n');
      rawGit('add work.txt', otherDir);

      await expectRegisters(
        `git -C ${otherDir} commit -m "other work" && ${COMMIT_FEATURE}`,
        false,
      );
      // The redirected commit (OTHER repo) must not carry our trailer: that
      // wrong-repo stamping is why the latch exists, and why the fix is "don't
      // latch on a commit segment", not "don't latch at all".
      expect(lastLog('%B', otherDir)).not.toContain(
        'Co-authored-by: Qwen-Coder',
      );
    });

    it('keeps recognition conservative when a `cd` hides behind a keyword in a branch that never runs', async () => {
      // R1-17: `skipCommitRecognitionNoise` runs BEFORE the cd latch, so `then
      // cd <other>` reaches `cdTargetMayChangeRepo` and suppresses recognition
      // although the branch never runs and the commit lands here. Pre-#12514
      // the `tokens[0]`-only walk saw `then`, ignored the `cd`, and registered
      // and spliced the trailer, so this row is red at the merge base.
      //
      // Conservative half of a trade-off not resolvable statically:
      // `splitCommands` evaluates nothing, so false- and true-branch `cd`s give
      // identical segments, and any loosening that recovers this row re-admits
      // stamping our trailer onto a commit in a DIFFERENT repository
      // (`if true; then cd <other>; fi && git commit`). Pinned so loosening is
      // a deliberate, reviewed act.
      const otherDir = makeOtherRepo();
      const preHead = writeFeature();

      await runShellCommand(
        `if false; then cd ${otherDir}; fi && ${COMMIT_FEATURE}`,
      );

      // The commit landed in OUR repository (the branch never ran)…
      expectFeatureHead(preHead);
      // …with no trailer, and recognition stays off, so the amend is blocked.
      // That false block is accepted because the alternative is wrong-repo
      // stamping; the other repository must stay untouched either way.
      expect(lastLog('%B')).not.toContain('Co-authored-by: Qwen-Coder');
      expect(amendVerdict()?.blocked).toBe(true);
      expect(lastLog('%s', otherDir)).toBe('other seed');
    });

    it('registers a commit landed by a Ctrl+B-promoted foreground command once it settles (issue #12514)', async () => {
      // #12514-A.3: `handlePromotedForeground` returns before the
      // attribution/registration block in `execute()`, so a commit landed by
      // a promoted command used to earn no exemption — unlike
      // `executeBackground`, which refuses `git commit` outright.
      const preHead = writeFeature();
      await runPromoted(COMMIT_FEATURE);
      expectFeatureHead(preHead);
      // Witness assertion: registration happened at settle, so the follow-up
      // amend of the agent's own commit is exempt.
      expect(amendVerdict()).toBeNull();
    });

    it('does not register a promoted command whose commit lands in another repository', async () => {
      // Regression pin for the promoted-path gate: it must not be the bare
      // `hasCommit` flag. A promoted `cd /elsewhere && git commit` carries no
      // preHead capture, so nothing may register — as on the foreground path.
      await expectOtherRepoCommitBlocked((command) => runPromoted(command));
    });

    it('does not register a promoted command whose commit never landed', async () => {
      // The promoted-path analogue of regression ②: registration at settle
      // still requires HEAD movement against the captured preHead, so a
      // failed `git commit` (nothing staged) registers nothing.
      await expectFailedCommitBlocked('git commit -m "nothing staged"', (c) =>
        runPromoted(c),
      );
    });

    it('registers a promoted commit whose settle arrives after execute() returned (issue #12514)', async () => {
      // The rows above settle before the handle resolves (queued drain), so
      // none reaches the wired handler. A real Ctrl+B promote of a running
      // command registers only via `promoteArtifacts.onSettleWired`; moving
      // `registerPromotedCommit()` into the drain would keep them all green
      // while losing registration for every promoted commit in production.
      const preHead = writeFeature();

      const result = await runPromoted(COMMIT_FEATURE, true);

      expect(result.llmContent).toContain('promoted to background as');
      // The commit is on disk but the child still runs and registration is
      // settle-only, so no exemption yet: today's behaviour (R1-9 asks whether
      // it should be), and what makes the post-settle assertion causal.
      expect(headSha()).not.toBe(preHead);
      expect(amendVerdict()?.blocked).toBe(true);

      firePromoteSettle!();
      // `onSettleWired` starts registration asynchronously, so wait for the
      // registry to reflect it instead of sleeping a fixed guess.
      await vi.waitFor(() => expect(amendVerdict()).toBeNull());
    });

    it('does not adopt a commit somebody else landed while a promoted child ran (issue #12514)', async () => {
      // The promoted window is the child's whole lifetime, which #12523's
      // accepted foreground window does not cover: at settle the newest
      // `commit:` reflog entry can be one the user (or a hook, or a parallel
      // worktree session) landed after ours. Difference-from-`preHead` alone
      // adopts it, lifting the deterministic block on rewriting a commit the
      // shell tool never made while ours loses its exemption. Registration
      // must prove lineage: the entry creating HEAD moved it *from* preHead.
      const preHead = writeFeature();
      await runPromoted(COMMIT_FEATURE, true);
      const agentSha = headSha();
      expect(agentSha).not.toBe(preHead);

      // A foreign commit lands in the same repository while the promoted
      // child is still running.
      rawCommit('foreign.txt', 'not the agent\n', 'foreign');
      const foreignSha = headSha();
      expect(foreignSha).not.toBe(agentSha);

      firePromoteSettle!();
      // The settle probe is one `git log -g` (2 s timeout, ~10 ms healthy);
      // registering nothing leaves no observable to wait on, so give it room,
      // then assert fail-closed: HEAD is the foreign commit, never adopted, and
      // its amend stays hard-blocked.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(headSha()).toBe(foreignSha);
      expect(amendVerdict()?.blocked).toBe(true);
    });

    it('does not resurrect a promoted exemption across a session-commit registry clear', async () => {
      // R1-7: promoted registration fires when the child exits, arbitrarily
      // after the promote. `Config.setApprovalMode` clears the registry on
      // every real transition so exemptions do not cross it; a later settle
      // must not write one back. The clear itself models the boundary (its
      // only effect on this registry). The generation counter, not
      // `Config.getApprovalModeRevision()`, is the staleness signal: the
      // revision also moves on the AUTO → PLAN → AUTO excursion the clear is
      // gated off, and dropping a registration there would falsely block the
      // agent's own commit.
      const preHead = writeFeature();
      await runPromoted(COMMIT_FEATURE, true);
      expect(headSha()).not.toBe(preHead);

      // The boundary: the registry is cleared while the promoted child still
      // counts as running, i.e. before `onSettleWired` can fire.
      clearSessionCommits();
      expect(amendVerdict()?.blocked).toBe(true);

      firePromoteSettle!();
      // Nothing observable appears when registration is correctly skipped, so
      // give the settle-time probe room and then assert the fail-closed
      // outcome (same pattern as the foreign-commit row).
      await new Promise((resolve) => setTimeout(resolve, 500));
      // The commit is still on disk and untouched; only the exemption may not
      // come back. The control for the no-boundary path is the deferred-settle
      // row above, which still registers.
      expect(headSha()).not.toBe(preHead);
      expect(amendVerdict()?.blocked).toBe(true);
    });

    it('still blocks an amend of a commit the shell tool did not make', async () => {
      // Regression ①: a commit created outside the shell tool (a user commit,
      // or one from another session) must not be exempted.
      rawCommit('human.txt', 'human\n', 'human commit');

      expect(amendVerdict()?.blocked).toBe(true);
      expect(amendVerdict()?.reason).toContain(
        'not made by the agent in this session',
      );
    });

    it('does not register HEAD when the commit failed and HEAD did not move', async () => {
      // Regression ②: `git commit` with nothing staged exits non-zero and
      // leaves HEAD where it was. Registering that HEAD would exempt an amend
      // of a commit the agent never made.
      await expectFailedCommitBlocked('git commit -m "nothing staged"');
    });

    it('does not register a HEAD that a pull moved when the commit never landed', async () => {
      // Regression ⑤, the fail-open half of ②: HEAD moved, but `git pull`
      // fast-forwarded onto somebody else's commit and the `git commit`
      // segment then failed with nothing staged. Registering that HEAD would
      // exempt an amend of a commit the agent never authored, handing a
      // history rewrite from the deterministic Auto-mode block to the
      // non-deterministic classifier. The chain does reach the call site:
      // `gitCommitContext` latches `cwdShifted` only on cd/pushd/popd or a
      // cwd-shifting git flag (not `git pull`), so `attributableInCwd` stays
      // true, and the site is gated on sandbox/attributability only, with no
      // exit-code condition.
      const upstreamDir = initRepo(makeScratchDir('qwen-12460-upstream-'), {
        email: 'upstream@example.com',
        name: '"Upstream Author"',
      });
      rawCommit(
        'upstream.txt',
        'upstream work\n',
        'upstream work',
        upstreamDir,
      );
      const upstreamHead = headSha(upstreamDir);

      // Put the working repo on upstream's history one commit behind, so the
      // pull is a genuine fast-forward, not an unrelated-history merge.
      rawGit(`fetch -q ${upstreamDir} main`);
      rawGit('reset -q --hard FETCH_HEAD');
      rawGit('reset -q --hard HEAD~1');
      rawGit(`remote add upstream ${upstreamDir}`);

      const preHead = headSha();
      // The pull succeeds and moves HEAD; the commit then exits non-zero
      // because nothing is staged, so the whole chain's exit code is 1.
      await runShellCommand(
        'git pull -q upstream main && git commit -m "agent work"',
      );

      const postHead = headSha();
      // HEAD really moved, onto the upstream author's commit, so a criterion
      // based on HEAD movement alone cannot tell this apart from a commit the
      // agent landed itself.
      expect(postHead).not.toBe(preHead);
      expect(postHead).toBe(upstreamHead);
      expect(lastLog('%ae')).toBe('upstream@example.com');
      expect(lastLog('%s')).toBe('upstream work');

      // Witness assertion: the agent did not produce this HEAD, so the amend
      // must stay blocked.
      expect(amendVerdict()?.blocked).toBe(true);
      expect(amendVerdict()?.reason).toContain(
        'not made by the agent in this session',
      );
    });

    // Branch `other` gets a tip unlike `main`'s; the chain then lands the
    // feature commit and `tail` moves HEAD onto that tip. Landing anywhere
    // but the pre-command HEAD matters: otherwise `head.sha !== preHead` alone
    // rejects the registration and the reflog verb goes untested.
    async function expectTrailingMoveBlocked(tail: string) {
      const seedHead = headSha();
      rawGit('checkout -q -b other');
      rawCommit('other.txt', 'other\n', 'other work');
      const otherHead = headSha();
      rawGit('checkout -q main');
      expect(headSha()).toBe(seedHead);
      writeFeature();

      await runShellCommand(`${COMMIT_FEATURE} && ${tail}`);

      // The commit landed, but the chain left HEAD on `other`'s tip — a
      // different SHA from preHead, so only the reflog verb can reject it.
      expect(headSha()).toBe(otherHead);
      expect(headSha()).not.toBe(seedHead);
      expect(amendVerdict()?.blocked).toBe(true);
    }

    it('does not register when a later segment checked HEAD out away from the commit', async () => {
      // Regression ⑥, the trailing half of ⑤: the commit lands, then a later
      // segment moves HEAD onto a commit the agent never created, so the
      // newest reflog entry is that move and nothing registers (exempting it
      // would rewrite somebody else's commit). Both halves are needed: a
      // criterion that also accepted `checkout` / `reset` entries, or rejected
      // only `pull`, passes ⑤ and fails here.
      await expectTrailingMoveBlocked('git checkout -q other');
    });

    it('does not register when a later segment reset HEAD off the commit', async () => {
      // Regression ⑦ — same shape as ⑥ with `reset` instead of `checkout`,
      // so neither verb is special-cased by accident.
      await expectTrailingMoveBlocked('git reset -q --hard other');
    });

    it('registers the commit when a later segment makes the chain exit non-zero', async () => {
      // Regression ⑧ pins the *absence* of an exit-code gate at the call site.
      // `trackSessionCommit`'s docblock argues for it (`git commit -m x &&
      // npm test` can land the commit, then fail) and `:4199-4201` cites it
      // for why ⑤ reaches the code, but every other registering row exits 0,
      // so adding the gate fails nothing. Gating on the commit's own outcome
      // was proposed twice on this PR, so it is the likeliest "hardening", and
      // it would pass on a green suite while reintroducing #12460's false
      // block for exactly the shape the docblock endorses.
      //
      // The trailing `&& false` makes the chain exit 1 while the newest HEAD
      // reflog entry stays a `commit:` verb (the term under test); a trailing
      // `git checkout` / `git reset` would also exit non-zero but collide with
      // ⑥/⑦ and mute the verb mutants.
      const preHead = writeFeature();

      await runShellCommand(`${COMMIT_FEATURE} && false`);

      expect(headSha()).not.toBe(preHead);
      expect(rawGit('log -g -1 --format=%gs')).toMatch(/^commit\b/);
      expect(amendVerdict()).toBeNull();
    });

    it('registers nothing when the reflog cannot answer, so the amend stays blocked', async () => {
      // Regression ⑨, the fail-closed branch itself: `getGitHeadOrigin`
      // resolves `null` when git cannot say what put HEAD there, and
      // `trackSessionCommit` registers nothing. Every other repo has a readable
      // HEAD reflog, so no other row reaches it. The plausible refactor
      // (falling back to `getGitHead(cwd)` on `null` so a reflogs-off repo
      // keeps the exemption) keeps them all green while degrading the
      // criterion to HEAD movement, re-opening the fail-open ⑤/⑥/⑦ prevent: a
      // `git pull` onto a human commit would register as the agent's.
      //
      // `core.logAllRefUpdates=false` must precede the seed commit: git creates
      // `.git/logs/HEAD` on the first logged ref update, and a repo that has
      // one keeps answering the probe, so the row would pass via
      // `head.sha !== preHead` instead. Hence rebuilding the `beforeEach` repo
      // at the same path (helpers and config still point at it). Measured on
      // real git: `.git/logs/HEAD` never appears and `git log -g -1
      // --format='%H%n%gs' HEAD` exits 0 with EMPTY stdout, so the exit taken
      // is `!sha || !subject`, not `error`: a fallback only at the `error`
      // exit never runs here and does not model the refactor.
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.mkdirSync(repoDir, { recursive: true });
      initRepo(repoDir, { config: 'core.logAllRefUpdates false' });
      expect(fs.existsSync(path.join(repoDir, '.git', 'logs', 'HEAD'))).toBe(
        false,
      );

      const preHead = writeFeature();
      await runShellCommand(COMMIT_FEATURE);

      // The commit genuinely landed and HEAD moved, so a movement-only
      // criterion would register it. Only the unanswerable reflog stops it,
      // and the cost is a blocked amend rather than a lifted block.
      expect(headSha()).not.toBe(preHead);
      expect(amendVerdict()?.blocked).toBe(true);
    });

    it('registers the rewritten HEAD after an amend so amend-of-amend is exempt', async () => {
      // Regression ③: an amend replaces HEAD, so the new SHA has to be
      // registered too — otherwise the second amend in a row is blocked.
      await commitAndAssertExempt();

      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work v2\n');
      const preAmendHead = headSha();
      await runShellCommand(`git add feature.txt && ${AMEND_COMMAND}`);

      // The amend rewrote HEAD, so the guard reads a new SHA that the
      // original commit never registered.
      expectFeatureHead(preAmendHead);
      expect(amendVerdict()).toBeNull();
    });

    it('registers the commit even when gitCoAuthor.commit attribution is disabled', async () => {
      // Regression ④: session tracking is deliberately independent of the
      // commit-attribution toggle. A user who turned attribution off must not
      // lose the amend exemption.
      (mockConfig.getGitCoAuthor as ReturnType<typeof vi.fn>).mockReturnValue({
        commit: false,
        pr: false,
        name: 'Qwen-Coder',
        email: 'qwen-coder@alibabacloud.com',
      });

      // The amend exemption works, because session tracking does not consult
      // the toggle...
      await commitAndAssertExempt();
      // ...and the toggle really took effect: no Co-authored-by trailer.
      expect(lastLog('%B')).not.toContain('Co-authored-by');
    });

    it('clears the registry on a mode switch so the amend is blocked again', async () => {
      // Fail-closed witness for the `clearSessionCommits()` contract ("Called
      // on session end or mode switch"): exemptions earned under one approval
      // mode must not carry across a mode boundary.
      await commitAndAssertExempt();

      // Constructed already in DEFAULT (rather than switching into it) so the
      // registry is not cleared before the transition under test.
      const realConfig = realConfigIn(ApprovalMode.DEFAULT);
      expect(realConfig.getApprovalMode()).toBe(ApprovalMode.DEFAULT);

      realConfig.setApprovalMode(ApprovalMode.AUTO);
      expect(realConfig.getApprovalMode()).toBe(ApprovalMode.AUTO);

      // Same repo, commit and command, but the mode switched, so the guard
      // blocks again and the user has to re-approve.
      expect(amendVerdict()?.blocked).toBe(true);
    });

    it('keeps the exemption when the approval mode is re-set to its current value', async () => {
      // Guard against over-clearing: several callers re-set the mode they are
      // already in, and wiping the registry there would silently take the
      // amend exemption away mid-session.
      await commitAndAssertExempt();

      const realConfig = realConfigIn(ApprovalMode.DEFAULT, false);
      const currentMode = realConfig.getApprovalMode();
      expect(currentMode).toBe(ApprovalMode.DEFAULT);

      realConfig.setApprovalMode(currentMode);

      expect(amendVerdict()).toBeNull();
    });

    it('resolves the guard against the target dir when the call passes no directory', async () => {
      // The guard must inspect the repo the shell tool registered in, whose cwd
      // is `this.params.directory || this.config.getTargetDir()`, but
      // `PermissionCheckContext.cwd` is only set when a call passes
      // `directory`. With `undefined`, `isDestructiveCommand`'s `git rev-parse`
      // uses `process.cwd()`: in a process hosting several sessions (ACP,
      // daemon) or worktrees that is wherever the process started, so the
      // exemption could be read from one repo's registry while the amend
      // rewrites another's.
      await commitAndAssertExempt();

      const realConfig = realConfigIn(ApprovalMode.AUTO);
      expect(realConfig.getTargetDir()).toBe(repoDir);

      const decision = await evaluateAutoMode({
        // No `cwd` on the context — this is the shape a plain shell call has.
        ctx: { toolName: ToolNames.SHELL, command: AMEND_COMMAND },
        pmForcedAsk: false,
        toolParams: {},
        messages: [{ role: 'user', parts: [{ text: USER_PROMPT }] }],
        config: realConfig,
        signal: new AbortController().signal,
        // Keep the LLM classifier out of it; the assertion is about L5.2.5.
        skipClassifierReason: 'total_denial',
      });

      expect(decision.via).not.toBe('blocked:destructive-command');
    });

    it('keeps production abort/signal helpers behind the executor-only mock', () => {
      // The seam replaces `execute` only (so no node-pty dependency).
      // Production reads `kind` as an *own* property in a try/catch so a
      // prototype-only or throwing `kind` cannot take the promote branch; a
      // hand-rolled `'kind' in reason` copy returns 'background' below. This
      // row keeps such a copy from coming back.
      expect(
        getShellAbortReasonKind(Object.create({ kind: 'background' })),
      ).toBe('cancel');
      expect(isSignalTermination(0)).toBe(false);
      expect(isSignalTermination('SIGTERM')).toBe(true);
    });

    it('keeps the exemption across a PLAN round trip', async () => {
      // `enter_plan_mode` is model-callable from AUTO and `exit_plan_mode`
      // restores it: two real transitions ending where they began. PLAN
      // cannot commit, so the excursion cannot add an exemption; clearing on
      // it only cost the agent a false "not made by the agent in this session"
      // block on its own commit, inescapable inside AUTO. Both legs are
      // excluded, or the return leg alone still wipes it.
      await commitAndAssertExempt();

      const realConfig = realConfigIn(ApprovalMode.AUTO);
      expect(realConfig.getApprovalMode()).toBe(ApprovalMode.AUTO);

      realConfig.setApprovalMode(ApprovalMode.PLAN);
      expect(realConfig.getApprovalMode()).toBe(ApprovalMode.PLAN);
      realConfig.setApprovalMode(ApprovalMode.AUTO);
      expect(realConfig.getApprovalMode()).toBe(ApprovalMode.AUTO);

      expect(amendVerdict()).toBeNull();
    });

    it('keeps the root registry when a derived overlay changes its own mode', async () => {
      // `deriveApprovalModeConfig` installs an own `setApprovalMode` that
      // delegates to the prototype method, so a subagent's child-local
      // transition cleared the *root* registry, against the design, and the
      // root hard-blocked an amend of its own minutes-old commit with a false
      // reason. Fail-closed (a wrong block, not a lifted one), but still wrong.
      await commitAndAssertExempt();

      const realConfig = realConfigIn(ApprovalMode.AUTO);
      const overlay = deriveApprovalModeConfig(
        realConfig,
        realConfig.getApprovalMode(),
      );
      overlay.config.setApprovalMode(ApprovalMode.AUTO_EDIT);

      // The transition really happened, and it stayed child-local.
      expect(overlay.config.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);
      expect(realConfig.getApprovalMode()).toBe(ApprovalMode.AUTO);

      expect(amendVerdict()).toBeNull();
    });
  },
);
