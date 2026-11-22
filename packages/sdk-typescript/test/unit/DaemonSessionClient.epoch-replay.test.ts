/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { EventBus } from '@qwen-code/acp-bridge/eventBus';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonSessionClient } from '../../src/daemon/DaemonSessionClient.js';

function fixture(lastEventId: number, supportsEpoch = true, seedEpoch = false) {
  const bus = new EventBus(1024);
  for (let index = 1; index <= 600; index++) {
    bus.publish({ type: 'session_update', data: { marker: index } });
  }
  const requests: Headers[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    requests.push(headers);
    let frames = '';
    for await (const event of bus.subscribe({
      lastEventId: Number(headers.get('last-event-id')),
      epoch: supportsEpoch
        ? (headers.get('x-qwen-event-epoch') ?? undefined)
        : undefined,
      maxQueued: 1024,
    })) {
      frames += `${event.id === undefined ? '' : `id: ${event.id}\n`}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      if (event.type === 'replay_complete') break;
    }
    return new Response(frames, {
      headers: {
        'content-type': 'text/event-stream',
        ...(supportsEpoch ? { 'x-qwen-event-epoch': bus.epoch } : {}),
      },
    });
  };
  const session = new DaemonSessionClient({
    client: new DaemonClient({ baseUrl: 'http://daemon', fetch }),
    session: { sessionId: 's-1', workspaceCwd: '/work', attached: true },
    lastEventId,
    ...(seedEpoch ? { eventEpoch: bus.epoch } : {}),
  });
  return { bus, session, requests };
}

describe('cursor provenance against a populated daemon EventBus', () => {
  it('replays the missing prefix before advancing an epochless saved cursor', async () => {
    const { bus, session, requests } = fixture(500);
    const ids: number[] = [];
    try {
      for await (const event of session.events()) {
        if (event.id !== undefined) ids.push(event.id);
      }
      expect(ids).toEqual(Array.from({ length: 600 }, (_, index) => index + 1));
      expect(requests[0]?.get('last-event-id')).toBe('500');
      expect(requests[0]?.get('x-qwen-event-epoch')).toBe(
        'unpaired-cursor-epoch',
      );
      expect(session.lastEventId).toBe(600);
      expect(session.eventEpoch).toBe(bus.epoch);
    } finally {
      bus.close();
    }
  });

  it('retains numeric replay on older daemons without epoch support', async () => {
    const { bus, session, requests } = fixture(500, false);
    const ids: number[] = [];
    try {
      for await (const event of session.events()) {
        if (event.id !== undefined) ids.push(event.id);
      }
      expect(ids).toEqual(
        Array.from({ length: 100 }, (_, index) => index + 501),
      );
      expect(requests[0]?.get('last-event-id')).toBe('500');
      expect(session.eventEpoch).toBeUndefined();
    } finally {
      bus.close();
    }
  });

  it('does not attach a placeholder epoch to an explicit zero cursor', async () => {
    const { bus, session, requests } = fixture(0);
    try {
      for await (const _event of session.events()) {
        // Drain the replay without inventing an epoch mismatch for a fresh cursor.
      }
      expect(requests[0]?.get('last-event-id')).toBe('0');
      expect(requests[0]?.get('x-qwen-event-epoch')).toBeNull();
    } finally {
      bus.close();
    }
  });

  it('preserves an explicit forward seek before any epoch change', async () => {
    const { bus, session, requests } = fixture(100, true, true);
    try {
      for await (const _event of session.events({ lastEventId: 500 })) {
        // An override within the unchanged known epoch retains its contract.
      }
      expect(requests[0]?.get('last-event-id')).toBe('500');
      expect(requests[0]?.get('x-qwen-event-epoch')).toBe(bus.epoch);
    } finally {
      bus.close();
    }
  });

  it('preserves an explicit cursor and epoch pair after resynchronization', async () => {
    const { bus, session, requests } = fixture(500);
    try {
      for await (const event of session.events()) {
        if (event.id === 100) break;
      }
      expect(session.lastEventId).toBeLessThan(500);
      for await (const _event of session.events({
        lastEventId: 500,
        epoch: bus.epoch,
      })) {
        // A caller-supplied pair intentionally seeks past the retained cursor.
      }
      expect(requests[1]?.get('last-event-id')).toBe('500');
      expect(requests[1]?.get('x-qwen-event-epoch')).toBe(bus.epoch);
    } finally {
      bus.close();
    }
  });

  it('remembers an unpaired explicit cursor even when the stored cursor is zero', async () => {
    const { bus, session, requests } = fixture(0);
    try {
      for await (const event of session.events({ lastEventId: 500 })) {
        if (event.id === 100) break;
      }
      expect(requests[0]?.get('x-qwen-event-epoch')).toBe(
        'unpaired-cursor-epoch',
      );
      const resumeFrom = session.lastEventId!;
      expect(resumeFrom).toBeLessThan(500);
      const ids: number[] = [];
      for await (const event of session.events({ lastEventId: 500 })) {
        if (event.id !== undefined) ids.push(event.id);
      }
      expect(ids).toEqual(
        Array.from(
          { length: 600 - resumeFrom },
          (_, index) => resumeFrom + index + 1,
        ),
      );
      expect(requests[1]?.get('last-event-id')).toBe(String(resumeFrom));
      expect(requests[1]?.get('x-qwen-event-epoch')).toBe(bus.epoch);
    } finally {
      bus.close();
    }
  });

  it('does not restrict a same-epoch seek after learning an epoch from zero', async () => {
    const { bus, session, requests } = fixture(0);
    try {
      for await (const event of session.events()) {
        if (event.id === 100) break;
      }
      for await (const _event of session.events({ lastEventId: 500 })) {
        // Learning an epoch with no old positive cursor is not a cursor reset.
      }
      expect(requests[1]?.get('last-event-id')).toBe('500');
      expect(requests[1]?.get('x-qwen-event-epoch')).toBe(bus.epoch);
    } finally {
      bus.close();
    }
  });
});
