/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeFakeConfig,
  readSubagentTranscript,
  type Message,
} from '@qwen-code/core';
import { renderHookWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import {
  useAgentTranscript,
  type AgentTranscriptSource,
} from './useAgentTranscript.js';

vi.mock('@qwen-code/core', async () => {
  const actual = await vi.importActual<typeof import('@qwen-code/core')>(
    '@qwen-code/core',
  );
  return {
    ...actual,
    readSubagentTranscript: vi.fn(),
  };
});

const mockReadSubagentTranscript = vi.mocked(readSubagentTranscript);

function message(uuid: string): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: uuid },
  };
}

function source(liveMessages: Message[]): AgentTranscriptSource {
  return {
    id: 'a-agent-1',
    agentId: 'agent-1',
    status: 'running',
    liveMessages,
  };
}

describe('useAgentTranscript', () => {
  beforeEach(() => {
    mockReadSubagentTranscript.mockReset();
  });

  it('UUID-merges the disk prefix with the retained live suffix once', async () => {
    mockReadSubagentTranscript.mockResolvedValue({
      agentId: 'agent-1',
      messages: [message('disk-1'), message('overlap')],
      leafUuid: 'overlap',
      metadata: null,
    });

    const hook = await renderHookWithProviders(
      (task: AgentTranscriptSource) => useAgentTranscript(task),
      {
        initialProps: source([message('overlap'), message('live-1')]),
        config: makeFakeConfig({
          targetDir: process.cwd(),
          cwd: process.cwd(),
          sessionId: 'session-1',
        }),
      },
    );

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.messages.map((item) => item.uuid)).toEqual([
      'disk-1',
      'overlap',
      'live-1',
    ]);

    hook.rerender(
      source([message('overlap'), message('live-1'), message('live-2')]),
    );
    expect(hook.result.current.messages.map((item) => item.uuid)).toEqual([
      'disk-1',
      'overlap',
      'live-1',
      'live-2',
    ]);
    expect(mockReadSubagentTranscript).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('merges a disk snapshot with the latest live suffix that arrived while reading', async () => {
    let resolveRead:
      | ((value: Awaited<ReturnType<typeof readSubagentTranscript>>) => void)
      | undefined;
    mockReadSubagentTranscript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );

    const hook = await renderHookWithProviders(
      (task: AgentTranscriptSource) => useAgentTranscript(task),
      {
        initialProps: source([message('live-before-open')]),
        config: makeFakeConfig({
          targetDir: process.cwd(),
          cwd: process.cwd(),
          sessionId: 'session-1',
        }),
      },
    );

    hook.rerender(
      source([
        message('live-before-open'),
        message('live-during-read-1'),
        message('live-during-read-2'),
      ]),
    );
    resolveRead?.({
      agentId: 'agent-1',
      messages: [message('disk-1'), message('live-before-open')],
      leafUuid: 'live-before-open',
      metadata: null,
    });

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.messages.map((item) => item.uuid)).toEqual([
      'disk-1',
      'live-before-open',
      'live-during-read-1',
      'live-during-read-2',
    ]);
    hook.unmount();
  });

  it('refreshes the disk prefix once when a running task becomes terminal', async () => {
    mockReadSubagentTranscript
      .mockResolvedValueOnce({
        agentId: 'agent-1',
        messages: [message('disk-before-terminal')],
        leafUuid: 'disk-before-terminal',
        metadata: null,
      })
      .mockResolvedValueOnce({
        agentId: 'agent-1',
        messages: [
          message('disk-before-terminal'),
          message('disk-final-result'),
        ],
        leafUuid: 'disk-final-result',
        metadata: null,
      });

    const hook = await renderHookWithProviders(
      (task: AgentTranscriptSource) => useAgentTranscript(task),
      {
        initialProps: source([]),
        config: makeFakeConfig({
          targetDir: process.cwd(),
          cwd: process.cwd(),
          sessionId: 'session-1',
        }),
      },
    );

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    hook.rerender({ ...source([]), status: 'completed' });
    await waitFor(() =>
      expect(mockReadSubagentTranscript).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.messages.map((item) => item.uuid)).toEqual([
      'disk-before-terminal',
      'disk-final-result',
    ]);
    hook.unmount();
  });
});
