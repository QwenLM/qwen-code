/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话链 `/compact` wire 帧构造器的**逐字段 golden 契约**（防漂移钉桩）。
 *
 * 为什么需要这份测试：`turn/compactWireFrames.ts` 是 worker 侧
 * `headlessSlashDispatcher.ts` 私有构造器的一份副本（复制而非抽取，理由见那个文件的
 * 头注）。副本会漂移，所以这里对每个构造器用固定输入产出帧、断言**完整字段与值**：
 * 多一个字段、少一个字段、字段改名、值改动，都会在这里变红，而不是等到宿主解析失败
 * 才被发现。断言刻意写成整对象 `toEqual`（而不是 `toMatchObject`）——后者只查列出的
 * 键，删字段是查不出来的。
 *
 * 钉住的契约要点：
 *
 * 1. `system/status` 只有 `type` / `subtype` / `status` / `uuid` / `session_id` 五个键，
 *    且每帧自带新 uuid（宿主按 uuid 去重，复用同一个 uuid 会让状态帧被吞）。
 * 2. `compact_boundary` 的 `compact_metadata` 用蛇形键；`compactMetadata` 缺失时
 *    `trigger` 兜底成 `'manual'`、`pre_tokens` 兜底成 0——手动压缩不能兜成 `'auto'`，
 *    否则宿主的自动/手动压缩统计会把用户的 `/compact` 记成系统自动压缩。
 * 3. `Compacted` 回显帧带 `isReplay: true` 与 `parent_tool_use_id: null`。
 * 4. 压缩轮自己的合成 `result` 帧 **`num_turns` 必须是 0**：这是它区别于真实模型轮的
 *    关键，宿主按 result 帧给 turnIndex 记终态，混进 `num_turns >= 1` 会让轮次记账错位。
 * 5. 成功 result 带空正文且**不带** `errors` / `error_code`；失败 result 两者都带；
 *    `compressNow` 抛错兜出的 result **不带** `result` 字段（与成功/失败分支的形状差异
 *    是有意的，宿主据此区分「压缩跑完了」与「压缩本体炸了」），中止再额外带
 *    `terminal_reason: 'aborted_streaming'` 且不带业务错误码。
 * 6. `usage` 的完整字段来自 core 的 `cloneUsage()` 基线，只有 `input_tokens` /
 *    `output_tokens` 被压缩前后的 token 数覆盖。core 扩字段时这里要同步——
 *    这类红灯是有意义的：它说明压缩轮终态帧的用量形状变了。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CompressionStatus,
  FatalCancellationError,
  type Message,
  type SDKMessage,
} from '@qwen-code/core';
import {
  buildCompactionStatusMessage,
  buildCompactResultMessage,
  buildCompactThrownErrorResultMessage,
  buildLocalCommandOutputMessage,
  projectPostCompactMessages,
  type CompactTurnResult,
} from './compactWireFrames.js';
import { COMPACT_NOOP_TEXT } from '../../../utils/compressionFailureText.js';

const SESSION = 'session-abc';
/** 冻结时钟：`duration_ms` 与回显帧的 `timestamp` 都由 `Date.now()` 推出。 */
const NOW = new Date('2026-03-04T05:06:07.000Z');
const STARTED_AT = NOW.getTime() - 250;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `cloneUsage()` 的零值基线，只被下面两处 token 数覆盖。 */
const ZERO_USAGE = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
};

/**
 * 把随机 uuid 摘出来单独断言格式，剩下的字段整体交给 golden 比对。
 * 只摘这一个键：其余字段（含时间戳）都在冻结时钟下完全确定。
 */
function splitUuid(frame: SDKMessage): {
  uuid: unknown;
  rest: Record<string, unknown>;
} {
  const { uuid, ...rest } = frame as unknown as Record<string, unknown>;
  return { uuid, rest };
}

function boundaryMessage(
  overrides?: Partial<Extract<Message, { type: 'system' }>>,
): Message {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'boundary-uuid',
    timestamp: NOW.toISOString(),
    content: 'Conversation compacted',
    level: 'info',
    isCompactSummary: true,
    compactMetadata: {
      trigger: 'manual',
      preTokens: 12345,
      postTokens: 2000,
      messagesSummarized: 7,
      durationMs: 321,
    },
    ...overrides,
  } satisfies Extract<Message, { type: 'system' }>;
}

