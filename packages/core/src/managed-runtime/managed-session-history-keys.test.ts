/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { FileManagedSessionHistory } from './managed-session-history.js';
import type {
  ManagedSessionEvent,
  ManagedSessionEventKind,
  ManagedSessionJsonValue,
} from './managed-session-records.js';

it('uses the Java golden identity bytes for canonical correlation indexing and native lookups', async () => {
  const fixtures = JSON.parse(
    await readFile(
      new URL(
        '../../../managed-agent-server/src/test/resources/managed-session-history-keys.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Array<{
    kind: ManagedSessionEventKind;
    field: string;
    value: string;
    identity: string;
  }>;
  const root = await mkdtemp(path.join(tmpdir(), 'managed-history-keys-'));
  const history = await FileManagedSessionHistory.create(root);
  const events = fixtures.map((fixture, index): ManagedSessionEvent => {
    const payload: Record<string, ManagedSessionJsonValue> = {};
    if (fixture.field === 'target.turnId')
      payload['target'] = { turnId: fixture.value };
    else if (fixture.field !== 'kind') payload[fixture.field] = fixture.value;
    return {
      v: 1,
      sequence: index + 1,
      eventId: `event-${index}`,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: 'session',
      },
      kind: fixture.kind,
      occurredAt: 0,
      payload,
    };
  });
  const query = vi.fn(async (_family: string, identity: string) => {
    const index = fixtures.findIndex(
      (fixture) => fixture.identity === identity,
    );
    return index < 0 ? [] : [{ sequence: index + 1 }];
  });
  const state = {
    committed: fixtures.length,
    latestByKind: new Map(),
    eventCorrelations: history.map('event-correlation'),
    eventLinks: history.map('event-link'),
    receiptsByExecutionCall: history.map('receipt'),
    nativeHistory: {
      query,
      readEvent: async (fact: { sequence: number }) =>
        events[fact.sequence - 1],
      repair: vi.fn(async () => {
        throw new Error('A shared identity must not require repair.');
      }),
    },
  };
  // Admission is covered separately; this exercises the production index and query codec.
  const methods = LocalManagedSessionAuthority.prototype as unknown as {
    indexCommittedEvent(
      this: unknown,
      event: ManagedSessionEvent,
    ): Promise<void>;
    findEvent(
      this: unknown,
      kind: ManagedSessionEventKind,
      field: string,
      value: string,
    ): Promise<ManagedSessionEvent | undefined>;
  };
  try {
    for (const event of events)
      await methods.indexCommittedEvent.call(state, event);
    for (const [index, fixture] of fixtures.entries()) {
      expect(await state.eventCorrelations.get(fixture.identity)).toEqual({
        first: index + 1,
        last: index + 1,
        count: 1,
      });
      expect(
        await methods.findEvent.call(
          state,
          fixture.kind,
          fixture.field,
          fixture.value,
        ),
      ).toEqual(events[index]);
      expect(query.mock.calls[index]?.[1]).toBe(fixture.identity);
    }
  } finally {
    await history.close();
    await rm(root, { recursive: true, force: true });
  }
});
