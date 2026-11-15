/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import {
  ManagedSessionAppendUnsettledError,
  MANAGED_SESSION_LIMITS,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';
import {
  ManagedSessionCommitRejectedError,
  scanManagedSessionJournal,
  type ManagedSessionJournalHandle,
} from './managed-session-storage.js';

const sessionKey = {
  tenantId: 'tenant',
  workspaceId: 'workspace',
  sessionId: 'session',
};
const reference: ManagedSessionDurableRef = {
  resourceId: 'resource',
  kind: 'test-resource',
  schemaVersion: 1,
  byteLength: 4,
  digest: 'b'.repeat(64),
};

async function fixture(inputCount = 0) {
  const chunks: Buffer[] = [];
  const visits = { count: 0 };
  let sealed = false;
  const journal: ManagedSessionJournalHandle = {
    sessionKey,
    async read(options) {
      const scan = scanManagedSessionJournal(
        Buffer.concat(chunks),
        sessionKey,
        options?.maxBytes,
      );
      return {
        ...scan,
        events: new Proxy(scan.events, {
          get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
              visits.count++;
            }
            return Reflect.get(target, property, receiver);
          },
        }),
      };
    },
    async appendTransaction(records) {
      chunks.push(
        Buffer.from(
          records.map((record) => `${JSON.stringify(record)}\n`).join(''),
        ),
      );
    },
    async seal() {
      sealed = true;
    },
    get writerSealed() {
      return sealed;
    },
    async abort() {},
  };
  const open = () =>
    LocalManagedSessionAuthority.open({
      journal,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      create: {
        definitionRef: reference,
        rootSnapshotRef: reference,
        createdBy: 'daemon',
      },
    });
  const submit = (authority: LocalManagedSessionAuthority, id: number) =>
    authority.submitInput(
      {
        operation: 'submitInput',
        commandId: `command-${id}`,
        sessionKey,
        contentDigest: reference.digest,
      },
      {
        inputId: `input-${id}`,
        turnId: `turn-${id}`,
        source: 'web_shell',
        contentRef: reference,
        admissionRef: reference,
        deadline: null,
        wakeReason: 'input',
      },
    );
  const authority = await open();
  for (let index = 1; index <= inputCount; index++) {
    await submit(authority, index);
  }
  return { authority, journal, visits, open, submit };
}

