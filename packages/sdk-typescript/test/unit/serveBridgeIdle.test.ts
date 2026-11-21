/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../../src/daemon/DaemonClient.js';
import type { PromptResult } from '../../src/daemon/types.js';
import { agentTools } from '../../src/daemon-mcp/serve-bridge/tools/agent.js';
import {
  createPromptCollector,
  startSessionCleanup,
} from '../../src/daemon-mcp/serve-bridge/sse.js';
import type {
  BridgeState,
  SessionEventStream,
} from '../../src/daemon-mcp/serve-bridge/types.js';

const MINUTE = 60_000;

function setup(client: Partial<DaemonClient> = {}) {
  const stream: SessionEventStream = {
    sessionId: 'session',
    abortCtrl: new AbortController(),
    activeCollector: null,
    lastActivityMs: Date.now(),
  };
  const state: BridgeState = {
    client: client as DaemonClient,
    daemonUrl: 'http://daemon',
    token: undefined,
    defaultSessionId: 'session',
    workspaceCwd: undefined,
    eventStreams: new Map([['session', stream]]),
    allowGlobalScope: false,
  };
  return { stream, state };
}

describe('serve bridge idle cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retains a quiet stream while its prompt is active', async () => {
    vi.useFakeTimers();
    const { stream, state } = setup();
    const collector = createPromptCollector();
    stream.activeCollector = collector;
    const stop = startSessionCleanup(state);
    try {
      await vi.advanceTimersByTimeAsync(35 * MINUTE);
      expect(stream.abortCtrl.signal.aborted).toBe(false);
      expect(collector.interrupted).toBeUndefined();
      expect(state.eventStreams.get('session')).toBe(stream);
    } finally {
      stop();
    }
  });

  it('still removes an idle stream after the existing TTL', async () => {
    vi.useFakeTimers();
    const { stream, state } = setup();
    const stop = startSessionCleanup(state);
    try {
      await vi.advanceTimersByTimeAsync(35 * MINUTE);
      expect(stream.abortCtrl.signal.aborted).toBe(true);
      expect(state.eventStreams.size).toBe(0);
      expect(state.defaultSessionId).toBeUndefined();
    } finally {
      stop();
    }
  });

  it('starts a fresh idle window when a quiet prompt finishes', async () => {
    vi.useFakeTimers();
    let finish!: (result: PromptResult) => void;
    const response = new Promise<PromptResult>((resolve) => {
      finish = resolve;
    });
    const { stream, state } = setup({ prompt: vi.fn(() => response) });
    const prompt = agentTools(state).find((entry) => entry.name === 'prompt')!;
    const pending = prompt.handler({ prompt: 'long running tool' }, undefined);
    await vi.advanceTimersByTimeAsync(35 * MINUTE);
    stream.activeCollector!.resolve();
    finish({ stopReason: 'end_turn' });
    await pending;
    const stop = startSessionCleanup(state);
    try {
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      expect(state.eventStreams.get('session')).toBe(stream);
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
      expect(state.eventStreams.size).toBe(0);
    } finally {
      stop();
    }
  });
});
