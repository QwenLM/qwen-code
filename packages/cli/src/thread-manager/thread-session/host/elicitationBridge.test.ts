/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * elicitation 桥的不变量：
 * 1. **payload 的条件字段用 `in` + 真值判定**，SDK 侧按字段是否存在分支，
 *    用解构默认值会把「显式传了空串」和「没传」混成一件事。
 * 2. **action 白名单**：只有 accept / decline / cancel 能透传，其余一律回落 cancel——
 *    这条回落也是 MCP client 在没有桥时的行为，所以桥坏了不会放大成协议错误。
 * 3. **content 只在 accept 且确实是对象时透传**，decline / cancel 带内容一律丢弃。
 *
 * 帧不再是本模块的产出：请求走宿主的 `elicit`（payload 不带 subtype 信封），完成
 * 通知走 `elicitationCompleted` 语义通知（type / subtype / uuid / session_id 信封
 * 由宿主编解码器补齐）。这里锁的就是这两件产品级形状。
 */

import { describe, expect, it, vi } from 'vitest';
import { OutputFormat, type Config } from '@qwen-code/core';
import { installElicitationBridge } from './elicitationBridge.js';

interface ElicitationBridge {
  requestElicitation: (
    serverName: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ action: string; content?: Record<string, unknown> }>;
  notifyElicitationComplete: (
    serverName: string,
    elicitationId: string,
  ) => void;
}

function setup(outputFormat = OutputFormat.STREAM_JSON) {
  let bridge: ElicitationBridge | undefined;
  const config = {
    getOutputFormat: () => outputFormat,
    getElicitationHost: () => ({
      setElicitationBridge: (value: ElicitationBridge) => {
        bridge = value;
      },
    }),
  } as unknown as Config;
  const emitNotice = vi.fn();
  const elicit = vi.fn();
  installElicitationBridge({
    config,
    sessionId: 's-1',
    emitNotice,
    elicit,
  });
  return {
    bridge: () => {
      if (!bridge) throw new Error('bridge not installed');
      return bridge;
    },
    installed: () => bridge !== undefined,
    emitNotice,
    elicit,
  };
}

describe('installElicitationBridge', () => {
  it('非 stream-json 输出不装桥', () => {
    const harness = setup(OutputFormat.JSON);
    expect(harness.installed()).toBe(false);
  });

  it('必带字段恒在，条件字段只在 in 且真值时出现', async () => {
    const harness = setup();
    harness.elicit.mockResolvedValue({ action: 'decline' });

    await harness.bridge().requestElicitation('srv', { message: 'hi' });
    // subtype 信封归宿主，payload 只剩上游协议定义的数据字段。
    expect(harness.elicit.mock.calls[0]![0]).toEqual({
      mcp_server_name: 'srv',
      message: 'hi',
    });

    await harness.bridge().requestElicitation('srv', {
      message: 'hi',
      mode: '',
      url: undefined,
      elicitationId: 'e-1',
      requestedSchema: { type: 'object' },
    });
    const payload = harness.elicit.mock.calls[1]![0];
    // mode 是空串、url 是 undefined：`in` 为真但真值判定为假，两个都不该出现。
    expect(payload).not.toHaveProperty('mode');
    expect(payload).not.toHaveProperty('url');
    expect(payload).toMatchObject({
      elicitation_id: 'e-1',
      requested_schema: { type: 'object' },
    });
  });

  it('取消信号经 options.signal 透传给宿主', async () => {
    const harness = setup();
    harness.elicit.mockResolvedValue({ action: 'cancel' });
    const controller = new AbortController();

    await harness
      .bridge()
      .requestElicitation('srv', { message: 'hi' }, controller.signal);
    expect(harness.elicit.mock.calls[0]![1]).toEqual({
      signal: controller.signal,
    });
  });

  it.each([
    ['accept', 'accept'],
    ['decline', 'decline'],
    ['cancel', 'cancel'],
  ])('白名单 action %s 原样透传', async (returned, expected) => {
    const harness = setup();
    harness.elicit.mockResolvedValue({ action: returned });
    await expect(
      harness.bridge().requestElicitation('srv', { message: 'hi' }),
    ).resolves.toEqual({ action: expected });
  });

  it.each([['maybe'], ['ACCEPT'], [''], [42]])(
    '白名单外的 action %p 回落 cancel',
    async (action) => {
      const harness = setup();
      harness.elicit.mockResolvedValue({ action });
      await expect(
        harness.bridge().requestElicitation('srv', { message: 'hi' }),
      ).resolves.toEqual({ action: 'cancel' });
    },
  );

  it('响应不是对象时回落 cancel', async () => {
    const harness = setup();
    harness.elicit.mockResolvedValue(undefined);
    await expect(
      harness.bridge().requestElicitation('srv', { message: 'hi' }),
    ).resolves.toEqual({ action: 'cancel' });
  });

  it('content 只在 accept 且是对象时透传', async () => {
    const harness = setup();

    harness.elicit.mockResolvedValue({
      action: 'accept',
      content: { token: 'abc' },
    });
    await expect(
      harness.bridge().requestElicitation('srv', { message: 'hi' }),
    ).resolves.toEqual({ action: 'accept', content: { token: 'abc' } });

    harness.elicit.mockResolvedValue({
      action: 'decline',
      content: { token: 'abc' },
    });
    await expect(
      harness.bridge().requestElicitation('srv', { message: 'hi' }),
    ).resolves.toEqual({ action: 'decline' });

    harness.elicit.mockResolvedValue({
      action: 'accept',
      content: 'not-an-object',
    });
    await expect(
      harness.bridge().requestElicitation('srv', { message: 'hi' }),
    ).resolves.toEqual({ action: 'accept' });
  });

  it('完成通知只产 elicitationCompleted 语义通知，数据齐全、不带信封', () => {
    const harness = setup();
    harness.bridge().notifyElicitationComplete('srv', 'e-1');

    expect(harness.emitNotice).toHaveBeenCalledWith({
      kind: 'elicitationCompleted',
      payload: { mcp_server_name: 'srv', elicitation_id: 'e-1' },
    });
  });
});
