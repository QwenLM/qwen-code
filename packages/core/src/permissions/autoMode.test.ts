/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SAFE_TOOL_ALLOWLIST,
  applyAutoModeDecision,
  evaluateAutoMode,
  formatClassifierBlockMessage,
  getAutoModePermissionDeniedReason,
  isAutoModeProtectedWritePath,
  isInSafeToolAllowlist,
  shouldFirePermissionDeniedForAutoMode,
  passesAcceptEditsFastPath,
  shouldForceAutoModeReviewForAllow,
  shouldRunAutoModeForCall,
} from './autoMode.js';
import { ApprovalMode } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import type { Config } from '../config/config.js';
import type { PermissionCheckContext } from './types.js';
import { setGeminiMdFilename } from '../memory/const.js';

// ─── SAFE_TOOL_ALLOWLIST contents (frozen) ───────────────────────────────

describe('SAFE_TOOL_ALLOWLIST', () => {
  it('includes the canonical read-only / metadata tools', () => {
    const expected = [
      ToolNames.READ_FILE,
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
      // `send_message` injects arbitrary text into another running agent
      // as a new instruction — the classifier must see destination + body
      // so it can detect inter-agent steering toward destructive actions.
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

/**
 * Build a stub Config whose WorkspaceContext considers `workspaceRoots`
 * as inside-the-workspace.
 */
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

describe('isAutoModeProtectedWritePath', () => {
  it('matches Qwen self-modification files and directories', () => {
    const protectedPaths = [
      '/repo/.qwen/settings.json',
      '/repo/.qwen/settings.local.json',
      '/repo/QWEN.md',
      '/repo/AGENTS.md',
      '/repo/.qwen/commands/review.md',
      '/repo/.qwen/agents/reviewer.md',
      '/repo/.qwen/skills/skill-a/SKILL.md',
      '/repo/.qwen/hooks/pre-tool-use.json',
      '/repo/.qwen/QWEN.local.md',
      '/repo/.qwen/rules/backend.md',
      '/repo/.mcp.json',
      '/repo/.git',
    ];

    for (const filePath of protectedPaths) {
      expect(isAutoModeProtectedWritePath(filePath)).toBe(true);
    }
  });

  it('does not treat ordinary source files or worktree files as protected', () => {
    const ordinaryPaths = [
      '/repo/src/index.ts',
      '/repo/.qwen/PROJECT_SUMMARY.md',
      '/repo/.qwen/worktrees/feature/src/index.ts',
    ];

    for (const filePath of ordinaryPaths) {
      expect(isAutoModeProtectedWritePath(filePath)).toBe(false);
    }
  });

  it('still protects config surfaces inside managed worktrees', () => {
    const protectedPaths = [
      '/repo/.qwen/worktrees/feature/.qwen/settings.json',
      '/repo/.qwen/worktrees/feature/AGENTS.md',
      '/repo/.qwen/worktrees/feature/.qwen/QWEN.local.md',
      '/repo/.qwen/worktrees/feature/.qwen/rules/backend.md',
      '/repo/.qwen/worktrees/feature/.mcp.json',
    ];

    for (const filePath of protectedPaths) {
      expect(isAutoModeProtectedWritePath(filePath)).toBe(true);
    }
  });

  it('matches protected paths case-insensitively', () => {
    const protectedPaths = [
      '/repo/qwen.md',
      '/repo/agents.md',
      '/repo/.QWEN/SETTINGS.JSON',
      '/repo/.QWEN/QWEN.LOCAL.MD',
      '/repo/.QWEN/RULES/backend.md',
      '/repo/.MCP.JSON',
      '/repo/GNUmakefile',
      '/repo/Taskfile.yaml',
      '/repo/.Github/workflows/ci.yml',
    ];

    for (const filePath of protectedPaths) {
      expect(isAutoModeProtectedWritePath(filePath)).toBe(true);
    }
  });

  it('matches configured context filenames', () => {
    setGeminiMdFilename(['CUSTOM_AGENTS.md', 'docs/TEAM_CONTEXT.md']);
    try {
      const protectedPaths = [
        '/repo/CUSTOM_AGENTS.md',
        '/repo/docs/TEAM_CONTEXT.md',
        '/repo/.qwen/worktrees/feature/CUSTOM_AGENTS.md',
      ];

      for (const filePath of protectedPaths) {
        expect(isAutoModeProtectedWritePath(filePath)).toBe(true);
      }
    } finally {
      setGeminiMdFilename(['QWEN.md', 'AGENTS.md']);
    }
  });

  it('matches self-modification surfaces in custom QWEN_HOME', () => {
    const originalQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = '/tmp/custom-qwen-home';

    try {
      const protectedPaths = [
        '/tmp/custom-qwen-home/settings.json',
        '/tmp/custom-qwen-home/settings.local.json',
        '/tmp/custom-qwen-home/QWEN.local.md',
        '/tmp/custom-qwen-home/commands/review.md',
        '/tmp/custom-qwen-home/agents/reviewer.md',
        '/tmp/custom-qwen-home/skills/review/SKILL.md',
        '/tmp/custom-qwen-home/hooks/pre-tool-use.json',
        '/tmp/custom-qwen-home/rules/backend.md',
        '/tmp/custom-qwen-home/.mcp.json',
      ];

      for (const filePath of protectedPaths) {
        expect(isAutoModeProtectedWritePath(filePath)).toBe(true);
      }
    } finally {
      if (originalQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = originalQwenHome;
      }
    }
  });

  it('matches real paths under a symlinked custom QWEN_HOME', () => {
    const originalQwenHome = process.env['QWEN_HOME'];
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-home-'));

    try {
      const realHome = path.join(tmpRoot, 'real-home');
      const linkedHome = path.join(tmpRoot, 'linked-home');
      fs.mkdirSync(realHome, { recursive: true });
      fs.symlinkSync(realHome, linkedHome);
      process.env['QWEN_HOME'] = linkedHome;

      const settingsPath = path.join(realHome, 'settings.json');
      fs.writeFileSync(settingsPath, '{}');

      expect(isAutoModeProtectedWritePath(settingsPath)).toBe(true);
    } finally {
      if (originalQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = originalQwenHome;
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('re-resolves write paths after symlinks are created', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-write-path-'));

    try {
      const protectedDir = path.join(tmpRoot, '.qwen');
      const settingsPath = path.join(protectedDir, 'settings.json');
      const linkPath = path.join(tmpRoot, 'scratch');
      fs.mkdirSync(protectedDir, { recursive: true });
      fs.writeFileSync(settingsPath, '{}');

      expect(isAutoModeProtectedWritePath(linkPath)).toBe(false);

      fs.symlinkSync(settingsPath, linkPath);

      expect(isAutoModeProtectedWritePath(linkPath)).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('caches normalized QWEN_HOME prefixes per configured home', () => {
    const originalQwenHome = process.env['QWEN_HOME'];
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-home-cache-'));
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
      if (originalQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = originalQwenHome;
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('passesAcceptEditsFastPath', () => {
  const cwd = '/Users/test/project';
  const config = makeConfig([cwd]);

  it('allows EDIT targeting a path inside cwd', () => {
    expect(
      passesAcceptEditsFastPath(
        ctx({ toolName: ToolNames.EDIT, filePath: `${cwd}/src/foo.ts` }),
        config,
      ),
    ).toBe(true);
  });

  it('allows WRITE_FILE targeting a path inside cwd', () => {
    expect(
      passesAcceptEditsFastPath(
        ctx({ toolName: ToolNames.WRITE_FILE, filePath: `${cwd}/x.ts` }),
        config,
      ),
    ).toBe(true);
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
      `${cwd}/.qwen/QWEN.local.md`,
      `${cwd}/.qwen/rules/backend.md`,
      `${cwd}/.mcp.json`,
    ];

    for (const filePath of protectedPaths) {
      expect(
        passesAcceptEditsFastPath(
          ctx({ toolName: ToolNames.WRITE_FILE, filePath }),
          config,
        ),
      ).toBe(false);
    }
  });

  it('allows ordinary files under .qwen/worktrees but rejects nested config surfaces', () => {
    expect(
      passesAcceptEditsFastPath(
        ctx({
          toolName: ToolNames.WRITE_FILE,
          filePath: `${cwd}/.qwen/worktrees/feature/src/index.ts`,
        }),
        config,
      ),
    ).toBe(true);

    expect(
      passesAcceptEditsFastPath(
        ctx({
          toolName: ToolNames.WRITE_FILE,
          filePath: `${cwd}/.qwen/worktrees/feature/.qwen/settings.json`,
        }),
        config,
      ),
    ).toBe(false);
  });

  it('rejects symlinks that resolve to protected self-modification paths', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-auto-mode-'));
    try {
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

      expect(
        passesAcceptEditsFastPath(
          ctx({ toolName: ToolNames.WRITE_FILE, filePath: link }),
          cfg,
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects EDIT targeting a path outside the workspace', () => {
    expect(
      passesAcceptEditsFastPath(
        ctx({
          toolName: ToolNames.EDIT,
          filePath: '/Users/test/other-project/x.ts',
        }),
        config,
      ),
    ).toBe(false);
  });

  it('rejects WRITE_FILE targeting /etc/hosts', () => {
    expect(
      passesAcceptEditsFastPath(
        ctx({ toolName: ToolNames.WRITE_FILE, filePath: '/etc/hosts' }),
        config,
      ),
    ).toBe(false);
  });

  it('rejects when filePath is missing', () => {
    expect(
      passesAcceptEditsFastPath(
        ctx({ toolName: ToolNames.EDIT, filePath: undefined }),
        config,
      ),
    ).toBe(false);
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
    expect(
      passesAcceptEditsFastPath(
        ctx({ toolName: ToolNames.READ_FILE, filePath: `${cwd}/x.ts` }),
        config,
      ),
    ).toBe(false);
  });

  it('respects additional workspace roots', () => {
    const cfg = makeConfig([cwd, '/Users/test/extra-dir']);
    expect(
      passesAcceptEditsFastPath(
        ctx({
          toolName: ToolNames.EDIT,
          filePath: '/Users/test/extra-dir/sub/file.ts',
        }),
        cfg,
      ),
    ).toBe(true);
  });

  it('does not match prefix-collision paths (e.g. /project vs /project-other)', () => {
    expect(
      passesAcceptEditsFastPath(
        ctx({
          toolName: ToolNames.EDIT,
          filePath: '/Users/test/project-other/x.ts',
        }),
        config,
      ),
    ).toBe(false);
  });

  it('calls workspace context isPathWithinWorkspace for the actual path check', () => {
    const fn = vi.fn(() => true);
    const cfg = {
      getWorkspaceContext: () => ({ isPathWithinWorkspace: fn }),
    } as unknown as Config;
    passesAcceptEditsFastPath(
      ctx({ toolName: ToolNames.EDIT, filePath: '/some/path/x.ts' }),
      cfg,
    );
    expect(fn).toHaveBeenCalledWith('/some/path/x.ts');
  });
});

describe('shouldForceAutoModeReviewForAllow', () => {
  it('returns true for Edit/Write targeting protected self-modification paths', () => {
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.EDIT,
          filePath: '/Users/test/.qwen/settings.json',
        }),
      ),
    ).toBe(true);

    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.WRITE_FILE,
          filePath: '/repo/.qwen/QWEN.local.md',
        }),
      ),
    ).toBe(true);

    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.NOTEBOOK_EDIT,
          filePath: '/repo/.qwen/skills/review/demo.ipynb',
        }),
      ),
    ).toBe(true);
  });

  it('returns true for shell-like commands writing protected paths', () => {
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: 'echo "{}" > .qwen/settings.json',
          cwd: '/repo',
        }),
      ),
    ).toBe(true);

    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.MONITOR,
          command: 'bash -lc \'echo "{}" > .qwen/settings.json\'',
          cwd: '/repo',
        }),
      ),
    ).toBe(true);
  });

  it('returns true for nested wrappers writing protected paths after `cd`', () => {
    // Regression guard: without `extractShellOperationsAcrossCommand` doing
    // cross-segment cd tracking AND recursive wrapper unwrapping, this
    // exact payload would slip past AUTO force-review. A user
    // `permissions.allow: ["Bash(*)"]` rule plus this command would have
    // silently overwritten settings.json.
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: "cd .qwen && bash -lc 'echo {} > settings.json'",
          cwd: '/repo',
        }),
      ),
    ).toBe(true);
  });

  it('returns true for relative writes after an unresolved dynamic `cd`', () => {
    // If cwd is dynamic, the apparent resolved path is only a guess. Route
    // back to the classifier so an allow rule cannot hide writes like
    // `cd "$QWEN_HOME" && echo > settings.json`.
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: 'cd "$QWEN_HOME" && echo "{}" > settings.json',
          cwd: '/repo',
        }),
      ),
    ).toBe(true);
  });

  it('returns false for ordinary writes after `cd` into project subdirs', () => {
    // Counter-case for the cd-tracking check above: cd-into-src + write a
    // generated file should NOT force AUTO review. Otherwise every
    // workspace-internal compound shell command would round-trip through
    // the classifier and dilute the policy boundary's signal.
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: "cd src && bash -lc 'echo ok > generated.txt'",
          cwd: '/repo',
        }),
      ),
    ).toBe(false);
  });

  it('returns true for shell-like commands writing protected paths after cd', () => {
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: 'cd .qwen && echo "{}" > settings.json',
          cwd: '/repo',
        }),
      ),
    ).toBe(true);

    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.MONITOR,
          command: 'bash -lc \'cd .qwen && echo "{}" > settings.json\'',
          cwd: '/repo',
        }),
      ),
    ).toBe(true);
  });

  it('returns true for protected writes in sibling segments after shell wrappers', () => {
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: "bash -lc 'echo ok' && echo hi > .qwen/settings.json",
          cwd: '/repo',
        }),
      ),
    ).toBe(true);
  });

  it('returns true for newline-separated protected shell writes after cd', () => {
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: 'cd .qwen\ncp /tmp/malicious settings.json',
          cwd: '/repo',
        }),
      ),
    ).toBe(true);
  });

  it('returns true for grouped and metacharacter-suffixed protected writes', () => {
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: "{ cd .qwen && echo '{}' > settings.json; }",
          cwd: '/repo',
        }),
      ),
    ).toBe(true);

    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: '(echo > .qwen/settings.json)',
          cwd: '/repo',
        }),
      ),
    ).toBe(true);
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
    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({ toolName: ToolNames.EDIT, filePath: '/repo/src/index.ts' }),
      ),
    ).toBe(false);

    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.READ_FILE,
          filePath: '/repo/.qwen/settings.json',
        }),
      ),
    ).toBe(false);

    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: 'echo "ok" > src/output.txt',
          cwd: '/repo',
        }),
      ),
    ).toBe(false);

    expect(
      shouldForceAutoModeReviewForAllow(
        ctx({
          toolName: ToolNames.SHELL,
          command: 'cd src && echo "ok" > output.txt',
          cwd: '/repo',
        }),
      ),
    ).toBe(false);
  });
});

