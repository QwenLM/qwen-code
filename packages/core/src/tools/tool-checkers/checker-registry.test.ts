/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The table has to be complete: the module refuses any tool it has no check for,
 * so a tool missing from the registry cannot run. These tests are what makes
 * that failure loud at build time rather than at the user's first call.
 */

import { describe, expect, it } from 'vitest';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionRules,
  type ToolCheckContext,
} from '../../permissions/manager/decision/index.js';
import { createToolCheckerMap } from './checker-registry.js';
import {
  alwaysAllowChecker,
  askWithSelfAllowChecker,
} from './rule-precedence.js';
import {
  ALL_BUILTIN_TOOL_NAMES,
  VIDEO_GEN_TOOL_NAME,
  VIDEO_GEN_RETRIEVE_TOOL_NAME,
  IMAGE_SEARCH_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  SHELL_TOOL_NAME,
  MONITOR_TOOL_NAME,
} from '../tool-names.js';
import type { ToolPermissionReason } from './checker-reasons.js';

const deps = {
  skill: {
    isAllowedForMainSession: () => true,
    isDisabled: () => false,
    hasOnlySafeProperties: () => false,
  },
  mcpCall: {
    isKnownTool: () => true,
    parseQualifiedName: (name: string) => {
      const rest = name.slice('mcp__'.length);
      const sep = rest.indexOf('__');
      return sep < 0
        ? {}
        : { serverName: rest.slice(0, sep), toolName: rest.slice(sep + 2) };
    },
  },
};

function emptyRules(): PermissionRules {
  return { allow: {}, deny: {}, ask: {} };
}

function contextFor(toolName: string): ToolCheckContext<ToolPermissionReason> {
  const rules = emptyRules();
  return {
    mode: PermissionModes.Default,
    rules,
    cwd: '/repo',
    additionalDirectories: [],
    rulesForTool: rulesForToolName(rules, toolName),
    toolUseId: 'tu-1',
  };
}

describe('injected registry paths', () => {
  it('uses internal paths already supplied in the tool check context', async () => {
    const map = createToolCheckerMap({
      ...deps,
      internalPaths: { resolve: () => ({ projectStorageDir: '/configured/storage' }) },
    }, new Map());
    for (const name of [
      READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME, EDIT_TOOL_NAME,
      NOTEBOOK_EDIT_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME,
      SHELL_TOOL_NAME, MONITOR_TOOL_NAME,
    ]) {
      const ctx: ToolCheckContext<ToolPermissionReason> = {
        ...contextFor(name),
        internalPaths: { projectStorageDir: '/provided/storage' },
      };
      expect((await map.get(name)!.check({
        file_path: '/provided/storage/file.txt',
        path: '/provided/storage',
        notebook_path: '/provided/storage/file.ipynb',
        pattern: '*',
        command: 'cat /provided/storage/file.txt',
      }, ctx)).kind).toBe('allow');
    }
  });

  it('resolves paths for each cwd and preserves edit-implies-read', async () => {
    const map = createToolCheckerMap(
      {
        ...deps,
        internalPaths: {
          resolve: ({ cwd }: { cwd: string }) => ({
            projectStorageDir: '/runtime' + cwd,
          }),
        },
      },
      new Map(),
    );
    for (const cwd of ['/one', '/two']) {
      for (const name of [
        READ_FILE_TOOL_NAME,
        WRITE_FILE_TOOL_NAME,
        EDIT_TOOL_NAME,
        NOTEBOOK_EDIT_TOOL_NAME,
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
      ]) {
        const result = await map
          .get(name)!
          .check(
            {
              file_path: '/runtime' + cwd + '/memory.txt',
              path: '/runtime' + cwd,
              notebook_path: '/runtime' + cwd + '/notebook.ipynb',
              pattern: '*',
            },
            { ...contextFor(name), cwd },
          );
        expect(result.kind).toBe('allow');
      }
    }
    const wrong = await map
      .get(READ_FILE_TOOL_NAME)!
      .check(
        { file_path: '/runtime/one/memory.txt' },
        { ...contextFor(READ_FILE_TOOL_NAME), cwd: '/two' },
      );
    expect(wrong.kind).toBe('ask');
  });
});

describe('command checker injected paths', () => {
  it('passes injected paths through shell and monitor read constraints', async () => {
    const map = createToolCheckerMap(
      {
        ...deps,
        internalPaths: {
          resolve: () => ({ projectStorageDir: '/runtime/storage' }),
        },
      },
      new Map(),
    );
    for (const name of [SHELL_TOOL_NAME, MONITOR_TOOL_NAME]) {
      expect(
        (
          await map
            .get(name)!
            .check(
              { command: 'cat /runtime/storage/file.txt' },
              contextFor(name),
            )
        ).kind,
      ).toBe('allow');
    }
  });
});

