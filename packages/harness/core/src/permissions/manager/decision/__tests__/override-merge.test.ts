/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 单次调用覆盖（override）合并的测试：既测纯粹的合并/差异辅助函数，也测它们经由
 * `checkPermission` 表现出的行为——给了的字段被钉住、无视它自己的 setter；没给的
 * 字段跟随对象状态、setter 一改就重跑自检。
 *
 * 本文件会 import 内部模块 snapshot.js 的 mergeSnapshot/configDiffers——这两个
 * 辅助函数的签名在重写中保持原样，因此用例无需改动。
 */

import { describe, expect, it, vi } from 'vitest';
import { createIsolatedPermissionSession } from '../../../../test-utils/config.js';
import { checkWithOverride } from '../../../../test-utils/config.js';
import type { SessionPermissionManager } from '../../session-permission-manager.js';
import {
  configDiffers,
  mergeSnapshot,
  type ConfigSnapshot,
} from '../config-snapshot.js';
import type {
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

type Reason = ToolPermissionReason;

type ContractModule = Omit<
  SessionPermissionManager,
  'check' | 'setAskHandler'
> & {
  check(
    request: PermissionRequest,
    override?: CheckPermissionOptions<Reason>,
  ): Promise<PermissionDecision<Reason>>;
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emptyRules(): PermissionRules {
  return { allow: {}, deny: {}, ask: {} };
}

function checker(
  impl: (
    input: Record<string, unknown>,
    ctx: ToolCheckContext<Reason>,
  ) => ToolCheckResult<Reason> | Promise<ToolCheckResult<Reason>>,
): ToolPermissionChecker<Reason> {
  return { check: impl };
}

function liveSnapshot(): ConfigSnapshot {
  return {
    permissionMode: 'default',
    rules: emptyRules(),
    cwd: '/repo',
    additionalDirectories: ['/repo/a'],
    toolCheckVersion: 0,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// mergeSnapshot
// ---------------------------------------------------------------------------

describe('mergeSnapshot', () => {
  it('returns the live snapshot untouched when there is no override', () => {
    const live = liveSnapshot();
    const merged = mergeSnapshot(live, undefined);
    expect(merged).toBe(live);
  });

  it('replaces only the fields the override supplies', () => {
    const live = liveSnapshot();
    const pinnedRules = emptyRules();
    const override: CheckPermissionOptions<Reason> = {
      permissionMode: 'auto',
      rules: pinnedRules,
    };

    const merged = mergeSnapshot(live, override);

    // Supplied fields take the override value.
    expect(merged.permissionMode).toBe('auto');
    expect(merged.rules).toBe(pinnedRules);
    // Omitted fields keep the live reference.
    expect(merged.cwd).toBe(live.cwd);
    expect(merged.additionalDirectories).toBe(live.additionalDirectories);
  });

  it('treats an all-empty override as a plain copy of the live values', () => {
    const live = liveSnapshot();
    const merged = mergeSnapshot(live, {});

    expect(merged).not.toBe(live);
    expect(merged.permissionMode).toBe(live.permissionMode);
    expect(merged.rules).toBe(live.rules);
  });

  it('pins the preToolUseHookVerdict the override supplies; omitted stays undefined', () => {
    const live = liveSnapshot();
    const verdict: PreToolUseHookVerdict = {
      behavior: 'deny',
      message: 'blocked by hook',
    };

    // 给了就钉住：合并结果携带同一引用。
    const merged = mergeSnapshot(live, { preToolUseHookVerdict: verdict });
    expect(merged.preToolUseHookVerdict).toBe(verdict);

    // 不给就是 undefined：对象状态从不持有 hook 裁决。
    expect(mergeSnapshot(live, {}).preToolUseHookVerdict).toBeUndefined();
    expect(mergeSnapshot(live, undefined).preToolUseHookVerdict).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// configDiffers
// ---------------------------------------------------------------------------

describe('configDiffers', () => {
  it('is false for two snapshots built from the same references', () => {
    const live = liveSnapshot();
    const copy = mergeSnapshot(live, {});
    expect(configDiffers(live, copy)).toBe(false);
  });

  it('is true when any single field reference changed', () => {
    const live = liveSnapshot();

    const modeChanged = mergeSnapshot(live, { permissionMode: 'auto' });
    expect(configDiffers(live, modeChanged)).toBe(true);

    const rulesChanged = mergeSnapshot(live, { rules: emptyRules() });
    expect(configDiffers(live, rulesChanged)).toBe(true);

    const dirChanged = mergeSnapshot(live, { additionalDirectories: [] });
    expect(configDiffers(live, dirChanged)).toBe(true);

    const verdictChanged = mergeSnapshot(live, {
      preToolUseHookVerdict: { behavior: 'allow' },
    });
    expect(configDiffers(live, verdictChanged)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Partial override through checkPermission
// ---------------------------------------------------------------------------

describe('partial override recheck', () => {
  it('pins the supplied field: its setter does not notify the pending prompt', async () => {
    const notified = vi.fn();
    const module = createContractModule({
      permissionMode: 'default',
      rules: emptyRules(),
      cwd: '/repo',
      additionalDirectories: [],
      toolCheckerMap: new Map([
        [
          'T',
          checker(() => ({
            kind: 'ask',
            reason: {
              message: 'Answer required',
              attribution: { type: 'interaction', reason: 'Collect an answer' },
            },
          })),
        ],
      ]),
      askHandler: async (ctx) => {
        ctx.onToolCheckResult(notified);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { kind: 'approved' };
      },
    });

    const override: CheckPermissionOptions<Reason> = { permissionMode: 'auto' };
    const pending = module.check(
      { toolName: 'T', input: {}, toolUseId: 'tu-1' },
      override,
    );
    await tick();

    // The pinned field's setter must not disturb this call.
    module.setPermissionMode('yolo');

    const decision = await pending;
    expect(notified).not.toHaveBeenCalled();
    expect(decision.history).toHaveLength(1);
  });

  it('follows an omitted field: its setter re-runs with the pin still applied', async () => {
    const modesSeen: string[] = [];
    const module = createContractModule({
      permissionMode: 'default',
      rules: emptyRules(),
      cwd: '/repo',
      additionalDirectories: [],
      toolCheckerMap: new Map([
        [
          'T',
          checker((_input, ctx) => {
            modesSeen.push(ctx.mode);
            return { kind: 'ask', reason: { message: 'Answer required', attribution: { type: 'interaction', reason: 'Collect an answer' } } };
          }),
        ],
      ]),
      askHandler: async (ctx) => {
        ctx.onToolCheckResult(() => {});
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { kind: 'approved' };
      },
    });

    // Pin the mode, leave rules following the object state.
    const override: CheckPermissionOptions<Reason> = { permissionMode: 'auto' };
    const pending = module.check(
      { toolName: 'T', input: {}, toolUseId: 'tu-1' },
      override,
    );
    await tick();

    // rules is omitted → this setter drives a re-run.
    module.setRules({ allow: { session: ['T'] }, deny: {}, ask: {} });

    const decision = await pending;
    expect(decision.history).toHaveLength(2);
    // Initial check, settings notification and final rule review all keep the pin.
    expect(modesSeen).toEqual(['auto', 'auto', 'auto']);
  });

  it('uses the override askHandler when the override supplies one', async () => {
    const module = createContractModule({
      permissionMode: 'default',
      rules: emptyRules(),
      cwd: '/repo',
      additionalDirectories: [],
      toolCheckerMap: new Map([
        ['T', checker(() => ({ kind: 'ask', reason: { message: 'Answer required', attribution: { type: 'interaction', reason: 'Collect an answer' } } }))],
      ]),
      askHandler: async () => ({ kind: 'approved' }),
    });

    const override: CheckPermissionOptions<Reason> = {
      askHandler: async () => ({ kind: 'rejected' }),
    };
    const decision = await module.check(
      { toolName: 'T', input: {}, toolUseId: 'tu-1' },
      override,
    );

    expect(decision.kind).toBe('deny');
    expect(decision.decidedBy).toBe('ask');
  });
});
