/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { FileManagedSessionHistory } from './managed-session-history.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import {
  ManagedSessionAppendUnsettledError,
  MANAGED_SESSION_LIMITS,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';
import {
  ManagedSessionCommitRejectedError,
  scanManagedSessionJournal,
  scanManagedSessionJournalStream,
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
    scan: (consume) =>
      scanManagedSessionJournalStream(
        (async function* () {
          yield* chunks;
        })(),
        sessionKey,
        consume,
      ),
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
    const harness = await fixture(8);
    const authority = await harness.open();
    const through = authority.committedSequence;
    const reads = vi.spyOn(FileManagedSessionHistory.prototype, 'readBlock');
    expect(
      (
        await authority.iterateEvents(through - 2, through).collect(1_000_000)
      ).map((event) => event.sequence),
    ).toEqual([through - 2, through - 1, through]);
    const rangeVisits = reads.mock.calls.length;
    reads.mockClear();
    expect(
      (
        await authority.readEvents({ afterSequence: through - 3, limit: 3 })
      ).map((event) => event.sequence),
    ).toEqual([through - 2, through - 1, through]);
    const pageVisits = reads.mock.calls.length;
    reads.mockClear();
    expect(authority.lastEventOfKind('tool.intent')).toBeUndefined();
    const latestVisits = reads.mock.calls.length;
    console.log(
      JSON.stringify({
        committed: through,
        rangeVisits,
        pageVisits,
        latestVisits,
      }),
    );
    expect.soft(rangeVisits).toBe(2);
    expect.soft(pageVisits).toBe(2);
    expect.soft(latestVisits).toBe(0);
    reads.mockRestore();
    await authority.disposeHistory();
    await harness.authority.disposeHistory();
  });

  it('preserves inclusive integer ranges and rejects invalid sequence bounds', async () => {
    const { authority } = await fixture(4);
    for (const { from, to, expected } of [
      { from: 2, to: 5, expected: [2, 3, 4, 5] },
      { from: 7, to: 100, expected: [7, 8] },
      { from: 5, to: 4, expected: [] },
      { from: 1, to: 0, expected: [] },
    ])
      expect(
        (await authority.iterateEvents(from, to).collect(16)).map(
          (event) => event.sequence,
        ),
      ).toEqual(expected);
    for (const [from, to] of [
      [2.2, 5.8],
      [-10, 2],
      [NaN, 8],
      [1, NaN],
      [Infinity, Infinity],
      [-Infinity, Infinity],
      [1, -Infinity],
    ])
      expect(() => authority.iterateEvents(from, to)).toThrow(
        /safe integer bounds/,
      );
    const first = (await authority.readEvents({ limit: 1 }))[0];
    expect((await authority.iterateEvents(1, 1).collect(1_000_000))[0]).toEqual(
      first,
    );
    expect(await authority.iterateEvents(1, 8).collect(1_000_000)).not.toBe(
      await authority.iterateEvents(1, 8).collect(1_000_000),
    );
    expect(
      await (await fixture()).authority.iterateEvents(1, 10).collect(1_000_000),
    ).toEqual([]);
  });

  it('pages a frozen prefix and rejects invalid cursors and limits', async () => {
    const { authority } = await fixture(4);
    for (const { after, limit, expected } of [
      { after: 0, limit: 3, expected: [1, 2, 3] },
      { after: 1, limit: 2, expected: [2, 3] },
      { after: 100, limit: 2, expected: [] },
      { after: Number.MAX_SAFE_INTEGER, limit: 2, expected: [] },
    ])
      expect(
        (await authority.readEvents({ afterSequence: after, limit })).map(
          (event) => event.sequence,
        ),
      ).toEqual(expected);
    for (const afterSequence of [1.5, NaN, -3, Infinity, -Infinity])
      await expect(authority.readEvents({ afterSequence })).rejects.toThrow(
        /outside their bounds/,
      );
    for (const limit of [0, -1, 1.5, NaN, Infinity, -Infinity, 257])
      await expect(authority.readEvents({ limit })).rejects.toThrow(
        /outside their bounds/,
      );
    for (const throughSequence of [0.5, NaN, -1, Infinity])
      await expect(authority.readEvents({ throughSequence })).rejects.toThrow(
        /safe integer/,
      );
    const { authority: large } = await fixture(128);
    expect(await large.readEvents()).toHaveLength(
      MANAGED_SESSION_LIMITS.defaultReadEvents,
    );
    expect(
      await large.readEvents({ limit: MANAGED_SESSION_LIMITS.maxReadEvents }),
    ).toHaveLength(MANAGED_SESSION_LIMITS.maxReadEvents);
    expect(
      (await large.readEvents({ afterSequence: 254, limit: 3 })).map(
        (event) => event.sequence,
      ),
    ).toEqual([255, 256]);
    await authority.disposeHistory();
    await large.disposeHistory();
  }, 60_000);

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
    expect(
      await harness.authority.iterateEvents(3, 10).collect(1_000_000),
    ).toEqual([]);
    expect(await harness.authority.readEvents({ afterSequence: 2 })).toEqual(
      [],
    );
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
      expect(await harness.authority.readEvents({ afterSequence: 2 })).toEqual(
        [],
      );
      expect(
        await harness.authority.iterateEvents(3, 4).collect(1_000_000),
      ).toEqual([]);
      const receipt = await harness.submit(harness.authority, 2);
      expect(receipt.replayed).toBe(outcome === 'landed');
      expect(
        harness.authority.lastEventOfKind('input.accepted')?.sequence,
      ).toBe(3);
      expect(
        harness.authority.lastEventOfKind('wake.requested')?.sequence,
      ).toBe(4);
      expect(
        (await harness.authority.readEvents({ afterSequence: 2 })).map(
          (event) => event.sequence,
        ),
      ).toEqual([3, 4]);
    },
  );
});
