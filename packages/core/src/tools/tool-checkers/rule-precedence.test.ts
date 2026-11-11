/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { PermissionModes } from '../../permissions/manager/decision/index.js';
import type {
  PermissionRule,
  PermissionRules,
  ToolCheckContext,
} from '../../permissions/manager/decision/index.js';
import { rulesForToolName } from '../../permissions/manager/decision/index.js';
import {
  alwaysAllowChecker,
  checkToolLevelRules,
  firstRule,
  getReadProbeChecker,
  ruleText,
  withHookAsk,
  withReadProbe,
  withToolLevelRules,
  type HostToolChecker,
  type ToolPermissionResult,
} from './rule-precedence.js';
import { createMcpToolChecker } from './checkers/mcp-checker.js';
import { createMcpCallToolChecker } from './checkers/mcp-call-checker.js';
import type { ToolPermissionReason } from './checker-reasons.js';

function rules(overrides: Partial<PermissionRules> = {}): PermissionRules {
  return { allow: {}, deny: {}, ask: {}, ...overrides };
}

function contextFor(
  toolName: string,
  ruleSet: PermissionRules,
): ToolCheckContext<ToolPermissionReason> {
  return {
    mode: PermissionModes.Default,
    rules: ruleSet,
    cwd: '/repo',
    additionalDirectories: [],
    rulesForTool: rulesForToolName(ruleSet, toolName),
    toolUseId: 'tu-1',
  };
}

describe('ruleText', () => {
  it('renders tool-level and content-level rules as written', () => {
    const toolLevel: PermissionRule = {
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'Bash' },
    };
    const contentLevel: PermissionRule = {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash', ruleContent: 'git:*' },
    };
    expect(ruleText(toolLevel)).toBe('Bash');
    expect(ruleText(contentLevel)).toBe('Bash(git:*)');
  });
});

describe('firstRule', () => {
  it('is undefined for an empty bucket and finds the rule in any source', () => {
    expect(firstRule({})).toBeUndefined();
    const rule: PermissionRule = {
      source: 'localSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'Bash' },
    };
    expect(firstRule({ localSettings: [rule] })).toBe(rule);
  });
});

describe('checkToolLevelRules', () => {
  it('is undefined when no tool-level rule matches', () => {
    const ruleSet = rules({ allow: { userSettings: ['Bash(git:*)'] } });
    expect(
      checkToolLevelRules('Bash', rulesForToolName(ruleSet, 'Bash')),
    ).toBeUndefined();
  });

  it('denies first, and says which rule did it', () => {
    const ruleSet = rules({
      deny: { userSettings: ['Bash'] },
      ask: { userSettings: ['Bash'] },
      allow: { userSettings: ['Bash'] },
    });
    const result = checkToolLevelRules(
      'Bash',
      rulesForToolName(ruleSet, 'Bash'),
    );
    expect(result?.kind).toBe('deny');
    expect(result?.extra?.denialReason?.denialKind).toBe('permission-rule');
    expect(result?.extra?.denialReason?.attribution).toEqual({
      type: 'rule',
      rule: expect.objectContaining({ ruleBehavior: 'deny' }),
    });
  });

  it('asks when ask matches and deny does not', () => {
    const ruleSet = rules({
      ask: { projectSettings: ['Bash'] },
      allow: { userSettings: ['Bash'] },
    });
    const result = checkToolLevelRules(
      'Bash',
      rulesForToolName(ruleSet, 'Bash'),
    );
    expect(result?.kind).toBe('ask');
    if (result?.kind === 'ask') {
      expect(result.reason.message).toContain('Bash');
      expect(result.reason.attribution.type).toBe('rule');
    }
  });

  it('does not settle on an allow rule — the tool still judges its input', () => {
    const ruleSet = rules({ allow: { session: ['Bash'] } });
    expect(
      checkToolLevelRules('Bash', rulesForToolName(ruleSet, 'Bash')),
    ).toBeUndefined();
  });

  it('honours the wildcard rule', () => {
    const ruleSet = rules({ deny: { policySettings: ['*'] } });
    expect(
      checkToolLevelRules('Bash', rulesForToolName(ruleSet, 'Bash'))?.kind,
    ).toBe('deny');
  });
});

