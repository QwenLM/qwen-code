/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 拉取式模型策略最要保护的不变量是**三态**与**失败必须抛**：
 *
 * - `undefined` = Host 明确不覆盖 → 本地解析链继续，正常；
 * - `null`（响应非法）→ 必须抛，不能当成「无覆盖」；
 * - Host 拒绝 / 超时 → 同样必须抛。
 *
 * 后两条合并成一句话就是：策略拿不到不等于没有策略。宿主直连场景下静默回落会让请求沿启动
 * 模型进入平台计费路径，那是账单事故（worker headlessSession.ts:4266 的注释）。
 * 请求负载的字段集（产品级，不带 subtype 信封——信封归宿主）与归一化的校验分支一并锁住。
 */

import { describe, expect, it, vi } from 'vitest';
import { createModelPolicyCallback } from './sessionModelPolicy.js';
import type { ThreadReverseRequestOptions } from '../contract/hostContext.js';

const h = vi.hoisted(() => ({
  buildSessionModelList: vi.fn(),
  log: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // 只换日志出口：sub_task 的可观测性是本次要钉的行为，其余级别用空替身即可。
  runLogger: { debug: vi.fn(), log: h.log, warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../session/buildSessionModelList.js', () => ({
  buildSessionModelList: h.buildSessionModelList,
}));

function setup(options: { enabled?: boolean } = {}) {
  h.buildSessionModelList.mockReset();
  h.buildSessionModelList.mockReturnValue([{ modelId: 'auto' }]);

  // 假宿主：扣住每次反向请求的落定权，替代旧的 pendingRequests + emit 帧捕获。
  const controllers: Array<{
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const getModelPolicy = vi.fn(
    (
      _payload: unknown,
      _options?: ThreadReverseRequestOptions,
    ): Promise<unknown> =>
      new Promise<unknown>((resolve, reject) => {
        controllers.push({ resolve, reject });
      }),
  );
  let enabled = options.enabled ?? true;
  const callback = createModelPolicyCallback({
    sessionId: 's-1',
    getModelPolicy,
    isEnabled: () => enabled,
  });

  return {
    callback,
    getModelPolicy,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    /** 发起一次策略请求，拿到 promise 与「Host 回什么」的控制器。 */
    start: (signal?: AbortSignal) => {
      const promise = callback('main' as never, 's-1', 3, 'agent-1', signal);
      const controller = controllers[controllers.length - 1]!;
      return {
        promise,
        respond: (value: unknown) => controller.resolve(value),
        rejectWith: (reason: unknown) => controller.reject(reason),
      };
    },
  };
}

describe('createModelPolicyCallback: 门禁', () => {
  it('未声明 modelPolicyProvider 时返回 undefined 且一次反向请求都不发', async () => {
    const harness = setup({ enabled: false });
    await expect(
      harness.callback('main' as never, 's-1', 0),
    ).resolves.toBeUndefined();
    expect(harness.getModelPolicy).not.toHaveBeenCalled();
  });
});

describe('createModelPolicyCallback: 请求负载', () => {
  it('负载是产品级字段集（不带 subtype 信封），模型表由宿主补齐', async () => {
    const harness = setup();
    const { respond, promise } = harness.start();
    respond(undefined);
    await promise;

    const payload = harness.getModelPolicy.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      purpose: 'main',
      sessionId: 's-1',
      turnIndex: 3,
      agentId: 'agent-1',
    });
    expect(payload).not.toHaveProperty('subtype');
    expect(payload).not.toHaveProperty('models');
  });

  it('调用方的中止信号经 options.signal 透传给宿主', async () => {
    const harness = setup();
    const abort = new AbortController();
    const { respond, promise } = harness.start(abort.signal);
    expect(harness.getModelPolicy.mock.calls[0]![1]).toEqual({
      signal: abort.signal,
    });
    respond(undefined);
    await promise;
  });
});