// ─── evaluateAutoMode gating ─────────────────────────────────────────────

describe('evaluateAutoMode — fast-path gating', () => {
  const cwd = '/Users/test/project';
  const baseConfig = makeConfig([cwd]);

  it('fires L5.1 acceptEdits fast-path when pmForcedAsk=false', async () => {
    const decision = await evaluateAutoMode({
      ctx: { toolName: ToolNames.EDIT, filePath: `${cwd}/src/x.ts` },
      pmForcedAsk: false,
      toolParams: {},
      messages: [],
      config: baseConfig,
      signal: new AbortController().signal,
    });
    expect(decision.via).toBe('fast-path:accept-edits');
  });

  it('fires L5.2 allowlist fast-path when pmForcedAsk=false', async () => {
    const decision = await evaluateAutoMode({
      ctx: { toolName: ToolNames.READ_FILE, filePath: '/anywhere/x.ts' },
      pmForcedAsk: false,
      toolParams: {},
      messages: [],
      config: baseConfig,
      signal: new AbortController().signal,
    });
    expect(decision.via).toBe('fast-path:allowlist');
  });

  it('routes to manual fallback (skipping classifier) when pmForcedAsk=true', async () => {
    // User wrote an explicit ask rule — fast-paths AND classifier must be
    // skipped. The PR auto-mode.md doc states "ask rules force manual
    // confirmation"; without this leg, the classifier could approve and
    // silently override the user's explicit intent.
    const decision = await evaluateAutoMode({
      ctx: { toolName: ToolNames.EDIT, filePath: `${cwd}/src/x.ts` },
      pmForcedAsk: true,
      toolParams: {},
      messages: [],
      config: baseConfig,
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ via: 'fallback', reason: 'ask_rule' });
  });

  it('routes to fallback with the denialTracking reason when armed', async () => {
    // Regression guard: when denialTracking has already armed a fallback
    // (3 consecutive blocks / 2 consecutive unavailables), the scheduler
    // passes the specific reason so the in-progress call drops to manual
    // approval without burning another classifier request. Fast paths still
    // fire — only the classifier dispatch is suppressed. Tool here is SHELL
    // (not on the allowlist, not an edit), so neither fast-path applies;
    // without skipClassifierReason this would dispatch the classifier.
    const decision = await evaluateAutoMode({
      ctx: { toolName: ToolNames.SHELL, command: 'rm -rf /' },
      pmForcedAsk: false,
      toolParams: {},
      messages: [],
      config: baseConfig,
      signal: new AbortController().signal,
      skipClassifierReason: 'total_denial',
    });
    expect(decision).toEqual({ via: 'fallback', reason: 'total_denial' });
  });
});