describe('withToolLevelRules', () => {
  const allowRule = rules({ allow: { userSettings: ['Bash'] } });

  const plainAsk: ToolPermissionResult = {
    kind: 'ask',
    reason: {
      message: 'Allow?',
      attribution: { type: 'other', reason: 'no rule covers this command' },
    },
  };

  function checkerReturning(result: ToolPermissionResult) {
    return { check: () => result };
  }

  it('passes one filtered rule set to tool-level and content-level checks in Auto', async () => {
    const ruleSet = rules({
      allow: { session: ['Bash', 'Bash(python:*)', 'Bash(npm test)'] },
      deny: { userSettings: ['Bash(rm:*)'] },
      ask: { userSettings: ['Bash(git push:*)'] },
    });
    const ctx = { ...contextFor('Bash', ruleSet), mode: PermissionModes.Auto };
    const check = vi.fn<HostToolChecker['check']>(() => ({
      ...plainAsk,
      extra: { fillableByAllow: true },
    }));
    const result = await withToolLevelRules('Bash', { check }).check({}, ctx);
    const filtered = check.mock.calls[0]![1];

    expect(result.kind).toBe('ask');
    expect(filtered.rules.allow.session).toEqual(['Bash(npm test)']);
    expect(firstRule(filtered.rulesForTool.toolLevel.allow)).toBeUndefined();
    expect(filtered.rulesForTool).toEqual(
      rulesForToolName(filtered.rules, 'Bash'),
    );
    expect(filtered.rules.deny).toBe(ruleSet.deny);
    expect(filtered.rules.ask).toBe(ruleSet.ask);
    expect(ctx.rules).toBe(ruleSet);
    expect(
      firstRule(ctx.rulesForTool.toolLevel.allow)?.ruleValue.toolName,
    ).toBe('Bash');
  });

  it('does not let a hook approval erase a safety objection in Auto', async () => {
    const objection: ToolPermissionResult = {
      kind: 'ask',
      reason: {
        message: 'Dangerous command.',
        attribution: { type: 'safetyCheck', reason: 'unsafe command' },
      },
    };
    const ctx = {
      ...contextFor('Bash', allowRule),
      mode: PermissionModes.Auto,
      preToolUseHookVerdict: { behavior: 'allow' as const },
    };
    expect(
      await withToolLevelRules('Bash', checkerReturning(objection)).check(
        {},
        ctx,
      ),
    ).toBe(objection);
  });

  it('preserves the check context when Auto has no dangerous grant', async () => {
    const ctx = {
      ...contextFor('Bash', rules({ allow: { session: ['Bash(npm test)'] } })),
      mode: PermissionModes.Auto,
    };
    const check = vi.fn<HostToolChecker['check']>(() => plainAsk);
    await withToolLevelRules('Bash', { check }).check({}, ctx);
    expect(check).toHaveBeenCalledWith({}, ctx);
    expect(check.mock.calls[0]?.[1]).toBe(ctx);
  });

  it("never lets an allow rule suppress the tool's own ask", async () => {
    // develop parity: a tool-level allow is a voucher only — collection
    // continues and any objection the self-check raises still stands.
    const wrapped = withToolLevelRules('Bash', checkerReturning(plainAsk));
    const result = await wrapped.check({}, contextFor('Bash', allowRule));
    expect(result.kind).toBe('ask');
  });

  it('does not let an allow rule erase a safety objection', async () => {
    const dangerous: ToolPermissionResult = {
      kind: 'ask',
      reason: {
        message: 'Dangerous command.',
        attribution: {
          type: 'safetyCheck',
          reason: 'rm -rf',
          classifierApprovable: false,
        },
      },
    };
    const wrapped = withToolLevelRules('Bash', checkerReturning(dangerous));
    const result = await wrapped.check({}, contextFor('Bash', allowRule));
    expect(result.kind).toBe('ask');
  });

  it("does not let an allow rule override the tool's own deny", async () => {
    // `allow: ["Bash"]` grants the tool, not every command: a content-level deny
    // like Bash(rm:*) is found by the tool's own check and still wins.
    const denied: ToolPermissionResult = {
      kind: 'deny',
      extra: { decisionPoint: 'shell.rule_prefix.deny' },
    };
    const wrapped = withToolLevelRules('Bash', checkerReturning(denied));
    const result = await wrapped.check({}, contextFor('Bash', allowRule));
    expect(result.kind).toBe('deny');
  });

  it('settles on a deny rule without running the tool check', async () => {
    const ranTool = vi.fn(() => plainAsk);
    const wrapped = withToolLevelRules('Bash', { check: ranTool });
    const ruleSet = rules({ deny: { userSettings: ['Bash'] } });
    const result = await wrapped.check({}, contextFor('Bash', ruleSet));
    expect(result.kind).toBe('deny');
    expect(ranTool).not.toHaveBeenCalled();
  });

  it('does not let a tool-level ask stop a content-level deny', async () => {
    // develop parity: an ask is recorded but collection continues, so a deny
    // the self-check finds (e.g. Bash(rm:*)) still outranks it.
    const denied: ToolPermissionResult = {
      kind: 'deny',
      extra: { decisionPoint: 'shell.rule_prefix.deny' },
    };
    const ranTool = vi.fn(() => denied);
    const wrapped = withToolLevelRules('Bash', { check: ranTool });
    const ruleSet = rules({ ask: { userSettings: ['Bash'] } });
    const result = await wrapped.check({}, contextFor('Bash', ruleSet));
    expect(result.kind).toBe('deny');
    expect(ranTool).toHaveBeenCalledTimes(1);
  });

  it('shows the rule ask when both the rule and the self-check ask', async () => {
    // First ask wins, as in the develop pipeline.
    const wrapped = withToolLevelRules('Bash', checkerReturning(plainAsk));
    const ruleSet = rules({ ask: { userSettings: ['Bash'] } });
    const result = await wrapped.check({}, contextFor('Bash', ruleSet));
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.attribution).toMatchObject({ type: 'rule' });
    }
  });

  it('shows the rule ask even when the self-check allows', async () => {
    // develop parity: `ask: ["Read"]` prompts every Read — a self-check that
    // merely allows is not an objection that may overrule the user's rule.
    const allowed: ToolPermissionResult = {
      kind: 'allow',
      extra: { decisionPoint: 'fs_read.working_dir.allow' },
    };
    const wrapped = withToolLevelRules('Read', checkerReturning(allowed));
    const ruleSet = rules({ ask: { userSettings: ['Read'] } });
    const result = await wrapped.check({}, contextFor('Read', ruleSet));
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.attribution).toMatchObject({ type: 'rule' });
    }
  });

  it('leaves an ask alone when no allow rule vouches', async () => {
    const wrapped = withToolLevelRules('Bash', checkerReturning(plainAsk));
    const result = await wrapped.check({}, contextFor('Bash', rules()));
    expect(result.kind).toBe('ask');
  });
});

