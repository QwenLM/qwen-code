/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 模块对外契约的回归测试网。
 *
 * 这些用例覆盖的是契约用文字承诺下的保证——三选一的判定、失败时的方向、什么东西
 * 会送达 ask handler、重跑通道、单次调用覆盖的隔离性。每一条断言都是宿主能够
 * 观察到的行为。
 *
 * 注意：本文件通过公开的 SessionPermissionManager 判定入口驱动，
 * 只断言宿主可观察的行为。
 */

import { describe, expect, it } from 'vitest';
import {
  checkWithOverride,
  createIsolatedPermissionSession,
} from '../../../../test-utils/config.js';
import type { SessionPermissionManager } from '../../session-permission-manager.js';
import {
  PERMISSION_MODES,
  PermissionModes,
  getLegacyToolNames,
  normalizeLegacyToolName,
  normalizePermissionMode,
  isDefaultMode,
  isAcceptEditsMode,
  isAutoMode,
  isDontAskMode,
  isYoloMode,
  permissionRuleValueFromString,
  rulesForToolName,
} from '../index.js';
import {
  UnregisteredToolError,
} from '../../session-permission-manager.js';
import type {
  AskHandleContext,
  AskHandleResult,
  CheckPermissionOptions,
  PermissionDecision,
  PermissionOptions,
  PermissionRequest,
  PermissionRules,
  PreToolUseHookVerdict,
  ToolCheckContext,
  ToolCheckResult,
  ToolPermissionChecker,
} from '../index.js';
import type { ToolPermissionReason } from '../../../../tools/tool-checkers/checker-reasons.js';

type Reason = { note: string };

type ContractModule = Omit<
  SessionPermissionManager,
  'check' | 'setAskHandler'
> & {
  check(
    request: PermissionRequest,
    override?: CheckPermissionOptions<Reason>,
  ): Promise<PermissionDecision<Reason>>;
  setAskHandler(
    handler:
      | ((ctx: AskHandleContext<Reason, unknown, unknown>) => Promise<AskHandleResult>)
      | undefined,
  ): void;
};

function createContractModule(
  options: PermissionOptions<Reason>,
): ContractModule {
  const session = createIsolatedPermissionSession(
    options as unknown as PermissionOptions<ToolPermissionReason>,
  );
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === 'check') {
        return (request: PermissionRequest, override?: CheckPermissionOptions<Reason>) =>
          checkWithOverride(
            target,
            request,
            override as CheckPermissionOptions<ToolPermissionReason> | undefined,
          ) as unknown as Promise<PermissionDecision<Reason>>;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as ContractModule;
}

const emptyRules = (): PermissionRules => ({ allow: {}, deny: {}, ask: {} });

const baseOptions = (): PermissionOptions<Reason> => ({
  permissionMode: 'default',
  rules: emptyRules(),
  cwd: '/repo',
  additionalDirectories: [],
  toolCheckerMap: new Map(),
  askHandler: undefined,
});

type Capture = {
  ctx?: ToolCheckContext<Reason>;
  askCtx?: AskHandleContext<Reason, unknown, unknown>;
  handleResult: AskHandleResult;
  reRuns: Array<ToolCheckResult<Reason>>;
};

function build(
  overrides: Partial<PermissionOptions<Reason>> = {},
): {
  module: ContractModule;
  capture: Capture;
} {
  const capture: Capture = { handleResult: { kind: 'approved' }, reRuns: [] };
  const module = createContractModule({
    ...baseOptions(),
    ...overrides,
  });
  return { module, capture };
}

function checker(
  impl: (
    input: Record<string, unknown>,
    ctx: ToolCheckContext<Reason>,
  ) => ToolCheckResult<Reason> | Promise<ToolCheckResult<Reason>>,
): ToolPermissionChecker<Reason> {
  return { check: impl };
}

function req(toolUseId: string) {
  return { toolName: 'T', input: { a: 1 }, toolUseId };
}

// ---------------------------------------------------------------------------

describe('tool check verdicts', () => {
  it('allow settles immediately, decidedBy toolCheck', async () => {
    const { module } = build({
      toolCheckerMap: new Map([['T', checker(() => ({ kind: 'allow' }))]]),
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('allow');
    expect(d.decidedBy).toBe('toolCheck');
    expect(d.history).toEqual([]);
    expect(d.toolCheck).toEqual({ kind: 'allow' });
  });

  it('deny settles immediately', async () => {
    const { module } = build({
      toolCheckerMap: new Map([['T', checker(() => ({ kind: 'deny' }))]]),
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('deny');
    expect(d.decidedBy).toBe('toolCheck');
    // 没跑 ask，就没有落定方式可言。
    expect(d.settlement).toBeUndefined();
  });

  it('unregistered tool throws UnregisteredToolError for the host to decide', async () => {
    // 组件不为装配遗漏背拒绝的锅：抛出去，宿主自行兜底（如默认放行，
    // 对齐重构前老管线的 fallthrough）。
    const { module } = build();
    await expect(module.check(req('tu-1'))).rejects.toThrow(
      UnregisteredToolError,
    );
  });

  it('a throwing checker is denied (fail-closed)', async () => {
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => { throw new Error('boom'); })],
      ]),
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('deny');
  });
});