// ─── applyAutoModeDecision reason mapping ────────────────────────────────

describe('applyAutoModeDecision — blocked reason mapping', () => {
  const denialState = {
    consecutiveBlock: 0,
    consecutiveUnavailable: 0,
    totalBlock: 0,
    totalUnavailable: 0,
  };

  it('maps classifier policy blocks to classifier_blocked', () => {
    const setAutoModeDenialState = vi.fn();
    const result = applyAutoModeDecision(
      {
        via: 'classifier',
        shouldBlock: true,
        reason: 'unsafe command',
        unavailable: false,
        stage: 'fast',
        durationMs: 10,
      },
      { setAutoModeDenialState } as unknown as Config,
      denialState,
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'classifier_blocked',
    });
    expect(setAutoModeDenialState).toHaveBeenCalledWith({
      consecutiveBlock: 1,
      consecutiveUnavailable: 0,
      totalBlock: 1,
      totalUnavailable: 0,
    });
  });

  it('maps classifier infrastructure failures to classifier_unavailable', () => {
    const setAutoModeDenialState = vi.fn();
    const result = applyAutoModeDecision(
      {
        via: 'classifier',
        shouldBlock: true,
        reason: 'timeout',
        unavailable: true,
        stage: 'thinking',
        durationMs: 10,
      },
      { setAutoModeDenialState } as unknown as Config,
      denialState,
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'classifier_unavailable',
    });
    expect(setAutoModeDenialState).toHaveBeenCalledWith({
      consecutiveBlock: 0,
      consecutiveUnavailable: 1,
      totalBlock: 0,
      totalUnavailable: 1,
    });
  });

  it('allows classifier approvals and resets consecutive counters', () => {
    const setAutoModeDenialState = vi.fn();
    const result = applyAutoModeDecision(
      {
        via: 'classifier',
        shouldBlock: false,
        reason: 'safe command',
        unavailable: false,
        stage: 'fast',
        durationMs: 10,
      },
      { setAutoModeDenialState } as unknown as Config,
      {
        consecutiveBlock: 1,
        consecutiveUnavailable: 2,
        totalBlock: 3,
        totalUnavailable: 4,
      },
    );

    expect(result).toEqual({ kind: 'approved' });
    expect(setAutoModeDenialState).toHaveBeenCalledWith({
      consecutiveBlock: 0,
      consecutiveUnavailable: 0,
      totalBlock: 3,
      totalUnavailable: 4,
    });
  });

  it('passes through fallback reason without mutating denial state', () => {
    const setAutoModeDenialState = vi.fn();
    const result = applyAutoModeDecision(
      { via: 'fallback', reason: 'consecutive_block' },
      { setAutoModeDenialState } as unknown as Config,
      denialState,
    );

    expect(result).toEqual({ kind: 'fallback', reason: 'consecutive_block' });
    expect(setAutoModeDenialState).not.toHaveBeenCalled();
  });
});

