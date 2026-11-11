/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话 slash 处理的两条不变量。
 *
 * 1. **不继承 worker 的 `/plan` 封禁**。worker 版硬编码返回
 *    `'Plan mode is not available in headless mode.'`，而会话链自己实现了 `plan_mode_v1`
 *    ——照搬会让「控制请求能切进 plan 模式、用户在 prompt 里打 /plan 却被告知这个模式
 *    不存在」这个矛盾一直留着。
 * 2. **CommandService 按会话缓存**。worker 版每条消息新建一个、且 signal 建完即丢；
 *    常驻进程里那是每条消息的命令发现开销加一个无人回收的 controller。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandService = {
  getCommands: vi.fn(() => []),
};
// 显式给出参数签名：mock 工厂要把实参原样转交，`(...args: unknown[])` 转发给一个
// 无参的 vi.fn 会撞 TS2556；而 `mock.calls[0][1]` 要断言 signal 身份，也需要第二个
// 参数在类型上存在。
const createService = vi.fn(
  async (_config: unknown, _signal?: AbortSignal) => commandService,
);
const handleSlash = vi.fn(
  async (
    _input: string,
    _signal: AbortSignal,
    _config: unknown,
    _settings: unknown,
  ) => undefined as unknown,
);

vi.mock('../../../nonInteractiveCliCommands.js', () => ({
  createNonInteractiveCommandService: (config: unknown, signal: AbortSignal) =>
    createService(config, signal),
  handleSlashCommand: (
    input: string,
    signal: AbortSignal,
    config: unknown,
    settings: unknown,
  ) => handleSlash(input, signal, config, settings),
}));

const {
  SessionBridgeSlashDecider,
  createSessionSlashHandler,
  parseCompactInvocation,
} = await import('./sessionSlashCommands.js');

function makeConfig() {
  return {
    getPermissionMode: () => 'default',
  } as never;
}

beforeEach(() => {
  createService.mockClear();
  handleSlash.mockClear();
  commandService.getCommands.mockClear();
});

describe('parseCompactInvocation（逐字镜像自 worker 版）', () => {
  it('认 /compact /compress /summarize 三个别名，并取出自定义指令', () => {
    expect(parseCompactInvocation('/compact')).toEqual({});
    expect(parseCompactInvocation('/compress')).toEqual({});
    expect(parseCompactInvocation('/summarize')).toEqual({});
    expect(parseCompactInvocation('/compact 只保留测试相关内容')).toEqual({
      customInstructions: '只保留测试相关内容',
    });
  });

  it('不认其它命令，返回 null 让它们走正常派发', () => {
    expect(parseCompactInvocation('/model foo')).toBeNull();
    expect(parseCompactInvocation('普通文本')).toBeNull();
  });
});

describe('createSessionSlashHandler', () => {
  it('/plan 不被 headless 文案拒掉（worker 版的行为是错的）', async () => {
    handleSlash.mockResolvedValueOnce(undefined);
    const handler = createSessionSlashHandler(makeConfig(), {});
    const result = await handler('/plan', [], [], [], {
      signal: new AbortController().signal,
      promptId: 'p1',
      userMessageUuid: 'u1',
    } as never);
    // 不认就落回纯文本（false），而不是编一个「这个模式不存在」的错误回执。
    expect(result).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain('not available in headless mode');
  });

  it('/compact 交回执行内核，不在这里处理', async () => {
    const handler = createSessionSlashHandler(makeConfig(), {});
    const result = await handler('/compact', [], [], [], {
      signal: new AbortController().signal,
      promptId: 'p1',
      userMessageUuid: 'u1',
    } as never);
    expect(result).toBe(false);
    expect(handleSlash).not.toHaveBeenCalled();
  });
});

describe('SessionBridgeSlashDecider 的 CommandService 缓存', () => {
  it('多次判定只建一次 service，且用的是会话给的 signal', async () => {
    const sessionSignal = new AbortController().signal;
    const decider = new SessionBridgeSlashDecider(makeConfig(), sessionSignal);
    await decider.decide('/usage');
    await decider.decide('/compact');
    await decider.decide('/model foo');
    expect(createService).toHaveBeenCalledTimes(1);
    expect(createService.mock.calls[0][1]).toBe(sessionSignal);
  });

  it('invalidate 之后重建（命令面随插件/skill 重载变化）', async () => {
    const decider = new SessionBridgeSlashDecider(
      makeConfig(),
      new AbortController().signal,
    );
    await decider.decide('/usage');
    decider.invalidate();
    await decider.decide('/usage');
    expect(createService).toHaveBeenCalledTimes(2);
  });

  it('不是 slash command 时返回 null（按纯文本落下去）', async () => {
    const decider = new SessionBridgeSlashDecider(
      makeConfig(),
      new AbortController().signal,
    );
    expect(await decider.decide('普通文本')).toBeNull();
  });
});
