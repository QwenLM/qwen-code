/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import {
  SAFE_TOOL_ALLOWLIST,
  evaluateAutoMode,
  isInSafeToolAllowlist,
  passesAcceptEditsFastPath,
} from './autoMode.js';
import { ToolNames } from '../tools/tool-names.js';
import type { Config } from '../config/config.js';
import type { PermissionCheckContext } from './types.js';

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
      ToolNames.SEND_MESSAGE,
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
        "send_message",
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
      isPathWithinWorkspace: (p: string) =>
        workspaceRoots.some(
          (root) => p === root || p.startsWith(root + path.sep),
        ),
    }),
  } as unknown as Config;
}

function ctx(over: Partial<PermissionCheckContext>): PermissionCheckContext {
  return {
    toolName: ToolNames.EDIT,
    ...over,
  };
}

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

  it('skips fast-paths and routes to classifier when pmForcedAsk=true', async () => {
    // User wrote an explicit ask rule for Edit — fast-path must NOT auto-allow.
    // We can't actually call the classifier here (no LLM), so we provide a
    // config that throws when sideQuery is invoked — proving control reached
    // L5.3 dispatch.
    const cfg = {
      ...(baseConfig as unknown as Record<string, unknown>),
      getFastModel: () => undefined,
      getModel: () => 'pretend-model',
      getAutoModeSettings: () => ({}),
      getToolRegistry: () => ({ getTool: () => undefined }),
    } as unknown as Config;
    const ac = new AbortController();
    ac.abort();
    await expect(
      evaluateAutoMode({
        ctx: { toolName: ToolNames.EDIT, filePath: `${cwd}/src/x.ts` },
        pmForcedAsk: true,
        toolParams: {},
        messages: [],
        config: cfg,
        signal: ac.signal,
      }),
    ).rejects.toBeDefined();
  });
});
