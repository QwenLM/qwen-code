/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWebBridgeFrame, isWebBridgeFrame } from './web-bridge.js';

const actions = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock('./web-bridge-actions', () => ({
  executeWebBridgeAction: actions.execute,
}));

describe('WebBridge protocol', () => {
  beforeEach(() => vi.clearAllMocks());

  it('recognizes only command frames', () => {
    expect(isWebBridgeFrame('webbridge_call')).toBe(true);
    expect(isWebBridgeFrame('webbridge_result')).toBe(false);
  });

  it('returns a correlated error for an unknown action', async () => {
    actions.execute.mockRejectedValue(
      new Error('Unknown WebBridge action: unknown'),
    );
    const send = vi.fn();
    handleWebBridgeFrame(
      {
        type: 'webbridge_call',
        requestId: 'request-1',
        payload: { name: 'unknown', args: {} },
      } as never,
      send,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'webbridge_result',
        responseToRequestId: 'request-1',
        payload: {
          error: expect.stringContaining('Unknown WebBridge action: unknown'),
        },
      }),
    );
  });

  it('marks action deadline errors as timeouts', async () => {
    const error = new Error('WebBridge action timed out after 55s');
    error.name = 'WebBridgeTimeoutError';
    actions.execute.mockRejectedValue(error);
    const send = vi.fn();

    handleWebBridgeFrame(
      {
        type: 'webbridge_call',
        requestId: 'request-timeout',
        payload: { name: 'evaluate', args: {} },
      } as never,
      send,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    expect(send).toHaveBeenCalledWith({
      type: 'webbridge_result',
      responseToRequestId: 'request-timeout',
      payload: {
        error: 'WebBridge action timed out after 55s',
        timeout: true,
      },
    });
  });

  it('chunks artifact data below the ACP WebSocket frame limit', async () => {
    actions.execute.mockResolvedValue({
      format: 'png',
      data: 'x'.repeat(8 * 1024 * 1024 + 1),
    });
    const send = vi.fn();

    handleWebBridgeFrame(
      {
        type: 'webbridge_call',
        requestId: 'request-2',
        payload: { name: 'screenshot', args: {} },
      } as never,
      send,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(10));

    expect(send.mock.calls[0][0].payload.chunk).toHaveLength(1024 * 1024);
    expect(send.mock.calls[8][0].payload.chunk).toBe('x');
    for (const [frame] of send.mock.calls.slice(0, 9)) {
      expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThan(
        10_000_000,
      );
    }
    expect(send.mock.calls[9][0]).toEqual({
      type: 'webbridge_result',
      responseToRequestId: 'request-2',
      payload: { data: { format: 'png' }, chunked: true },
    });
  });

  it('chunks large nested results below the ACP WebSocket frame limit', async () => {
    const data = { body: 'x'.repeat(8 * 1024 * 1024 + 1) };
    actions.execute.mockResolvedValue(data);
    const send = vi.fn();

    handleWebBridgeFrame(
      {
        type: 'webbridge_call',
        requestId: 'request-large-result',
        payload: { name: 'network', args: {} },
      } as never,
      send,
    );
    await vi.waitFor(() => expect(send.mock.calls.length).toBeGreaterThan(1));

    const frames = send.mock.calls.map(([frame]) => frame);
    const chunks = frames
      .filter((frame) => frame.type === 'webbridge_result_chunk')
      .map((frame) => frame.payload.chunk);
    expect(
      frames.every(
        (frame) =>
          Buffer.byteLength(JSON.stringify(frame), 'utf8') < 10_000_000,
      ),
    ).toBe(true);
    expect(JSON.parse(chunks.join(''))).toEqual(data);
    expect(frames.at(-1)).toEqual({
      type: 'webbridge_result',
      responseToRequestId: 'request-large-result',
      payload: { chunked: true, encoding: 'json' },
    });
  });

  it('marks an empty data field as chunked', async () => {
    actions.execute.mockResolvedValue({ data: '', eof: true });
    const send = vi.fn();

    handleWebBridgeFrame(
      {
        type: 'webbridge_call',
        requestId: 'request-3',
        payload: { name: 'cdp', args: {} },
      } as never,
      send,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    expect(send).toHaveBeenCalledWith({
      type: 'webbridge_result',
      responseToRequestId: 'request-3',
      payload: { data: { eof: true }, chunked: true },
    });
  });
});
