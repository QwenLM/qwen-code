/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `SessionCommandManager` 的行为门禁。
 *
 * 被保护的不变量（对应方案 §9.2）：
 * 1. `submit` 入队即返回，**不等** turn 跑完——宿主读循环对每帧都要投递，进程内所有会话
 *    共享一个事件循环，在这里跑完一整轮会卡死其余会话；
 * 2. 派发是串行的：一轮在跑时不会并发开第二轮；
 * 3. 忙时来了 `priority:'now'` → 打断当前 turn（抢跑）；
 * 4. 重复 uuid → `disposition:'duplicate'`，且 `messageReplay` **早于** `completed`
 *    （对齐 worker headlessSession.ts:6037 → :6039 的调用序）；
 * 5. 一条命令的终态只报一次：队列报过 `completed` 之后，引擎回放的同 uuid 终态帧被吃掉；
 * 6. `discardQueuedAndReport` 给每条排队命令报 `discarded`；
 * 7. `runExclusive`（`set_goal` kickoff）走同一个 `runTurnGuarded`，即记账唯一；
 * 8. 逃逸出 turn 循环的异常是**会话级不可恢复**：调 `terminate({kind:'runtime_error'})`
 *    交给 Manager 合成 worker 退出，不是报一个 `turnFailed` 就完事。
 * 9. **一轮的终态 result 帧唯一**：`turnFailed` 会被宿主编码成一个合成 result 错误帧，
 *    所以 runner 在 result **已出门之后**才抛的异常（result 后的 prompt-suggestion /
 *    usage flush）不得再报 `turnFailed`——否则上游一轮看到两个终态；result 还没出门时
 *    照报，那是这一轮唯一的 result 来源。记账按轮重置，上一轮的 result 不抑制下一轮。
 *
 * 未覆盖的一条，明确记账：`takeDispatchMessage` 在原始帧映射丢失时**抛**、绝不退回合成帧
 * （合成帧把数组 prompt 塌成 `''` 并强制 `isMeta:true`，用它接主线命令等于把用户输入换成
 * 空 turn）。触发它需要在派发中途操纵 core 的进程级队列映射，本文件没有可靠手段；
 * 该不变量目前只由代码注释与方案 §6.2 第 2 条守着，见方案 §9.3 扰动 6。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetQueueForTest,
  enqueuePendingNotification,
  type InboundUserMessage,
  type SDKMessage,
} from '@qwen-code/core';
import type {
  ThreadEvent,
  ThreadTerminationReason,
} from '../contract/hostContext.js';
import {
  SessionCommandManager,
  type SessionCommandManagerDeps,
} from './sessionCommandManager.js';

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function userMessage(
  text: string,
  extra: Partial<InboundUserMessage> = {},
): InboundUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...extra,
  } as InboundUserMessage;
}

/** 让出到微任务队列排空：pump 是 queueMicrotask 驱动的。 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

interface Harness {
  manager: SessionCommandManager;
  events: ThreadEvent[];
  terminations: ThreadTerminationReason[];
  aborts: number;
  turnCalls: Array<{ msg: InboundUserMessage; uuid?: string }>;
  /** 让 runTurn 挂住，由测试决定何时结算。 */
  gate: {
    promise: Promise<'completed' | 'cancelled'>;
    resolve: (v: 'completed' | 'cancelled') => void;
  } | null;
  lifecycles(): Array<{ uuid?: string; state: string }>;
}

