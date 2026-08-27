from pathlib import Path

# 1) Track repository-local clean/process filters as executable Git config.
path = "packages/core/src/utils/git-config-safety.ts"
p = Path(path)
s = p.read_text()

s = s.replace(
    """  diffDriverTextconv: boolean;
  fsmonitor: boolean;""",
    """  diffDriverTextconv: boolean;
  worktreeFilter: boolean;
  fsmonitor: boolean;""",
    1,
)
s = s.replace(
    """  diffDriverTextconv: false,
  fsmonitor: false,""",
    """  diffDriverTextconv: false,
  worktreeFilter: false,
  fsmonitor: false,""",
    1,
)
s = s.replace(
    """  diffDriverTextconv: true,
  fsmonitor: true,""",
    """  diffDriverTextconv: true,
  worktreeFilter: true,
  fsmonitor: true,""",
    1,
)
s = s.replace(
    """const DIFF_DRIVER_TEXTCONV_KEY_PATTERN = String.raw`^diff\\..*\\.textconv$`;
const LOCAL_GIT_CONFIG_RISK_KEY_PATTERN = [""",
    """const DIFF_DRIVER_TEXTCONV_KEY_PATTERN = String.raw`^diff\\..*\\.textconv$`;
const WORKTREE_FILTER_KEY_PATTERN = String.raw`^filter\\..*\\.(?:clean|process)$`;
const LOCAL_GIT_CONFIG_RISK_KEY_PATTERN = [""",
    1,
)
s = s.replace(
    """  DIFF_DRIVER_COMMAND_KEY_PATTERN,
  DIFF_DRIVER_TEXTCONV_KEY_PATTERN,
].join('|');""",
    """  DIFF_DRIVER_COMMAND_KEY_PATTERN,
  DIFF_DRIVER_TEXTCONV_KEY_PATTERN,
  WORKTREE_FILTER_KEY_PATTERN,
].join('|');""",
    1,
)
s = s.replace(
    """const DIFF_DRIVER_TEXTCONV_KEY = new RegExp(
  DIFF_DRIVER_TEXTCONV_KEY_PATTERN,
  'i',
);
""",
    """const DIFF_DRIVER_TEXTCONV_KEY = new RegExp(
  DIFF_DRIVER_TEXTCONV_KEY_PATTERN,
  'i',
);
const WORKTREE_FILTER_KEY = new RegExp(WORKTREE_FILTER_KEY_PATTERN, 'i');
""",
    1,
)
s = s.replace(
    """    diffDriverCommand: hasLocalValueMatching(DIFF_DRIVER_COMMAND_KEY),
    diffDriverTextconv: hasLocalValueMatching(DIFF_DRIVER_TEXTCONV_KEY),
    fsmonitor:""",
    """    diffDriverCommand: hasLocalValueMatching(DIFF_DRIVER_COMMAND_KEY),
    diffDriverTextconv: hasLocalValueMatching(DIFF_DRIVER_TEXTCONV_KEY),
    worktreeFilter: hasLocalValueMatching(WORKTREE_FILTER_KEY),
    fsmonitor:""",
    1,
)
required = [
    "worktreeFilter: boolean",
    "WORKTREE_FILTER_KEY_PATTERN",
    "worktreeFilter: hasLocalValueMatching",
]
if not all(x in s for x in required):
    raise SystemExit("git-config-safety patch incomplete")
p.write_text(s)

# 2) Harden `git remote show`, filter/fsmonitor consumers, and fallback gate.
path = "packages/core/src/utils/shellAstParser.ts"
p = Path(path)
s = p.read_text()

old_remote = """  if (subcommand === 'remote') {
    const action = rest.find((arg) => !arg.startsWith('-'))?.toLowerCase();
    if (!action) return invokesHelper ? 'unknown' : 'read-only';
    if (['show', 'get-url'].includes(action))
      return rest.some((arg) =>
        /^(?:add|remove|rm|rename|set-branches|set-head|set-url|update|prune)$/i.test(
          arg,
        ),
      ) || invokesHelper
        ? 'unknown'
        : 'read-only';
    if (WRITE_GIT_REMOTE_ACTION.test(action)) return 'write';"""
new_remote = """  if (subcommand === 'remote') {
    const action = rest.find((arg) => !arg.startsWith('-'))?.toLowerCase();
    if (!action) return invokesHelper ? 'unknown' : 'read-only';
    if (action === 'show') {
      // `git remote show <name>` queries the remote and may invoke
      // repository-controlled transport helpers (for example core.sshCommand).
      // Only the documented no-query form is safe for silent execution.
      const noQuery = rest.some((arg) => ['-n', '--no-query'].includes(arg));
      return noQuery && !invokesHelper ? 'read-only' : 'unknown';
    }
    if (action === 'get-url')
      return rest.some((arg) =>
        /^(?:add|remove|rm|rename|set-branches|set-head|set-url|update|prune)$/i.test(
          arg,
        ),
      ) || invokesHelper
        ? 'unknown'
        : 'read-only';
    if (WRITE_GIT_REMOTE_ACTION.test(action)) return 'write';"""
