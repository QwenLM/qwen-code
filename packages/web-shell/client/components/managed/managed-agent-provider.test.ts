import { describe, expect, it, vi } from 'vitest';
import type {
  DaemonClient,
  DaemonManagedSessionEvent,
  DaemonManagedSessionSummary,
} from '@qwen-code/sdk/daemon';
import { createDaemonManagedAgentProvider } from './managed-agent-provider';

function summary(): DaemonManagedSessionSummary {
  return {
    sessionId: 'session-1',
    promptId: 'prompt-1',
    title: 'Task',
    workspaceCwd: '/workspace',
    createdAt: 1,
    admittedAt: 2,
    updatedAt: 3,
    phase: 'agent_running',
    runtimeReady: false,
    runtimeState: 'starting',
    capabilities: { canSend: false, canCancel: true },
  };
}

function event(): DaemonManagedSessionEvent {
  return {
    id: 7,
    at: 10,
    type: 'assistant_delta',
    sessionId: 'session-1',
    promptId: 'prompt-1',
    data: { text: 'hello' },
  };
}

describe('createDaemonManagedAgentProvider', () => {
  it('keeps daemon transport behind the provider contract', async () => {
    const client = {
      listManagedSessions: vi.fn().mockResolvedValue({
        sessions: [summary()],
        nextCursor: 'next',
      }),
      createManagedSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        promptId: 'prompt-1',
      }),
    } as unknown as DaemonClient;
    const provider = createDaemonManagedAgentProvider(client, 'http://daemon');

    await expect(
      provider.listSessions({
        clientId: 'client-1',
        workspaceCwd: '/workspace',
        limit: 20,
      }),
    ).resolves.toEqual({
      sessions: [
        {
          sessionId: 'session-1',
          activeTurnId: 'prompt-1',
          title: 'Task',
          workspaceCwd: '/workspace',
          createdAt: 1,
          admittedAt: 2,
          updatedAt: 3,
          phase: 'agent_running',
          runtimeReady: false,
          runtimeState: 'starting',
          capabilities: { canSend: false, canCancel: true },
        },
      ],
      nextCursor: 'next',
    });
    await expect(
      provider.createSession(
        { text: 'hello', workspaceCwd: '/workspace' },
        { clientId: 'client-1', idempotencyKey: 'request-1' },
      ),
    ).resolves.toEqual({ sessionId: 'session-1', turnId: 'prompt-1' });
    expect(client.listManagedSessions).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace', limit: 20 }),
    );
    expect(client.createManagedSession).toHaveBeenCalledWith(
      {
        prompt: [{ type: 'text', text: 'hello' }],
        cwd: '/workspace',
      },
      expect.objectContaining({ idempotencyKey: 'request-1' }),
    );
    expect(provider.kind).toBe('daemon');
  });

  it('maps daemon event streams to provider events', async () => {
    const client = {
      subscribeManagedSessionEvents: vi
        .fn()
        .mockImplementation(async function* () {
          yield event();
        }),
    } as unknown as DaemonClient;
    const provider = createDaemonManagedAgentProvider(client, 'http://daemon');

    const received = [];
    for await (const value of provider.subscribeEvents('session-1', {
      clientId: 'client-1',
      lastEventId: 6,
    })) {
      received.push(value);
    }

    const { promptId: _promptId, ...daemonEvent } = event();
    expect(received).toEqual([{ ...daemonEvent, turnId: 'prompt-1' }]);
    expect(client.subscribeManagedSessionEvents).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ lastEventId: 6 }),
    );
  });
});