function makeHarness(
  overrides: Partial<SessionCommandManagerDeps> = {},
  opts: { blockTurn?: boolean; throwOnEmit?: boolean } = {},
): Harness {
  const events: ThreadEvent[] = [];
  const terminations: ThreadTerminationReason[] = [];
  const turnCalls: Array<{ msg: InboundUserMessage; uuid?: string }> = [];
  const persisted = new Set<string>();
  let aborts = 0;
  let gate: Harness['gate'] = null;

  const h: Harness = {
    manager: undefined as unknown as SessionCommandManager,
    events,
    terminations,
    get aborts() {
      return aborts;
    },
    turnCalls,
    get gate() {
      return gate;
    },
    lifecycles: () =>
      events
        .filter((e) => e.kind === 'commandLifecycle')
        .map((e) => {
          const c = e as { commandUuid?: string; state: string };
          return { uuid: c.commandUuid, state: c.state };
        }),
  };

  const deps: SessionCommandManagerDeps = {
    sessionId: SESSION,
    emit: (event) => {
      // 只对**终态**抛：`submit` 里的 queued 上报不在 runPump 的 try 内，那里抛只会让
      // submit 拒绝，测不到派发循环的 catch。终态由 runQueuedCommand 上报，正好在 try 内。
      if (
        opts.throwOnEmit &&
        event.kind === 'commandLifecycle' &&
        event.state === 'completed'
      ) {
        throw new Error('emit exploded');
      }
      events.push(event);
    },
    isTerminated: () => false,
    runTurn: async (msg, _controller, commandUuid) => {
      turnCalls.push({ msg, ...(commandUuid ? { uuid: commandUuid } : {}) });
      // 真实 runTurn 的契约：controller 装好之后、模型调用之前报 started。
      // 假实现不履行这条，started 就永远不会出现，断言会假绿。
      h.manager.reportStarted(commandUuid ?? msg.uuid);
      if (opts.blockTurn) {
        let resolve!: (v: 'completed' | 'cancelled') => void;
        const promise = new Promise<'completed' | 'cancelled'>((r) => {
          resolve = r;
        });
        gate = { promise, resolve };
        return promise;
      }
      return 'completed';
    },
    abortRunner: () => {
      aborts += 1;
    },
    hasPersistedUuid: (uuid) => persisted.has(uuid),
    terminate: (reason) => terminations.push(reason),
    ...overrides,
  };
  h.manager = new SessionCommandManager(deps);
  return h;
}

beforeEach(() => {
  _resetQueueForTest();
});

