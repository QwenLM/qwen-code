/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonSessionClient } from '../../src/daemon/DaemonSessionClient.js';

function fixture(
  lastEventId?: number,
  eventEpoch?: string,
  epochs = ['new', 'new', 'new'],
) {
  const requests: Headers[] = [];
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Headers(init?.headers));
    return new Response('', {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-qwen-event-epoch': epochs[requests.length - 1] ?? 'new',
      },
    });
  });
  const session = new DaemonSessionClient({
    client: new DaemonClient({ baseUrl: 'http://daemon', fetch }),
    session: { sessionId: 's-1', workspaceCwd: '/work/a', attached: true },
    lastEventId,
    eventEpoch,
  });
  return { session, requests };
}

describe('session replay cursor epoch boundary', () => {
  it('resets an existing cursor even when the new epoch has no events', async () => {
    const { session, requests } = fixture(100, 'old');
    for await (const _event of session.events()) {
      /* empty stream */
    }
    for await (const _event of session.events()) {
      /* empty stream */
    }
    expect(requests[1]?.get('last-event-id')).toBe('0');
    expect(requests[1]?.get('x-qwen-event-epoch')).toBe('new');
  });

  it('does not relabel an epochless saved cursor with a newly learned epoch', async () => {
    const { session, requests } = fixture(100);
    for await (const _event of session.events()) {
      /* empty stream */
    }
    for await (const _event of session.events()) {
      /* empty stream */
    }
    expect(requests[1]?.get('last-event-id')).toBe('0');
    expect(requests[1]?.get('x-qwen-event-epoch')).toBe('new');
  });

  it('preserves live-only subscription when no cursor existed', async () => {
    const { session, requests } = fixture(undefined, 'old');
    for await (const _event of session.events()) {
      /* empty stream */
    }
    for await (const _event of session.events()) {
      /* empty stream */
    }
    expect(requests[1]?.get('last-event-id')).toBeNull();
  });

  it('does not reuse an explicit old cursor after learning a different epoch', async () => {
    const { session, requests } = fixture(500, 'old', ['old', 'new', 'new']);
    for await (const _event of session.events()) {
      /* empty stream */
    }
    for await (const _event of session.events({
      lastEventId: 500,
      epoch: 'old',
    })) {
      /* empty stream */
    }
    for await (const _event of session.events({ lastEventId: 500 })) {
      /* empty stream */
    }
    expect(requests[2]?.get('last-event-id')).toBe('0');
    expect(requests[2]?.get('x-qwen-event-epoch')).toBe('new');
  });
});
