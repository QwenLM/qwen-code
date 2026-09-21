/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-initiated tool scheduling tests (/restore, /setup-github parity):
 * the one-shot CoreToolScheduler runs with isClientInitiated requests, its
 * completion feeds tool-result/tool-end events, and the result never becomes
 * a model follow-up (the generator ends with `done`).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { OpenTuiStreamEvent } from './event-adapter.js';

interface ScheduledCall {
  request: { callId: string; name: string; args?: unknown };
  status: string;
  response?: { resultDisplay?: unknown };
}

let schedulerBehavior: (
  options: {
    onToolCallsUpdate?: (calls: unknown[]) => void;
    onAllToolCallsComplete?: (calls: ScheduledCall[]) => Promise<void>;
  },
  requests: Array<{ callId: string; name: string; args?: unknown }>,
) => Promise<void>;

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    CoreToolScheduler: class {
      constructor(
        private readonly options: {
          onToolCallsUpdate?: (calls: unknown[]) => void;
          onAllToolCallsComplete?: (calls: ScheduledCall[]) => Promise<void>;
        },
      ) {}
      async schedule(
        request:
          | { callId: string; name: string; args?: unknown }
          | Array<{ callId: string; name: string; args?: unknown }>,
      ): Promise<void> {
        const requests = Array.isArray(request) ? request : [request];
        await schedulerBehavior(this.options, requests);
      }
    },
  };
});

import { clientToolEvents } from './client-tool-run.js';

async function collect(
  generator: AsyncGenerator<OpenTuiStreamEvent>,
): Promise<OpenTuiStreamEvent[]> {
  const events: OpenTuiStreamEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe('clientToolEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const config = {} as Config;

  it('schedules a client-initiated call and streams its result', async () => {
    schedulerBehavior = async (options, requests) => {
      await options.onAllToolCallsComplete?.(
        requests.map((request) => ({
          request,
          status: 'success',
          response: { resultDisplay: 'restored 3 files' },
        })),
      );
    };
    const events = await collect(
      clientToolEvents(config, 'restore_files', { checkpoint: 'c1' }),
    );
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      'tool-start',
      'tool-args',
      'tool-result',
      'tool-end',
      'done',
    ]);
    const start = events[0];
    if (start?.type === 'tool-start') {
      expect(start.tool).toBe('restore_files');
    }
    const result = events[2];
    if (result?.type === 'tool-result') {
      expect(result.display).toBe('restored 3 files');
    }
    const end = events[3];
    if (end?.type === 'tool-end') {
      expect(end.success).toBe(true);
    }
  });

  it('marks failed executions as unsuccessful tool-end events', async () => {
    schedulerBehavior = async (options, requests) => {
      await options.onAllToolCallsComplete?.(
        requests.map((request) => ({
          request,
          status: 'error',
          response: { resultDisplay: 'boom' },
        })),
      );
    };
    const events = await collect(
      clientToolEvents(config, 'run_shell_command', { command: 'false' }),
    );
    const end = events.find((event) => event.type === 'tool-end');
    if (end?.type === 'tool-end') {
      expect(end.success).toBe(false);
      expect(end.summary).toBe('error');
    } else {
      throw new Error('expected a tool-end event');
    }
  });

  it('surfaces awaiting_approval calls through onWaitingCall', async () => {
    const onConfirm = vi.fn();
    schedulerBehavior = async (options, requests) => {
      options.onToolCallsUpdate?.([
        {
          status: 'awaiting_approval',
          request: requests[0],
          confirmationDetails: { type: 'exec', onConfirm },
        },
      ]);
      await options.onAllToolCallsComplete?.(
        requests.map((request) => ({ request, status: 'success' })),
      );
    };
    const waiting: Array<{ name: string }> = [];
    const events = await collect(
      clientToolEvents(
        config,
        'run_shell_command',
        { command: 'gh auth status' },
        undefined,
        {
          onWaitingCall: (call) => {
            waiting.push({ name: call.name });
          },
        },
      ),
    );
    expect(waiting).toEqual([{ name: 'run_shell_command' }]);
    expect(events.map((event) => event.type)).toContain('done');
  });
});
