/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { LOAD_REPLAY_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';
import {
  classifyLargePipeFrame,
  createLargePipeFrameObserver,
  LARGE_PIPE_FRAME_EVENT_NAME,
  LARGE_PIPE_FRAME_THRESHOLD_BYTES,
} from './large-pipe-frame-observer.js';

describe('large pipe frame observer', () => {
  it('does not classify or log frames below the large-frame threshold', () => {
    const daemonLog = { warn: vi.fn() };
    const emitTelemetryLog = vi.fn();
    const observe = createLargePipeFrameObserver({
      daemonLog,
      emitTelemetryLog,
    });

    observe({
      direction: 'inbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES - 1,
      message: { jsonrpc: '2.0', method: 'session/update' },
    });

    expect(
      classifyLargePipeFrame({
        direction: 'inbound',
        bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES - 1,
        message: { jsonrpc: '2.0', method: 'session/update' },
      }),
    ).toBeUndefined();
    expect(daemonLog.warn).not.toHaveBeenCalled();
    expect(emitTelemetryLog).not.toHaveBeenCalled();
  });

  it('classifies large session/update tool_call_update frames without sensitive identifiers', () => {
    const contentText = 'x'.repeat(64);
    const rawOutput = 'y'.repeat(96);
    const longToolName = 'tool-'.padEnd(160, 'n');

    const context = classifyLargePipeFrame({
      direction: 'inbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'secret-session',
          update: {
            sessionUpdate: 'tool_call_update',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: contentText },
              },
            ],
            rawOutput,
            _meta: {
              toolName: longToolName,
              provenance: 'mcp',
            },
          },
        },
      },
    });

    expect(context).toMatchObject({
      direction: 'inbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      thresholdBytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      messageKind: 'notification',
      method: 'session/update',
      sourceClass: 'session_update_notification',
      sessionUpdate: 'tool_call_update',
      toolProvenance: 'mcp',
      maxContentTextBytes: Buffer.byteLength(contentText, 'utf8'),
      maxRawOutputTextBytes: Buffer.byteLength(rawOutput, 'utf8'),
      rawOutputKind: 'string',
    });
    expect(context?.['toolName']).toHaveLength(128);
    expect(context).not.toHaveProperty('sessionId');
  });

  it('classifies loadSession bulk replay responses from response metadata', () => {
    const contentText = 'loaded answer';

    const context = classifyLargePipeFrame({
      direction: 'outbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          _meta: {
            [LOAD_REPLAY_META_KEY]: {
              v: 1,
              partial: false,
              updates: [
                {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: contentText },
                },
              ],
            },
          },
        },
      },
    });

    expect(context).toMatchObject({
      direction: 'outbound',
      messageKind: 'response',
      sourceClass: 'load_session_bulk_replay_response',
      updateCount: 1,
      maxContentTextBytes: Buffer.byteLength(contentText, 'utf8'),
    });
  });

  it('classifies generic JSON-RPC result and error responses', () => {
    expect(
      classifyLargePipeFrame({
        direction: 'outbound',
        bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
        message: { jsonrpc: '2.0', id: 1, result: { ok: true } },
      }),
    ).toMatchObject({
      messageKind: 'response',
      sourceClass: 'jsonrpc_response',
    });
    expect(
      classifyLargePipeFrame({
        direction: 'outbound',
        bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
        message: {
          jsonrpc: '2.0',
          id: 2,
          error: { code: -32000, message: 'failed' },
        },
      }),
    ).toMatchObject({
      messageKind: 'response',
      sourceClass: 'jsonrpc_response',
    });
  });

  it('bounds string attribution fields from generic JSON-RPC requests', () => {
    const context = classifyLargePipeFrame({
      direction: 'inbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        id: 1,
        method: 'x'.repeat(512),
      },
    });

    expect(context).toMatchObject({
      messageKind: 'request',
      sourceClass: 'jsonrpc_request',
    });
    expect(context?.['method']).toHaveLength(128);
  });

  it('does not classify session/update requests as notifications', () => {
    const context = classifyLargePipeFrame({
      direction: 'inbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk' } },
      },
    });

    expect(context).toMatchObject({
      messageKind: 'request',
      method: 'session/update',
      sourceClass: 'jsonrpc_request',
    });
  });

  it('classifies qwen/session/loadUpdates responses', () => {
    const context = classifyLargePipeFrame({
      direction: 'outbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          updates: [
            {
              sessionUpdate: 'tool_call_update',
              rawOutput: { type: 'task_execution' },
            },
            { sessionUpdate: 'agent_message_chunk' },
          ],
          startTime: '2026-07-05T00:00:00.000Z',
        },
      },
    });

    expect(context).toMatchObject({
      messageKind: 'response',
      sourceClass: 'load_updates_response',
      updateCount: 2,
      maxRawOutputApproxBytes: Buffer.byteLength(
        JSON.stringify({ type: 'task_execution' }),
        'utf8',
      ),
      rawOutputKind: 'object',
    });
  });

  it('caps object rawOutput byte approximation without full stringification', () => {
    const rawOutput = {
      payload: 'x'.repeat(LARGE_PIPE_FRAME_THRESHOLD_BYTES * 2),
      toJSON: () => {
        throw new Error('rawOutput should not be stringified');
      },
    };

    const context = classifyLargePipeFrame({
      direction: 'outbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        id: 3,
        result: {
          updates: [
            {
              sessionUpdate: 'tool_call_update',
              rawOutput,
            },
          ],
          startTime: '2026-07-05T00:00:00.000Z',
        },
      },
    });

    expect(context).toMatchObject({
      sourceClass: 'load_updates_response',
      maxRawOutputApproxBytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      maxRawOutputApproxBytesCapped: true,
      rawOutputKind: 'object',
    });
  });

  it('handles cyclic object rawOutput without throwing from attribution', () => {
    const rawOutput: Record<string, unknown> = {};
    rawOutput['self'] = rawOutput;
    let context: ReturnType<typeof classifyLargePipeFrame> = undefined;

    expect(
      () =>
        (context = classifyLargePipeFrame({
          direction: 'outbound',
          bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
          message: {
            jsonrpc: '2.0',
            id: 4,
            result: {
              updates: [
                {
                  sessionUpdate: 'tool_call_update',
                  rawOutput,
                },
              ],
              startTime: '2026-07-05T00:00:00.000Z',
            },
          },
        })),
    ).not.toThrow();

    expect(context).toMatchObject({
      sourceClass: 'load_updates_response',
      maxRawOutputApproxBytesCapped: true,
      rawOutputKind: 'object',
    });
  });

  it('uses byte-dominant update attribution for mixed bulk updates', () => {
    const rawOutput = 'r'.repeat(256);
    const context = classifyLargePipeFrame({
      direction: 'outbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        id: 3,
        result: {
          _meta: {
            [LOAD_REPLAY_META_KEY]: {
              updates: [
                {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'small' },
                },
                {
                  sessionUpdate: 'tool_call_update',
                  rawOutput,
                  _meta: { toolName: 'shell', provenance: 'builtin' },
                },
              ],
            },
          },
        },
      },
    });

    expect(context).toMatchObject({
      sourceClass: 'load_session_bulk_replay_response',
      updateCount: 2,
      mixedSessionUpdate: true,
      sessionUpdate: 'tool_call_update',
      toolName: 'shell',
      toolProvenance: 'builtin',
      maxRawOutputTextBytes: Buffer.byteLength(rawOutput, 'utf8'),
      rawOutputKind: 'string',
    });
  });

  it('preserves existing attribution when a larger update omits it', () => {
    const largerRawOutput = 'r'.repeat(256);
    const context = classifyLargePipeFrame({
      direction: 'outbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        id: 4,
        result: {
          _meta: {
            [LOAD_REPLAY_META_KEY]: {
              updates: [
                {
                  sessionUpdate: 'tool_call_update',
                  rawOutput: 'small',
                  _meta: { toolName: 'shell', provenance: 'builtin' },
                },
                {
                  rawOutput: largerRawOutput,
                },
              ],
            },
          },
        },
      },
    });

    expect(context).toMatchObject({
      sourceClass: 'load_session_bulk_replay_response',
      updateCount: 2,
      sessionUpdate: 'tool_call_update',
      toolName: 'shell',
      toolProvenance: 'builtin',
      maxRawOutputTextBytes: Buffer.byteLength(largerRawOutput, 'utf8'),
      rawOutputKind: 'string',
    });
  });

  it('caps shallow update and content traversal work', () => {
    let nestedContent: unknown = { type: 'text', text: 'too-deep' };
    for (let i = 0; i < 64; i += 1) {
      nestedContent = { content: nestedContent };
    }
    const updates = Array.from({ length: 501 }, (_, index) => ({
      sessionUpdate: 'agent_message_chunk',
      content: index === 0 ? { type: 'text', text: 'sampled' } : nestedContent,
    }));

    const context = classifyLargePipeFrame({
      direction: 'outbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        id: 5,
        result: {
          _meta: {
            [LOAD_REPLAY_META_KEY]: {
              updates,
            },
          },
        },
      },
    });

    expect(context).toMatchObject({
      updateCount: 501,
      summarizedUpdateCount: 500,
      summarizedUpdateStrategy: 'prefix_and_suffix',
      maxContentTextBytes: Buffer.byteLength('sampled', 'utf8'),
    });
  });

  it('samples suffix updates so late large payloads are attributed', () => {
    const rawOutput = 'r'.repeat(300 * 1024);
    const updates = [
      ...Array.from({ length: 500 }, () => ({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'x' },
      })),
      {
        sessionUpdate: 'tool_call_update',
        rawOutput,
        _meta: { toolName: 'shell', provenance: 'builtin' },
      },
    ];

    const context = classifyLargePipeFrame({
      direction: 'outbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        id: 6,
        result: {
          _meta: {
            [LOAD_REPLAY_META_KEY]: {
              updates,
            },
          },
        },
      },
    });

    expect(context).toMatchObject({
      sourceClass: 'load_session_bulk_replay_response',
      updateCount: 501,
      summarizedUpdateCount: 500,
      summarizedUpdateStrategy: 'prefix_and_suffix',
      sessionUpdate: 'tool_call_update',
      toolName: 'shell',
      toolProvenance: 'builtin',
      maxRawOutputTextBytes: Buffer.byteLength(rawOutput, 'utf8'),
      rawOutputKind: 'string',
    });
  });

  it('rate limits large-frame logs and reports suppressed samples on the next log', () => {
    let now = 0;
    const daemonLog = { warn: vi.fn() };
    const emitTelemetryLog = vi.fn();
    const observe = createLargePipeFrameObserver({
      daemonLog,
      emitTelemetryLog,
      logLimit: 2,
      now: () => now,
      windowMs: 1_000,
    });
    const message = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk' } },
    };

    observe({
      direction: 'inbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message,
    });
    observe({
      direction: 'inbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message,
    });
    observe({
      direction: 'inbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message,
    });
    now = 1_001;
    observe({
      direction: 'inbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message,
    });

    expect(daemonLog.warn).toHaveBeenCalledTimes(3);
    expect(daemonLog.warn.mock.calls[2]?.[1]).toMatchObject({
      suppressedCount: 1,
      suppressedWindowStartMs: 0,
    });
    expect(emitTelemetryLog).toHaveBeenCalledWith(
      'Large ACP pipe frame observed.',
      expect.objectContaining({
        suppressedCount: 1,
        suppressedWindowStartMs: 0,
      }),
      expect.objectContaining({ eventName: LARGE_PIPE_FRAME_EVENT_NAME }),
    );
  });

  it('logs without a telemetry hook', () => {
    const daemonLog = { warn: vi.fn() };
    const observe = createLargePipeFrameObserver({ daemonLog });

    observe({
      direction: 'inbound',
      bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
      message: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk' } },
      },
    });

    expect(daemonLog.warn).toHaveBeenCalledWith(
      'large ACP pipe frame observed',
      expect.objectContaining({
        sourceClass: 'session_update_notification',
      }),
    );
  });

  it('does not let logging failures escape the observer', () => {
    const observe = createLargePipeFrameObserver({
      daemonLog: {
        warn: () => {
          throw new Error('log failed');
        },
      },
      emitTelemetryLog: () => {
        throw new Error('telemetry failed');
      },
    });

    expect(() =>
      observe({
        direction: 'inbound',
        bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
        message: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_message_chunk' } },
        },
      }),
    ).not.toThrow();
  });
});
