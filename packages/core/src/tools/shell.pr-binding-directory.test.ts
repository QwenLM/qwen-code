/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real-filesystem end-to-end coverage for `gh pr create` attribution
 * directory resolution. Nothing in the attribution chain is mocked: a real
 * git repository with a real linked worktree, a real `gh` subprocess (a
 * PATH stub that answers per branch and only reports a PR after a create),
 * the real `findGitRoot` / `fetchCurrentBranchPullRequest` /
 * `fetchCurrentBranchName` / `fetchAttributionRepoKeys` probes, the real
 * shell AST, and the real locked sidecar write.
 *
 * This is the shape of two live incidents (sessions d0911852 / 195215bf):
 * `cd <worktree> && gh pr create` with no `directory` param, launched from a
 * workspace root whose own branch has no PR.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShellTool } from './shell.js';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { readSessionPrs } from '../services/session-pr-service.js';

const PR_NUMBER = 4242;
const PR_URL = `https://github.com/o/r/pull/${PR_NUMBER}`;
const WORKTREE_BRANCH = 'fix/x';

/**
 * A gh stand-in that models creation: `pr view` reports no PR for a branch
 * until `pr create` ran in it. Without that state the pre-run snapshot
 * would already see the PR and the gate would (correctly) decline it as
 * pre-existing, which would hide the directory bug this file pins.
 */