describe('tool checker registry', () => {
  const map = createToolCheckerMap(deps);

  it('covers core built-ins while video checkers are supplied by the product plugin', () => {
    const missing = ALL_BUILTIN_TOOL_NAMES.filter((name) => !map.has(name));
    expect(missing).toEqual([VIDEO_GEN_TOOL_NAME, VIDEO_GEN_RETRIEVE_TOOL_NAME]);
  });

  it('registers only built-ins and the tools that are added conditionally', () => {
    // Not in ALL_BUILTIN_TOOL_NAMES because they appear only in some sessions:
    // the codebase investigator when enabled, the lazy MCP meta tools when a
    // server is configured, and StructuredOutput, injected only into workflow
    // and hook agents. They are still real tools and still need a check.
    const conditional = new Set([
      'CodebaseInvestigator',
      'mcp_call',
      'mcp_list',
      'mcp_get',
      'StructuredOutput',
      'CodeMode',
      'CodeModeWait',
    ]);
    const known = new Set<string>([...ALL_BUILTIN_TOOL_NAMES, ...conditional]);
    const unexpected = [...map.keys()].filter((name) => !known.has(name));
    expect(unexpected).toEqual([]);
  });

  it('lets the lazy discovery helpers run without a prompt', async () => {
    // mcp_list and mcp_get only describe what is connected; refusing them
    // would make lazy MCP unusable before the first dispatch could even be
    // asked about.
    for (const name of ['mcp_list', 'mcp_get']) {
      const result = await map.get(name)!.check({}, contextFor(name));
      expect(result.kind).toBe('allow');
    }
  });

  it('authorizes only the CodeMode VM by default and respects explicit ask and deny', async () => {
    const checker = map.get('CodeMode')!;
    expect((await checker.check({}, contextFor('CodeMode'))).kind).toBe(
      'allow',
    );
    for (const kind of ['ask', 'deny'] as const) {
      const rules = emptyRules();
      rules[kind] = { userSettings: ['CodeMode'] };
      expect(
        (
          await checker.check(
            {},
            {
              ...contextFor('CodeMode'),
              rules,
              rulesForTool: rulesForToolName(rules, 'CodeMode'),
            },
          )
        ).kind,
      ).toBe(kind);
    }
  });

  it('gives every registered tool a verdict on empty input and empty rules', async () => {
    for (const [name, checker] of map) {
      const result = await checker.check({}, contextFor(name));
      expect(['allow', 'ask', 'deny']).toContain(result.kind);
    }
  });

  it('lets a deny rule stop even the tools that exist to ask', async () => {
    const rules: PermissionRules = {
      allow: {},
      ask: {},
      deny: { policySettings: ['AskUserQuestion'] },
    };
    const checker = map.get('AskUserQuestion');
    const result = await checker!.check(
      {},
      {
        ...contextFor('AskUserQuestion'),
        rules,
        rulesForTool: rulesForToolName(rules, 'AskUserQuestion'),
      },
    );
    expect(result.kind).toBe('deny');
  });

  it('does not let an allow rule skip a prompt that is the feature', async () => {
    const rules: PermissionRules = {
      allow: { userSettings: ['AskUserQuestion'] },
      ask: {},
      deny: {},
    };
    const checker = map.get('AskUserQuestion');
    const result = await checker!.check(
      {},
      {
        ...contextFor('AskUserQuestion'),
        rules,
        rulesForTool: rulesForToolName(rules, 'AskUserQuestion'),
      },
    );
    expect(result.kind).toBe('ask');
  });

  it('wraps a plugin allow policy with the host permission rules', async () => {
    const toolName = 'ProductLookup';
    const pluginMap = createToolCheckerMap(
      deps,
      new Map([
        [
          toolName,
          alwaysAllowChecker(toolName, 'product_lookup.default.allow'),
        ],
      ]),
    );

    const allowed = await pluginMap
      .get(toolName)!
      .check({}, contextFor(toolName));
    expect(allowed).toMatchObject({
      kind: 'allow',
      extra: { decisionPoint: 'product_lookup.default.allow' },
    });

    const rules: PermissionRules = {
      allow: {},
      ask: {},
      deny: { policySettings: [toolName] },
    };
    const denied = await pluginMap.get(toolName)!.check(
      {},
      {
        ...contextFor(toolName),
        rules,
        rulesForTool: rulesForToolName(rules, toolName),
      },
    );
    expect(denied.kind).toBe('deny');
  });

  it('turns a plugin ask policy into the standard rememberable prompt', async () => {
    const toolName = 'ProductMutation';
    const pluginMap = createToolCheckerMap(
      deps,
      new Map([
        [
          toolName,
          askWithSelfAllowChecker(
            toolName,
            'Run the product mutation?',
            'product_mutation.no_rule.ask',
          ),
        ],
      ]),
    );

    const result = await pluginMap
      .get(toolName)!
      .check({}, contextFor(toolName));
    expect(result).toMatchObject({
      kind: 'ask',
      reason: {
        message: 'Run the product mutation?',
        decisionPoint: 'product_mutation.no_rule.ask',
      },
      suggestions: [
        expect.objectContaining({
          behavior: 'allow',
          rules: [{ toolName }],
        }),
      ],
    });
  });

  it('lets a product plugin override the legacy checker for a migrated tool', async () => {
    const pluginMap = createToolCheckerMap(
      deps,
      new Map([
        [
          IMAGE_SEARCH_TOOL_NAME,
          alwaysAllowChecker(
            IMAGE_SEARCH_TOOL_NAME,
            'plugin_image_search.default.allow',
          ),
        ],
      ]),
    );

    const result = await pluginMap
      .get(IMAGE_SEARCH_TOOL_NAME)!
      .check({}, contextFor(IMAGE_SEARCH_TOOL_NAME));

    expect(result).toMatchObject({
      kind: 'allow',
      extra: { decisionPoint: 'plugin_image_search.default.allow' },
    });
  });
});