// ─── formatClassifierBlockMessage ────────────────────────────────────────

describe('formatClassifierBlockMessage', () => {
  // Shared between coreToolScheduler.ts and acp-integration/session/
  // Session.ts. Drift between the two used to give CLI vs ACP users
  // different diagnostics for the same failure — guard it once.
  const baseDecision = {
    via: 'classifier' as const,
    shouldBlock: true,
    stage: 'thinking' as const,
    durationMs: 100,
  };

  it('renders a policy-block message including the reason', () => {
    expect(
      formatClassifierBlockMessage({
        ...baseDecision,
        reason: 'Irreversible filesystem destruction',
        unavailable: false,
      }),
    ).toBe(
      'Permission for this action has been denied. Reason: Irreversible filesystem destruction\nDo not try to complete the denied action through another tool, shell indirection, generated script, alias, symlink, config change, hook, command file, MCP configuration, encoded payload, or equivalent path. If that action is required, stop and ask the user for explicit approval. You may continue with unrelated safe work or a genuinely safer alternative that does not accomplish the denied action.',
    );
  });

  it('renders an unavailable message with cause when reason is present', () => {
    expect(
      formatClassifierBlockMessage({
        ...baseDecision,
        reason: 'Conversation transcript exceeds classifier context window',
        unavailable: true,
      }),
    ).toBe(
      'Auto mode classifier unavailable (Conversation transcript exceeds classifier context window); action blocked for safety\nDo not try to complete the denied action through another tool, shell indirection, generated script, alias, symlink, config change, hook, command file, MCP configuration, encoded payload, or equivalent path. If that action is required, stop and ask the user for explicit approval. You may continue with unrelated safe work or a genuinely safer alternative that does not accomplish the denied action.',
    );
  });

  it('falls back to a bare unavailable message when reason is empty', () => {
    expect(
      formatClassifierBlockMessage({
        ...baseDecision,
        reason: '',
        unavailable: true,
      }),
    ).toBe(
      'Auto mode classifier unavailable; action blocked for safety\nDo not try to complete the denied action through another tool, shell indirection, generated script, alias, symlink, config change, hook, command file, MCP configuration, encoded payload, or equivalent path. If that action is required, stop and ask the user for explicit approval. You may continue with unrelated safe work or a genuinely safer alternative that does not accomplish the denied action.',
    );
  });
});