// ---------------------------------------------------------------------------

describe('ask settlement', () => {
  it('approved → allow with first-check reason and suggestions', async () => {
    const { module, capture } = build({
      toolCheckerMap: new Map([
        [
          'T',
          checker(() => ({
            kind: 'ask',
            reason: { note: 'confirm please' },
            suggestions: ['always'],
          })),
        ],
      ]),
      askHandler: async (ctx) => {
        capture.askCtx = ctx;
        return { kind: 'approved' };
      },
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('allow');
    expect(d.decidedBy).toBe('ask');
    expect(d.settlement).toBe('approved');
    expect(d.reason).toEqual({ note: 'confirm please' });
    expect(d.suggestions).toEqual(['always']);
    expect(d.history).toEqual([]);
  });

  it('rejected → deny', async () => {
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () => ({ kind: 'rejected' }),
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('deny');
    expect(d.decidedBy).toBe('ask');
    expect(d.settlement).toBe('rejected');
  });

  it('aborted → deny', async () => {
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () => ({ kind: 'aborted' }),
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('deny');
    expect(d.settlement).toBe('aborted');
  });

  it('a reasoned rejection carries its wording as denialMessage', async () => {
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () => ({ kind: 'rejected', reason: 'nope' }),
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('deny');
    expect(d.denialMessage).toBe('nope');
    // The check's ask copy is still there; the refusal wording is additive.
    expect(d.reason).toEqual({ note: 'x' });
  });

  it('a bare rejection and an abort leave denialMessage unset', async () => {
    const { module: bare } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () => ({ kind: 'rejected' }),
    });
    expect(
      (await bare.check(req('tu-1'))).denialMessage,
    ).toBeUndefined();

    const { module: aborted } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () => ({ kind: 'aborted' }),
    });
    expect(
      (await aborted.check(req('tu-2'))).denialMessage,
    ).toBeUndefined();

    // An empty-string reason counts as no wording: denialMessage stays unset.
    const { module: emptyReason } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () => ({ kind: 'rejected', reason: '' }),
    });
    expect(
      (await emptyReason.check(req('tu-3'))).denialMessage,
    ).toBeUndefined();
  });

  it('settlement tells a bare rejection from an abort', async () => {
    // 上一条证明了这两者在 denialMessage 上同形；宿主要区分只能靠 settlement。
    const askOnly = (result: AskHandleResult) =>
      build({
        toolCheckerMap: new Map([
          ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
        ]),
        askHandler: async () => result,
      }).module;

    const bare = await askOnly({ kind: 'rejected' }).check(req('tu-1'));
    expect(bare.settlement).toBe('rejected');
    expect(bare.denialMessage).toBeUndefined();

    const aborted = await askOnly({ kind: 'aborted' }).check(req('tu-2'));
    expect(aborted.settlement).toBe('aborted');
    expect(aborted.denialMessage).toBeUndefined();

    const reasoned = await askOnly({ kind: 'rejected', reason: 'nope' }).check(
      req('tu-3'),
    );
    expect(reasoned.settlement).toBe('rejected');
    expect(reasoned.denialMessage).toBe('nope');
  });

  it('no askHandler → ask is denied (fail-closed)', async () => {
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('deny');
    expect(d.decidedBy).toBe('ask');
    // 没人可问：decidedBy 是 ask 却没有 settlement，只有这一种解释。
    expect(d.settlement).toBeUndefined();
  });

  it('a throwing handler counts as aborted, not rejected', async () => {
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () => { throw new Error('handler crash'); },
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('deny');
    expect(d.decidedBy).toBe('ask');
    expect(d.settlement).toBe('aborted');
  });

  it('handler receives the first result and the channel', async () => {
    const { module, capture } = build({
      toolCheckerMap: new Map([
        [
          'T',
          checker((input, _ctx) => ({
            kind: 'ask',
            reason: { note: `for ${input['a']}` },
            suggestions: ['s1'],
          })),
        ],
      ]),
      askHandler: async (ctx) => {
        capture.askCtx = ctx;
        return { kind: 'approved' };
      },
    });
    await module.check(req('tu-1'));
    expect(capture.askCtx?.toolCheckResult).toEqual({
      kind: 'ask',
      reason: { note: 'for 1' },
      suggestions: ['s1'],
    });
    expect(capture.askCtx?.toolName).toBe('T');
    expect(capture.askCtx?.input).toEqual({ a: 1 });
    expect(typeof capture.askCtx?.onToolCheckResult).toBe('function');
  });
});