describe('managed authority history reads', () => {
  it('visits only the returned tail range/page and does not scan for an absent kind', async () => {
    const harness = await fixture(2048);
    const authority = await harness.open();
    const through = authority.committedSequence;
    harness.visits.count = 0;
    expect(
      authority
        .eventsInSequenceRange(through - 2, through)
        .map((event) => event.sequence),
    ).toEqual([through - 2, through - 1, through]);
    const rangeVisits = harness.visits.count;
    harness.visits.count = 0;
    expect(
      authority
        .readEvents({ afterSequence: through - 3, limit: 3 })
        .map((event) => event.sequence),
    ).toEqual([through - 2, through - 1, through]);
    const pageVisits = harness.visits.count;
    harness.visits.count = 0;
    expect(authority.lastEventOfKind('tool.intent')).toBeUndefined();
    const latestVisits = harness.visits.count;
    console.log(
      JSON.stringify({
        committed: through,
        rangeVisits,
        pageVisits,
        latestVisits,
      }),
    );
    expect.soft(rangeVisits).toBe(3);
    expect.soft(pageVisits).toBe(3);
    expect.soft(latestVisits).toBe(0);
  });

  it('preserves inclusive, clipped, fractional and non-finite range semantics', async () => {
    const { authority } = await fixture(4);
    const cases = [
      { from: 2, to: 5, expected: [2, 3, 4, 5] },
      { from: 2.2, to: 5.8, expected: [3, 4, 5] },
      { from: -10, to: 2, expected: [1, 2] },
      { from: 7, to: 100, expected: [7, 8] },
      { from: 5, to: 4, expected: [] },
      { from: NaN, to: 8, expected: [] },
      { from: 1, to: NaN, expected: [] },
      { from: Infinity, to: Infinity, expected: [] },
      { from: -Infinity, to: Infinity, expected: [1, 2, 3, 4, 5, 6, 7, 8] },
      { from: 1, to: -Infinity, expected: [] },
    ];
    for (const { from, to, expected } of cases) {
      expect(
        authority
          .eventsInSequenceRange(from, to)
          .map((event) => event.sequence),
      ).toEqual(expected);
    }
    const first = authority.readEvents({ limit: 1 })[0];
    expect(authority.eventsInSequenceRange(1, 1)[0]).toBe(first);
    expect(authority.eventsInSequenceRange(1, 8)).not.toBe(
      authority.eventsInSequenceRange(1, 8),
    );
    expect((await fixture()).authority.eventsInSequenceRange(1, 10)).toEqual(
      [],
    );
  });

  it('preserves page cursor and existing numeric limit behavior', async () => {
    const { authority } = await fixture(4);
    const cases = [
      { after: 0, limit: 3, expected: [1, 2, 3] },
      { after: 1.5, limit: 2, expected: [2, 3] },
      { after: NaN, limit: 2, expected: [1, 2] },
      { after: -3, limit: 2, expected: [1, 2] },
      { after: Infinity, limit: 2, expected: [] },
      { after: -Infinity, limit: 2, expected: [1, 2] },
      { after: 100, limit: 2, expected: [] },
      { after: 5, limit: 1.5, expected: [6, 7, 8] },
      { after: 5, limit: NaN, expected: [6, 7, 8] },
    ];
    for (const { after, limit, expected } of cases) {
      expect(
        authority
          .readEvents({ afterSequence: after, limit })
          .map((event) => event.sequence),
      ).toEqual(expected);
    }
    for (const limit of [0, -1, -Infinity]) {
      expect(() => authority.readEvents({ limit })).toThrow(
        'limit must be positive',
      );
    }
    const { authority: large } = await fixture(256);
    expect(large.readEvents()).toHaveLength(
      MANAGED_SESSION_LIMITS.defaultReadEvents,
    );
    expect(large.readEvents({ limit: Infinity })).toHaveLength(
      MANAGED_SESSION_LIMITS.maxReadEvents,
    );
    expect(
      large
        .readEvents({ afterSequence: 510, limit: 3 })
        .map((event) => event.sequence),
    ).toEqual([511, 512]);
  });

  it('keeps latest-kind results current across live writes, retries and cold open', async () => {
    const harness = await fixture(2);
    expect(harness.authority.lastEventOfKind('input.accepted')?.sequence).toBe(
      3,
    );
    expect(harness.authority.lastEventOfKind('wake.requested')?.sequence).toBe(
      4,
    );
    const original = harness.authority.lastEventOfKind('input.accepted');
    await expect(harness.submit(harness.authority, 1)).resolves.toMatchObject({
      replayed: true,
    });
    expect(harness.authority.lastEventOfKind('input.accepted')).toBe(original);
    const reopened = await harness.open();
    expect(reopened.lastEventOfKind('input.accepted')).toEqual(original);
    await harness.submit(reopened, 3);
    expect(reopened.lastEventOfKind('input.accepted')?.sequence).toBe(5);
    expect(reopened.lastEventOfKind('wake.requested')?.sequence).toBe(6);
    expect(reopened.lastEventOfKind('checkpoint.committed')).toBeUndefined();
    expect(
      (await fixture()).authority.lastEventOfKind('input.accepted'),
    ).toBeUndefined();
  });

  it('does not publish rejected events into any history read', async () => {
    const harness = await fixture(1);
    const previous = harness.authority.lastEventOfKind('input.accepted');
    vi.spyOn(harness.journal, 'appendTransaction').mockRejectedValueOnce(
      new ManagedSessionCommitRejectedError(new Error('rejected')),
    );
    await expect(harness.submit(harness.authority, 2)).rejects.toThrow(
      'rejected',
    );
    expect(harness.authority.lastEventOfKind('input.accepted')).toBe(previous);
    expect(harness.authority.eventsInSequenceRange(3, 10)).toEqual([]);
    expect(harness.authority.readEvents({ afterSequence: 2 })).toEqual([]);
    await harness.submit(harness.authority, 2);
    expect(harness.authority.lastEventOfKind('input.accepted')?.sequence).toBe(
      3,
    );
  });

  it.each(['landed', 'absent'] as const)(
    'keeps an unknown append invisible until its %s settlement',
    async (outcome) => {
      const harness = await fixture(1);
      const previous = harness.authority.lastEventOfKind('input.accepted');
      const append = harness.journal.appendTransaction.bind(harness.journal);
      harness.journal.settleAppend = async () => outcome;
      vi.spyOn(harness.journal, 'appendTransaction').mockImplementationOnce(
        async (records) => {
          if (outcome === 'landed') await append(records);
          throw new ManagedSessionAppendUnsettledError(new Error('unknown'));
        },
      );
      await expect(harness.submit(harness.authority, 2)).rejects.toThrow(
        'unknown',
      );
      expect(harness.authority.lastEventOfKind('input.accepted')).toBe(
        previous,
      );
      expect(harness.authority.readEvents({ afterSequence: 2 })).toEqual([]);
      expect(harness.authority.eventsInSequenceRange(3, 4)).toEqual([]);
      const receipt = await harness.submit(harness.authority, 2);
      expect(receipt.replayed).toBe(outcome === 'landed');
      expect(
        harness.authority.lastEventOfKind('input.accepted')?.sequence,
      ).toBe(3);
      expect(
        harness.authority.lastEventOfKind('wake.requested')?.sequence,
      ).toBe(4);
      expect(
        harness.authority
          .readEvents({ afterSequence: 2 })
          .map((event) => event.sequence),
      ).toEqual([3, 4]);
    },
  );
});