// ─── PermissionDenied hook gating ────────────────────────────────────────

describe('PermissionDenied hook gating', () => {
  const classifierBlock = {
    via: 'classifier' as const,
    shouldBlock: true,
    reason: 'Dangerous shell command',
    unavailable: false,
    stage: 'fast' as const,
    durationMs: 20,
  };

  it('fires only for classifier blocks that produce a blocked outcome', () => {
    expect(
      shouldFirePermissionDeniedForAutoMode(classifierBlock, {
        kind: 'blocked',
        errorMessage: 'blocked',
        reason: 'classifier_blocked',
      }),
    ).toBe(true);

    expect(
      shouldFirePermissionDeniedForAutoMode(
        { ...classifierBlock, shouldBlock: false },
        { kind: 'approved' },
      ),
    ).toBe(false);

    expect(
      shouldFirePermissionDeniedForAutoMode(
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
  // Security-critical gate. Drift here would either silently skip AUTO
  // for tools that need it (false negative — bypass) or invoke the
  // classifier on tools that must always reach the user
  // (false positive — UX break for ask_user_question / exit_plan_mode).

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

  it('excludes ASK_USER_QUESTION even under AUTO — must always reach the user', () => {
    expect(
      shouldRunAutoModeForCall(ApprovalMode.AUTO, ToolNames.ASK_USER_QUESTION),
    ).toBe(false);
  });

  it('excludes EXIT_PLAN_MODE even under AUTO — plan exits are operator-driven', () => {
    expect(
      shouldRunAutoModeForCall(ApprovalMode.AUTO, ToolNames.EXIT_PLAN_MODE),
    ).toBe(false);
  });

  it('returns false for unknown tool names when not in AUTO', () => {
    expect(shouldRunAutoModeForCall(ApprovalMode.DEFAULT, 'unknown_tool')).toBe(
      false,
    );
  });
});