describe('createModelPolicyCallback: 三态归一化', () => {
  it('Host 回 undefined / null 是「明确不覆盖」，返回 undefined 且不抛', async () => {
    const harness = setup();
    const first = harness.start();
    first.respond(undefined);
    await expect(first.promise).resolves.toBeUndefined();

    const second = setup().start();
    second.respond(null);
    await expect(second.promise).resolves.toBeUndefined();
  });

  it('合法策略原样归一化返回', async () => {
    const harness = setup();
    const { promise, respond } = harness.start();
    respond({
      model: 'auto',
      parameters: { contextWindow: 200000, reasoningEffort: 'high' },
      task_id: '  t-1  ',
      sub_task: 'st-1',
    });

    await expect(promise).resolves.toEqual({
      model: 'auto',
      parameters: { contextWindow: 200000, reasoningEffort: 'high' },
      labels: { taskId: 't-1', subTask: 'st-1' },
    });
  });

  it('原样透传宿主提供的渠道，不在会话重复归一化', async () => {
    const { promise, respond } = setup().start();
    respond({
      model: 'cmcc/model',
      parameters: { outerProvider: ' CMCC ' },
    });
    await expect(promise).resolves.toEqual({
      model: 'cmcc/model',
      parameters: { outerProvider: ' CMCC ' },
    });
  });

  it.each([
    ['合法形状', { model: 'auto', custom_model: { api_key: 'k', provider: 'p' } }],
    ['不是对象', { model: 'auto', custom_model: 'nope' }],
    ['没带 model', { custom_model: { api_key: 'k', url: 'u' } }],
  ])('custom_model %s 一律拒绝，不回落平台模型', async (_label, response) => {
    const harness = setup();
    const { promise, respond } = harness.start();
    respond(response);
    await expect(promise).rejects.toThrow(
      'get_model_policy custom_model is not supported',
    );
  });

  it('空标签被丢掉，全空时不出现 labels 字段', async () => {
    const harness = setup();
    const { promise, respond } = harness.start();
    respond({ model: 'auto', task_id: '   ' });
    await expect(promise).resolves.toEqual({ model: 'auto' });
  });

  it('三个字段全缺时是「不覆盖」，返回 undefined', async () => {
    const harness = setup();
    const { promise, respond } = harness.start();
    respond({});
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('createModelPolicyCallback: 非法响应必须抛，不回落', () => {
  it.each([
    ['响应不是对象', 'plain string'],
    ['parameters 不是对象', { model: 'auto', parameters: 'nope' }],
    ['渠道不是字符串', { parameters: { outerProvider: 1 } }],
    ['渠道为空', { parameters: { outerProvider: '' } }],
  ])('%s', async (_label, response) => {
    const harness = setup();
    const { promise, respond } = harness.start();
    respond(response);
    await expect(promise).rejects.toThrow(
      /get_model_policy returned invalid response/,
    );
  });

  it('Host 拒绝时原样抛出——策略失败不等于无覆盖', async () => {
    const harness = setup();
    const { promise, rejectWith } = harness.start();
    const reason = new Error('host said no');
    rejectWith(reason);
    await expect(promise).rejects.toBe(reason);
  });

  it('超时抛 get_model_policy timeout', async () => {
    vi.useFakeTimers();
    try {
      const harness = setup();
      const { promise } = harness.start();
      // 拨表之前先给 promise 挂一个 handler：定时器在 advanceTimersByTimeAsync **内部**
      // 就会拒掉它，处理函数晚挂一步就变成 unhandled rejection，污染整个测试文件。
      // 断言本身仍然正常 await，这样才满足 vitest/valid-expect。
      void promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(promise).rejects.toThrow(/get_model_policy timeout/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createModelPolicyCallback: sub_task 可观测性', () => {
  // 背景：sub_task 此前在默认日志里完全不可见——BusinessInfo 的 JSON 日志是 debug 级
  // 且仅子代理分支，其余路径拿不到它。"宿主以为设了其实没生效"因此无从排查，
  // 这里钉住默认级别的那条日志。

  beforeEach(() => {
    h.log.mockClear();
  });

  function policyLogLine() {
    return h.log.mock.calls.find(
      (call) => call[0] === '[model-policy] resolveModel 回包标签',
    )?.[1] as Record<string, unknown> | undefined;
  }

  it('resolveModel 回包的 sub_task / task_id 以默认级别落日志', async () => {
    const harness = setup();
    const { respond, promise } = harness.start();
    respond({ model: 'auto', sub_task: 'awareness_nudge', task_id: 't-1' });
    await promise;

    const line = policyLogLine();
    expect(line).toMatchObject({
      sessionId: 's-1',
      purpose: 'main',
      sub_task: 'awareness_nudge',
      task_id: 't-1',
    });
  });

  it('宿主没回标签时写 (未设置) 而不是静默缺行：缺行与未设置必须可区分', async () => {
    const harness = setup();
    const { respond, promise } = harness.start();
    respond({ model: 'auto' });
    await promise;

    expect(policyLogLine()).toMatchObject({
      sub_task: '(未设置)',
      task_id: '(未设置)',
    });
  });

  it('宿主可控的超长标签截断到 64 字符，不把 run 日志撑爆', async () => {
    const harness = setup();
    const { respond, promise } = harness.start();
    respond({ sub_task: 'x'.repeat(200) });
    await promise;

    expect(String(policyLogLine()?.['sub_task']).length).toBe(64);
  });
});
