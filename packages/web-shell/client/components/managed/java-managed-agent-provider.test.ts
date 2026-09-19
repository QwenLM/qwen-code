import { describe, expect, it, vi } from 'vitest';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createJavaManagedAgentProvider', () => {
  it('maps Java session, environment, and active turn state', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        sessionId: 'session-1',
        title: 'Managed task',
        status: 'IN_PROGRESS',
        createdAt: 10,
        updatedAt: 20,
        activeTurn: {
          turnId: 'turn-1',
          sessionId: 'session-1',
          status: 'IN_PROGRESS',
          submittedAt: 11,
        },
        environment: {
          environmentId: 'python',
          state: 'starting',
        },
        lastSequence: 3,
      }),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example?token=not-stored',
      environmentId: 'python',
      fetch: fetchImpl,
    });

    const summary = await provider.getSession('session-1', {
      clientId: 'client-1',
    });

    expect(summary).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        activeTurnId: 'turn-1',
        phase: 'agent_running',
        runtimeState: 'starting',
        runtimeReady: false,
        capabilities: { canSend: false, canCancel: true },
      }),
    );
    expect(provider.storageKey).not.toContain('token');
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://product.example/api/agent/web-shell/v1/sessions/get',
    );
  });

  it('sends idempotent create, submit, and cancel commands only to Java', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        const url = String(input);
        return jsonResponse({
          sessionId: 'session-1',
          turnId: url.includes('/sessions/create') ? 'turn-1' : 'turn-2',
          status: 'accepted',
          replayed: false,
        });
      });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      environmentId: 'python',
      fetch: fetchImpl,
    });
    const options = { clientId: 'client-1', idempotencyKey: 'key-1' };

    await provider.createSession({ text: 'hello' }, options);
    await provider.submitPrompt('session-1', { text: 'next' }, options);
    await provider.cancel('session-1', 'turn-2', options);

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://product.example/api/agent/web-shell/v1/sessions/create',
      'https://product.example/api/agent/web-shell/v1/turns/submit',
      'https://product.example/api/agent/web-shell/v1/turns/cancel',
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual(
      expect.objectContaining({
        idempotencyKey: 'key-1',
        environmentId: 'python',
        input: [{ type: 'text', text: 'hello' }],
      }),
    );
  });

  it('uses lastEventId only as the Java public sequence cursor', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          'id: 9\nevent: turn.completed\ndata: {"sequence":9,"eventId":"evt_9","sessionId":"session-1","turnId":"turn-1","type":"turn.completed","createdAt":9,"data":{},"terminal":true}\n\n',
          { status: 200 },
        ),
      );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    const events = [];
    for await (const event of provider.subscribeEvents('session-1', {
      clientId: 'client-1',
      lastEventId: 8,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ id: 9, type: 'completed' }),
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      sessionId: 'session-1',
      afterSequence: 8,
      limit: 100,
    });
  });

  it('projects a bounded transcript snapshot from canonical Java events', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        events: [
          {
            sequence: 1,
            eventId: 'evt_1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            type: 'turn.accepted',
            createdAt: 1,
            data: { input: [{ type: 'text', text: 'hello' }] },
            terminal: false,
          },
          {
            sequence: 2,
            eventId: 'evt_2',
            sessionId: 'session-1',
            turnId: 'turn-1',
            type: 'item.output_text.delta',
            createdAt: 2,
            data: { text: 'world' },
            terminal: false,
          },
        ],
        olderCursor: 'older-1',
        hasMore: true,
        lastSequence: 4,
      }),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    const transcript = await provider.getTranscript('session-1', {
      clientId: 'client-1',
      limit: 100,
    });

    expect(transcript.events).toEqual([
      expect.objectContaining({ id: 1, type: 'accepted' }),
      expect.objectContaining({ id: 2, type: 'assistant_delta' }),
    ]);
    expect(transcript.olderCursor).toBe('older-1');
    expect(transcript.lastEventId).toBe(4);
  });
});