if old_remote not in s:
    raise SystemExit("remote show marker not found")
s = s.replace(old_remote, new_remote, 1)

old_gate = """  let changedDirectory = false;
  let usesDiff = false;
  let usesStatus = false;
  let usesTextconvConsumer = false;

  for (const command of collectDescendants(root, new Set(['command']))) {
    const name = getCommandName(command);
    if (name === 'cd' || name === 'pushd') {
      changedDirectory = true;
      continue;
    }
    if (name !== 'git') continue;
    const subcommand = stripOuterQuotes(
      getArgumentNodes(command)[0]?.text ?? '',
    ).toLowerCase();
    if (!['blame', 'diff', 'log', 'show', 'status'].includes(subcommand))
      continue;
    if (changedDirectory) return true;
    usesDiff ||= subcommand === 'diff';
    usesStatus ||= subcommand === 'status';
    usesTextconvConsumer ||= ['blame', 'diff', 'log', 'show'].includes(
      subcommand,
    );
  }

  if (!usesDiff && !usesStatus && !usesTextconvConsumer) return false;
  const risk = getLocalGitConfigRisk(cwd);
  return (
    (usesDiff && (risk.diffExternal || risk.diffDriverCommand)) ||
    (usesTextconvConsumer && risk.diffDriverTextconv) ||
    (usesStatus && risk.fsmonitor)
  );"""
new_gate = """  let changedDirectory = false;
  let usesDiff = false;
  let usesTextconvConsumer = false;
  let usesWorktreeFilterConsumer = false;
  let usesFsmonitorConsumer = false;

  for (const command of collectDescendants(root, new Set(['command']))) {
    const name = getCommandName(command);
    if (name === 'cd' || name === 'pushd') {
      changedDirectory = true;
      continue;
    }
    if (name !== 'git') continue;
    const subcommand = stripOuterQuotes(
      getArgumentNodes(command)[0]?.text ?? '',
    ).toLowerCase();
    if (!['blame', 'diff', 'log', 'show', 'status'].includes(subcommand))
      continue;
    if (changedDirectory) return true;
    usesDiff ||= subcommand === 'diff';
    usesTextconvConsumer ||= ['blame', 'diff', 'log', 'show'].includes(
      subcommand,
    );
    usesWorktreeFilterConsumer ||= ['blame', 'diff', 'status'].includes(
      subcommand,
    );
    usesFsmonitorConsumer ||= ['blame', 'diff', 'status'].includes(subcommand);
  }

  if (
    !usesDiff &&
    !usesTextconvConsumer &&
    !usesWorktreeFilterConsumer &&
    !usesFsmonitorConsumer
  )
    return false;
  const risk = getLocalGitConfigRisk(cwd);
  return (
    (usesDiff && (risk.diffExternal || risk.diffDriverCommand)) ||
    (usesTextconvConsumer && risk.diffDriverTextconv) ||
    (usesWorktreeFilterConsumer && risk.worktreeFilter) ||
    (usesFsmonitorConsumer && risk.fsmonitor)
  );"""
if old_gate not in s:
    raise SystemExit("local Git config gate marker not found")
s = s.replace(old_gate, new_gate, 1)

old_fallback = """    risk.diffDriverCommand ||
    risk.diffDriverTextconv ||
    risk.fsmonitor"""
new_fallback = """    risk.diffDriverCommand ||
    risk.diffDriverTextconv ||
    risk.worktreeFilter ||
    risk.fsmonitor"""
if old_fallback not in s:
    raise SystemExit("fallback Git config marker not found")
s = s.replace(old_fallback, new_fallback, 1)
p.write_text(s)

# 3) Fail closed on leading environment assignments before wrapper stripping.
path = "packages/core/src/tools/shell.ts"
p = Path(path)
s = p.read_text()
marker = """/**
 * Escape `s` so it is safe to interpolate inside a bash double-quoted
 * string."""
helper = """function hasLeadingEnvironmentAssignment(command: string): boolean {
  try {
    const first = parse(command)[0];
    return (
      typeof first === 'string' &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)
    );
  } catch {
    // A parse failure must not make a wrapper look safer than it is.
    return true;
  }
}

/**
 * Escape `s` so it is safe to interpolate inside a bash double-quoted
 * string."""
if marker not in s:
    raise SystemExit("shell helper insertion marker not found")
s = s.replace(marker, helper, 1)

old_perm = """    if (hasShellSubstitution(this.params.command)) {
      return 'ask';
    }

    const command = stripShellWrapper(this.params.command);"""
new_perm = """    if (
      hasShellSubstitution(this.params.command) ||
      hasLeadingEnvironmentAssignment(this.params.command)
    ) {
      return 'ask';
    }

    const command = stripShellWrapper(this.params.command);"""
if old_perm not in s:
    raise SystemExit("default permission marker not found")
