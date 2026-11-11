/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  SessionEvent,
  SessionMessageInput,
  SessionPort,
} from '../../session/sessionPort.js';
import { createSessionMessageChannel } from '../../session/sessionMessageChannel.js';
import { createCliSessionBridge } from './cliSessionBridge.js';
import type { HistoryItemWithoutId } from '../types.js';

/** Contract fake: no remote protocol, transport or capability handling. */
function createConnectedSession() {
  const inputs: SessionMessageInput[] = [];
  const history: HistoryItemWithoutId[] = [];
  const send = vi.fn<SessionPort['submitMessage']>(async () => {});
  const interrupt = vi.fn(async () => {});
  const channel = createSessionMessageChannel({
    pendingAssistantText: '',
    activityStatus: 'idle',
  });
  const port: SessionPort = {
    observe: channel.observe,
    interrupt,
    submitMessage: async (message, options) => {
      inputs.push(message);
      channel.applyEvent({ type: 'input_prepared', message });
      channel.applyEvent({ type: 'send_started', messageId: message.id });
      try {
        await send(message, options);
      } catch (error) {
        channel.applyEvent({
          type: 'send_failed',
          messageId: message.id,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        channel.applyEvent({ type: 'send_finished', messageId: message.id });
      }
    },
  };
  const addHistoryItem = vi.fn((item: HistoryItemWithoutId) => {
    history.push(item);
  });
  const bridge = createCliSessionBridge({
    initialState: {
      pendingAssistantText: '',
      workerStatus: 'idle',
      pendingApprovalTools: [],
      pendingDisplayHistory: null,
      historyAvailable: false,
    },
    addHistoryItem,
    port,
    formatRequestError: (operation, message) =>
      `Failed to ${operation === 'submit' ? 'send remote prompt' : 'interrupt remote session'}: ${message}`,
  });
  return {
    port: channel,
    bridge,
    inputs,
    history,
    send,
    interrupt,
    addHistoryItem,
  };
}

const input: SessionMessageInput = {
  id: 'input-1',
  text: 'hello',
  content: [{ type: 'text', text: 'hello' }],
};

describe('CLI bridge message SessionPort wiring', () => {
  it('writes optimistic input before the send operation', async () => {
    const { bridge, send, inputs } = createConnectedSession();
    const calls: string[] = [];
    const writer = vi.fn(() => {
      expect(inputs).toHaveLength(1);
      calls.push('display');
    });
    send.mockImplementationOnce(async () => {
      calls.push('post');
    });
    await bridge.submitMessage(input, undefined, writer);
    expect(calls).toEqual(['display', 'post']);
    expect(writer).toHaveBeenCalledWith({ type: 'user', text: 'hello' });
  });

  it('keeps hidden input out of display while sending it once', async () => {
    const { bridge, inputs, history, send } = createConnectedSession();
    await bridge.submitMessage(input, { hideFromDisplay: true });
    expect(history).toEqual([]);
    expect(inputs).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it('forwards the original message and retry metadata without displaying another input', async () => {
    const { bridge, send, history } = createConnectedSession();
    const message: SessionMessageInput = {
      id: 'existing-user-uuid',
      text: 'look',
      content: [
        { type: 'text', text: 'look' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
        },
      ],
    };
    const options = {
      timestamp: '2026-10-29T02:00:00.000Z',
      hideFromDisplay: true,
    };
    await bridge.submitMessage(message, options);
    expect(send).toHaveBeenCalledExactlyOnceWith(message, options);
    expect(send.mock.calls[0]![0]).toBe(message);
    expect(send.mock.calls[0]![0].content).toBe(message.content);
    expect(send.mock.calls[0]![1]).toBe(options);
    expect(history).toEqual([]);
  });

  it('keeps optimistic input on send failure, displays the original error and rethrows', async () => {
    const { bridge, history, send } = createConnectedSession();
    const failure = new Error('send failed');
    send.mockRejectedValueOnce(failure);
    await expect(bridge.submitMessage(input)).rejects.toBe(failure);
    expect(history).toEqual([
      { type: 'user', text: 'hello' },
      { type: 'error', text: 'Failed to send remote prompt: send failed' },
    ]);
  });

  it('uses the caller history writer for both optimistic input and its failure', async () => {
    const { bridge, addHistoryItem, send } = createConnectedSession();
    send.mockRejectedValueOnce(new Error('failed'));
    const currentWriter = vi.fn();
    await expect(
      bridge.submitMessage(input, undefined, currentWriter),
    ).rejects.toThrow('failed');
    expect(currentWriter.mock.calls).toEqual([
      [{ type: 'user', text: 'hello' }],
      [{ type: 'error', text: 'Failed to send remote prompt: failed' }],
    ]);
    expect(addHistoryItem).not.toHaveBeenCalled();
  });

  it('subscribes once and releases observation without interrupting the session', () => {
    const { bridge, port, interrupt, send } = createConnectedSession();
    bridge.observeSession();
    bridge.observeSession();
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'text_delta', text: 'one' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    expect(bridge.getSnapshot().pendingAssistantText).toBe('one');
    bridge.dispose();
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'text_delta', text: ' two' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    expect(bridge.getSnapshot().pendingAssistantText).toBe('one');
    bridge.observeSession();
    expect(bridge.getSnapshot().pendingAssistantText).toBe('one two');
    expect(interrupt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('clears stale thinking when observation resumes after the message has completed', () => {
    const { bridge, port } = createConnectedSession();
    bridge.observeSession();
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'thinking_delta', text: '**Checking**\nDetails' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    expect(bridge.getSnapshot().thought).not.toBeNull();
    bridge.dispose();
    port.applyEvent({
      type: 'assistant_message',
      endsTurn: true,
      source: { delivery: 'live', hasDisplayHistory: false },
      content: { text: 'done', thinkingTexts: [] },
    });
    bridge.observeSession();
    expect(bridge.getSnapshot().thought).toBeNull();
    expect(bridge.getSnapshot().pendingHistoryItems).toEqual([]);
  });

  it('preserves the existing current thought when replacing restored session data', () => {
    const { bridge, port } = createConnectedSession();
    bridge.observeSession();
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'thinking_delta', text: '**Checking**\nDetails' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    const previousThought = bridge.getSnapshot().thought;
    port.restore({ pendingAssistantText: 'restored', activityStatus: 'idle' });
    expect(bridge.getSnapshot().thought).toBe(previousThought);
    expect(bridge.getSnapshot().pendingAssistantText).toBe('restored');
  });

  it('initializes from current pending thinking and body without writing formal history', () => {
    const { bridge, port, history } = createConnectedSession();
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'text_delta', text: 'body' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'thinking_delta', text: '**Checking**\nDetails' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    bridge.observeSession();
    expect(bridge.getSnapshot()).toMatchObject({
      pendingAssistantText: 'body',
      thought: { subject: 'Checking', description: 'Details' },
      workerStatus: 'running',
    });
    expect(history).toEqual([]);
  });

  it('projects streamed and complete assistant changes with shared thinking deduplication', () => {
    const { bridge, port, history } = createConnectedSession();
    bridge.observeSession();
    const thinking = '**Checking**\nDetails';
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'thinking_delta', text: thinking },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'text_delta', text: 'streamed' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    port.applyEvent({
      type: 'assistant_message',
      content: { text: 'final', thinkingTexts: [thinking] },
      endsTurn: true,
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    expect(history).toEqual([
      {
        type: 'thinking',
        thought: { subject: 'Checking', description: 'Details' },
      },
      { type: 'gemini', text: 'final' },
    ]);
    expect(bridge.getSnapshot().pendingHistoryItems).toEqual([]);
  });

  it('keeps tool-result priority and canonical-history replay policy in the display bridge', () => {
    const { bridge, port, history } = createConnectedSession();
    bridge.observeSession();
    const change: Extract<SessionEvent, { type: 'user_message' }> = {
      type: 'user_message' as const,
      synthetic: true,
      content: { text: 'must not display', images: [] },
      toolResults: [
        {
          toolUse: { id: 'tool-1', name: 'mcp__demo__lookup', input: {} },
          toolResult: { content: 'ok', isError: false },
        },
      ],
      source: { delivery: 'live', hasDisplayHistory: false },
    };
    port.applyEvent(change);
    expect(history).toEqual([expect.objectContaining({ type: 'tool_group' })]);
    bridge.apply({
      type: 'display_history',
      change: { type: 'pending', items: [{ type: 'gemini', text: 'overlay' }] },
    });
    port.applyEvent({
      ...change,
      source: { delivery: 'live', hasDisplayHistory: true },
    });
    expect(history).toHaveLength(1);
    port.applyEvent({
      ...change,
      source: { delivery: 'recovery', hasDisplayHistory: false },
    });
    expect(history).toHaveLength(2);
    expect(bridge.getSnapshot().pendingHistoryItems).toEqual([]);
  });

  it('reports interrupt failure without clearing an active message', async () => {
    const { bridge, port, interrupt, history } = createConnectedSession();
    bridge.observeSession();
    port.applyEvent({
      type: 'assistant_stream',
      delta: { type: 'text_delta', text: 'pending' },
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    interrupt.mockRejectedValueOnce(new Error('failed'));
    bridge.interrupt();
    await vi.waitFor(() =>
      expect(history).toEqual([
        { type: 'error', text: 'Failed to interrupt remote session: failed' },
      ]),
    );
    expect(bridge.getSnapshot().pendingAssistantText).toBe('pending');
  });
});