describe('MCP checks', () => {
  const checker = createMcpToolChecker({
    serverName: 'files',
    toolName: 'read',
  });

  it('asks with a per-tool and a per-server suggestion when no rule applies', async () => {
    const result = await checker.check(
      {},
      contextFor('mcp__files__read', rules()),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.message).toBe('Allow MCP tool files/read?');
      expect(result.suggestions).toEqual([
        expect.objectContaining({
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'mcp__files__read' }],
        }),
        expect.objectContaining({
          rules: [{ toolName: 'mcp__files__*' }],
        }),
      ]);
    }
  });

  it('allows via an exact rule', async () => {
    const ruleSet = rules({ allow: { userSettings: ['mcp__files__read'] } });
    const result = await checker.check(
      {},
      contextFor('mcp__files__read', ruleSet),
    );
    expect(result.kind).toBe('allow');
  });

  it('allows via a server wildcard', async () => {
    const ruleSet = rules({ allow: { userSettings: ['mcp__files__*'] } });
    const result = await checker.check(
      {},
      contextFor('mcp__files__read', ruleSet),
    );
    expect(result.kind).toBe('allow');
  });

  it('denies via the global MCP wildcard, outranking an exact allow', async () => {
    const ruleSet = rules({
      deny: { policySettings: ['mcp__*'] },
      allow: { userSettings: ['mcp__files__read'] },
    });
    const result = await checker.check(
      {},
      contextFor('mcp__files__read', ruleSet),
    );
    expect(result.kind).toBe('deny');
  });

  it('judges under the qualified name even when called as another tool', async () => {
    // The lazy dispatcher is invoked as `mcp_call`, so filtering by the request's
    // tool name would hide every `mcp__*` rule.
    const ruleSet = rules({ deny: { userSettings: ['mcp__files__*'] } });
    const result = await checker.check({}, contextFor('mcp_call', ruleSet));
    expect(result.kind).toBe('deny');
  });
});

