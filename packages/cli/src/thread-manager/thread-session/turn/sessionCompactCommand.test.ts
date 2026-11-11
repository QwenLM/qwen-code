/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话链手动 `/compact` 执行器的帧序契约。
 *
 * 被保护的不变量（与 worker 链 `headlessSlashDispatcher.test.ts` 钉住的是同一份
 * wire 契约——本链的帧构造器 `turn/compactWireFrames.ts` 是 worker 侧私有构造器的
 * 副本，两处必须手工同步，所以这里的断言刻意与那边逐条对应；帧字段级的 golden 断言
 * 在 `turn/compactWireFrames.test.ts`）：
 *
 * 1. **帧序**：status('compacting') → status(null) → 新历史投影（compact_boundary
 *    带 `trigger=manual`、摘要 / tool_result / assistant 帧）→ `Compacted` 本地命令
 *    回显 → `num_turns: 0` 的合成 result。压缩轮自己的终态就是这个 result，宿主按它
 *    给 turnIndex 记账；形状混进真实模型轮（num_turns >= 1）会让轮次终态缺失或不唯一。
 * 2. **入参透传**：force:true、`/compact <args>` 的自定义指令、SDK custom_context。
 * 3. **NOOP 是成功命令**：不带边界，只发 status × 2 + 成功 result（noop 文案），
 *    且不清零遥测的上次 prompt token 计数。
 * 4. **失败可读**：模型请求失败带动态错误码与用户可读文案；compressNow 抛错兜成
 *    error result；中止不带业务错误码、带 terminal_reason。
 * 5. **生成器永不抛**：终态帧就是正常返回路径，命令生命周期由调用方结算。
 * 6. `extractTrailingTextBlock` 与 worker 的 slash 判定文本视图一致：只看**最后一个**
 *    text 块，不是拼接全部。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  CompressionStatus,
  FatalCancellationError,
  uiTelemetryService,
  type Message,
  type SDKMessage,
} from '@qwen-code/core';
import {
  extractTrailingTextBlock,
  runSessionCompactCommand,
  type SessionManualCompactOptions,
  type SessionManualCompactor,
} from './sessionCompactCommand.js';
import { COMPACT_NOOP_TEXT } from '../../../utils/compressionFailureText.js';
import type { CompactTurnResult } from './compactWireFrames.js';

const SESSION = 'session-abc';

function makeCompactor(overrides?: {
  compressNow?: (
    options?: SessionManualCompactOptions,
  ) => Promise<CompactTurnResult>;
}): {
  compactor: SessionManualCompactor;
  calls: SessionManualCompactOptions[];
} {
  const calls: SessionManualCompactOptions[] = [];
  const compressNow =
    overrides?.compressNow ??
    (async () => ({
      newHistory: [
        {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'boundary-uuid',
          timestamp: new Date().toISOString(),
          content: 'Conversation compacted',
          level: 'info',
          isCompactSummary: true,
          compactMetadata: {
            trigger: 'manual',
            preTokens: 12345,
            postTokens: 2000,
            durationMs: 321,
          } as Extract<Message, { type: 'system' }>['compactMetadata'] & {
            durationMs: number;
          },
        } satisfies Extract<Message, { type: 'system' }>,
        {
          type: 'user',
          uuid: 'summary-uuid',
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Summary:\nTest summary' }],
          },
          isCompactSummary: true,
        } satisfies Extract<Message, { type: 'user' }>,
      ],
      info: {
        originalTokenCount: 12345,
        newTokenCount: 2000,
        compressionStatus: CompressionStatus.COMPRESSED,
      },
    }));
  return {
    calls,
    compactor: {
      compressNow: async (options) => {
        calls.push(options ?? {});
        return compressNow(options);
      },
    },
  };
}

async function collect(
  customInstructions: string | undefined,
  compactor: SessionManualCompactor,
  customContext?: Readonly<Record<string, string>>,
): Promise<SDKMessage[]> {
  const frames: SDKMessage[] = [];
  for await (const frame of runSessionCompactCommand(customInstructions, {
    sessionId: SESSION,
    compactor,
    ...(customContext !== undefined ? { customContext } : {}),
  })) {
    frames.push(frame);
  }
  return frames;
}

function typeSubtype(message: SDKMessage): string {
  return `${message.type}:${(message as { subtype?: string }).subtype ?? ''}`;
}