s = s.replace(old_perm, new_perm, 1)
s = s.replace(
    """   * - Read-only commands (via AST analysis) → 'allow'""",
    """   * - Commands with leading environment assignments → 'ask' before wrapper stripping
   * - Read-only commands (via AST analysis) → 'allow'""",
    1,
)
p.write_text(s)

# 4) Add an end-to-end permission regression beside the existing raw-command tests.
path = "packages/core/src/tools/shell.test.ts"
p = Path(path)
s = p.read_text()
test_marker = """    it('should request confirmation for a non-read-only command and return details', async () => {"""
new_test = """    it('should keep env-prefixed Git wrappers confirmable before stripping', async () => {
      for (const command of [
        `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=/tmp/helper bash -c 'git diff'`,
        `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=/tmp/helper git status`,
      ]) {
        const invocation = shellTool.build({
          command,
          is_background: false,
        });

        expect(await invocation.getDefaultPermission()).toBe('ask');
      }
    });

""" + test_marker
if test_marker not in s:
    raise SystemExit("shell test insertion marker not found")
s = s.replace(test_marker, new_test, 1)
p.write_text(s)

# 5) Focused regression coverage for repository-local Git execution hooks.
test_content = """/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLocalGitConfigRisk } from './git-config-safety.js';
import {
  classifyShellCommandSafety,
  classifyShellCommandSafetyInDirectory,
} from './shellAstParser.js';

describe.sequential('repository-local Git execution hooks', () => {
  let repo: string;
  let oldGlobal: string | undefined;
  let oldNoSystem: string | undefined;

  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: process.env,
    });
    expect(result.status, result.stderr).toBe(0);
  };

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'qwen-git-risk-'));
    oldGlobal = process.env.GIT_CONFIG_GLOBAL;
    oldNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = path.join(repo, 'isolated-global-config');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    git('init');
  });

  afterEach(() => {
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
    if (oldNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = oldNoSystem;
    rmSync(repo, { recursive: true, force: true });
  });

  it('gates local clean/process filters for blame, diff and status', async () => {
    git('config', '--local', 'filter.demo.clean', '/tmp/filter-helper');
    expect(getLocalGitConfigRisk(repo).worktreeFilter).toBe(true);

    for (const command of ['git blame file', 'git diff', 'git status']) {
      expect(
        await classifyShellCommandSafetyInDirectory(command, repo),
      ).toBe('unknown');
    }

    git('config', '--local', '--unset', 'filter.demo.clean');
    git('config', '--local', 'filter.demo.process', '/tmp/filter-process');
    expect(getLocalGitConfigRisk(repo).worktreeFilter).toBe(true);
    expect(
      await classifyShellCommandSafetyInDirectory('git diff', repo),
    ).toBe('unknown');
  });

  it('does not treat a matching global filter key as repository-local risk', () => {
    git('config', '--global', 'filter.global.clean', '/tmp/global-helper');
    expect(getLocalGitConfigRisk(repo).worktreeFilter).toBe(false);
  });

  it('gates fsmonitor for blame, diff and status but not log', async () => {
    git('config', '--local', 'core.fsmonitor', '/tmp/fsmonitor-helper');

    for (const command of ['git blame file', 'git diff', 'git status']) {
      expect(
        await classifyShellCommandSafetyInDirectory(command, repo),
      ).toBe('unknown');
    }
    expect(
      await classifyShellCommandSafetyInDirectory('git log -1', repo),
    ).toBe('read-only');
  });

  it('requires no-query mode for git remote show', async () => {
    expect(await classifyShellCommandSafety('git remote show origin')).toBe(
      'unknown',
    );
    expect(await classifyShellCommandSafety('git remote show -n origin')).toBe(
      'read-only',
    );
    expect(
      await classifyShellCommandSafety('git remote show --no-query origin'),
    ).toBe('read-only');
    expect(await classifyShellCommandSafety('git remote get-url origin')).toBe(
      'read-only',
    );
  });
});
"""
Path("packages/core/src/utils/git-config-safety.round2.test.ts").write_text(test_content)

# 6) Document the expanded threat model.
doc = Path("docs/design/2026-08-08-read-only-git-config-safety.md")
text = doc.read_text()
heading = "## Follow-up hardening: execution-bearing Git configuration"
section = """
## Follow-up hardening: execution-bearing Git configuration

The repository-local safety gate also treats these paths as executable rather
than merely observational:

- `filter.<name>.clean` and `filter.<name>.process` can start filter helpers
  while `git blame`, `git diff`, or `git status` inspects worktree content.
- `core.fsmonitor` is consumed by `git blame`, `git diff`, and `git status`,
  not only by status.
- `git remote show <name>` may contact the remote and invoke transport helpers;
  only `git remote show -n <name>` / `--no-query` is classified read-only.
- Leading environment assignments are checked before shell-wrapper stripping,
  so injected Git configuration cannot disappear from the permission input.

As with diff drivers, only effective repository-local or worktree-scoped config
is treated as repository-controlled risk. A matching global value alone does
not downgrade a command.
"""
if heading not in text:
    doc.write_text(text.rstrip() + "\n\n" + section.strip() + "\n")