describe('alwaysAllowChecker', () => {
  it('marks the default allow with the generic decision point', async () => {
    const result = await alwaysAllowChecker('WriteTodos').check(
      {},
      contextFor('WriteTodos', rules()),
    );
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.extra?.decisionPoint).toBe('no_check.default.allow');
    }
  });

  it('stamps a tool-specific decision point when given one', async () => {
    const result = await alwaysAllowChecker(
      'BashOutput',
      'bash_pty.output.allow',
    ).check({}, contextFor('BashOutput', rules()));
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.extra?.decisionPoint).toBe('bash_pty.output.allow');
    }
  });

  it('still lets a tool-level deny rule win', async () => {
    const ruleSet = rules({ deny: { userSettings: ['WriteTodos'] } });
    const result = await alwaysAllowChecker('WriteTodos').check(
      {},
      contextFor('WriteTodos', ruleSet),
    );
    expect(result.kind).toBe('deny');
  });
});

describe('MCP dispatcher check', () => {
  const dispatcher = createMcpCallToolChecker({
    isKnownTool: (name: string) => name === 'mcp__files__read',
    parseQualifiedName: (name: string) =>
      name === 'mcp__files__read'
        ? { serverName: 'files', toolName: 'read' }
        : {},
  });

  it('resolves the target named in the input', async () => {
    const ruleSet = rules({ allow: { userSettings: ['mcp__files__read'] } });
    const result = await dispatcher.check(
      { toolName: 'mcp__files__read' },
      contextFor('mcp_call', ruleSet),
    );
    expect(result.kind).toBe('allow');
  });

  it('refuses a call that names no tool', async () => {
    const result = await dispatcher.check({}, contextFor('mcp_call', rules()));
    expect(result.kind).toBe('deny');
    expect(result.extra?.decisionPoint).toBe('mcp.no_identity.deny');
  });

  it('refuses a tool no connected server offers', async () => {
    const result = await dispatcher.check(
      { toolName: 'mcp__files__write' },
      contextFor('mcp_call', rules()),
    );
    expect(result.kind).toBe('deny');
    expect(result.extra?.decisionPoint).toBe('mcp.unknown_tool.deny');
  });
});

describe('withHookAsk', () => {
  function returning(result: ToolPermissionResult): HostToolChecker {
    return { check: () => result };
  }

  const allow: ToolPermissionResult = {
    kind: 'allow',
    extra: { decisionPoint: 'tool.allow' },
  };
  const deny: ToolPermissionResult = {
    kind: 'deny',
    extra: { decisionPoint: 'tool.deny' },
  };
  const plainAsk: ToolPermissionResult = {
    kind: 'ask',
    reason: {
      message: 'Allow?',
      attribution: { type: 'other', reason: 'no rule' },
      decisionPoint: 'tool.ask',
    },
  };

  function ctxWithHookAsk(): ToolCheckContext<ToolPermissionReason> {
    return {
      ...contextFor('Bash', rules()),
      preToolUseHookVerdict: { behavior: 'ask', message: 'Hook says ask' },
    };
  }

  it('demotes a final allow into the hook prompt', async () => {
    const result = await withHookAsk(returning(allow)).check(
      {},
      ctxWithHookAsk(),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.message).toBe('Hook says ask');
      expect(result.reason.attribution).toEqual({
        type: 'hook',
        hookName: 'PreToolUse',
      });
      expect(result.reason.decisionPoint).toBe('hook.pre_tool_use.ask');
    }
  });

  it('cannot turn a deny into a question', async () => {
    const result = await withHookAsk(returning(deny)).check(
      {},
      ctxWithHookAsk(),
    );
    expect(result).toEqual(deny);
  });

  it('makes the hook ask the standing ask over an existing checker ask', async () => {
    // develop parity: the hook verdict is recorded first, so its ask is the
    // one shown; the mode layer then resolves it like any other ask.
    const result = await withHookAsk(returning(plainAsk)).check(
      {},
      ctxWithHookAsk(),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.decisionPoint).toBe('hook.pre_tool_use.ask');
    }
  });

  it('stays inert when the hook said something else', async () => {
    const ctx = {
      ...contextFor('Bash', rules()),
      preToolUseHookVerdict: { behavior: 'allow' as const },
    };
    const result = await withHookAsk(returning(allow)).check({}, ctx);
    expect(result).toEqual(allow);
  });
});