describe('SessionCommandManager', () => {
  it.each(['next', 'now', 'later'] as const)(
    'settles rejected %s input without queueing or interrupting the active turn',
    async (priority) => {
      const h = makeHarness({}, { blockTurn: true });
      h.manager.attach();
      try {
        await h.manager.submit(userMessage('running', { uuid: 'active' }));
        await flush();
        const rejection = new Error('Mode disabled');
        await expect(h.manager.submit(
          userMessage('blocked', { uuid: 'blocked', priority }), rejection,
        )).resolves.toEqual({ commandUuid: 'blocked', disposition: 'rejected' });
        expect(h.events).toContainEqual({ kind: 'turnFailed', error: rejection });
        expect(h.lifecycles().filter((e) => e.uuid === 'blocked')).toEqual([
          { uuid: 'blocked', state: 'queued' },
          { uuid: 'blocked', state: 'cancelled' },
        ]);
        expect(h.manager.queuedUuids()).toEqual([]);
        expect(h.manager.isTurnRunning()).toBe(true);
        expect(h.aborts).toBe(0);
        expect(h.turnCalls).toHaveLength(1);
        await expect(h.manager.submit(userMessage('replay', { uuid: 'blocked' })))
          .resolves.toMatchObject({ disposition: 'duplicate' });
        expect(h.events.filter((e) => e.kind === 'turnFailed')).toHaveLength(1);
        h.gate!.resolve('completed');
        await flush();
        expect(h.lifecycles().filter((e) => e.uuid === 'active')).toEqual([
          { uuid: 'active', state: 'queued' },
          { uuid: 'active', state: 'started' },
          { uuid: 'active', state: 'completed' },
        ]);
        expect(h.turnCalls).toHaveLength(1);
      } finally {
        h.gate?.resolve('completed');
        h.manager.dispose();
      }
    },
  );

  it('carries customContext into a synthetic task-notification continuation', async () => {
    const h = makeHarness();
    h.manager.attach();
    const customContext = Object.freeze({ tenant: 'alpha' });

    enqueuePendingNotification({
      prompt: '<task-notification>done</task-notification>',
      commandMode: 'task-notification',
      priority: 'next',
      sessionId: SESSION,
      customContext,
    });
    await flush(20);

    expect(h.turnCalls).toHaveLength(1);
    expect(h.turnCalls[0]?.msg.custom_context).toEqual(customContext);
    h.manager.dispose();
  });

  it('waits for cancelled turn terminal frames before releasing the session host', async () => {
    const h = makeHarness({}, { blockTurn: true });
    h.manager.attach();
    await h.manager.submit(userMessage('sleep', { uuid: 'closing-command' }));
    await flush();
    let closed = false;
    const closing = h.manager.cancelAndDrain().then(() => { closed = true; });
    await flush();
    expect(h.aborts).toBe(1);
    expect(closed).toBe(false);
    h.gate!.resolve('cancelled');
    await closing;
    expect(h.lifecycles().at(-1)?.state).toBe('cancelled');
    h.manager.dispose();
  });

  it('submit 入队即返回，不等 turn 跑完', async () => {
    const h = makeHarness({}, { blockTurn: true });
    h.manager.attach();
    const result = await h.manager.submit(userMessage('hi'));
    // submit 已经结算，而 turn 还挂着——这就是「绝不卡住宿主读循环」的含义。
    expect(result).toEqual({ commandUuid: undefined, disposition: 'queued' });
    await flush();
    expect(h.turnCalls).toHaveLength(1);
    expect(h.gate).not.toBeNull();
    h.gate?.resolve('completed');
    await flush();
  });

  it('派发是串行的：一轮在跑时不会并发开第二轮', async () => {
    const h = makeHarness({}, { blockTurn: true });
    h.manager.attach();
    await h.manager.submit(userMessage('one'));
    await flush();
    expect(h.turnCalls).toHaveLength(1);
    // 第一条还挂着，再投两条：pump 会因 turnRunning 立即退出，不并发派发。
    await h.manager.submit(userMessage('two'));
    await h.manager.submit(userMessage('three'));
    await flush();
    expect(h.turnCalls).toHaveLength(1);
    // 第一条还在跑，后两条应当仍在排队（或已在跑）——总之没被丢掉、也没并发开第二轮。
    expect(
      h.manager.queuedUuids().length > 0 || h.manager.isTurnRunning(),
    ).toBe(true);
    h.gate?.resolve('completed');
    await flush(20);
  });

  it('忙时来了 priority:now → 打断当前 turn', async () => {
    const h = makeHarness({}, { blockTurn: true });
    h.manager.attach();
    await h.manager.submit(userMessage('one'));
    await flush();
    expect(h.turnCalls).toHaveLength(1);
    expect(h.aborts).toBe(0);
    await h.manager.submit(userMessage('urgent', { priority: 'now' }));
    await flush();
    expect(h.aborts).toBe(1);
    h.gate?.resolve('cancelled');
    await flush(20);
  });

  it('重复 uuid：disposition duplicate，且 messageReplay 早于 completed', async () => {
    const h = makeHarness({
      hasPersistedUuid: () => true,
    });
    h.manager.attach();
    const result = await h.manager.submit(
      userMessage('again', { uuid: 'dup-1' }),
    );
    expect(result).toEqual({ commandUuid: 'dup-1', disposition: 'duplicate' });
    // 顺序是契约：宿主按 commandUuid 记账，completed 先到会让 replay 帧无处安放。
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.indexOf('messageReplay')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('messageReplay')).toBeLessThan(
      kinds.indexOf('commandLifecycle'),
    );
    expect(h.lifecycles()).toEqual([{ uuid: 'dup-1', state: 'completed' }]);
    // 重复投递不重跑这一轮。
    expect(h.turnCalls).toHaveLength(0);
  });

  it('终态只报一次：队列报过 completed 之后，引擎回放的同 uuid 终态被吃掉', async () => {
    const h = makeHarness();
    h.manager.attach();
    await h.manager.submit(userMessage('hi', { uuid: 'cmd-1' }));
    await flush(20);
    expect(h.lifecycles()).toEqual([
      { uuid: 'cmd-1', state: 'queued' },
      { uuid: 'cmd-1', state: 'started' },
      { uuid: 'cmd-1', state: 'completed' },
    ]);
    const replayed = {
      type: 'command_lifecycle',
      command_uuid: 'cmd-1',
      state: 'completed',
    } as unknown as SDKMessage;
    expect(h.manager.shouldForwardEngineMessage(replayed)).toBe(false);
    // 非终态与别的 uuid 不受影响。
    const other = {
      type: 'command_lifecycle',
      command_uuid: 'cmd-2',
      state: 'completed',
    } as unknown as SDKMessage;
    expect(h.manager.shouldForwardEngineMessage(other)).toBe(true);
  });

  it('discardQueuedAndReport 给每条排队命令报 discarded', async () => {
    const h = makeHarness({}, { blockTurn: true });
    h.manager.attach();
    await h.manager.submit(userMessage('one', { uuid: 'u1' }));
    await flush();
    await h.manager.submit(userMessage('two', { uuid: 'u2' }));
    await h.manager.submit(userMessage('three', { uuid: 'u3' }));
    await flush();
    h.manager.discardQueuedAndReport();
    const discarded = h
      .lifecycles()
      .filter((l) => l.state === 'discarded')
      .map((l) => l.uuid);
    expect(discarded).toEqual(['u2', 'u3']);
    h.gate?.resolve('cancelled');
    await flush(20);
  });

  it('runExclusive 走同一个 runTurnGuarded：其间 isTurnRunning 为真', async () => {
    let runningInside = false;
    const h = makeHarness({
      runTurn: async () => {
        runningInside = h.manager.isTurnRunning();
        return 'completed';
      },
    });
    h.manager.attach();
    expect(h.manager.isTurnRunning()).toBe(false);
    await h.manager.runExclusive(userMessage('kickoff'));
    expect(runningInside).toBe(true);
    expect(h.manager.isTurnRunning()).toBe(false);
  });

  it('逃逸出派发循环的异常 → terminate(runtime_error)，不是只报 turnFailed', async () => {
    // runTurnGuarded 兜住的是 turn 内部异常（报 turnFailed、会话继续活着）。
    // 这里让 emit 抛，模拟逃逸到 runPump 的异常：那是会话级不可恢复。
    const h = makeHarness({}, { throwOnEmit: true });
    h.manager.attach();
    await h.manager.submit(userMessage('hi', { uuid: 'boom-1' }));
    await flush(20);
    expect(h.terminations).toHaveLength(1);
    expect(h.terminations[0]?.kind).toBe('runtime_error');
  });

  it('turn 内部异常只报 turnFailed，会话不被 terminate', async () => {
    // 与上一条对照：同一个 catch 分两层，语义完全不同。
    const h = makeHarness({
      runTurn: async () => {
        throw new Error('turn blew up');
      },
    });
    h.manager.attach();
    await h.manager.submit(userMessage('hi', { uuid: 'x1' }));
    await flush(20);
    expect(h.terminations).toHaveLength(0);
    expect(h.events.some((e) => e.kind === 'turnFailed')).toBe(true);
    // 兜住之后仍然报终态，否则宿主的命令状态机一直挂着。
    expect(h.lifecycles().some((l) => l.state === 'cancelled')).toBe(true);
  });

  it('result 帧已出门后才抛的 turn 不再报 turnFailed：终态 result 唯一', async () => {
    const h = makeHarness({
      runTurn: async (msg, _controller, commandUuid) => {
        h.manager.reportStarted(commandUuid ?? msg.uuid);
        // 真实 runTurn 的消费循环对每条引擎产出都调 shouldForwardEngineMessage，
        // result 帧就是从那里转发给宿主的；这里只走到观察点，转发本身归宿主。
        const forwarded = h.manager.shouldForwardEngineMessage({
          type: 'result',
          subtype: 'success',
          is_error: false,
        } as unknown as SDKMessage);
        expect(forwarded).toBe(true);
        // result 之后的收尾（prompt-suggestion / usage flush）炸了。
        throw new Error('post-result flush blew up');
      },
    });
    h.manager.attach();
    await h.manager.submit(userMessage('hi', { uuid: 'r1' }));
    await flush(20);
    // turnFailed 会被宿主再编码成一个合成 result 错误帧——报出去就是一轮两个终态。
    expect(h.events.some((e) => e.kind === 'turnFailed')).toBe(false);
    // 命令生命周期终态照报，宿主的命令状态机不能挂着；会话也不 terminate。
    expect(h.lifecycles().some((l) => l.state === 'cancelled')).toBe(true);
    expect(h.terminations).toHaveLength(0);
  });

  it('没产出 result 帧就抛时 turnFailed 照报：它是这一轮唯一的 result 来源', async () => {
    const h = makeHarness({
      runTurn: async (msg, _controller, commandUuid) => {
        h.manager.reportStarted(commandUuid ?? msg.uuid);
        h.manager.shouldForwardEngineMessage({
          type: 'assistant',
        } as unknown as SDKMessage);
        throw new Error('blew up before result');
      },
    });
    h.manager.attach();
    await h.manager.submit(userMessage('hi', { uuid: 'r2' }));
    await flush(20);
    expect(h.events.filter((e) => e.kind === 'turnFailed')).toHaveLength(1);
  });

  it('result 记账按轮重置：上一轮的 result 不抑制下一轮的 turnFailed', async () => {
    let firstTurn = true;
    const h = makeHarness({
      runTurn: async (msg, _controller, commandUuid) => {
        h.manager.reportStarted(commandUuid ?? msg.uuid);
        if (firstTurn) {
          firstTurn = false;
          h.manager.shouldForwardEngineMessage({
            type: 'result',
            subtype: 'success',
          } as unknown as SDKMessage);
          return 'completed';
        }
        throw new Error('second turn blew up before result');
      },
    });
    h.manager.attach();
    await h.manager.submit(userMessage('one', { uuid: 'a1' }));
    await flush(20);
    await h.manager.submit(userMessage('two', { uuid: 'a2' }));
    await flush(20);
    expect(h.events.filter((e) => e.kind === 'turnFailed')).toHaveLength(1);
  });

  it('interruptTurn 只在真有 controller 时 abort runner', () => {
    const h = makeHarness();
    h.manager.interruptTurn();
    expect(h.aborts).toBe(0);
  });

  it('关闭时中止当前 turn，并等待它完成终态输出', async () => {
    const h = makeHarness({}, { blockTurn: true });
    h.manager.attach();
    await h.manager.submit(userMessage('closing', { uuid: 'close-1' }));
    await flush();

    let settled = false;
    const waiting = h.manager
      .cancelAndDrain()
      .then(() => {
        settled = true;
      });
    await flush();

    expect(h.aborts).toBe(1);
    expect(settled).toBe(false);

    h.gate?.resolve('cancelled');
    await waiting;
    expect(h.lifecycles()).toContainEqual({
      uuid: 'close-1',
      state: 'cancelled',
    });
  });

  it('dispose 之后不再响应全局队列变更', async () => {
    const h = makeHarness({}, { blockTurn: true });
    h.manager.attach();
    h.manager.dispose();
    const spy = vi.spyOn(h.manager, 'isTurnRunning');
    await h.manager.submit(userMessage('hi'));
    await flush();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('prompt suggestion 取消', () => {
  function makeCancellingHarness() {
    const cancelPromptSuggestion = vi.fn();
    const h = makeHarness({ cancelPromptSuggestion });
    h.manager.attach();
    return { h, cancelPromptSuggestion };
  }

  it('忙时本会话来了新命令：取消在途 suggestion，不打断 turn', async () => {
    const cancelPromptSuggestion = vi.fn();
    const h = makeHarness({ cancelPromptSuggestion }, { blockTurn: true });
    h.manager.attach();
    await h.manager.submit(userMessage('first'));
    await flush(10);
    expect(h.gate).not.toBeNull();

    await h.manager.submit(userMessage('second'));
    await flush(10);

    expect(cancelPromptSuggestion).toHaveBeenCalled();
    // 非 priority 命令不抢跑：turn 仍在跑。
    expect(h.turnCalls).toHaveLength(1);
    h.gate?.resolve('completed');
    await flush(10);
    h.manager.dispose();
  });

  it('闲时新命令入队：取消一次并立即派发', async () => {
    const { h, cancelPromptSuggestion } = makeCancellingHarness();
    await h.manager.submit(userMessage('hello'));
    await flush(10);

    expect(cancelPromptSuggestion).toHaveBeenCalled();
    expect(h.turnCalls).toHaveLength(1);
    h.manager.dispose();
  });

  it('其他会话的命令不触发本会话取消', async () => {
    const { h, cancelPromptSuggestion } = makeCancellingHarness();
    await h.manager.submit(userMessage('mine'));
    await flush(10);
    cancelPromptSuggestion.mockClear();

    enqueuePendingNotification({
      prompt: 'theirs',
      commandMode: 'prompt',
      priority: 'next',
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    await flush(10);

    expect(cancelPromptSuggestion).not.toHaveBeenCalled();
    h.manager.dispose();
  });
});
