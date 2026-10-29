/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import { FileManagedSessionHistory } from './managed-session-history.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { ManagedSessionAppendUnsettledError } from './managed-session-records.js';

const fixtures: Array<{
  root: string;
  authority: LocalManagedSessionAuthority;
  lease: SessionWriterLease;
}> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.authority.disposeHistory().catch(() => undefined);
    await f.lease.release().catch(() => undefined);
    await rm(f.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-authority-repair-'));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: 'repair-session',
  };
  const transcriptPath = path.join(root, 'transcripts', 'session.jsonl');
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const definitionRef = await resources.publish(
    'managed-definition',
    Buffer.from('{}'),
  );
  const rootSnapshotRef = await resources.publish(
    'managed-root',
    Buffer.from('{}'),
  );
  const contentRef = await resources.publish(
    'managed-input',
    Buffer.from('[]'),
  );
  const admissionRef = await resources.publish(
    'managed-admission',
    Buffer.from('{}'),
  );
  const outcomeRef = await resources.publish(
    'managed-tool-outcome',
    Buffer.from('{}'),
  );
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: root,
    sessionId: sessionKey.sessionId,
    transcriptPath,
  });
  const journal = LocalJsonlManagedSessionJournalStore.fromLease(
    lease,
    sessionKey,
  );
  const authority = await LocalManagedSessionAuthority.open({
    journal,
    resources,
    sessionKey,
    cwd: '/workspace',
    version: 'test',
    historyDirectory: path.join(root, 'history'),
    create: { definitionRef, rootSnapshotRef, createdBy: 'repair-test' },
  });
  const submit = (id: string) =>
    authority.submitInput(
      {
        operation: 'submitInput',
        commandId: id,
        sessionKey,
        contentDigest: contentRef.digest,
      },
      {
        inputId: id,
        turnId: id,
        source: 'web_shell',
        contentRef,
        admissionRef,
        deadline: null,
        wakeReason: 'input',
      },
    );
  const receipt = () =>
    authority.appendExecutionEvent(
      {
        operation: 'recordToolResult',
        commandId: 'receipt',
        sessionKey,
        contentDigest: outcomeRef.digest,
      },
      (sequence) => ({
        v: 1,
        sequence,
        eventId: 'receipt-event',
        sessionKey,
        kind: 'tool.receipt',
        occurredAt: 1,
        payload: {
          executionCallId: 'execution',
          toolOutcomeRef: outcomeRef,
          resultRef: null,
          resources: [],
          historyRevision: sequence,
        },
      }),
      { class: 'trusted_entry' },
    );
  const result = {
    root,
    transcriptPath,
    resources,
    outcomeRef,
    lease,
    journal,
    authority,
    submit,
    receipt,
  };
  fixtures.push(result);
  return result;
}

function historyOf(
  authority: LocalManagedSessionAuthority,
): FileManagedSessionHistory {
  return Reflect.get(authority, 'history') as FileManagedSessionHistory;
}

async function damageRoot(
  history: FileManagedSessionHistory,
  damage: 'missing' | 'corrupt',
) {
  const root = history.rootDigest;
  expect(root).not.toBeNull();
  if (damage === 'missing') await unlink(path.join(history.directory, root!));
  else await writeFile(path.join(history.directory, root!), 'corrupt');
  const owner = Reflect.get(history, 'owner') as { cache: { clear(): void } };
  owner.cache.clear();
}