describe('bypass-immune asks and the rule wrappers', () => {
  const catastrophic: ToolPermissionResult = {
    kind: 'ask',
    reason: {
      message: "Dangerous rm operation detected: '~'",
      attribution: {
        type: 'safetyCheck',
        reason: 'Dangerous rm operation on critical path: ~',
        safetyCheckKind: 'dangerousRemoval',
        bypassImmune: true,
      },
      decisionPoint: 'shell.dangerous_removal.ask',
    },
    suggestions: [],
  };
  const returning = (result: ToolPermissionResult): HostToolChecker => ({
    check: () => result,
  });

  it('a tool-level ask rule does not replace the catastrophic ask', async () => {
    const ctx = contextFor('Bash', rules({ ask: { userSettings: ['Bash'] } }));
    const result = await withToolLevelRules(
      'Bash',
      returning(catastrophic),
    ).check({ command: 'rm -rf ~' }, ctx);
    expect(result).toBe(catastrophic);
  });

  it('a tool-level allow rule does not fill the catastrophic ask', async () => {
    const ctx = contextFor(
      'Bash',
      rules({ allow: { userSettings: ['Bash'] } }),
    );
    const result = await withToolLevelRules(
      'Bash',
      returning(catastrophic),
    ).check({ command: 'rm -rf ~' }, ctx);
    expect(result).toBe(catastrophic);
  });

  it('a PreToolUse hook ask does not replace the catastrophic ask', async () => {
    const ctx: ToolCheckContext<ToolPermissionReason> = {
      ...contextFor('Bash', rules()),
      preToolUseHookVerdict: { behavior: 'ask', message: 'Hook says ask' },
    };
    const result = await withHookAsk(returning(catastrophic)).check(
      { command: 'rm -rf ~' },
      ctx,
    );
    expect(result).toBe(catastrophic);
  });

  it('a deny rule still wins over it', async () => {
    const ctx = contextFor('Bash', rules({ deny: { userSettings: ['Bash'] } }));
    const result = await withToolLevelRules(
      'Bash',
      returning(catastrophic),
    ).check({ command: 'rm -rf ~' }, ctx);
    expect(result.kind).toBe('deny');
  });
});

describe('withReadProbe / getReadProbeChecker', () => {
  const allowResult: ToolPermissionResult = {
    kind: 'allow',
    extra: { decisionPoint: 'tool.allow' },
  };
  // A fresh object each call, so identity is the thing under test.
  const stub = (): HostToolChecker => ({ check: () => allowResult });

  it('attaches the pure variant to the wrapper itself', () => {
    const pure = stub();
    const wrapped = withReadProbe(stub(), pure);

    expect(getReadProbeChecker(wrapped)).toBe(pure);
  });

  it('hands the wrapper back so the caller can register it as-is', () => {
    const outer = stub();

    expect(withReadProbe(outer, stub())).toBe(outer);
  });

  it('finds nothing on a checker that was never wrapped', () => {
    expect(getReadProbeChecker(stub())).toBeUndefined();
    expect(getReadProbeChecker(undefined)).toBeUndefined();
  });

  it('keeps two wrappers apart, so a probe cannot cross checker maps', () => {
    const pureA = stub();
    const pureB = stub();
    const wrappedA = withReadProbe(stub(), pureA);
    const wrappedB = withReadProbe(stub(), pureB);

    expect(getReadProbeChecker(wrappedA)).toBe(pureA);
    expect(getReadProbeChecker(wrappedB)).toBe(pureB);
  });
});