function compactResult(
  overrides?: Partial<CompactTurnResult['info']> & {
    newHistory?: CompactTurnResult['newHistory'];
  },
): CompactTurnResult {
  const { newHistory, ...info } = overrides ?? {};
  return {
    // `null` 是有效输入（NOOP / 失败不带新历史），不能与「未指定」混为一谈。
    newHistory:
      overrides !== undefined && 'newHistory' in overrides
        ? (newHistory ?? null)
        : [boundaryMessage()],
    info: {
      originalTokenCount: 12345,
      newTokenCount: 2000,
      compressionStatus: CompressionStatus.COMPRESSED,
      ...info,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildCompactionStatusMessage：压缩状态帧', () => {
  it("进入压缩：system/status 只有五个键，status='compacting'", () => {
    const { uuid, rest } = splitUuid(
      buildCompactionStatusMessage(SESSION, 'compacting'),
    );
    expect(uuid).toMatch(UUID_RE);
    expect(rest).toEqual({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      session_id: SESSION,
    });
  });

  it('结束压缩：status 是 null（不是 undefined、不是缺键）', () => {
    const { uuid, rest } = splitUuid(
      buildCompactionStatusMessage(SESSION, null),
    );
    expect(uuid).toMatch(UUID_RE);
    expect(rest).toEqual({
      type: 'system',
      subtype: 'status',
      status: null,
      session_id: SESSION,
    });
    expect(rest).toHaveProperty('status', null);
  });

  it('每帧自带新 uuid：宿主按 uuid 去重，复用会让结束帧被吞', () => {
    const first = splitUuid(
      buildCompactionStatusMessage(SESSION, 'compacting'),
    );
    const second = splitUuid(buildCompactionStatusMessage(SESSION, null));
    expect(first.uuid).toMatch(UUID_RE);
    expect(second.uuid).toMatch(UUID_RE);
    expect(first.uuid).not.toBe(second.uuid);
  });
});

describe('projectPostCompactMessages：压缩后新历史的投影', () => {
  it('compact_boundary：蛇形 compact_metadata 原样投影，uuid 取自消息', () => {
    const frames = projectPostCompactMessages(boundaryMessage(), SESSION);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'manual',
        pre_tokens: 12345,
        post_tokens: 2000,
        messages_summarized: 7,
        duration_ms: 321,
      },
      uuid: 'boundary-uuid',
      session_id: SESSION,
    });
  });

  it("compactMetadata 缺失时兜底 trigger='manual'、pre_tokens=0（不得兜成 auto）", () => {
    const bare = boundaryMessage({ compactMetadata: undefined });
    const frames = projectPostCompactMessages(bare, SESSION);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 0 },
      uuid: 'boundary-uuid',
      session_id: SESSION,
    });
  });

  it('摘要 user 帧：逐字段 golden（isSynthetic 来自 isCompactSummary）', () => {
    const message = {
      type: 'user',
      uuid: 'summary-uuid',
      timestamp: NOW.toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Summary:\nTest summary' }],
      },
      isCompactSummary: true,
    } satisfies Extract<Message, { type: 'user' }>;

    expect(projectPostCompactMessages(message, SESSION)).toEqual([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Summary:\nTest summary' }],
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: 'summary-uuid',
        timestamp: NOW.toISOString(),
        isSynthetic: true,
      },
    ]);
  });

  it('assistant 帧走拆分投影：一个内容块一帧，uuid 与会话归属保留', () => {
    const message = {
      type: 'assistant',
      uuid: 'assistant-uuid',
      timestamp: NOW.toISOString(),
      message: {
        id: 'assistant-uuid',
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        model: 'test-model',
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
      },
    } satisfies Extract<Message, { type: 'assistant' }>;

    const frames = projectPostCompactMessages(message, SESSION);
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.type)).toEqual(['assistant', 'assistant']);
    expect(frames.map((f) => (f as { uuid: string }).uuid)).toEqual([
      // 多块时 uuid 按块序号派生，宿主靠它把同一轮的多帧串起来。
      'assistant-uuid'.slice(0, 24) + '000000000000',
      'assistant-uuid'.slice(0, 24) + '000000000001',
    ]);
    expect(frames.map((f) => (f as { session_id: string }).session_id)).toEqual(
      [SESSION, SESSION],
    );
    expect(
      frames.map(
        (f) =>
          (f as { message: { content: unknown[] } }).message.content.length,
      ),
    ).toEqual([1, 1]);
  });

  it('其余消息类型不产帧（压缩历史里的非投影类型不得漏成空帧）', () => {
    const message = {
      type: 'system',
      subtype: 'informational',
      uuid: 'other-uuid',
      timestamp: NOW.toISOString(),
      content: 'not a boundary',
      level: 'info',
    } satisfies Extract<Message, { type: 'system' }>;
    expect(projectPostCompactMessages(message, SESSION)).toEqual([]);
  });
});

describe('buildLocalCommandOutputMessage：Compacted 回显帧', () => {
  it('逐字段 golden：本地命令回显文案、isReplay、时间戳比当前晚 100ms', () => {
    const { uuid, rest } = splitUuid(buildLocalCommandOutputMessage(SESSION));
    expect(uuid).toMatch(UUID_RE);
    expect(rest).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: '<local-command-stdout>Compacted </local-command-stdout>',
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      timestamp: '2026-03-04T05:06:07.100Z',
      isReplay: true,
    });
  });
});