const GH_STUB = `#!/usr/bin/env bash
set -u
state_dir="\${GH_STUB_STATE_DIR:?}"
branch=$(git branch --show-current 2>/dev/null || echo detached)
marker="$state_dir/$(printf '%s' "$branch" | tr '/' '_')"
if [ "\${1:-}" = "repo" ] && [ "\${2:-}" = "view" ]; then
  printf '%s' '{"url":"https://github.com/o/r","parent":null}'
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "create" ]; then
  : > "$marker"
  printf '%s\\n' '${PR_URL}'
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  if [ -f "$marker" ]; then
    printf '{"number":${PR_NUMBER},"url":"${PR_URL}","state":"OPEN","headRefName":"%s"}' "$branch"
    exit 0
  fi
  printf 'no pull requests found for branch "%s"\\n' "$branch" >&2
  exit 1
fi
printf 'gh stub: unsupported arguments: %s\\n' "$*" >&2
exit 1
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

// The gh stand-in is a bash script and the fixture drives a real POSIX shell,
// so this suite cannot run on the Windows workspace lane (same guard as the
// executable-entry case in autofix-pr.test.ts).
describe.skipIf(process.platform === 'win32')(
  'gh pr create attribution directory (real filesystem)',
  () => {
    let tmp: string;
    let repo: string;
    let worktree: string;
    let sidecar: string;
    let stubBin: string;
    let originalPath: string | undefined;
    let originalStubState: string | undefined;

    beforeEach(() => {
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-bind-')));
      repo = path.join(tmp, 'repo');
      fs.mkdirSync(repo);
      stubBin = path.join(tmp, 'bin');
      fs.mkdirSync(stubBin);
      const stateDir = path.join(tmp, 'gh-state');
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(stubBin, 'gh'), GH_STUB, { mode: 0o755 });

      originalPath = process.env['PATH'];
      originalStubState = process.env['GH_STUB_STATE_DIR'];
      process.env['PATH'] = `${stubBin}${path.delimiter}${originalPath ?? ''}`;
      process.env['GH_STUB_STATE_DIR'] = stateDir;

      git(repo, 'init', '--initial-branch=main', '.');
      git(repo, 'config', 'user.name', 'Test');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
      fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '-m', 'base');
      // The launch directory's own branch deliberately has no PR.
      worktree = path.join(repo, '.qwen', 'worktrees', 'fix');
      git(repo, 'worktree', 'add', worktree, '-b', WORKTREE_BRANCH);
      fs.writeFileSync(path.join(worktree, 'change.txt'), 'change\n');
      git(worktree, 'add', 'change.txt');
      git(worktree, 'commit', '-m', 'change');

      sidecar = path.join(tmp, 'chats', 'real-session.pr.json');
      fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    });

    afterEach(() => {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      if (originalStubState === undefined)
        delete process.env['GH_STUB_STATE_DIR'];
      else process.env['GH_STUB_STATE_DIR'] = originalStubState;
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    /** A config whose target dir is the repo root, as a daemon session has. */
    const config = (): Config =>
      ({
        getCoreTools: () => [],
        getPermissionsAllow: () => [],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => [],
        getDebugMode: () => false,
        isRecordArtifactEnabled: () => false,
        getTargetDir: () => repo,
        getSessionId: () => 'real-session',
        getWorkspaceContext: () => createMockWorkspaceContext(repo),
        storage: {
          getUserSkillsDirs: () => [],
          getProjectTempDir: () => tmp,
          getProjectDir: () => tmp,
        },
        getTruncateToolOutputThreshold: () => 0,
        getTruncateToolOutputLines: () => 0,
        isTruncateToolOutputThresholdExplicit: () => false,
        getPermissionManager: () => undefined,
        getFileReadCacheDisabled: () => true,
        getModel: () => 'test-model',
        isInteractive: () => false,
        getGitCoAuthor: () => ({
          commit: false,
          pr: false,
          name: 'Test',
          email: 'test@example.com',
        }),
        getShouldUseNodePtyShell: () => false,
        getShellDefaultTimeoutMs: () => undefined,
        getShellHeartbeatIntervalMs: () => undefined,
        getBackgroundShellRegistry: () => undefined,
        getSessionService: () => ({
          getPrSessionPathForArchiveState: () => sidecar,
          getSessionLocation: async () => 'active',
          emitSessionPrBound: () => {},
        }),
      }) as unknown as Config;

    /**
     * Runs a real foreground command. The binding hook is fire-and-forget, so
     * this returns before the bind lands; callers that assert a binding poll
     * the sidecar via `waitForSidecar`.
     */
    const run = async (command: string, directory?: string) => {
      const tool = new ShellTool(config());
      const invocation = tool.build({
        command,
        is_background: false,
        ...(directory ? { directory } : {}),
      });
      return invocation.execute(new AbortController().signal);
    };

    const waitForSidecar = async (timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // null means "no sidecar yet" (or an empty list, which the reader
        // rejects by shape) — keep polling until the bind lands or we time out.
        const prs = (await readSessionPrs(sidecar)) ?? [];
        if (prs.length > 0 || Date.now() > deadline) return prs;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    it('binds the worktree PR when the command cds into the worktree itself', async () => {
      const result = await run(
        `cd ${worktree} && gh pr create --fill 2>&1 | tail -5`,
      );
      expect(result.error).toBeUndefined();

      const prs = await waitForSidecar();
      expect(prs.map((pr) => pr.number)).toEqual([PR_NUMBER]);
      expect(prs[0]).toMatchObject({ url: PR_URL, source: 'create' });
    });

    it('binds through a chained cd with intervening commands and a redirect', async () => {
      const body = path.join(tmp, 'body.md');
      await run(
        `cd ${repo} && printf 'body\\n' > ${body} && wc -l ${body} && cd .qwen/worktrees/fix && gh pr create --title "fix(managed-agent): dedupe" --body-file ${body} 2>&1 | tail -5`,
      );

      const prs = await waitForSidecar();
      expect(prs.map((pr) => pr.number)).toEqual([PR_NUMBER]);
    });

    it('still binds when the directory param names the worktree directly', async () => {
      await run('gh pr create --fill', worktree);
      const prs = await waitForSidecar();
      expect(prs.map((pr) => pr.number)).toEqual([PR_NUMBER]);
    });

    it('falls back with a notice when the cd target is an expansion', async () => {
      // The create really runs and really creates the worktree's PR; only the
      // attribution is unprovable, because the resolver refuses to guess what
      // $WORKTREE_PATH expands to. That is the miss the notice must surface.
      const original = process.env['WORKTREE_PATH'];
      process.env['WORKTREE_PATH'] = worktree;
      try {
        const result = await run('cd "$WORKTREE_PATH" && gh pr create --fill');
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toContain(
          'PR auto-binding fell back to the launch directory',
        );
        // The PR exists on the worktree branch, but nothing bound it. The stub
        // names its marker by the branch with separators flattened.
        expect(
          fs.existsSync(
            path.join(tmp, 'gh-state', WORKTREE_BRANCH.replace(/\//g, '_')),
          ),
        ).toBe(true);
        expect((await readSessionPrs(sidecar)) ?? []).toEqual([]);
      } finally {
        if (original === undefined) delete process.env['WORKTREE_PATH'];
        else process.env['WORKTREE_PATH'] = original;
      }
    });
  },
);