describe('runSessionCompactCommand：帧序与 worker 逐条对应', () => {
  afterEach(() => {
    uiTelemetryService.setLastPromptTokenCount(0);
  });

  it('成功压缩：status → compact_boundary(manual) → 摘要 → Compacted → num_turns:0 的 result', async () => {
    const { compactor, calls } = makeCompactor();
    const frames = await collect(undefined, compactor);

    expect(frames.map(typeSubtype)).toEqual([
      'system:status',
      'system:status',
      'system:compact_boundary',
      'user:',
      'user:',
      'result:success',
    ]);
    expect(calls).toEqual([{ force: true, customInstructions: undefined }]);
    expect((frames[0] as { status: unknown }).status).toBe('compacting');
    expect((frames[1] as { status: unknown }).status).toBeNull();

    const boundary = frames[2] as unknown as Record<string, unknown>;
    expect(boundary['subtype']).toBe('compact_boundary');
    expect(boundary['compact_metadata']).toEqual({
      trigger: 'manual',
      pre_tokens: 12345,
      post_tokens: 2000,
      duration_ms: 321,
    });
    expect(boundary['session_id']).toBe(SESSION);
    expect(boundary['uuid']).toBe('boundary-uuid');

    // 摘要 user 帧保留脚本 uuid 并标记合成。
    expect(frames[3]).toMatchObject({
      type: 'user',
      uuid: 'summary-uuid',
      isSynthetic: true,
    });
    // `Compacted` 本地命令回显。
    expect(frames[4]).toMatchObject({
      type: 'user',
      isReplay: true,
      message: {
        content: '<local-command-stdout>Compacted </local-command-stdout>',
      },
    });
    // 压缩轮自己的终态：num_turns 必须是 0，成功时正文为空、不带 errors。
    const result = frames[5] as unknown as Record<string, unknown>;
    expect(result['type']).toBe('result');
    expect(result['subtype']).toBe('success');
    expect(result['is_error']).toBe(false);
    expect(result['num_turns']).toBe(0);
    expect(result['result']).toBe('');
    expect(frames[5]).not.toHaveProperty('errors');
    // 整个序列里不得出现第二个 result：宿主按 result 帧给轮次记终态。
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(1);
    // 帧里没有 command_lifecycle：命令终态归 SessionCommandManager 唯一上报。
    expect(frames.filter((f) => f.type === 'command_lifecycle')).toHaveLength(
      0,
    );
  });

  it('成功压缩后清零遥测的上次 prompt token 计数（旧值已失真）', async () => {
    uiTelemetryService.setLastPromptTokenCount(45_000);
    const { compactor } = makeCompactor();
    await collect(undefined, compactor);
    expect(uiTelemetryService.getLastPromptTokenCount()).toBe(0);
  });

  it('透传 /compact <args> 的自定义指令与 SDK custom_context', async () => {
    const { compactor, calls } = makeCompactor();
    const customContext = { tenant: 'pds', request_scope: 'manual-compact' };
    await collect('只保留测试相关内容', compactor, customContext);
    expect(calls).toEqual([
      {
        force: true,
        customInstructions: '只保留测试相关内容',
        customContext,
      },
    ]);
  });

  it('NOOP 是成功命令：不带边界，只发 status × 2 + noop 文案的成功 result，遥测不清零', async () => {
    uiTelemetryService.setLastPromptTokenCount(45_000);
    const { compactor } = makeCompactor({
      compressNow: async () => ({
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      }),
    });
    const frames = await collect(undefined, compactor);
    expect(frames.map(typeSubtype)).toEqual([
      'system:status',
      'system:status',
      'result:success',
    ]);
    const result = frames[2] as unknown as Record<string, unknown>;
    expect(result['is_error']).toBe(false);
    expect(result['num_turns']).toBe(0);
    expect(result['result']).toBe(COMPACT_NOOP_TEXT);
    expect(frames[2]).not.toHaveProperty('errors');
    expect(uiTelemetryService.getLastPromptTokenCount()).toBe(45_000);
  });

  it('压缩模型请求失败：error result 带可读文案与错误码', async () => {
    const { compactor } = makeCompactor({
      compressNow: async () => ({
        newHistory: null,
        info: {
          originalTokenCount: 100,
          newTokenCount: 100,
          compressionStatus: CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
          failureReason: 'quota_exhausted',
          providerStatus: 403,
          providerCode: '112',
        },
      }),
    });
    const frames = await collect(undefined, compactor);
    expect(frames.map(typeSubtype)).toEqual([
      'system:status',
      'system:status',
      'result:error_during_execution',
    ]);
    expect(frames[2]).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 0,
      error_code: '112',
      result: expect.stringContaining(
        'credits or usage quota are exhausted',
      ),
    });
  });

  it('compressNow 抛错：兜成 error result 终态帧，生成器不外抛', async () => {
    uiTelemetryService.setLastPromptTokenCount(45_000);
    const { compactor } = makeCompactor({
      compressNow: async () => {
        throw Object.assign(new Error('compact service unavailable'), {
          status: 503,
        });
      },
    });
    const frames = await collect(undefined, compactor);
    expect(frames.map(typeSubtype)).toEqual([
      'system:status',
      'system:status',
      'result:error_during_execution',
    ]);
    expect((frames[0] as { status: unknown }).status).toBe('compacting');
    expect((frames[1] as { status: unknown }).status).toBeNull();
    expect(frames[2]).toMatchObject({
      type: 'result',
      is_error: true,
      num_turns: 0,
      error_code: 10500,
      errors: ['compact service unavailable'],
    });
    // 失败不清零遥测：这次压缩没有改变上下文。
    expect(uiTelemetryService.getLastPromptTokenCount()).toBe(45_000);
  });

  it('中止：Operation aborted + terminal_reason，不带业务错误码', async () => {
    const { compactor } = makeCompactor({
      compressNow: async () => {
        throw new FatalCancellationError('cancelled');
      },
    });
    const frames = await collect(undefined, compactor);
    expect(frames[2]).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 0,
      terminal_reason: 'aborted_streaming',
      errors: ['Operation aborted'],
    });
    expect(frames[2]).not.toHaveProperty('error_code');
  });
});

describe('extractTrailingTextBlock：与 worker 的 slash 判定文本视图一致', () => {
  it('字符串原样返回', () => {
    expect(extractTrailingTextBlock('/compact')).toBe('/compact');
  });

  it('块数组只看最后一个 text 块', () => {
    expect(
      extractTrailingTextBlock([
        { type: 'text', text: '前面的正文' },
        { type: 'text', text: '/compact 只留重点' },
      ] as never),
    ).toBe('/compact 只留重点');
  });

  it('最后一个块不是 text 时返回空串（不当成 slash 命令）', () => {
    expect(
      extractTrailingTextBlock([
        { type: 'text', text: '/compact' },
        { type: 'image', source: {} },
      ] as never),
    ).toBe('');
  });
});
