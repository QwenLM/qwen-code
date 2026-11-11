/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CoreEventEmitter,
  CoreEvent,
  coreEvents,
  type UserFeedbackPayload,
  type McpProgressPayload,
} from './events.js';

vi.mock('./runLogger.js', () => ({
  runLogger: { log: vi.fn() },
}));

describe('CoreEventEmitter', () => {
  let events: CoreEventEmitter;

  beforeEach(() => {
    events = new CoreEventEmitter();
  });

  it('should emit feedback immediately when a listener is present', () => {
    const listener = vi.fn();
    events.on(CoreEvent.UserFeedback, listener);

    const payload = {
      severity: 'info' as const,
      message: 'Test message',
    };

    events.emitFeedback(payload.severity, payload.message);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));
  });

  it('should buffer feedback when no listener is present', () => {
    const listener = vi.fn();
    const payload = {
      severity: 'warning' as const,
      message: 'Buffered message',
    };

    // Emit while no listeners attached
    events.emitFeedback(payload.severity, payload.message);
    expect(listener).not.toHaveBeenCalled();

    // Attach listener and drain
    events.on(CoreEvent.UserFeedback, listener);
    events.drainBacklogs();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));
  });

  it('should respect the backlog size limit and maintain FIFO order', () => {
    const listener = vi.fn();
    const MAX_BACKLOG_SIZE = 10000;

    for (let i = 0; i < MAX_BACKLOG_SIZE + 10; i++) {
      events.emitFeedback('info', `Message ${i}`);
    }

    events.on(CoreEvent.UserFeedback, listener);
    events.drainBacklogs();

    expect(listener).toHaveBeenCalledTimes(MAX_BACKLOG_SIZE);
    // Verify strictly that the FIRST call was Message 10 (0-9 dropped)
    expect(listener.mock.calls[0][0]).toMatchObject({ message: 'Message 10' });
    // Verify strictly that the LAST call was Message 109
    expect(listener.mock.lastCall?.[0]).toMatchObject({
      message: `Message ${MAX_BACKLOG_SIZE + 9}`,
    });
  });

  it('should clear the backlog after draining', () => {
    const listener = vi.fn();
    events.emitFeedback('error', 'Test error');

    events.on(CoreEvent.UserFeedback, listener);
    events.drainBacklogs();
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    events.drainBacklogs();
    expect(listener).not.toHaveBeenCalled();
  });

  it('should include optional error object in payload', () => {
    const listener = vi.fn();
    events.on(CoreEvent.UserFeedback, listener);

    const error = new Error('Original error');
    events.emitFeedback('error', 'Something went wrong', error);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        message: 'Something went wrong',
        error,
      }),
    );
  });

  it('should handle multiple listeners correctly', () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    events.on(CoreEvent.UserFeedback, listenerA);
    events.on(CoreEvent.UserFeedback, listenerB);

    events.emitFeedback('info', 'Broadcast message');

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  it('should preserve display-only transcript metadata', () => {
    const listener = vi.fn();
    events.on(CoreEvent.UserFeedback, listener);

    events.emitFeedback('info', 'Display only', undefined, {
      omitFromTranscript: true,
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'info',
        message: 'Display only',
        omitFromTranscript: true,
      }),
    );
  });

  it('should stop receiving events after off() is called', () => {
    const listener = vi.fn();
    events.on(CoreEvent.UserFeedback, listener);

    events.emitFeedback('info', 'First message');
    expect(listener).toHaveBeenCalledTimes(1);

    events.off(CoreEvent.UserFeedback, listener);
    events.emitFeedback('info', 'Second message');
    expect(listener).toHaveBeenCalledTimes(1); // Still 1
  });

  it('should handle re-entrant feedback emission during draining safely', () => {
    events.emitFeedback('info', 'Buffered 1');
    events.emitFeedback('info', 'Buffered 2');

    const listener = vi.fn((payload: UserFeedbackPayload) => {
      // When 'Buffered 1' is received, immediately emit another event.
      if (payload.message === 'Buffered 1') {
        events.emitFeedback('warning', 'Re-entrant message');
      }
    });

    events.on(CoreEvent.UserFeedback, listener);
    events.drainBacklogs();

    // Expectation with atomic snapshot:
    // 1. loop starts with ['Buffered 1', 'Buffered 2']
    // 2. emits 'Buffered 1'
    // 3. listener fires for 'Buffered 1', calls emitFeedback('Re-entrant')
    // 4. emitFeedback sees listener attached, emits 'Re-entrant' synchronously
    // 5. listener fires for 'Re-entrant'
    // 6. loop continues, emits 'Buffered 2'
    // 7. listener fires for 'Buffered 2'

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[0][0]).toMatchObject({ message: 'Buffered 1' });
    expect(listener.mock.calls[1][0]).toMatchObject({
      message: 'Re-entrant message',
    });
    expect(listener.mock.calls[2][0]).toMatchObject({ message: 'Buffered 2' });
  });

  describe('ConsoleLog Event', () => {
    it('should emit console log immediately when a listener is present', () => {
      const listener = vi.fn();
      events.on(CoreEvent.ConsoleLog, listener);

      const payload = {
        type: 'info' as const,
        content: 'Test log',
      };

      events.emitConsoleLog(payload.type, payload.content);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));
    });

    it('should buffer console logs when no listener is present', () => {
      const listener = vi.fn();
      const payload = {
        type: 'warn' as const,
        content: 'Buffered log',
      };

      // Emit while no listeners attached
      events.emitConsoleLog(payload.type, payload.content);
      expect(listener).not.toHaveBeenCalled();

      // Attach listener and drain
      events.on(CoreEvent.ConsoleLog, listener);
      events.drainBacklogs();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));
    });

    it('should respect the backlog size limit for console logs', () => {
      const listener = vi.fn();
      const MAX_BACKLOG_SIZE = 10000;

      for (let i = 0; i < MAX_BACKLOG_SIZE + 10; i++) {
        events.emitConsoleLog('debug', `Log ${i}`);
      }

      events.on(CoreEvent.ConsoleLog, listener);
      events.drainBacklogs();

      expect(listener).toHaveBeenCalledTimes(MAX_BACKLOG_SIZE);
      // Verify strictly that the FIRST call was Log 10 (0-9 dropped)
      expect(listener.mock.calls[0][0]).toMatchObject({ content: 'Log 10' });
    });
  });

  describe('Output Event', () => {
    it('should emit output immediately when a listener is present', () => {
      const listener = vi.fn();
      events.on(CoreEvent.Output, listener);

      const payload = {
        isStderr: false,
        chunk: 'Test output',
        encoding: 'utf8' as BufferEncoding,
      };

      events.emitOutput(payload.isStderr, payload.chunk, payload.encoding);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));
    });

    it('should buffer output when no listener is present', () => {
      const listener = vi.fn();
      const payload = {
        isStderr: true,
        chunk: 'Buffered output',
      };

      // Emit while no listeners attached
      events.emitOutput(payload.isStderr, payload.chunk);
      expect(listener).not.toHaveBeenCalled();

      // Attach listener and drain
      events.on(CoreEvent.Output, listener);
      events.drainBacklogs();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));
    });

    it('should respect the backlog size limit for output', () => {
      const listener = vi.fn();
      const MAX_BACKLOG_SIZE = 10000;

      for (let i = 0; i < MAX_BACKLOG_SIZE + 10; i++) {
        events.emitOutput(false, `Output ${i}`);
      }

      events.on(CoreEvent.Output, listener);
      events.drainBacklogs();

      expect(listener).toHaveBeenCalledTimes(MAX_BACKLOG_SIZE);
      // Verify strictly that the FIRST call was Output 10 (0-9 dropped)
      expect(listener.mock.calls[0][0]).toMatchObject({ chunk: 'Output 10' });
    });
  });

  describe('ModelChanged Event', () => {
    it('should emit ModelChanged event with correct payload', () => {
      const listener = vi.fn();
      events.on(CoreEvent.ModelChanged, listener);

      const newModel = 'gemini-2.5-pro';
      events.emitModelChanged('sess-1', newModel);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        model: newModel,
      });
    });
  });

  describe('ModelInfoChanged Event', () => {
    it('should emit ModelInfoChanged event', () => {
      const listener = vi.fn();
      events.on(CoreEvent.ModelInfoChanged, listener);

      events.emitModelInfoChanged();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith();
    });
  });

  describe('ConsentRequest Event', () => {
    it('should emit consent request immediately when a listener is present', () => {
      const listener = vi.fn();
      events.on(CoreEvent.ConsentRequest, listener);

      const payload = {
        prompt: 'Do you consent?',
        onConfirm: vi.fn(),
      };

      events.emitConsentRequest(payload);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);
    });

    it('should buffer consent requests when no listener is present', () => {
      const listener = vi.fn();
      const payload = {
        prompt: 'Buffered consent?',
        onConfirm: vi.fn(),
      };

      // Emit while no listeners attached
      events.emitConsentRequest(payload);
      expect(listener).not.toHaveBeenCalled();

      // Attach listener and drain
      events.on(CoreEvent.ConsentRequest, listener);
      events.drainBacklogs();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);
    });

    it('should respect the backlog size limit for consent requests', () => {
      const listener = vi.fn();
      const MAX_BACKLOG_SIZE = 10000;

      for (let i = 0; i < MAX_BACKLOG_SIZE + 10; i++) {
        events.emitConsentRequest({
          prompt: `Consent ${i}`,
          onConfirm: vi.fn(),
        });
      }

      events.on(CoreEvent.ConsentRequest, listener);
      events.drainBacklogs();

      expect(listener).toHaveBeenCalledTimes(MAX_BACKLOG_SIZE);
      // Verify strictly that the FIRST call was Consent 10 (0-9 dropped)
      expect(listener.mock.calls[0][0]).toMatchObject({ prompt: 'Consent 10' });
    });
  });

  describe('emitMcpProgress validation', () => {
    const basePayload: McpProgressPayload = {
      sessionId: 'test-session',
      serverName: 'test-server',
      callId: 'call-1',
      progressToken: 'token-1',
      progress: 0,
    };

    let listener: ReturnType<typeof vi.fn>;

    afterEach(() => {
      if (listener) {
        coreEvents.off(CoreEvent.McpProgress, listener);
      }
    });

    it('rejects NaN progress', () => {
      listener = vi.fn();
      coreEvents.on(CoreEvent.McpProgress, listener);

      coreEvents.emitMcpProgress({ ...basePayload, progress: NaN });

      expect(listener).not.toHaveBeenCalled();
    });

    it('rejects negative progress', () => {
      listener = vi.fn();
      coreEvents.on(CoreEvent.McpProgress, listener);

      coreEvents.emitMcpProgress({ ...basePayload, progress: -1 });

      expect(listener).not.toHaveBeenCalled();
    });

    it('rejects Infinity progress', () => {
      listener = vi.fn();
      coreEvents.on(CoreEvent.McpProgress, listener);

      coreEvents.emitMcpProgress({ ...basePayload, progress: Infinity });

      expect(listener).not.toHaveBeenCalled();
    });

    it('emits valid progress payload', () => {
      listener = vi.fn();
      coreEvents.on(CoreEvent.McpProgress, listener);

      const payload: McpProgressPayload = {
        ...basePayload,
        progress: 5,
        total: 10,
        message: 'test',
      };
      coreEvents.emitMcpProgress(payload);

      expect(listener).toHaveBeenCalledExactlyOnceWith(payload);
    });
  });

  // 会话归属机制的门禁（§4.2）。onSessionEvent 是过滤的唯一实现：coreEvents 是进程级
  // 单例总线，多会话下每个存活会话都收到所有会话的同名事件，payload.sessionId 是唯一
  // 归属事实。这组测试钉住「按戳过滤」与「退订」两个不变量——改坏 onSessionEvent 的
  // 过滤逻辑（例如去掉 sessionId 比对、或比对写成 !==）必须让这里变红。
  describe('onSessionEvent (会话归属过滤)', () => {
    const turnPayload = (sessionId: string, prompt: string) => ({
      sessionId,
      prompt,
      promptResponse: `resp:${prompt}`,
    });

    it('只投递匹配 sessionId 的事件，丢弃其他会话的', () => {
      const sessionA = vi.fn();
      const sessionB = vi.fn();
      events.onSessionEvent(CoreEvent.TurnComplete, 'sess-A', sessionA);
      events.onSessionEvent(CoreEvent.TurnComplete, 'sess-B', sessionB);

      events.emit(CoreEvent.TurnComplete, turnPayload('sess-A', 'a1'));
      events.emit(CoreEvent.TurnComplete, turnPayload('sess-B', 'b1'));
      events.emit(CoreEvent.TurnComplete, turnPayload('sess-A', 'a2'));

      // A 只看到自己的两条，B 只看到自己的一条——跨会话不泄漏。
      expect(sessionA).toHaveBeenCalledTimes(2);
      expect(sessionA).toHaveBeenNthCalledWith(
        1,
        turnPayload('sess-A', 'a1'),
      );
      expect(sessionA).toHaveBeenNthCalledWith(
        2,
        turnPayload('sess-A', 'a2'),
      );
      expect(sessionB).toHaveBeenCalledExactlyOnceWith(
        turnPayload('sess-B', 'b1'),
      );
    });

    it('返回的退订函数只解绑自己那一份订阅', () => {
      const sessionA = vi.fn();
      const sessionB = vi.fn();
      const unsubA = events.onSessionEvent(
        CoreEvent.TurnComplete,
        'sess-A',
        sessionA,
      );
      events.onSessionEvent(CoreEvent.TurnComplete, 'sess-B', sessionB);

      unsubA();

      events.emit(CoreEvent.TurnComplete, turnPayload('sess-A', 'a1'));
      events.emit(CoreEvent.TurnComplete, turnPayload('sess-B', 'b1'));

      expect(sessionA).not.toHaveBeenCalled();
      expect(sessionB).toHaveBeenCalledExactlyOnceWith(
        turnPayload('sess-B', 'b1'),
      );
    });

    it('同一会话多个订阅者各自独立收事件', () => {
      const first = vi.fn();
      const second = vi.fn();
      events.onSessionEvent(CoreEvent.TurnComplete, 'sess-A', first);
      events.onSessionEvent(CoreEvent.TurnComplete, 'sess-A', second);

      events.emit(CoreEvent.TurnComplete, turnPayload('sess-A', 'a1'));

      expect(first).toHaveBeenCalledExactlyOnceWith(
        turnPayload('sess-A', 'a1'),
      );
      expect(second).toHaveBeenCalledExactlyOnceWith(
        turnPayload('sess-A', 'a1'),
      );
    });
  });

  // §5.2 的落地：监听器上限按存活会话数动态抬高。
  //
  // 为什么必须有这组测试：setMaxListeners 是 coreEvents 上唯一的泄漏信号——生产代码里
  // 那些 listenerCount 调用（outputListeners / context-observer / authConsent）都是
  // 「有没有人听，没人听就走 fallback」，不是泄漏检查。所以两个极端都不行：设 0 拆掉
  // 安全网，死守 15 则让 >15 个会话的 daemon 常态误报。这里钉住四个不变量，其中
  // 「全部退订后回落基线」正是原注释要求的「监听器计数不随会话关闭而增长」替代测试。
  describe('setMaxListeners 按存活会话数动态抬高', () => {
    it('未订阅会话级事件时保持单会话基线 15', () => {
      expect(events.getMaxListeners()).toBe(15);
    });

    it('N 个不同会话订阅后抬高到 15 + N*4，不再误报', () => {
      const unsubs = Array.from({ length: 20 }, (_, i) =>
        events.onSessionEvent(CoreEvent.TurnComplete, `sess-${i}`, () => {}),
      );
      // 20 个会话 > 基线 15：上限若不抬高，Node 会打 MaxListenersExceededWarning。
      expect(events.getMaxListeners()).toBe(15 + 20 * 4);
      expect(events.listenerCount(CoreEvent.TurnComplete)).toBe(20);
      for (const unsub of unsubs) unsub();
    });

    it('全部退订后回落基线（计数不随会话开合而增长）', () => {
      const unsubs = Array.from({ length: 8 }, (_, i) =>
        events.onSessionEvent(CoreEvent.TurnComplete, `sess-${i}`, () => {}),
      );
      expect(events.getMaxListeners()).toBe(15 + 8 * 4);
      for (const unsub of unsubs) unsub();
      expect(events.getMaxListeners()).toBe(15);
      expect(events.listenerCount(CoreEvent.TurnComplete)).toBe(0);
    });

    it('同一会话反复订阅不按会话数抬高上限，泄漏仍会撞线', () => {
      const unsubs = Array.from({ length: 25 }, () =>
        events.onSessionEvent(CoreEvent.TurnComplete, 'sess-A', () => {}),
      );
      // 只有一个不同 sessionId，所以上限只按 1 个会话抬高到 19；而监听器实打实挂了
      // 25 条、已越过上限——真正的泄漏形态（同会话反复订阅不退订）因此仍会告警，
      // 没有被「按会话数抬高」掩盖掉。
      expect(events.getMaxListeners()).toBe(15 + 1 * 4);
      expect(events.listenerCount(CoreEvent.TurnComplete)).toBe(25);
      for (const unsub of unsubs) unsub();
      expect(events.getMaxListeners()).toBe(15);
    });

    it('裸 on() 订阅不计入会话数，单会话运行时仍受基线约束', () => {
      for (let i = 0; i < 3; i++) {
        events.on(CoreEvent.TurnComplete, () => {});
      }
      expect(events.getMaxListeners()).toBe(15);
    });
  });
});
