import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import {
  asKnownDaemonEvent,
  reduceDaemonSessionEvent,
  createDaemonSessionViewState,
} from '../../src/daemon/events.js';
import {
  createDaemonTranscriptState,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
} from '../../src/daemon/ui/index.js';
import type { DaemonTransport } from '../../src/daemon/DaemonTransport.js';

describe('session sources', () => {
  it('uses owner-routed REST and bound client identity with an ACP transport', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const restFetch = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ revision: 1, sources: [], removed: true }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    );
    const transport: DaemonTransport = {
      type: 'acp-http',
      supportsReplay: false,
      connected: true,
      restFetch,
      fetch: vi.fn(),
      subscribeEvents: vi.fn(),
      dispose: vi.fn(),
    };
    const client = new DaemonClient({ baseUrl: 'http://daemon', transport });
    const input = {
      title: 'Requirements',
      locator: { type: 'url' as const, url: 'https://example.com/#section' },
    };
    await client.listSessionSources('session/1', 'client-1');
    await client.upsertSessionSource('session/1', input, 'client-1');
    await client.removeSessionSource('session/1', 'source/1', 'client-1');
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(calls.map((call) => call.url)).toEqual([
      'http://daemon/session/session%2F1/sources',
      'http://daemon/session/session%2F1/sources',
      'http://daemon/session/session%2F1/sources/source%2F1',
    ]);
    expect(
      calls.map((call) =>
        new Headers(call.init?.headers).get('x-qwen-client-id'),
      ),
    ).toEqual(['client-1', 'client-1', 'client-1']);
    expect(calls[1]?.init?.body).toBe(JSON.stringify(input));
    expect(calls[2]?.init?.method).toBe('DELETE');
  });

  it('recognizes invalidation and never creates conversation bubbles', () => {
    const event = {
      type: 'source_changed',
      id: 7,
      data: { sessionId: 'session-a', revision: 2 },
    };
    expect(asKnownDaemonEvent(event)?.type).toBe('source_changed');
    const normalized = normalizeDaemonEvent(event);
    expect(normalized).toMatchObject([
      { type: 'session.source.changed', sessionId: 'session-a', revision: 2 },
    ]);
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState(),
      normalized,
    );
    expect(state.blocks).toEqual([]);
    expect(state.lastEventId).toBe(7);
    expect(
      reduceDaemonSessionEvent(createDaemonSessionViewState(), event)
        .unrecognizedKnownEventCount,
    ).toBe(0);
    expect(
      normalizeDaemonEvent({ ...event, data: { revision: 'invalid' } }),
    ).toEqual([]);
  });
});
