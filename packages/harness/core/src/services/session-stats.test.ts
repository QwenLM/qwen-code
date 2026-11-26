/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStatsService, ToolCallDecision } from './session-stats.js';
import {
  createAssistantMessage,
  createToolResultMessage,
} from '../protocol/transcript/conversions.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { runLogger } from '../utils/runLogger.js';

describe('本地会话统计', () => {
  let service: SessionStatsService;
  beforeEach(() => {
    service = new SessionStatsService();
  });

  it('累计成功、失败和取消请求，取消不累计 token 或错误', () => {
    service.recordModelRequest({
      model: 'main',
      status: 'success',
      durationMs: 10,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        thinkingTokens: 5,
      },
    });
    service.recordModelRequest({
      model: 'main',
      status: 'error',
      durationMs: 20,
    });
    service.recordModelRequest({
      model: 'main',
      status: 'abort',
      durationMs: 30,
      usage: { inputTokens: 999 },
    });
    expect(service.getStats().models['main']).toMatchObject({
      api: { totalRequests: 3, totalErrors: 1, totalLatencyMs: 60 },
      tokens: {
        input: 70,
        prompt: 100,
        candidates: 20,
        cached: 30,
        thoughts: 5,
        total: 125,
      },
    });
  });

  it.each(Object.values(ToolCallDecision))(
    '保留工具判定、耗时和文件行数：%s',
    (decision) => {
      service.recordToolCall({
        name: 'Read',
        success: true,
        durationMs: 42,
        decision,
        linesAdded: 3,
        linesRemoved: 1,
      });
      service.recordToolCall({ name: 'Read', success: false, durationMs: 8 });
      expect(service.getStats().tools).toMatchObject({
        totalCalls: 2,
        totalSuccess: 1,
        totalFail: 1,
        totalDurationMs: 50,
        totalDecisions: { [decision]: 1 },
        byName: {
          Read: {
            count: 2,
            success: 1,
            fail: 1,
            durationMs: 50,
            decisions: { [decision]: 1 },
          },
        },
      });
      expect(service.getStats().files).toEqual({
        totalLinesAdded: 3,
        totalLinesRemoved: 1,
      });
    },
  );

  it('观察器异常不影响统计或其他观察器', () => {
    const log = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    try {
      service.on('update', () => {
        throw new Error('observer');
      });
      const update = vi.fn();
      service.on('update', update);
      expect(() => service.setLastPromptTokenCount(100)).not.toThrow();
      expect(update).toHaveBeenCalledOnce();
      expect(service.getLastPromptTokenCount()).toBe(100);
    } finally {
      log.mockRestore();
    }
  });

  it('压缩后清零上下文 token，不影响累计指标', () => {
    service.recordModelRequest({
      model: 'main',
      status: 'success',
      durationMs: 1,
      usage: { inputTokens: 100 },
    });
    const previous = structuredClone(service.getStats());
    const update = vi.fn();
    service.on('update', update);
    service.setLastPromptTokenCount(0);
    expect(service.getLastPromptTokenCount()).toBe(0);
    expect(service.getStats()).toEqual(previous);
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ stats: previous, lastPromptTokenCount: 0 }),
    );
  });

  it('恢复历史使用最后一轮上下文，重复恢复不累计工具次数', () => {
    const first = createAssistantMessage({
      messageId: 'first',
      model: 'main',
      blocks: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: {} }],
    });
    first.message.usage = {
      ...cloneUsage(),
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 20,
    };
    const tool = createToolResultMessage(
      [
        {
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: 'ok',
          is_error: false,
        },
      ],
      first.uuid,
    );
    const last = createAssistantMessage({
      messageId: 'last',
      model: 'main',
      blocks: [{ type: 'text', text: 'done' }],
    });
    last.message.usage = {
      ...cloneUsage(),
      input_tokens: 30,
      output_tokens: 10,
    };
    for (let index = 0; index < 2; index++) {
      service.hydrateFromMessages('session', [first, tool, last]);
      expect(service.getLastPromptTokenCount()).toBe(30);
      expect(service.getStats().models['main'].tokens.prompt).toBe(130);
      expect(service.getStats().tools).toMatchObject({
        totalCalls: 1,
        totalSuccess: 1,
        totalFail: 0,
      });
    }
  });

  it('费用快照不共享引用，同会话恢复保留费用，切换会话清零', () => {
    const snapshot = {
      observed: true,
      totalCredits: 1.25,
      byModel: { main: { credits: 1.25 } },
    };
    service.setSessionCreditsSnapshot('session', snapshot);
    snapshot.byModel.main.credits = 99;
    service.getSessionCreditsSnapshot().byModel['main'].credits = 88;
    service.clear('session');
    expect(service.getSessionCreditsSnapshot().byModel['main'].credits).toBe(1.25);
    service.clear('other');
    expect(service.getSessionCreditsSessionId()).toBe('other');
    expect(service.getSessionCreditsSnapshot()).toEqual({
      observed: false,
      totalCredits: 0,
      byModel: {},
    });
  });
});
