/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { ResumeReadError } from '@qwen-code/core';
import {
  createSessionHooks,
  type SessionHooksContext,
} from './sessionHooks.js';

function fixture() {
  const controller = new AbortController();
  let hookSignal: AbortSignal | undefined;
  let finished = false;
  const start = vi.fn((_source, _model, signal: AbortSignal) => {
    hookSignal = signal;
    return new Promise<void>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          finished = true;
          resolve();
        },
        { once: true },
      );
    });
  });
  const end = vi.fn(async () => {});
  const runner = { queueHookOutput: vi.fn() };
  const hooks = createSessionHooks({
    sessionId: 'cancel-start',
    signal: controller.signal,
    isTerminated: () => false,
    isResume: () => false,
    getConfig: () => ({
      getHookSystem: () => ({
        fireSessionStartEvent: start,
        fireSessionEndEvent: end,
      }),
      getModel: () => 'auto',
    }),
    peekQueryRunner: () => runner,
    ensureQueryRunner: async () => runner,
  } as unknown as SessionHooksContext);
  return {
    hooks,
    controller,
    start,
    end,
    runner,
    signal: () => hookSignal,
    finished: () => finished,
  };
}

describe('SessionStart 恢复失败契约', () => {
  it('类型化恢复失败原样传播，不触发 SessionStart；普通 hook 执行失败仍非致命', async () => {
    const failure = new ResumeReadError('budget');
    const fire = vi.fn(async () => {
      throw new Error('ordinary hook failure');
    });
    const runner = { queueHookOutput: vi.fn() };
    let failResume = true;
    const hooks = createSessionHooks({
      sessionId: 'resume-hook',
      signal: new AbortController().signal,
      isTerminated: () => false,
      isResume: () => true,
      ensureQueryRunner: async () => {
        if (failResume) throw failure;
        return runner;
      },
      peekQueryRunner: () => runner,
      getConfig: () => ({
        getModel: () => 'auto',
        getHookSystem: () => ({ fireSessionStartEvent: fire }),
      }),
    } as unknown as SessionHooksContext);
    await expect(hooks.ensureStart()).rejects.toBe(failure);
    expect(fire).not.toHaveBeenCalled();
    failResume = false;
    await expect(hooks.ensureStart()).resolves.toBeUndefined();
    expect(runner.queueHookOutput).not.toHaveBeenCalled();
  });
});

describe('SessionStart cancellation', () => {
  it.each(['interrupt', 'session-close'])(
    'propagates %s to the running hook and preserves SessionEnd',
    async (kind) => {
      const f = fixture();
      const pending = f.hooks.ensureStart();
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
      if (kind === 'interrupt') f.hooks.cancelStart();
      else f.controller.abort();
      await pending;
      expect(f.signal()?.aborted).toBe(true);
      expect(f.finished()).toBe(true);
      expect(f.runner.queueHookOutput).not.toHaveBeenCalled();
      await f.hooks.ensureStart();
      expect(f.start).toHaveBeenCalledOnce();
      await f.hooks.fireEnd();
      expect(f.end).toHaveBeenCalledOnce();
      if (kind === 'interrupt') expect(f.controller.signal.aborted).toBe(false);
    },
  );

  it('an idle interrupt does not suppress a future first startup', async () => {
    const f = fixture();
    f.hooks.cancelStart();
    const pending = f.hooks.ensureStart();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.hooks.cancelStart();
    await pending;
  });
});
