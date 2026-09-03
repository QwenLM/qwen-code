/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { LOAD_REPLAY_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';
import type { ToolResultBoundaryObservation } from '@qwen-code/qwen-code-core';
import type { CLIUserMessage } from './types.js';

const { mockObserveBoundary } = vi.hoisted(() => ({
  mockObserveBoundary: vi.fn(
    (_observation: ToolResultBoundaryObservation) => true,
  ),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  observeToolResultBoundary: mockObserveBoundary,
}));

import {
  associateAcpToolResultArtifact,
  observeAcpToolResultProjection,
  observeAcpToolResultWire,
  observeHeadlessJsonToolResultWire,
  observeHeadlessToolResultProjection,
  observeHeadlessToolResultWire,
} from './tool-result-boundary-diagnostics.js';

function acpUpdate(text: string, toolCallId = 'call-secret'): SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    content: [
      {
        type: 'content',
        content: { type: 'text', text },
      },
    ],
    rawOutput: text,
  };
}

function headlessMessage(
  content: string,
  toolCallId = 'call-secret',
): CLIUserMessage {
  return {
    type: 'user',
    session_id: 'session-secret',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolCallId,
          content,
        },
      ],
    },
  };
}

describe('CLI tool-result boundary diagnostics', () => {
  beforeEach(() => {
    mockObserveBoundary.mockReset().mockReturnValue(true);
  });

  it('correlates ACP projection with the exact direct NDJSON writer frame', () => {
    const input = acpUpdate('original');
    const output = acpUpdate('projected');
    associateAcpToolResultArtifact(input, {
      state: 'reusable',
      kinds: ['file', 'image'],
    });

    observeAcpToolResultProjection(input, output, 'session-secret');
    observeAcpToolResultWire(
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'session-secret', update: output },
      },
      1_234,
    );

    expect(mockObserveBoundary).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        stage: 'acp_projection_input',
        mutated: true,
        sessionId: 'session-secret',
        toolCallId: 'call-secret',
        artifacts: [{ state: 'reusable', kinds: ['file', 'image'] }],
        values: expect.any(Function),
      }),
    );
    expect(mockObserveBoundary).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        stage: 'acp_projection_output',
        mutated: true,
        sessionId: 'session-secret',
        toolCallId: 'call-secret',
        artifacts: [{ state: 'reusable', kinds: ['file', 'image'] }],
      }),
    );
    const projectionValues = mockObserveBoundary.mock.calls[0]?.[0].values;
    expect(
      typeof projectionValues === 'function'
        ? projectionValues()
        : projectionValues,
    ).toEqual([
      { representation: 'acp_content', value: 'original' },
      { representation: 'acp_raw_output', value: 'original' },
    ]);
    expect(mockObserveBoundary).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'acp_wire',
        sessionId: 'session-secret',
        toolCallId: 'call-secret',
        mutated: true,
        wireUtf8Bytes: 1_235,
        artifacts: [{ state: 'reusable', kinds: ['file', 'image'] }],
        values: expect.any(Function),
      }),
    );
    const wireValues = mockObserveBoundary.mock.calls.at(-1)?.[0]?.values;
    expect(
      typeof wireValues === 'function' ? wireValues() : wireValues,
    ).toEqual([
      { representation: 'acp_content', value: 'projected' },
      { representation: 'acp_raw_output', value: 'projected' },
    ]);
  });

  it('correlates the delivered replay clone inside a bulk response', () => {
    const input = acpUpdate('original');
    const projected = acpUpdate('projected');
    const delivered = {
      ...projected,
      _meta: { 'qwen.session.recordId': 'record-secret' },
    } as SessionUpdate;
    associateAcpToolResultArtifact(input, {
      state: 'none',
      kinds: ['link'],
    });
    observeAcpToolResultProjection(
      input,
      projected,
      'session-secret',
      delivered,
    );

    observeAcpToolResultWire(
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          _meta: {
            [LOAD_REPLAY_META_KEY]: { v: 1, updates: [delivered] },
          },
        },
      },
      2_000,
    );

    expect(mockObserveBoundary).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'acp_wire',
        wireUtf8Bytes: 2_001,
        artifacts: [{ state: 'none', kinds: ['link'] }],
      }),
    );
  });

  it('correlates paged replay events with the ACP writer frame', () => {
    const input = acpUpdate('original');
    const projected = acpUpdate('projected');
    const delivered = { ...projected, timestamp: 123 };
    observeAcpToolResultProjection(
      input,
      projected,
      'session-secret',
      delivered,
    );

    observeAcpToolResultWire(
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          events: [{ v: 1, type: 'session_update', data: delivered }],
        },
      },
      2_500,
    );

    expect(mockObserveBoundary).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'acp_wire',
        sessionId: 'session-secret',
        wireUtf8Bytes: 2_501,
      }),
    );
  });

  it('preserves per-call artifact summaries in bulk ACP responses', () => {
    const firstInput = acpUpdate('first-original', 'first-call');
    const firstProjected = acpUpdate('first-projected', 'first-call');
    const firstDelivered = { ...firstProjected };
    const secondInput = acpUpdate('second-original', 'second-call');
    const secondProjected = acpUpdate('second-projected', 'second-call');
    const secondDelivered = { ...secondProjected };

    associateAcpToolResultArtifact(firstInput, {
      state: 'reusable',
      kinds: ['file'],
    });
    observeAcpToolResultProjection(
      firstInput,
      firstProjected,
      'session-secret',
      firstDelivered,
    );
    associateAcpToolResultArtifact(secondInput, {
      state: 'none',
      kinds: ['image'],
    });
    observeAcpToolResultProjection(
      secondInput,
      secondProjected,
      'session-secret',
      secondDelivered,
    );

    observeAcpToolResultWire(
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          _meta: {
            [LOAD_REPLAY_META_KEY]: {
              v: 1,
              updates: [
                { sessionUpdate: 'plan', entries: [] },
                firstDelivered,
                secondDelivered,
              ],
            },
          },
        },
      },
      3_000,
    );

    expect(mockObserveBoundary).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'acp_wire',
        sessionId: 'session-secret',
        toolCallId: undefined,
        toolCallIds: ['first-call', 'second-call'],
        wireUtf8Bytes: 3_001,
        artifacts: [
          { state: 'reusable', kinds: ['file'] },
          { state: 'none', kinds: ['image'] },
        ],
      }),
    );
  });

  it('correlates Headless projection with its writer frame', () => {
    const message = headlessMessage('projected');
    observeHeadlessToolResultProjection(
      message,
      'original',
      'projected',
      'call-secret',
      { state: 'reusable', kinds: ['file'] },
    );
    const frame = '汉😀';
    observeHeadlessToolResultWire(message, frame);

    expect(mockObserveBoundary).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        stage: 'headless_projection_input',
        mutated: true,
        artifacts: [{ state: 'reusable', kinds: ['file'] }],
        values: [{ representation: 'headless_content', value: 'original' }],
      }),
    );
    expect(mockObserveBoundary).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        stage: 'headless_projection_output',
        mutated: true,
        artifacts: [{ state: 'reusable', kinds: ['file'] }],
        values: [{ representation: 'headless_content', value: 'projected' }],
      }),
    );
    expect(mockObserveBoundary).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'headless_wire',
        sessionId: 'session-secret',
        toolCallId: 'call-secret',
        mutated: true,
        wireUtf8Bytes: Buffer.byteLength(frame, 'utf8'),
        artifacts: [{ state: 'reusable', kinds: ['file'] }],
        values: [{ representation: 'headless_content', value: 'projected' }],
      }),
    );
  });

  it('logs one exact wire event for a batch JSON frame', () => {
    const first = headlessMessage('first-projected', 'first-call');
    const second = headlessMessage('second-projected', 'second-call');
    observeHeadlessToolResultProjection(
      first,
      'first-original',
      'first-projected',
      'first-call',
      { state: 'reusable', kinds: ['file'] },
    );
    observeHeadlessToolResultProjection(
      second,
      'second-original',
      'second-projected',
      'second-call',
      { state: 'none', kinds: ['image'] },
    );

    observeHeadlessJsonToolResultWire(
      [headlessMessage('uncorrelated'), first, second],
      'x'.repeat(999),
    );

    expect(mockObserveBoundary).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'headless_wire',
        toolCallId: undefined,
        toolCallIds: ['first-call', 'second-call'],
        wireUtf8Bytes: 999,
        artifacts: [
          { state: 'reusable', kinds: ['file'] },
          { state: 'none', kinds: ['image'] },
        ],
        values: [
          {
            representation: 'headless_content',
            value: 'first-projected',
          },
          {
            representation: 'headless_content',
            value: 'second-projected',
          },
        ],
      }),
    );
  });

  it('does not retain objects when neither projection event is eligible', () => {
    mockObserveBoundary.mockReturnValue(false);
    const output = acpUpdate('small');
    observeAcpToolResultProjection(output, output, 'session-secret');
    expect(mockObserveBoundary).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mutated: false }),
    );
    expect(mockObserveBoundary).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mutated: false }),
    );
    mockObserveBoundary.mockClear();

    observeAcpToolResultWire(
      {
        method: 'session/update',
        params: { update: output },
      },
      10,
    );

    expect(mockObserveBoundary).not.toHaveBeenCalled();
  });

  it('correlates eligible unmutated ACP updates with the writer', () => {
    mockObserveBoundary.mockReturnValue(true);
    const update = acpUpdate('large');
    observeAcpToolResultProjection(update, update, 'session-secret');
    mockObserveBoundary.mockClear();

    observeAcpToolResultWire(
      { method: 'session/update', params: { update } },
      20,
    );

    expect(mockObserveBoundary).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'acp_wire',
        sessionId: 'session-secret',
        mutated: false,
        wireUtf8Bytes: 21,
      }),
    );
  });

  it('does not observe the same replay-delivered ACP update twice', () => {
    mockObserveBoundary.mockReturnValue(true);
    const update = acpUpdate('large');

    observeAcpToolResultProjection(update, update, 'session-secret');
    expect(mockObserveBoundary).toHaveBeenCalledTimes(2);

    observeAcpToolResultProjection(update, update, 'session-secret');
    expect(mockObserveBoundary).toHaveBeenCalledTimes(2);

    observeAcpToolResultWire(
      { method: 'session/update', params: { update } },
      20,
    );
    expect(mockObserveBoundary).toHaveBeenCalledTimes(3);
  });

  it('swallows observer failures at projection boundaries', () => {
    mockObserveBoundary.mockImplementation(() => {
      throw new Error('diagnostic failure');
    });
    const message = headlessMessage('projected');

    expect(() =>
      observeHeadlessToolResultProjection(
        message,
        'original',
        'projected',
        'call-secret',
        { state: 'undecided', kinds: [] },
      ),
    ).not.toThrow();
    expect(() =>
      observeAcpToolResultProjection(
        acpUpdate('original'),
        acpUpdate('projected'),
        'session-secret',
      ),
    ).not.toThrow();
  });

  it('swallows observer failures at writer boundaries', () => {
    const acpInput = acpUpdate('original');
    const acpOutput = acpUpdate('projected');
    const headless = headlessMessage('projected');
    observeAcpToolResultProjection(acpInput, acpOutput, 'session-secret');
    observeHeadlessToolResultProjection(
      headless,
      'original',
      'projected',
      'call-secret',
      { state: 'undecided', kinds: [] },
    );
    mockObserveBoundary.mockImplementation(() => {
      throw new Error('diagnostic failure');
    });

    expect(() =>
      observeAcpToolResultWire(
        {
          method: 'session/update',
          params: { sessionId: 'session-secret', update: acpOutput },
        },
        10,
      ),
    ).not.toThrow();
    expect(() =>
      observeHeadlessToolResultWire(headless, 'frame'),
    ).not.toThrow();
    expect(() =>
      observeHeadlessJsonToolResultWire([headless], 'frame'),
    ).not.toThrow();
  });
});
