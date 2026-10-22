/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileManagedActivationStore } from './managed-activation-store.js';
import { FileManagedSessionInbox } from './managed-session-inbox.js';
import {
  encodeManagedJournalSnapshot,
  MANAGED_JOURNAL_COMPACT_BYTES,
  parseManagedJournalSnapshot,
  replaceManagedJournalWithSnapshot,
} from './managed-journal-snapshot.js';

const fault = vi.hoisted(() => ({
  phase: undefined as
    | 'write'
    | 'file-sync'
    | 'rename'
    | 'directory-sync'
    | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const pending = String(args[0]).endsWith('.snapshot.pending');
      return {
        writeFile: async (bytes: Buffer) => {
          if (pending && fault.phase === 'write') {
            await handle.writeFile(bytes.subarray(0, 10));
            throw new Error('snapshot write failed');
          }
          await handle.writeFile(bytes);
        },
        sync: async () => {
          if (fault.phase === (pending ? 'file-sync' : 'directory-sync')) {
            throw new Error(`snapshot ${fault.phase} failed`);
          }
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      if (fault.phase === 'rename') throw new Error('snapshot rename failed');
      await original.rename(...args);
    },
  };
});

const phases = ['write', 'file-sync', 'rename', 'directory-sync'] as const;
const activationLimits = { maxQueued: 10, maxQueuedPerTenant: 10 };
const inboxLimits = { maxPending: 10, maxPendingPerTenant: 10 };

const adapters = [
  {
    name: 'activation',
    async prepare(file: string) {
      const input = {
        tenantId: 'tenant',
        sessionId: 'session',
        activationId: 'activation',
        payloadRef: 'x'.repeat(MANAGED_JOURNAL_COMPACT_BYTES),
        reason: 'user_message' as const,
        recovery: 'replay_safe' as const,
      };
      const store = await FileManagedActivationStore.open(file);
      await store.enqueue(input, activationLimits);
      const expected = store.get(input);
      return {
        halted: () => store.haltedError,
        mutate: () => store.claim(input, 'worker', 300_000),
        async retry() {
          const reopened = await FileManagedActivationStore.open(file);
          expect(reopened.get(input)).toEqual(expected);
          const lease = (await reopened.claim(input, 'worker', 300_000))!;
          expect(lease.epoch).toBe(1);
          expect(
            (await FileManagedActivationStore.open(file)).get(input),
          ).toEqual(reopened.get(input));
        },
      };
    },
    open: (file: string) => FileManagedActivationStore.open(file),
    snapshot() {
      return {
        nextSequence: 2,
        activations: [
          {
            descriptor: {
              tenantId: 'tenant',
              sessionId: 'session',
              activationId: 'activation',
              payloadRef: 'payload',
              reason: 'user_message',
              recovery: 'replay_safe',
            },
            queuedAt: 100,
            queueSequence: 1,
            status: 'queued',
          },
        ],
        nextEpoch: {},
      };
    },
  },
  {
    name: 'inbox',
    async prepare(file: string) {
      const input = {
        tenantId: 'tenant',
        sessionId: 'session',
        messageId: 'message',
        payload: 'x'.repeat(MANAGED_JOURNAL_COMPACT_BYTES),
      };
      const store = await FileManagedSessionInbox.open(file);
      await store.admit(input, inboxLimits);
      const expected = store.get(input);
      return {
        halted: () => store.haltedError,
        mutate: () => store.markActivationReady(input),
        async retry() {
          const reopened = await FileManagedSessionInbox.open(file);
          expect(reopened.get(input)).toEqual(expected);
          await reopened.markActivationReady(input);
          expect((await FileManagedSessionInbox.open(file)).get(input)).toEqual(
            reopened.get(input),
          );
        },
      };
    },
    open: (file: string) => FileManagedSessionInbox.open(file),
    snapshot() {
      return {
        nextSequence: 2,
        messages: [
          {
            message: {
              tenantId: 'tenant',
              sessionId: 'session',
              messageId: 'message',
              payload: 'payload',
            },
            admittedAt: 100,
            admissionSequence: 1,
            activationReady: false,
            state: 'admitted',
          },
        ],
      };
    },
  },
];

describe('managed journal snapshots', () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'managed-journal-snapshot-'));
    file = path.join(root, 'journal.jsonl');
  });

  afterEach(async () => {
    fault.phase = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('checks snapshot contents and refuses unknown versions', () => {
    const state = { nextSequence: 12, entries: [{ id: 'a' }] };
    const record = JSON.parse(
      encodeManagedJournalSnapshot('test.snapshot', state).toString(),
    ) as Record<string, unknown>;
    expect(parseManagedJournalSnapshot(record)).toEqual(state);
    expect(() => parseManagedJournalSnapshot({ ...record, v: 3 })).toThrow(
      'invalid',
    );
    expect(() =>
      parseManagedJournalSnapshot({ ...record, state: { nextSequence: 13 } }),
    ).toThrow('digest');
  });

  it('replaces atomically, removes a stale pending snapshot, and keeps private mode', async () => {
    await writeFile(file, 'original\n');
    await writeFile(`${file}.snapshot.pending`, 'stale partial snapshot');
    const bytes = encodeManagedJournalSnapshot('test.snapshot', {
      nextSequence: 1,
    });
    await replaceManagedJournalWithSnapshot(file, bytes);
    expect(await readFile(file)).toEqual(bytes);
    await expect(stat(`${file}.snapshot.pending`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it.each(phases)(
    'keeps a complete old or new journal after %s failure',
    async (phase) => {
      if (process.platform === 'win32' && phase === 'directory-sync') return;
      await writeFile(file, 'original\n');
      const bytes = encodeManagedJournalSnapshot('test.snapshot', {
        nextSequence: 1,
      });
      fault.phase = phase;
      await expect(
        replaceManagedJournalWithSnapshot(file, bytes),
      ).rejects.toThrow(`snapshot ${phase} failed`);
      expect(await readFile(file)).toEqual(
        phase === 'directory-sync' ? bytes : Buffer.from('original\n'),
      );
      await expect(stat(`${file}.snapshot.pending`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  describe.each(adapters)('$name adapter', (adapter) => {
    it.each(phases)(
      'fences before a new event after %s failure and permits safe reopen',
      async (phase) => {
        if (process.platform === 'win32' && phase === 'directory-sync') return;
        const prepared = await adapter.prepare(file);
        fault.phase = phase;
        await expect(prepared.mutate()).rejects.toThrow(
          `snapshot ${phase} failed`,
        );
        expect(prepared.halted()?.message).toBe(`snapshot ${phase} failed`);
        fault.phase = undefined;
        await expect(prepared.mutate()).rejects.toThrow(
          `snapshot ${phase} failed`,
        );
        await prepared.retry();
      },
    );

    it('rejects a torn first snapshot without truncating it', async () => {
      const bytes = encodeManagedJournalSnapshot(
        `${adapter.name}.snapshot`,
        adapter.snapshot(),
      );
      const partial = bytes.subarray(0, bytes.length - 10);
      await writeFile(file, partial);
      await expect(adapter.open(file)).rejects.toThrow('no complete record');
      expect(await readFile(file)).toEqual(partial);
    });

    it('still repairs an incomplete first legacy event that was never committed', async () => {
      await writeFile(file, '{"v":1,"sequence":1');
      await expect(adapter.open(file)).resolves.toBeDefined();
      expect(await readFile(file, 'utf8')).toBe('');
    });

    it('rejects a changed snapshot digest before restoring identities', async () => {
      const encoded = JSON.parse(
        encodeManagedJournalSnapshot(
          `${adapter.name}.snapshot`,
          adapter.snapshot(),
        ).toString(),
      ) as Record<string, unknown>;
      encoded['state'] = { nextSequence: 500 };
      await writeFile(file, `${JSON.stringify(encoded)}\n`);
      await expect(adapter.open(file)).rejects.toThrow('digest');
    });

    it('requires a contiguous tail from the snapshotted next sequence', async () => {
      const saved = adapter.snapshot();
      const tail =
        'activations' in saved
          ? {
              type: 'activation.queued',
              activation: {
                ...saved.activations[0].descriptor,
                activationId: 'next',
              },
            }
          : {
              type: 'user.message.admitted',
              message: { ...saved.messages[0].message, messageId: 'next' },
            };
      await writeFile(
        file,
        Buffer.concat([
          encodeManagedJournalSnapshot(`${adapter.name}.snapshot`, saved),
          Buffer.from(
            `${JSON.stringify({ v: 1, sequence: 3, at: 100, ...tail })}\n`,
          ),
        ]),
      );
      await expect(adapter.open(file)).rejects.toThrow(/sequence 2, got 3/);
    });

    it('rejects a repeated snapshot instead of resetting its sequence', async () => {
      const bytes = encodeManagedJournalSnapshot(
        `${adapter.name}.snapshot`,
        adapter.snapshot(),
      );
      await writeFile(file, Buffer.concat([bytes, bytes]));
      await expect(adapter.open(file)).rejects.toThrow(
        'snapshot must be first',
      );
    });

    it('rejects duplicate identities and a regressed next sequence even with a valid checksum', async () => {
      const saved = adapter.snapshot() as Record<string, unknown>;
      const entries = (saved['activations'] ?? saved['messages']) as Array<
        Record<string, unknown>
      >;
      entries.push(structuredClone(entries[0]));
      await writeFile(
        file,
        encodeManagedJournalSnapshot(`${adapter.name}.snapshot`, saved),
      );
      await expect(adapter.open(file)).rejects.toThrow(/identity|order/);
      entries.pop();
      saved['nextSequence'] = 1;
      await writeFile(
        file,
        encodeManagedJournalSnapshot(`${adapter.name}.snapshot`, saved),
      );
      await expect(adapter.open(file)).rejects.toThrow(/identity|order/);
    });

    it('refuses a snapshot directory whose durability cannot be established on reopen', async () => {
      if (process.platform === 'win32') return;
      await writeFile(
        file,
        encodeManagedJournalSnapshot(
          `${adapter.name}.snapshot`,
          adapter.snapshot(),
        ),
      );
      fault.phase = 'directory-sync';
      await expect(adapter.open(file)).rejects.toThrow('directory-sync failed');
      fault.phase = undefined;
      await expect(adapter.open(file)).resolves.toBeDefined();
    });
  });
});
