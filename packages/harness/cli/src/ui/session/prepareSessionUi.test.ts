/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  prepareSessionUi,
  createSessionUiBinding,
} from './prepareSessionUi.js';
import { createSessionMessageChannel } from '../../session/sessionMessageChannel.js';
import type { SessionHandle, SessionState } from '../../session/session.js';

const state: SessionState = {
  model: 'test-model',
  permissionMode: 'default',
  title: 'session',
  models: [],
  modeChoices: [],
  approvals: [],
  access: { status: 'disconnected', sessionId: 'test', error: null },
  initialMessages: {
    pendingAssistantText: 'restored',
    activityStatus: 'running',
  },
  pendingHistory: null,
  historyAvailable: false,
};
describe('generic session UI preparation', () => {
  it('disposes a native UI binding without releasing the executor-owned handle', async () => {
    const release = vi.fn(async () => {});
    const session = {
      getState: () => state,
      release,
      describeOperationError: (_operation: string, text: string) => text,
    } as unknown as SessionHandle;
    const binding = createSessionUiBinding(session, 'local');
    await binding.dispose();
    expect(release).not.toHaveBeenCalled();
  });
  it('keeps the existing local entry without a supplied session', () => {
    expect(prepareSessionUi()).toBeUndefined();
  });
  it('binds one supplied session without connecting before history is attached', async () => {
    const channel = createSessionMessageChannel(state.initialMessages);
    const stop = vi.fn();
    const observe = vi.fn((listener) => {
      const unsubscribe = channel.observe(listener);
      return () => {
        stop();
        unsubscribe();
      };
    });
    const release = vi.fn(async () => {
      expect(stop).toHaveBeenCalledOnce();
    });
    const start = vi.fn(async () => {});
    const session = {
      observe,
      release,
      start,
      getState: () => state,
      describeOperationError: (_operation: string, message: string) => message,
    } as unknown as SessionHandle;
    const binding = prepareSessionUi(session)!;
    expect(binding.session).toBe(session);
    expect(observe).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(binding.uiSession.getSnapshot().pendingAssistantText).toBe(
      'restored',
    );
    const first = vi.fn();
    const latest = vi.fn();
    const unbind = binding.bindHistoryWriter(first);
    binding.uiSession.observeSession();
    channel.applyEvent({
      type: 'assistant_message',
      content: { text: 'first', thinkingTexts: [] },
      endsTurn: true,
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    expect(first).toHaveBeenCalledWith({ type: 'gemini', text: 'first' });
    binding.bindHistoryWriter(latest);
    unbind();
    channel.applyEvent({
      type: 'assistant_message',
      content: { text: 'latest', thinkingTexts: [] },
      endsTurn: true,
      source: { delivery: 'live', hasDisplayHistory: false },
    });
    expect(latest).toHaveBeenCalledWith({ type: 'gemini', text: 'latest' });
    await binding.dispose();
    expect(release).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });
  it('propagates binding failure without falling back to local execution', () => {
    const session = {
      getState: () => {
        throw new Error('state failed');
      },
    } as unknown as SessionHandle;
    expect(() => prepareSessionUi(session)).toThrow('state failed');
  });
});