describe('buildCompactResultMessage：压缩轮自己的合成 result 终态帧', () => {
  it.each(['112', '140', 'EXTERNAL_TOKEN_RATE_LIMITED'])(
    '透传压缩 Provider 错误码 %s，不根据 HTTP 状态重算',
    (code) => {
      const result = compactResult();
      result.newHistory = null;
      result.info.compressionStatus =
        CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST;
      result.info.providerStatus = 503;
      result.info.errorCode = code;
      expect(
        buildCompactResultMessage(SESSION, result, STARTED_AT),
      ).toHaveProperty('error_code', code);
    },
  );

  it('成功：num_turns=0、正文空、用量被压缩前后 token 数覆盖、不带 errors/error_code', () => {
    const { uuid, rest } = splitUuid(
      buildCompactResultMessage(SESSION, compactResult(), STARTED_AT),
    );
    expect(uuid).toMatch(UUID_RE);
    expect(rest).toEqual({
      type: 'result',
      subtype: 'success',
      duration_ms: 250,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 0,
      result: '',
      stop_reason: null,
      total_cost_usd: 0,
      total_credits: 0,
      usage: { ...ZERO_USAGE, input_tokens: 12345, output_tokens: 2000 },
      modelUsage: {},
      permission_denials: [],
      session_id: SESSION,
    });
  });

  it('NOOP：仍是成功终态，正文用共享 noop 文案，用量为 0', () => {
    const { uuid, rest } = splitUuid(
      buildCompactResultMessage(
        SESSION,
        compactResult({
          newHistory: null,
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        }),
        STARTED_AT,
      ),
    );
    expect(uuid).toMatch(UUID_RE);
    expect(rest).toEqual({
      type: 'result',
      subtype: 'success',
      duration_ms: 250,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 0,
      result: COMPACT_NOOP_TEXT,
      stop_reason: null,
      total_cost_usd: 0,
      total_credits: 0,
      usage: ZERO_USAGE,
      modelUsage: {},
      permission_denials: [],
      session_id: SESSION,
    });
  });

  it('压缩模型请求失败：error 终态带可读文案、errors 数组与动态错误码', () => {
    const { uuid, rest } = splitUuid(
      buildCompactResultMessage(
        SESSION,
        compactResult({
          newHistory: null,
          originalTokenCount: 100,
          newTokenCount: 100,
          compressionStatus: CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
          failureReason: 'quota_exhausted',
          providerStatus: 403,
          providerCode: '112',
        }),
        STARTED_AT,
      ),
    );
    expect(uuid).toMatch(UUID_RE);
    expect(rest).toEqual({
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 250,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      result: expect.stringContaining(
        'credits or usage quota are exhausted',
      ),
      stop_reason: null,
      total_cost_usd: 0,
      total_credits: 0,
      usage: { ...ZERO_USAGE, input_tokens: 100, output_tokens: 100 },
      modelUsage: {},
      permission_denials: [],
      // 失败时 errors 与 result 正文同文案，error_code 是 core 的动态映射（配额耗尽）。
      errors: [
        expect.stringContaining('credits or usage quota are exhausted'),
      ],
      error_code: '112',
      session_id: SESSION,
    });
  });
});

describe('buildCompactThrownErrorResultMessage：compressNow 抛错时的合成终态帧', () => {
  it('普通异常：errors 带原文、error_code 走 core 映射，且**不带** result 字段', () => {
    const { uuid, rest } = splitUuid(
      buildCompactThrownErrorResultMessage(
        SESSION,
        Object.assign(new Error('compact service unavailable'), {
          status: 503,
        }),
        STARTED_AT,
      ),
    );
    expect(uuid).toMatch(UUID_RE);
    expect(rest).toEqual({
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 250,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      total_cost_usd: 0,
      total_credits: 0,
      usage: ZERO_USAGE,
      modelUsage: {},
      permission_denials: [],
      errors: ['compact service unavailable'],
      error_code: 10500,
      session_id: SESSION,
    });
    expect(rest).not.toHaveProperty('result');
  });

  it('非 Error 抛出物：errors 用 String() 兜底', () => {
    const { rest } = splitUuid(
      buildCompactThrownErrorResultMessage(SESSION, 'boom', STARTED_AT),
    );
    expect(rest['errors']).toEqual(['boom']);
    expect(rest['num_turns']).toBe(0);
  });

  it('中止：terminal_reason=aborted_streaming、Operation aborted，且不带业务错误码', () => {
    const { uuid, rest } = splitUuid(
      buildCompactThrownErrorResultMessage(
        SESSION,
        new FatalCancellationError('cancelled'),
        STARTED_AT,
      ),
    );
    expect(uuid).toMatch(UUID_RE);
    expect(rest).toEqual({
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 250,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      total_cost_usd: 0,
      total_credits: 0,
      usage: ZERO_USAGE,
      modelUsage: {},
      permission_denials: [],
      errors: ['Operation aborted'],
      terminal_reason: 'aborted_streaming',
      session_id: SESSION,
    });
    expect(rest).not.toHaveProperty('error_code');
    expect(rest).not.toHaveProperty('result');
  });
});
