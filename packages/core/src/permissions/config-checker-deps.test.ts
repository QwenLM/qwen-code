/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { PermissionManager } from './manager/permission-manager.js';
import { LlmAutoJudge } from './permission-modes/auto/auto-judge.js';
import { createEmptyToolLookup } from './permission-modes/auto/classifier.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import { AutoClassifier } from './permission-modes/auto/auto-classifier.js';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionRules,
  type ToolCheckContext,
} from './manager/decision/index.js';
import { runWithCwdOverride } from '../utils/Shell.js';
import type { Config } from '../config/config.js';
import {
  createCheckerDepsForConfig,
  createEagerMcpToolChecker,
} from './config-checker-deps.js';
import type { ToolPermissionReason } from '../tools/tool-checkers/checker-reasons.js';
import { buildMcpToolName } from '../mcp/tools/mcp-tool.js';
import { normalizeMcpSegment } from '../mcp/tools/mcp-names.js';
import { createMcpCallToolChecker } from '../tools/tool-checkers/checkers/mcp-call-checker.js';
import { permissionRulesFromStartup } from './settings/startup-rules.js';
import { settingsJsonToRules } from './settings/permissionsLoader.js';

/** The minimum of Config the checker deps read. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    permission: { autoClassifier: new AutoClassifier() },
    getSkillManager: () =>
      ({
        isSkillAllowedForMainSession: () => true,
        getSkill: () => undefined,
      }) as never,
    getMcpClientManager: () => undefined,
    getConversationMessages: () => [],
    getToolRegistry: () =>
      ({
        hasToolEnabled: () => false,
        getTool: () => undefined,
      }) as never,
    ...overrides,
  } as unknown as Config;
}

function contextFor(
  toolName: string,
  rules: PermissionRules,
): ToolCheckContext<ToolPermissionReason> {
  return {
    mode: PermissionModes.Default,
    rules,
    cwd: '/repo',
    additionalDirectories: [],
    rulesForTool: rulesForToolName(rules, toolName),
    toolUseId: 'tu-1',
  };
}

describe('createCheckerDepsForConfig mcpCall.isKnownTool', () => {
  it('answers from the MCP manager lazy discovery index, not the tool registry', () => {
    // Lazy mode unregisters the qualified tools after locking, so the registry
    // answers "unknown" for every tool the dispatcher can dispatch. The
    // manager's lazy discovery index keeps existing regardless of registration,
    // and mirrors the view the dispatcher's execute reads.
    const config = makeConfig({
      getMcpClientManager: (() => ({
        getLazyDiscoveredMcpToolByQualifiedName: vi.fn((name: string) =>
          name === 'mcp__srv__tool' ? {} : undefined,
        ),
      })) as never,
      getToolRegistry: (() => ({
        hasToolEnabled: vi.fn().mockReturnValue(false),
        getTool: () => undefined,
      })) as never,
    });

    const deps = createCheckerDepsForConfig(config);
    const ctx = contextFor('mcp_call', { allow: {}, ask: {}, deny: {} });
    expect(deps.mcpCall.isKnownTool('mcp__srv__tool', ctx)).toBe(true);
    expect(deps.mcpCall.isKnownTool('mcp__other__tool', ctx)).toBe(false);
  });

  it('answers false when no MCP client manager exists', () => {
    const deps = createCheckerDepsForConfig(makeConfig());
    const ctx = contextFor('mcp_call', { allow: {}, ask: {}, deny: {} });
    expect(deps.mcpCall.isKnownTool('mcp__srv__tool', ctx)).toBe(false);
  });
});

describe('createEagerMcpToolChecker', () => {
  const identity = { serverName: 'srv', toolName: 'tool' };
  const FQN = 'mcp__srv__tool';

  function check(rules: PermissionRules) {
    const checker = createEagerMcpToolChecker(identity);
    return checker.check({}, contextFor(FQN, rules));
  }

  it('asks with this-tool and whole-server suggestions when no rule covers it', async () => {
    const result = await check({ allow: {}, ask: {}, deny: {} });
    expect(result.kind).toBe('ask');
    if (result.kind !== 'ask') return;
    expect(
      result.suggestions?.map((s) =>
        s.type === 'addRules' ? s.rules[0].toolName : undefined,
      ),
    ).toEqual([FQN, 'mcp__srv__*']);
  });

  it('honours a server-wildcard allow rule under the qualified name', async () => {
    const result = await check({
      allow: { session: ['mcp__srv__*'] },
      ask: {},
      deny: {},
    });
    expect(result.kind).toBe('allow');
  });

  it('lets a tool-level deny rule settle before the MCP check', async () => {
    const result = await check({
      allow: { session: ['mcp__srv__*'] },
      ask: {},
      deny: { userSettings: [FQN] },
    });
    expect(result.kind).toBe('deny');
  });
});

describe('search CWD dependency', () => {
  it('reads the session and agent CWD without moving the project root', () => {
    const config = makeConfig({
      getTargetDir: () => '/repo',
      isParallelToolStreamingEnabled: () => false,
    });
    const deps = createCheckerDepsForConfig(config);
    runWithCwdOverride('/repo/src', () => {
      expect(deps.getSearchCwd?.()).toBe('/repo/src');
      runWithCwdOverride('/worktree', () =>
        expect(deps.getSearchCwd?.()).toBe('/worktree'),
      );
      expect(deps.getSearchCwd?.()).toBe('/repo/src');
    });
  });
});

describe.each(['cmapi00074846', '中文转换服务'])(
  'Unicode MCP permissions on %s',
  (serverName) => {
    const query = '文档格式转换_查询';
    const submit = '文档格式转换_提交';
    const queryId = buildMcpToolName(serverName, query);
    const submitId = buildMcpToolName(serverName, submit);
    const config = makeConfig({
      getMcpClientManager: (() => ({
        getLazyDiscoveredMcpToolByQualifiedName: (name: string) =>
          [queryId, submitId].includes(name)
            ? { qualifiedName: name }
            : undefined,
      })) as never,
    });

    async function check(
      path: 'eager' | 'lazy',
      name: string,
      rules: PermissionRules,
    ) {
      const id = buildMcpToolName(serverName, name);
      const checker =
        path === 'eager'
          ? createEagerMcpToolChecker({ serverName, toolName: name })
          : createMcpCallToolChecker(
              createCheckerDepsForConfig(config).mcpCall,
            );
      return checker.check(
        path === 'eager' ? {} : { toolName: id },
        contextFor(path === 'eager' ? id : 'mcp_call', rules),
      );
    }

    it.each(['eager', 'lazy'] as const)(
      '%s grants only the configured Chinese tool',
      async (path) => {
        for (const rules of [
          permissionRulesFromStartup({
            mcpServerAlwaysAllow: { [serverName]: [query] },
          }),
          permissionRulesFromStartup({
            mcpServerAlwaysAllow: {
              [serverName]: [`mcp__${serverName}__${query}`],
            },
          }),
          permissionRulesFromStartup({
            allowedTools: [`mcp__${serverName}__${query}`],
          }),
          permissionRulesFromStartup({
            rulesFromSettings: settingsJsonToRules(
              { permissions: { allow: [`mcp__${serverName}__${query}`] } },
              'userSettings',
            ),
          }),
        ]) {
          expect((await check(path, query, rules)).kind).toBe('allow');
          expect((await check(path, submit, rules)).kind).toBe('ask');
        }
      },
    );

    it.each(['eager', 'lazy'] as const)(
      '%s honours a Chinese deny over a server allow',
      async (path) => {
        const rules = permissionRulesFromStartup({
          allowedTools: [`mcp__${serverName}__*`],
          disallowedTools: [`mcp__${serverName}__${submit}`],
        });
        expect((await check(path, query, rules)).kind).toBe('allow');
        expect((await check(path, submit, rules)).kind).toBe('deny');
      },
    );

    it.each(['eager', 'lazy'] as const)(
      '%s suggests reusable tool and server rules',
      async (path) => {
        const result = await check(path, query, {
          allow: {},
          deny: {},
          ask: {},
        });
        expect(result.kind).toBe('ask');
        if (result.kind !== 'ask') return;
        const suggestions = result.suggestions?.flatMap((s) =>
          s.type === 'addRules' ? s.rules.map((r) => r.toolName) : [],
        );
        expect(suggestions).toEqual([
          queryId,
          `mcp__${normalizeMcpSegment(serverName)}__*`,
        ]);
        expect(
          (
            await check(
              path,
              query,
              permissionRulesFromStartup({ allowedTools: [queryId] }),
            )
          ).kind,
        ).toBe('allow');
      },
    );
  },
);

describe('Permission Auto entry', () => {
  it('uses the same agent view for registered checkers and direct classification', async () => {
    class Classifier extends AutoClassifier {
      protected override readJevSettings() {
        return { classifier: 'llm' as const };
      }
    }
    class Manager extends PermissionManager {
      override initialize() {
        super.initialize();
        this.autoClassifier = new Classifier();
      }
    }
    const manager = new Manager();
    manager.initialize();
    const invoke = vi.fn(async () => ({
      shouldBlock: true,
      reason: 'blocked',
    }));
    const permission = manager.createSessionPermissionManager({
      getSessionId: () => 'adapter-session',
      getWorkingDir: () => '/repo',
      flagSettings: {
        initialMode: 'auto',
        rules: { allow: {}, deny: {}, ask: {} },
        additionalDirectories: [],
      },
      createSessionJudges: () => ({ llm: new LlmAutoJudge(invoke) }),
      classifierInputs: {
        getMessages: () => [],
        getToolLookup: () => createEmptyToolLookup(),
      },
    });
    const facts = { toolName: 'ReviewTool', coveredByAcceptEdits: false };
    const ctx = {
      ...contextFor('ReviewTool', { allow: {}, deny: {}, ask: {} }),
      mode: PermissionModes.Auto,
      agentId: 'child',
    };
    const ask = {
      kind: 'ask' as const,
      reason: {
        message: 'review',
        attribution: { type: 'other' as const, reason: 'review' },
      },
    };
    const messages = [createUserMessage('child-only')];
    manager.registerChecker('ReviewTool', { check: () => ask });
    permission.setAskHandler(async () => ({ kind: 'rejected' }));
    const approve = (agentId = 'child') =>
      permission.check(
        { toolName: 'ReviewTool', input: {}, toolUseId: 'review', agentId },
        { messages },
      );
    try {
      expect((await approve()).kind).toBe('deny');
      const view = permission.getAutoClassifier('child');
      expect(
        (
          await view.classify(
            facts,
            {},
            ctx,
            ask,
            messages,
            permission.getAutoSessionConfig(),
          )
        ).kind,
      ).toBe('deny');
      const third = await approve();
      expect(third.toolCheck.kind).toBe('ask');
      expect(third.toolCheck).toMatchObject({
        reason: { decisionPoint: 'mode.auto_denial_limit.keep_ask' },
      });
      expect(JSON.stringify(invoke.mock.calls)).toContain('child-only');
      expect((await approve('other')).kind).toBe('deny');
    } finally {
      await permission.dispose();
      manager.dispose();
    }
  });
});
