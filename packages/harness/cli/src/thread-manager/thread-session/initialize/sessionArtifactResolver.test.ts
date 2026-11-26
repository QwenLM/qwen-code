/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `resolve_session_artifacts` 的两条不变量：
 * 1. **必须有上界。** Host 解析产物走它自己的文件系统，慢是常态；10s 超时后要把错误
 *    换成一句带时长的话，而不是让 artifact 刷新队列永久挂住。
 * 2. **取消必须通过信号表达。** 会话不再持有 request_id、也不自己发 control_cancel 帧：
 *    超时与会话中止都收敛到交给宿主的同一个 AbortSignal 上，宿主把一个已中止的信号
 *    翻译成一个已 settle 的失败回执，在途请求不会悬死。测试里的假宿主按同一契约实现。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/core';
import { createHostArtifactRefresh } from './sessionArtifactResolver.js';

const h = vi.hoisted(() => ({
  parseResolveSessionArtifactsResponse: vi.fn(),
}));

vi.mock('../../../session/artifacts/sdkArtifactResolver.js', () => ({
  parseResolveSessionArtifactsResponse: h.parseResolveSessionArtifactsResponse,
}));

interface HostCall {
  payload: unknown;
  signal: AbortSignal | undefined;
  resolve: (response: unknown) => void;
  reject: (error: unknown) => void;
}

function setup() {
  h.parseResolveSessionArtifactsResponse.mockReset();
  const hostCalls: HostCall[] = [];
  const sessionAbort = new AbortController();
  const config = {
    getWorkingDir: () => '/wd',
  } as unknown as Config;
  // 假宿主：按契约在信号 abort 之后把在途请求收成失败（hostContext.ts：信号是
  // 取消在途反向请求的唯一机制），其余时候保持在途，等用例回包驱动。
  const resolveSessionArtifacts = vi.fn(
    (payload: unknown, callOptions?: { signal?: AbortSignal }) =>
      new Promise<unknown>((resolve, reject) => {
        hostCalls.push({
          payload,
          signal: callOptions?.signal,
          resolve,
          reject,
        });
        const onAbort = () => reject(new Error('Request aborted'));
        if (callOptions?.signal?.aborted) {
          onAbort();
          return;
        }
        callOptions?.signal?.addEventListener('abort', onAbort, { once: true });
      }),
  );
  const refresh = createHostArtifactRefresh({
    config,
    sessionId: 's-1',
    resolveSessionArtifacts,
    sessionSignal: sessionAbort.signal,
  });
  const lastCall = () => hostCalls[hostCalls.length - 1]!;
  return {
    refresh,
    resolveSessionArtifacts,
    hostCalls,
    lastCall,
    sessionAbort,
    /** 就地回最后一次反向请求，等价于宿主按自己的关联表把回包路由回来。 */
    replyLast: (response: unknown) => lastCall().resolve(response),
    rejectLast: (error: unknown) => lastCall().reject(error),
  };
}

describe('createHostArtifactRefresh', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('宿主负载带 camelCase 的 localSessionId 与 cwd，响应交给公共解析器', async () => {
    const harness = setup();
    h.parseResolveSessionArtifactsResponse.mockReturnValue([{ path: '/a' }]);

    const promise = harness.refresh();
    expect(harness.lastCall().payload).toEqual({
      localSessionId: 's-1',
      cwd: '/wd',
    });

    harness.replyLast({ artifacts: [] });
    await expect(promise).resolves.toEqual([{ path: '/a' }]);
    expect(h.parseResolveSessionArtifactsResponse).toHaveBeenCalledWith({
      artifacts: [],
    });
  });

  it('超时后抛带时长的错误，且交给宿主的信号已中止（取消在途请求）', async () => {
    vi.useFakeTimers();
    const harness = setup();

    const promise = harness.refresh();
    // 拨表之前先给 promise 挂一个 handler：定时器在 advanceTimersByTimeAsync **内部**
    // 就会 abort 并拒掉它，处理函数晚挂一步就变成 unhandled rejection，污染整个测试
    // 文件（vitest 会把它算成 unhandled error）。断言本身仍然正常 await，
    // 这样才满足 vitest/valid-expect。
    void promise.catch(() => {});
    expect(harness.lastCall().signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).rejects.toThrow(
      /resolve_session_artifacts timed out after 10000ms/,
    );
    // 取消不再靠补发取消帧：信号本身就是给宿主的取消指令。
    expect(harness.lastCall().signal?.aborted).toBe(true);
  });

  it('会话中止时通过信号取消在途请求并把错误抛出去', async () => {
    const harness = setup();

    const promise = harness.refresh();
    harness.sessionAbort.abort(new Error('Session closed'));

    await expect(promise).rejects.toThrow();
    expect(harness.lastCall().signal?.aborted).toBe(true);
  });

  it('Host 回错误时原样抛出，不吞成空清单', async () => {
    const harness = setup();
    const promise = harness.refresh();
    const reason = new Error('host could not resolve');
    harness.rejectLast(reason);

    await expect(promise).rejects.toBe(reason);
  });
});