describe('authority canonical history repair', () => {
  it.each(['missing', 'corrupt'] as const)(
    'rebuilds a %s captured prefix without changing current state or old identities',
    async (damage) => {
      const f = await fixture();
      await f.receipt();
      const original = await f.submit('old');
      const through = f.authority.committedSequence;
      const frozen = f.authority.iterateEvents(1, through);
      const snapshot = historyOf(f.authority).snapshot();
      await f.submit('new');
      const current = f.authority.commitProof;
      const residency = f.authority.residency;
      const bytes = await readFile(f.transcriptPath);
      const append = vi.spyOn(f.journal, 'appendTransaction');
      const seal = vi.spyOn(f.journal, 'seal');
      await damageRoot(snapshot, damage);
      expect((await frozen.collect(8)).map((event) => event.sequence)).toEqual([
        1, 2, 3,
      ]);
      expect(
        await snapshot.map<boolean>('event-id').get('input:new'),
      ).toBeUndefined();
      await damageRoot(historyOf(f.authority), damage);
      const replayed = await f.submit('old');
      expect(replayed).toEqual({
        ...original,
        replayed: true,
        committedSequence: current.lastCommitSequence,
      });
      expect(await f.authority.committedReceipt('execution')).toMatchObject({
        eventId: 'receipt-event',
        sequence: 1,
      });
      expect(await f.authority.hasInstalledActivation('missing')).toBe(false);
      expect(f.authority.commitProof).toEqual(current);
      expect(f.authority.residency.events).toBe(residency.events);
      expect(f.authority.residency.eventBytes).toBe(residency.eventBytes);
      expect(await readFile(f.transcriptPath)).toEqual(bytes);
      expect(append).not.toHaveBeenCalled();
      expect(seal).not.toHaveBeenCalled();
      await snapshot.close();
    },
  );

  it('rebuilds the header-only prefix as an empty identity view', async () => {
    const f = await fixture();
    const history = historyOf(f.authority);
    await history.map<boolean>('event-id').set('derived-only', true);
    await damageRoot(history, 'missing');
    expect(await f.authority.hasInstalledActivation('missing')).toBe(false);
    expect(f.authority.committedSequence).toBe(0);
    expect(history.count('event-id')).toBe(0);
  });

  it('repairs a read-only committed prefix without consuming or truncating its uncommitted tail', async () => {
    const f = await fixture();
    await f.receipt();
    const rows = (await readFile(f.transcriptPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            uuid: string;
            parentUuid: string;
            managedSession: {
              sequence: number;
              eventId: string;
              payload: { executionCallId: string; historyRevision: number };
            };
          },
      );
    const pending = rows[2];
    pending.uuid = randomUUID();
    pending.parentUuid = rows.at(-1)!.uuid;
    pending.managedSession.sequence = 2;
    pending.managedSession.eventId = 'uncommitted-receipt';
    pending.managedSession.payload.executionCallId = 'uncommitted-execution';
    pending.managedSession.payload.historyRevision = 2;
    await f.lease.appendJsonLine(pending);
    const bytes = await readFile(f.transcriptPath);
    const readOnly = await LocalManagedSessionAuthority.openReadOnly({
      sessionKey: f.authority.sessionHeader.sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: f.resources,
      historyDirectory: path.join(f.root, 'read-only-history'),
      scan: (consume) => f.journal.scan(consume),
    });
    try {
      await damageRoot(historyOf(readOnly), 'missing');
      expect(await readOnly.hasInstalledActivation('absent')).toBe(false);
      expect(await readOnly.committedReceipt('execution')).toMatchObject({
        sequence: 1,
      });
      expect(
        await readOnly.committedReceipt('uncommitted-execution'),
      ).toBeUndefined();
      expect(readOnly.committedSequence).toBe(1);
      expect(await readFile(f.transcriptPath)).toEqual(bytes);
    } finally {
      await readOnly.disposeHistory();
    }
  });

  it('keeps a known committed overlay and its original receipt across repair', async () => {
    const f = await fixture();
    const old = await f.submit('old');
    vi.spyOn(
      FileManagedSessionHistory.prototype,
      'flush',
    ).mockRejectedValueOnce(new Error('sidecar flush failed'));
    const landed = await f.submit('landed');
    expect(f.authority.writesStopped).toBe(true);
    await damageRoot(historyOf(f.authority), 'corrupt');
    expect(await f.submit('old')).toEqual({
      ...old,
      replayed: true,
      committedSequence: landed.committedSequence,
    });
    expect(await f.submit('landed')).toEqual({ ...landed, replayed: true });
    await f.submit('next');
    expect(f.authority.writesStopped).toBe(false);
    expect(
      (await f.authority.readEvents()).map((event) => event.sequence),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('repairs only the committed prefix without settling an unknown append', async () => {
    const f = await fixture();
    await f.submit('old');
    const proof = f.authority.commitProof;
    const append = f.journal.appendTransaction.bind(f.journal);
    const settle = vi.fn(async () => 'landed' as const);
    Reflect.set(f.journal, 'settleAppend', settle);
    const writes = vi
      .spyOn(f.journal, 'appendTransaction')
      .mockImplementationOnce(async (records) => {
        await append(records);
        throw new ManagedSessionAppendUnsettledError(
          new Error('lost acknowledgement'),
        );
      });
    await expect(f.submit('pending')).rejects.toThrow('lost acknowledgement');
    await damageRoot(historyOf(f.authority), 'missing');
    expect(await f.authority.hasInstalledActivation('absent')).toBe(false);
    expect(f.authority.commitProof).toEqual(proof);
    expect(settle).not.toHaveBeenCalled();
    expect(await f.submit('pending')).toMatchObject({
      replayed: true,
      committedSequence: proof.lastCommitSequence + 2,
    });
    expect(settle).toHaveBeenCalledOnce();
    expect(writes).toHaveBeenCalledOnce();
  });

  it.each([
    'journal',
    'resource',
    'short-prefix',
    'header',
    'ownership',
  ] as const)(
    'rejects canonical %s damage instead of answering absence',
    async (damage) => {
      const f = await fixture();
      await f.receipt();
      await f.submit('old');
      const proof = f.authority.commitProof;
      const bytes = await readFile(f.transcriptPath);
      const text = bytes.toString('utf8');
      if (damage === 'resource') {
        await writeFile(
          path.join(
            f.resources.sessionRoot,
            f.outcomeRef.kind,
            f.outcomeRef.resourceId,
          ),
          'bad',
        );
      } else if (damage === 'short-prefix') {
        const headerBytes = Buffer.byteLength(
          text.split('\n').slice(0, 2).join('\n') + '\n',
        );
        await f.lease.truncateTo(headerBytes);
      } else if (damage === 'ownership') {
        await writeFile(f.transcriptPath, text + '\n');
      } else {
        const rows = text
          .trimEnd()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                managedSession: { occurredAt: number; createdBy: string };
              },
          );
        if (damage === 'header') rows[1].managedSession.createdBy = 'foreign';
        else rows[2].managedSession.occurredAt++;
        await f.lease.replaceTranscript(
          rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
          createHash('sha256').update(bytes).digest('hex'),
        );
      }
      await damageRoot(historyOf(f.authority), 'missing');
      await expect(
        f.authority.hasInstalledActivation('absent'),
      ).rejects.toThrow();
      expect(f.authority.commitProof).toEqual(proof);
    },
  );
});