// ---------------------------------------------------------------------------

describe('config-change re-runs', () => {
  it('setRules while ask is pending re-runs the check and delivers to the channel', async () => {
    const verdict: ToolCheckResult<Reason> = {
      kind: 'ask',
      reason: { note: 'first' },
    };
    const { module, capture } = build({
      toolCheckerMap: new Map([['T', checker(() => verdict)]]),
      askHandler: async (ctx) => {
        capture.askCtx = ctx;
        const off = ctx.onToolCheckResult((r) => {
          capture.reRuns.push(r);
        });
        // Simulate the host double-writing inside the handler: change the
        // rules, which must re-run the check and deliver a new result.
        module.setRules(
          { allow: { session: ['T'] }, deny: {}, ask: {} },
          { merge: true },
        );
        // Give the async re-run a tick to complete.
        await new Promise((r) => setTimeout(r, 10));
        off();
        return { kind: 'approved' };
      },
    });

    const d = await module.check(req('tu-1'));
    expect(capture.reRuns.length).toBe(1);
    expect(capture.reRuns[0]).toEqual(verdict);
    // History carries the re-run result into the decision.
    expect(d.history).toEqual([verdict]);
  });

  it('a re-run delivering allow lets the handler settle approved', async () => {
    let verdict: ToolCheckResult<Reason> = {
      kind: 'ask',
      reason: { note: 'first' },
    };
    let settled: AskHandleResult | undefined;
    let resolveOuter: (() => void) | undefined;
    const { module } = build({
      toolCheckerMap: new Map([['T', checker(() => verdict)]]),
      askHandler: async (ctx) => {
        const off = ctx.onToolCheckResult((latest) => {
          if (latest.kind === 'allow') {
            settled = { kind: 'approved' };
            resolveOuter?.();
          }
        });
        await new Promise<void>((resolve) => { resolveOuter = resolve; });
        off();
        return settled ?? { kind: 'rejected' };
      },
    });

    const pending = module.check(req('tu-1'));
    await new Promise((r) => setTimeout(r, 0));   // 让 task 注册、handler 进入等待
    // The checker flips to allow, and the rules change triggers a re-run.
    verdict = { kind: 'allow' };
    module.setRules({ allow: {}, deny: { session: ['T'] }, ask: {} });
    const d = await pending;
    expect(d.kind).toBe('allow');
    expect(d.history).toEqual([{ kind: 'allow' }]);
  });

  it('a change with no diff does not re-run (reference comparison)', async () => {
    let runs = 0;
    const rules = emptyRules();
    const { module, capture } = build({
      toolCheckerMap: new Map([
        [
          'T',
          checker(() => {
            runs++;
            return { kind: 'allow' };
          }),
        ],
      ]),
      askHandler: async (ctx) => {
        capture.askCtx = ctx;
        ctx.onToolCheckResult(() => {});
        // Same reference → no re-run.
        module.setRules(rules);
        await new Promise((r) => setTimeout(r, 10));
        return { kind: 'approved' };
      },
    });
    await module.check(req('tu-1'));
    expect(runs).toBe(1);
    expect(capture.reRuns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('per-call override', () => {
  it('a call with option runs on it and does not follow object changes', async () => {
    const { module } = build({
      toolCheckerMap: new Map([['T', checker(() => ({ kind: 'allow' }))]]),
    });

    const pinned: PermissionOptions<Reason> = {
      ...baseOptions(),
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'pinned' } }))],
      ]),
      askHandler: async () => ({ kind: 'rejected' }),
    };

    const pending = module.check(req('tu-p'), pinned);
    // Object-state change must not disturb the pinned call.
    module.setRules({ allow: { session: ['T'] }, deny: {}, ask: {} });
    const d = await pending;
    expect(d.kind).toBe('deny'); // rejected by the pinned handler
    expect(d.decidedBy).toBe('ask');
    expect(d.history).toEqual([]);
  });

  it('a call without option follows object changes', async () => {
    const { module, capture } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async (ctx) => {
        capture.askCtx = ctx;
        ctx.onToolCheckResult((r) => capture.reRuns.push(r));
        await new Promise((r) => setTimeout(r, 30));
        return { kind: 'approved' };
      },
    });
    const pending = module.check(req('tu-1'));
    await new Promise((r) => setTimeout(r, 0));   // 让 task 注册进活跃集
    module.setRules({ allow: { session: ['T'] }, deny: {}, ask: {} });
    const d = await pending;
    expect(d.history.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('rules surface', () => {
  it('getRules() returns the full set; getRules(toolName) the three-dim view', () => {
    const rules: PermissionRules = {
      allow: { userSettings: ['T', 'Read(//docs/**)'] },
      deny: { projectSettings: ['Bash', 'T(secret)'] },
      ask: {},
    };
    const { module } = build({ rules });

    expect(module.getRules()).toBe(rules);

    const forT = module.getRules('T');
    expect(forT.toolLevel.allow.userSettings?.map((r) => r.ruleValue)).toEqual([
      { toolName: 'T' },
    ]);
    expect(
      forT.toolDetailLevel.deny.projectSettings?.map(
        (r) => r.ruleValue.ruleContent,
      ),
    ).toEqual(['secret']);
    // Bash rules do not leak into T's view.
    expect(forT.toolLevel.deny.projectSettings).toBeUndefined();
  });

  it('setRules merge appends per bucket', () => {
    const { module } = build();
    module.setRules({ allow: { userSettings: ['T'] }, deny: {}, ask: {} });
    module.setRules(
      { allow: { userSettings: ['Read'] }, deny: { session: ['Bash'] }, ask: {} },
      { merge: true },
    );
    const rules = module.getRules();
    expect(rules.allow.userSettings).toEqual(['T', 'Read']);
    expect(rules.deny.session).toEqual(['Bash']);
  });

  it('setRules without merge replaces', () => {
    const { module } = build();
    module.setRules({ allow: { userSettings: ['T'] }, deny: {}, ask: {} });
    module.setRules({ allow: {}, deny: { userSettings: ['Bash'] }, ask: {} });
    expect(module.getRules().allow.userSettings).toBeUndefined();
    expect(module.getRules().deny.userSettings).toEqual(['Bash']);
  });
});

// ---------------------------------------------------------------------------

describe('mode vocabulary', () => {
  it('has exactly five modes, in cycle order', () => {
    expect(PERMISSION_MODES).toEqual([
      'default',
      'acceptEdits',
      'auto',
      'dontAsk',
      'yolo',
    ]);
    expect(Object.values(PermissionModes)).toEqual([...PERMISSION_MODES]);
  });

  it('normalizes canonical values, historical spellings and nothing else', () => {
    for (const mode of PERMISSION_MODES) {
      expect(normalizePermissionMode(mode)).toBe(mode);
    }
    expect(normalizePermissionMode('bypassPermissions')).toBe(
      PermissionModes.Yolo,
    );
    expect(normalizePermissionMode('accepting_edits')).toBe(
      PermissionModes.AcceptEdits,
    );
    expect(normalizePermissionMode('plan')).toBeUndefined();
    expect(normalizePermissionMode('')).toBeUndefined();
  });

  it('mode predicates each recognize exactly their own mode', () => {
    const predicates = [
      [isDefaultMode, PermissionModes.Default],
      [isAcceptEditsMode, PermissionModes.AcceptEdits],
      [isAutoMode, PermissionModes.Auto],
      [isDontAskMode, PermissionModes.DontAsk],
      [isYoloMode, PermissionModes.Yolo],
    ] as const;
    for (const [pred, own] of predicates) {
      for (const mode of PERMISSION_MODES) {
        expect(pred(mode)).toBe(mode === own);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('state surface', () => {
  it('mode and directory setters round-trip', () => {
    const { module } = build();
    expect(module.getPermissionMode()).toBe('default');
    module.setPermissionMode('auto');
    expect(module.getPermissionMode()).toBe('auto');

    module.setAdditionalDirectories(['/extra']);
    expect(module.getAdditionalDirectories()).toEqual(['/extra']);
  });

  it('setAskHandler(undefined) makes asks fail closed again', async () => {
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () => ({ kind: 'approved' }),
    });
    await expect(module.check(req('tu-1'))).resolves.toMatchObject({
      kind: 'allow',
    });
    module.setAskHandler(undefined);
    await expect(module.check(req('tu-2'))).resolves.toMatchObject({
      kind: 'deny',
      decidedBy: 'ask',
    });
  });
});

// ---------------------------------------------------------------------------
// Legacy tool-name normalization
// ---------------------------------------------------------------------------

describe('legacy tool names', () => {
  // 别名表是宿主知识：这里以示例表注入，组件本身不内置任何表。
  const aliases = { RunWorkflow: 'Workflow', ListPeers: 'ListAgents' };

  it('normalizes every injected alias', () => {
    // A rule stored under an old name has to keep matching, or a deny the user
    // wrote once quietly stops denying after a rename.
    expect(normalizeLegacyToolName('RunWorkflow', aliases)).toBe('Workflow');
    expect(normalizeLegacyToolName('ListPeers', aliases)).toBe('ListAgents');
    // 未注入别名表时不做任何归一（组件不内置宿主知识）
    expect(normalizeLegacyToolName('RunWorkflow')).toBe('RunWorkflow');
  });

  it('leaves an unknown name alone', () => {
    expect(normalizeLegacyToolName('Bash')).toBe('Bash');
    expect(normalizeLegacyToolName('NotATool')).toBe('NotATool');
  });

  it('normalizes inside a parsed rule string, with and without content', () => {
    expect(permissionRuleValueFromString('RunWorkflow', aliases)).toEqual({
      toolName: 'Workflow',
    });
    expect(permissionRuleValueFromString('ListPeers(team)', aliases)).toEqual({
      toolName: 'ListAgents',
      ruleContent: 'team',
    });
  });

  it('reports the legacy names that map to a canonical one', () => {
    expect(getLegacyToolNames('Workflow', aliases)).toEqual(['RunWorkflow']);
    expect(getLegacyToolNames('ListAgents', aliases)).toEqual(['ListPeers']);
    expect(getLegacyToolNames('Bash')).toEqual([]);
  });

  it('matches a rule written under the legacy name against the canonical tool', () => {
    const rules = {
      allow: {},
      deny: { userSettings: ['RunWorkflow'] },
      ask: {},
    };

    const forTool = rulesForToolName(rules, 'Workflow', aliases);

    expect(forTool.toolLevel.deny.userSettings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Amending the call on approval
// ---------------------------------------------------------------------------

describe('approval with an amended input', () => {
  function moduleWith(
    handler: (input: Record<string, unknown>) => Promise<{
      kind: 'approved';
      input?: Record<string, unknown>;
    }>,
    deny: string[] = [],
  ) {
    const checker = {
      check(input: Record<string, unknown>) {
        const path = String(input['file_path'] ?? '');
        if (deny.some((bad) => path.startsWith(bad))) {
          return { kind: 'deny' as const };
        }
        if (path === '') {
          return { kind: 'deny' as const };
        }
        return { kind: 'ask' as const, reason: 'Allow?' };
      },
    };
    return createIsolatedPermissionSession({
      permissionMode: PermissionModes.Default,
      rules: { allow: {}, deny: {}, ask: {} },
      cwd: '/repo',
      additionalDirectories: [],
      toolCheckerMap: new Map([['Read', checker as never]]),
      askHandler: async (ctx: { input: Record<string, unknown> }) =>
        handler(ctx.input),
    } as never) as unknown as ContractModule;
  }

  it('runs the call as asked when the approver amends nothing', async () => {
    const permission = moduleWith(async () => ({ kind: 'approved' }));

    const decision = await permission.check({
      toolName: 'Read',
      input: { file_path: '/repo/a.txt' },
      toolUseId: 'c1',
    });

    expect(decision.kind).toBe('allow');
    expect(decision.input).toEqual({ file_path: '/repo/a.txt' });
  });

  it('reports the amended input as the one that will run', async () => {
    const permission = moduleWith(async () => ({
      kind: 'approved',
      input: { file_path: '/repo/b.txt' },
    }));

    const decision = await permission.check({
      toolName: 'Read',
      input: { file_path: '/repo/a.txt' },
      toolUseId: 'c2',
    });

    expect(decision.kind).toBe('allow');
    expect(decision.input).toEqual({ file_path: '/repo/b.txt' });
  });

  it('refuses an amendment that lands somewhere denied', async () => {
    // 这正是复检的意义所在：批准不能成为把调用挪到检查本会拒绝之处的后门。
    const permission = moduleWith(
      async () => ({ kind: 'approved', input: { file_path: '/etc/shadow' } }),
      ['/etc'],
    );

    const decision = await permission.check({
      toolName: 'Read',
      input: { file_path: '/repo/a.txt' },
      toolUseId: 'c3',
    });

    expect(decision.kind).toBe('deny');
    // 人批准了，拒的是改后的参数：落定方式仍是 approved。
    expect(decision.settlement).toBe('approved');
  });

  it('records the re-check in the history', async () => {
    const permission = moduleWith(async () => ({
      kind: 'approved',
      input: { file_path: '/repo/b.txt' },
    }));

    const decision = await permission.check({
      toolName: 'Read',
      input: { file_path: '/repo/a.txt' },
      toolUseId: 'c4',
    });

    expect(decision.history).toHaveLength(1);
  });

  it('does not ask a second time when the amended input still asks', async () => {
    let asked = 0;
    const permission = moduleWith(async () => {
      asked += 1;
      return { kind: 'approved', input: { file_path: '/repo/b.txt' } };
    });

    const decision = await permission.check({
      toolName: 'Read',
      input: { file_path: '/repo/a.txt' },
      toolUseId: 'c5',
    });

    expect(asked).toBe(1);
    expect(decision.kind).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// The registration-window recheck (#63, defect 1)
// ---------------------------------------------------------------------------

describe('recheck lost between first check and registration', () => {
  it('a config change landing while the first check runs still re-runs', async () => {
    // The checker reads the rules *before* yielding, so the first check captures
    // the pre-change rule set even though it resolves after the change lands.
    let openGate!: () => void;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const ruleAware = checker(async (_input, ctx) => {
      const allowed = ctx.rules.allow.session?.includes('T') ?? false;
      await gate;
      return allowed
        ? { kind: 'allow' }
        : { kind: 'ask', reason: { note: 'needs approval' } };
    });

    const { module } = build({
      toolCheckerMap: new Map([['T', ruleAware]]),
      askHandler: async (ctx) =>
        new Promise<AskHandleResult>((resolve) => {
          ctx.onToolCheckResult((result) => {
            // The post-registration recheck delivers the fresh result.
            if (result.kind === 'allow') resolve({ kind: 'approved' });
          });
        }),
    });

    const pending = module.check(req('tu-win'));
    // Let the first check start and suspend at the gate.
    await Promise.resolve();

    // The config changes while the first check is still in flight — the window.
    module.setRules({ allow: { session: ['T'] }, deny: {}, ask: {} });

    // Release the first check; it returns the stale `ask`, but the registration
    // recheck must see the new rule and re-run to `allow`.
    openGate();

    const d = await pending;
    expect(d.kind).toBe('allow');
    // The re-run that caught the window change is in the history.
    expect(d.history.some((r) => r.kind === 'allow')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reentrant recheck settlement (#63, defect 2)
// ---------------------------------------------------------------------------

describe('reentrant recheck settlement', () => {
  it('one prompt settling during a config change does not starve the others', async () => {
    // Both prompts ask; the first handler settles as soon as a recheck allows it,
    // the second records rechecks and stays open. A config change re-runs both;
    // the first settling mid-iteration must not stop the second being rechecked.
    const ruleAware = checker(async (_input, ctx) => {
      const allowed = ctx.rules.allow.session?.includes('T') ?? false;
      return allowed
        ? { kind: 'allow' }
        : { kind: 'ask', reason: { note: 'needs approval' } };
    });

    const secondReRuns: Array<ToolCheckResult<Reason>> = [];
    let handlerForSecond!: (r: ToolCheckResult<Reason>) => void;

    const { module } = build({
      toolCheckerMap: new Map([['T', ruleAware]]),
      askHandler: async (ctx) => {
        if (ctx.toolUseId === 'tu-first') {
          return new Promise<AskHandleResult>((resolve) => {
            ctx.onToolCheckResult((result) => {
              if (result.kind === 'allow') resolve({ kind: 'approved' });
            });
          });
        }
        return new Promise<AskHandleResult>((resolve) => {
          handlerForSecond = (result) => {
            secondReRuns.push(result);
            if (result.kind === 'allow') resolve({ kind: 'approved' });
          };
          ctx.onToolCheckResult(handlerForSecond);
        });
      },
    });

    const firstPending = module.check(req('tu-first'));
    const secondPending = module.check(req('tu-second'));
    await Promise.resolve();

    // One config change re-runs both in a single notify pass.
    module.setRules({ allow: { session: ['T'] }, deny: {}, ask: {} });

    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(first.kind).toBe('allow');
    // The second prompt was rechecked even though the first settled mid-pass.
    expect(second.kind).toBe('allow');
    expect(secondReRuns.some((r) => r.kind === 'allow')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session-scoped directories (#67)
// ---------------------------------------------------------------------------

describe('additional directories', () => {
  it('addDirectory appends to the single directory list', () => {
    const { module } = build({ additionalDirectories: ['/from-settings'] });

    module.addDirectory('/tmp/added');
    expect(module.getAdditionalDirectories()).toEqual([
      '/from-settings',
      '/tmp/added',
    ]);
  });

  it('adding the same directory twice is a no-op', () => {
    const { module } = build();
    module.addDirectory('/tmp/x');
    module.addDirectory('/tmp/x');
    expect(module.getAdditionalDirectories()).toEqual(['/tmp/x']);
  });
});

describe('decision.stages', () => {
  it('records a single toolCheck stage for an immediate allow', async () => {
    const { module } = build({
      toolCheckerMap: new Map([['T', checker(() => ({ kind: 'allow' }))]]),
    });
    const d = await module.check(req('tu-1'));
    expect(d.stages).toEqual([{ stage: 'toolCheck', verdict: 'allow' }]);
  });

  it('records a single toolCheck stage for an immediate deny', async () => {
    const { module } = build({
      toolCheckerMap: new Map([['T', checker(() => ({ kind: 'deny' }))]]),
    });
    const d = await module.check(req('tu-1'));
    expect(d.stages).toEqual([{ stage: 'toolCheck', verdict: 'deny' }]);
  });

  it('appends an ask stage carrying the settled verdict when approved', async () => {
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () => ({ kind: 'approved' }),
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('allow');
    expect(d.stages).toEqual([
      { stage: 'toolCheck', verdict: 'ask' },
      { stage: 'ask', verdict: 'allow' },
    ]);
  });

  it('appends an ask stage carrying the settled verdict when rejected', async () => {
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () => ({ kind: 'rejected' }),
    });
    const d = await module.check(req('tu-1'));
    expect(d.kind).toBe('deny');
    expect(d.stages).toEqual([
      { stage: 'toolCheck', verdict: 'ask' },
      { stage: 'ask', verdict: 'deny' },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('additionalRules overlay', () => {
  it('widens the live rule set rather than replacing it', async () => {
    const seen: PermissionRules[] = [];
    const { module } = build({
      rules: { allow: { userSettings: ['Base'] }, deny: {}, ask: {} },
      toolCheckerMap: new Map([
        [
          'T',
          checker((_i, ctx) => {
            seen.push(ctx.rules);
            return { kind: 'allow' };
          }),
        ],
      ]),
    });

    await module.check(req('tu-1'), {
      additionalRules: { allow: { session: ['Skill'] }, deny: {}, ask: {} },
    });

    // Both the live rule and the overlay's are visible to the check.
    expect(seen[0].allow.userSettings).toEqual(['Base']);
    expect(seen[0].allow.session).toEqual(['Skill']);
  });

  it('does not pin: a live rule edit still re-runs a pending check', async () => {
    const seen: PermissionRules[] = [];
    let settleAsk!: (r: AskHandleResult) => void;
    const reRuns: Array<ToolCheckResult<Reason>> = [];
    const { module } = build({
      rules: { allow: { userSettings: ['Base'] }, deny: {}, ask: {} },
      toolCheckerMap: new Map([
        [
          'T',
          checker((_i, ctx) => {
            seen.push(ctx.rules);
            return { kind: 'ask', reason: { note: 'x' } };
          }),
        ],
      ]),
      askHandler: async (ctx) => {
        ctx.onToolCheckResult((r) => reRuns.push(r));
        return new Promise<AskHandleResult>((res) => {
          settleAsk = res;
        });
      },
    });

    const pending = module.check(req('tu-1'), {
      additionalRules: { allow: { session: ['Skill'] }, deny: {}, ask: {} },
    });
    // Let the ask reach the handler.
    for (let i = 0; i < 20 && seen.length < 1; i++) await Promise.resolve();

    // A rule the user adds while the prompt is open must still reach the check.
    module.setRules({ allow: { userSettings: ['Base', 'Added'] }, deny: {}, ask: {} });
    for (let i = 0; i < 50 && seen.length < 2; i++) await Promise.resolve();

    expect(seen.length).toBeGreaterThan(1);
    const latest = seen[seen.length - 1];
    expect(latest.allow.userSettings).toEqual(['Base', 'Added']);
    // The overlay survives the re-run.
    expect(latest.allow.session).toEqual(['Skill']);

    settleAsk({ kind: 'approved' });
    await pending;
    expect(reRuns.length).toBeGreaterThan(0);
  });

  it('a rules replacement still pins, which is why the overlay exists', async () => {
    const seen: PermissionRules[] = [];
    let settleAsk!: (r: AskHandleResult) => void;
    const { module } = build({
      rules: { allow: { userSettings: ['Base'] }, deny: {}, ask: {} },
      toolCheckerMap: new Map([
        [
          'T',
          checker((_i, ctx) => {
            seen.push(ctx.rules);
            return { kind: 'ask', reason: { note: 'x' } };
          }),
        ],
      ]),
      askHandler: async () =>
        new Promise<AskHandleResult>((res) => {
          settleAsk = res;
        }),
    });

    const pending = module.check(req('tu-1'), {
      rules: { allow: { session: ['Pinned'] }, deny: {}, ask: {} },
    });
    for (let i = 0; i < 20 && seen.length < 1; i++) await Promise.resolve();

    module.setRules({ allow: { userSettings: ['Base', 'Added'] }, deny: {}, ask: {} });
    for (let i = 0; i < 30; i++) await Promise.resolve();

    // Pinned: the live edit produced no re-run at all.
    expect(seen.length).toBe(1);
    expect(seen[0].allow.session).toEqual(['Pinned']);

    settleAsk({ kind: 'approved' });
    await pending;
  });

  it('is reference-stable, so an unchanged config produces no re-run', async () => {
    // The merge runs again the moment the task registers. If it built a fresh
    // object each time, that would look like a config change and push a
    // spurious re-run into the history.
    let settleAsk!: (r: AskHandleResult) => void;
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async () =>
        new Promise<AskHandleResult>((res) => {
          settleAsk = res;
        }),
    });

    const pending = module.check(req('tu-1'), {
      additionalRules: { allow: { session: ['Skill'] }, deny: {}, ask: {} },
    });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    settleAsk({ kind: 'approved' });

    const d = await pending;
    expect(d.history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('batched configuration changes', () => {
  /**
   * Drives one pending ask and reports how many re-runs the handler saw. The
   * count is the observable that matters: each re-run also lands in the
   * decision's `history` and `stages`.
   */
  async function countReRuns(
    write: (module: ContractModule) => void,
  ): Promise<{ reRuns: number; history: number }> {
    const reRuns: Array<ToolCheckResult<Reason>> = [];
    const { module } = build({
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { note: 'x' } }))],
      ]),
      askHandler: async (ctx) => {
        const off = ctx.onToolCheckResult((r) => reRuns.push(r));
        write(module);
        await new Promise((r) => setTimeout(r, 10));
        off();
        return { kind: 'approved' };
      },
    });

    const d = await module.check(req('tu-1'));
    return { reRuns: reRuns.length, history: d.history.length };
  }

  it('re-runs once per setter when the same change is chained', async () => {
    const { reRuns } = await countReRuns((module) => {
      module.setPermissionMode(PermissionModes.AcceptEdits);
      module.setRules({ allow: { session: ['T'] }, deny: {}, ask: {} });
      module.setAdditionalDirectories(['/srv/data']);
    });

    // 三个 setter 各通知一次：一次逻辑变更拆成多次写入就会触发多次重跑。
    expect(reRuns).toBe(3);
  });

  it('does not re-run when setRules is handed back the live rule set', async () => {
    const { reRuns } = await countReRuns((module) => {
      module.setRules(module.getRules());
    });

    expect(reRuns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PreToolUse hook verdict pass-through
// ---------------------------------------------------------------------------

describe('preToolUseHookVerdict pass-through', () => {
  it('reaches the checker ctx untouched when the override supplies it', async () => {
    const verdict: PreToolUseHookVerdict = {
      behavior: 'ask',
      message: 'hook wants confirmation',
      reason: 'sensitive-path',
    };
    let seen: ToolCheckContext<Reason> | undefined;
    const { module } = build({
      toolCheckerMap: new Map([
        [
          'T',
          checker((_i, ctx) => {
            seen = ctx;
            return { kind: 'allow' };
          }),
        ],
      ]),
    });

    await module.check( req('tu-hook'), {
      preToolUseHookVerdict: verdict,
    });

    // 原样透传：同一引用、全部载荷都在。
    expect(seen?.preToolUseHookVerdict).toBe(verdict);
  });

  it('stays undefined on the checker ctx when the override omits it', async () => {
    let seen: ToolCheckContext<Reason> | undefined;
    const { module } = build({
      toolCheckerMap: new Map([
        [
          'T',
          checker((_i, ctx) => {
            seen = ctx;
            return { kind: 'allow' };
          }),
        ],
      ]),
    });

    await module.check(req('tu-hook'));

    expect(seen?.preToolUseHookVerdict).toBeUndefined();
  });

  it('stays pinned across config-change re-runs while the ask is pending', async () => {
    const verdict: PreToolUseHookVerdict = { behavior: 'deny', message: 'nope' };
    const seen: Array<PreToolUseHookVerdict | undefined> = [];
    const { module } = build({
      toolCheckerMap: new Map([
        [
          'T',
          checker((_i, ctx) => {
            seen.push(ctx.preToolUseHookVerdict);
            return { kind: 'ask', reason: { note: 'x' } };
          }),
        ],
      ]),
      askHandler: async (ctx) => {
        ctx.onToolCheckResult(() => {});
        // rules 没钉住：这次 setter 触发重跑；钉住的裁决必须随重跑一起送达。
        module.setRules({ allow: { session: ['T'] }, deny: {}, ask: {} });
        await new Promise((r) => setTimeout(r, 10));
        return { kind: 'approved' };
      },
    });

    const d = await module.check( req('tu-hook'), {
      preToolUseHookVerdict: verdict,
    });

    // 首次自检与配置变更重跑看到的是同一份裁决。
    expect(seen.length).toBe(2);
    expect(seen[0]).toBe(verdict);
    expect(seen[1]).toBe(verdict);
    expect(d.history.length).toBe(1);
  });
});
