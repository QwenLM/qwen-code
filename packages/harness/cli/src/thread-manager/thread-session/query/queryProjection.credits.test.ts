/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSessionCredits,
  getSessionCreditsSnapshot,
  linkRequestMeteringId,
  recordCompletedRequest,
  type QueryEvent,
} from '@qwen-code/core';
import { ENV_EXPOSE_TOKEN_USAGE } from '../../../../../core/src/config/brand.js';
import { SDKPartialAssistantMessageSchema } from '../../../../../core/src/protocol/schemas/sdk-message.js';
import { projectQueryEvent } from './queryProjection.js';

const rootSessionId = 'credits-root';
const childSessionId = 'credits-child';

afterEach(() => {
  clearSessionCredits(rootSessionId);
  clearSessionCredits(childSessionId);
  delete process.env[ENV_EXPOSE_TOKEN_USAGE];
});

function projectDelta(requestId: string, sessionId?: string) {
  const event: QueryEvent = {
    type: 'stream_event',
    requestId,
    ...(sessionId
      ? { session_id: sessionId, parent_tool_use_id: 'child-tool' }
      : {}),
    event: {
      type: 'message_delta',
      delta: { stopReason: 'end_turn' },
      usage: { inputTokens: 100, outputTokens: 20 },
    },
  };
  const frames = [
    ...projectQueryEvent(
      event,
      { sessionId: rootSessionId, includePartialMessages: true },
      () => {},
    ),
  ];
  const frame = SDKPartialAssistantMessageSchema().parse(frames[0]);
  if (frame.event.type !== 'message_delta')
    throw new Error('Expected message_delta');
  return { ...frame, event: frame.event };
}

describe('流式请求 Credits', () => {
  it('最终 usage 读取重试后的请求计量，保持 Token 屏蔽且不重复计费', () => {
    process.env[ENV_EXPOSE_TOKEN_USAGE] = 'false';
    recordCompletedRequest({
      sessionId: rootSessionId,
      requestId: 'physical-request',
      model: 'test-model',
      usage: { credits: 1.25, originalCredits: 2.5, billable: true },
    });
    linkRequestMeteringId(rootSessionId, 'logical-request', 'physical-request');

    const snapshot = getSessionCreditsSnapshot(rootSessionId);
    const frame = projectDelta('logical-request');
    expect(frame.event.usage).toMatchObject({
      request_id: 'logical-request',
      input_tokens: 0,
      output_tokens: 0,
      credits: 1.25,
      original_credits: 2.5,
      billable: true,
    });
    expect(projectDelta('logical-request').event.usage).toEqual(
      frame.event.usage,
    );
    expect(getSessionCreditsSnapshot(rootSessionId)).toEqual(snapshot);
  });

  it('子会话使用自己的计量并保留工具归属', () => {
    for (const [sessionId, credits] of [
      [rootSessionId, 9],
      [childSessionId, 2],
    ] as const) {
      recordCompletedRequest({
        sessionId,
        requestId: 'same-request',
        model: 'test-model',
        usage: { credits, billable: true },
      });
    }
    expect(projectDelta('same-request', childSessionId)).toMatchObject({
      session_id: childSessionId,
      parent_tool_use_id: 'child-tool',
      event: { usage: { credits: 2, billable: true } },
    });
  });

  it('保留明确的零值和非计费标记，未知计量不填零', () => {
    recordCompletedRequest({
      sessionId: rootSessionId,
      requestId: 'free-request',
      model: 'test-model',
      usage: { credits: 0, billable: false },
    });
    expect(projectDelta('free-request').event.usage).toMatchObject({
      credits: 0,
      billable: false,
    });
    const unknown = projectDelta('unknown-request').event.usage;
    expect(unknown).not.toHaveProperty('credits');
    expect(unknown).not.toHaveProperty('original_credits');
    expect(unknown).not.toHaveProperty('billable');
  });
});
