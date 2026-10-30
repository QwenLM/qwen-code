/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from '../services/sessionService.js';
import {
  getSessionWriterLockPath,
  SessionWriterLease,
} from '../services/session-writer-lease.js';
import { Storage } from '../config/storage.js';
import { isManagedSessionTranscriptSync } from '../utils/sessionStorageUtils.js';
import {
  LITE_READ_BUF_SIZE,
  readManagedSessionTitleInfoSync,
  readManagedSessionSourceSync,
  readSessionTitleInfoFromFileSync,
} from '../utils/sessionStorageUtils.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

const enablement = vi.hoisted(() => ({ sessionMetadata: true }));

// Lets a test disable session_metadata as a build that removed the domain
// would: the enabled list is a constant, so enablement flips only here.
vi.mock('./managed-session-records.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-session-records.js')>();
  return {
    ...actual,
    assertManagedSessionDomainEnabled: (
      domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
    ) => {
      if (domain === 'session_metadata' && !enablement.sessionMetadata) {
        throw new actual.ManagedSessionRecordError(
          `domain ${domain} is registered but not enabled for submission.`,
        );
      }
      actual.assertManagedSessionDomainEnabled(domain);
    },
  };
});

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.sessionMetadata = true;
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};

interface Harness {
  runtimeBaseDir: string;
  transcriptPath: string;
  store: LocalManagedSessionResourceStore;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-meta-'));
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(root, 'chats', `${sessionId}.jsonl`);
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return {
    runtimeBaseDir,
    transcriptPath,
    store: LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    }),
  };
}

async function withAuthority<T>(
  harness: Harness,
  run: (authority: LocalManagedSessionAuthority) => Promise<T>,
  options: { create?: boolean } = {},
): Promise<T> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: harness.runtimeBaseDir,
    sessionId,
    transcriptPath: harness.transcriptPath,
  });
  try {
    const create =
      options.create === false
        ? undefined
        : {
            definitionRef: await harness.store.publish(
              'managed-definition',
              Buffer.from('{}', 'utf8'),
            ),
            rootSnapshotRef: await harness.store.publish(
              'managed-root',
              Buffer.from('{}', 'utf8'),
            ),
            createdBy: 'daemon',
          };
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: harness.store,
      ...(create === undefined ? {} : { create }),
    });
    return await run(authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

function renameCommand(commandId: string) {
  return {
    operation: 'renameSession',
    commandId,
    sessionKey,
    contentDigest: 'd'.repeat(64),
  };
}

describe('managed session metadata', () => {
  type TranscriptRecord = {
    subtype?: string;
    managedSession?: {
      kind?: string;
      sequence?: number;
      eventCount?: number;
      firstSequence?: number;
      lastSequence?: number;
    };
  };

  async function readTranscriptLines(filePath: string) {
    const lines = (await fs.readFile(filePath, 'utf8')).split('\n');
    const records = lines.map((line) =>
      line.length === 0 ? undefined : (JSON.parse(line) as TranscriptRecord),
    );
    return { lines, records };
  }

  async function glueRecords(
    filePath: string,
    probe: (record: TranscriptRecord) => boolean,
    count: 2 | 3,
  ): Promise<TranscriptRecord[]> {
    const { lines, records } = await readTranscriptLines(filePath);
    const index = records.findIndex(
      (record) => record !== undefined && probe(record),
    );
    expect(index, 'no record matched the probe').toBeGreaterThanOrEqual(0);
    const following = records.slice(index + 1, index + count);
    expect(following).toHaveLength(count - 1);
    for (const record of following) expect(record).toBeDefined();
    lines.splice(index, count, lines.slice(index, index + count).join(''));
    await fs.writeFile(filePath, lines.join('\n'), 'utf8');
    return following.map((record) => record!);
  }

  async function removeTranscriptRecords(
    filePath: string,
    predicate: (record: TranscriptRecord) => boolean,
  ): Promise<void> {
    const { lines, records } = await readTranscriptLines(filePath);
    const kept = lines.filter((_, index) => {
      const record = records[index];
      return record === undefined || !predicate(record);
    });
    await fs.writeFile(filePath, kept.join('\n'), 'utf8');
  }

  async function moveRecordAfter(
    filePath: string,
    movingProbe: (record: TranscriptRecord) => boolean,
    afterProbe: (record: TranscriptRecord) => boolean,
  ): Promise<void> {
    const { lines, records } = await readTranscriptLines(filePath);
    const movingIndex = records.findIndex(
      (record) => record !== undefined && movingProbe(record),
    );
    expect(
      movingIndex,
      'no record matched the move probe',
    ).toBeGreaterThanOrEqual(0);
    const [movingLine] = lines.splice(movingIndex, 1);
    records.splice(movingIndex, 1);
    const afterIndex = records.findIndex(
      (record) => record !== undefined && afterProbe(record),
    );
    expect(
      afterIndex,
      'no record matched the destination probe',
    ).toBeGreaterThanOrEqual(0);
    lines.splice(afterIndex + 1, 0, movingLine);
    await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  }

  const domainEvent = (sequence: number) => (record: TranscriptRecord) =>
    record.subtype === 'managed_session_event_v1' &&
    record.managedSession?.kind === 'domain.committed' &&
    record.managedSession?.sequence === sequence;

  it('still reads a renamed title after a line in the transcript is torn', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-torn'),
        {
          domain: 'session_metadata',
          content: { title: 'Design review notes', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
    });

    // Damage can leave two records on one line, where a bare JSON.parse throws
    // and the committed title is lost with them. Glue the header to the event
    // that follows it.
    const [next] = await glueRecords(
      harness.transcriptPath,
      (record) => record.subtype === 'managed_session_header_v1',
      2,
    );
    expect(next.subtype).toBe('managed_session_event_v1');

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Design review notes', source: 'manual' });
  });

  // An interrupted append can leave a fragment that recovers nothing at all,
  // and the writer resumes after it with whole records. A reader that treats
  // such a line as "the transcript is broken, stop looking" throws away a title
  // committed further up the same window, so the scan has to move on to the
  // previous line instead. The fragment must not be left as the file's
  // unterminated tail: the scan drops whatever follows the last newline and
  // would never reach it, which makes the witness vacuous.
  it('keeps scanning earlier lines when one yields no record at all', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-unrecoverable'),
        {
          domain: 'session_metadata',
          content: { title: 'Design review notes', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
    });

    const text = await fs.readFile(harness.transcriptPath, 'utf8');
    const lines = text.trimEnd().split('\n');
    // The committed transaction ends the transcript, so the tear goes after it.
    expect(lines[lines.length - 1]).toContain(
      '"subtype":"managed_session_commit_v1"',
    );
    lines.push(
      '{"subtype":"managed_session_ev',
      JSON.stringify({
        uuid: 'rec-user-after-tear',
        parentUuid: null,
        sessionId,
        timestamp: '2026-09-01T10:00:00.000Z',
        type: 'user',
        cwd: '/workspace',
        version: 'test',
        message: { role: 'user', parts: [{ text: 'continue after the tear' }] },
      }),
    );
    await fs.writeFile(harness.transcriptPath, `${lines.join('\n')}\n`, 'utf8');

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Design review notes', source: 'manual' });
  });

  // A transaction is laid out events first and marker last, so the record
  // after a committed event is the marker that authorises it. Reading a line
  // holding that pair in file order reaches the event before the marker and
  // drops a rename that did commit.
  it('still reads a renamed title when the event is glued to its own commit marker', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-glued-marker'),
        {
          domain: 'session_metadata',
          content: { title: 'Design review notes', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
    });

    const [marker] = await glueRecords(
      harness.transcriptPath,
      domainEvent(1),
      2,
    );
    expect(marker.subtype).toBe('managed_session_commit_v1');
    expect(marker.managedSession).toMatchObject({
      firstSequence: 1,
      lastSequence: 1,
    });

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Design review notes', source: 'manual' });
  });

  it('reads the latest title when the newest event is glued to its own commit marker', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'First title', titleSource: 'auto' },
        },
        { class: 'trusted_entry' },
      );
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-2'),
        {
          domain: 'session_metadata',
          content: { title: 'Second title', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
    });

    // The newest event shares a line with its own marker. Returning the first
    // title here would show the session list a name the user already replaced.
    const [marker] = await glueRecords(
      harness.transcriptPath,
      domainEvent(2),
      2,
    );
    expect(marker.subtype).toBe('managed_session_commit_v1');
    expect(marker.managedSession).toMatchObject({
      firstSequence: 2,
      lastSequence: 2,
    });

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Second title', source: 'manual' });
  });

  // Gluing across a transaction boundary puts one line's records in the order
  // the writer never emits: an older commit marker ahead of the newer event that
  // opens the next transaction. A reader that applied a line's last record
  // first and then walked that line forwards would let marker1 authorise a
  // window of {1,1}, reject event2 for falling outside it, and report the title
  // the user already replaced. Only the writer's own order, walked backwards,
  // reaches event2 while marker2 still authorises it.
  it('reads the latest title when an older commit marker is glued onto the next event', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'First title', titleSource: 'auto' },
        },
        { class: 'trusted_entry' },
      );
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-2'),
        {
          domain: 'session_metadata',
          content: { title: 'Second title', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
    });

    // A commit marker carries no `domain` field, so the transaction it closes is
    // identified by the sequence window it authorises: firstSequence 1 is the
    // marker of the first rename, and the record after it is the second rename's
    // event.
    const [event] = await glueRecords(
      harness.transcriptPath,
      (record) =>
        record.subtype === 'managed_session_commit_v1' &&
        record.managedSession?.firstSequence === 1,
      2,
    );
    expect(event.subtype).toBe('managed_session_event_v1');
    expect(event.managedSession).toMatchObject({
      kind: 'domain.committed',
      sequence: 2,
    });

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Second title', source: 'manual' });
  });

  it.each([
    ['session_metadata', 'session_source'],
    ['session_source', 'session_metadata'],
  ] as const)(
    'keeps domain reads scoped to records in a three-record %s/%s glue',
    async (firstDomain, secondDomain) => {
      const harness = await createHarness();
      const metadata = {
        domain: 'session_metadata' as const,
        content: { title: 'Design review notes', titleSource: 'manual' },
      };
      const source = {
        domain: 'session_source' as const,
        content: {
          record: {
            uuid: 'rec-source-managed',
            parentUuid: null,
            sessionId,
            timestamp: '2026-09-01T10:00:00.000Z',
            type: 'system',
            subtype: 'session_source',
            cwd: '/workspace',
            version: 'test',
            systemPayload: { sourceType: 'agent', sourceId: 'managed' },
          },
        },
      };
      const contentFor = (domain: 'session_metadata' | 'session_source') =>
        domain === 'session_metadata' ? metadata : source;

      await withAuthority(harness, async (authority) => {
        await authority.commitDomainRecord(
          renameCommand(`cmd-${firstDomain}`),
          contentFor(firstDomain),
          { class: 'trusted_entry' },
        );
        await authority.commitDomainRecord(
          renameCommand(`cmd-${secondDomain}`),
          contentFor(secondDomain),
          { class: 'trusted_entry' },
        );
      });

      const [marker, nextEvent] = await glueRecords(
        harness.transcriptPath,
        domainEvent(1),
        3,
      );
      expect(marker).toMatchObject({
        subtype: 'managed_session_commit_v1',
        managedSession: { firstSequence: 1, lastSequence: 1, eventCount: 1 },
      });
      expect(nextEvent).toMatchObject({
        subtype: 'managed_session_event_v1',
        managedSession: { kind: 'domain.committed', sequence: 2 },
      });

      expect(
        readManagedSessionTitleInfoSync(
          harness.transcriptPath,
          harness.runtimeBaseDir,
        ),
      ).toEqual({ title: 'Design review notes', source: 'manual' });
      expect(
        readManagedSessionSourceSync(
          harness.transcriptPath,
          harness.runtimeBaseDir,
        ),
      ).toEqual({ sourceType: 'agent', sourceId: 'managed' });
    },
  );

  it('rejects a title outside the lower bound of the latest commit window', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      for (const [sequence, title] of [
        [1, 'First title'],
        [2, 'Second title'],
      ] as const) {
        await authority.commitDomainRecord(
          renameCommand(`cmd-window-${sequence}`),
          {
            domain: 'session_metadata',
            content: { title, titleSource: 'manual' },
          },
          { class: 'trusted_entry' },
        );
      }
    });

    // Keep a real {2,2} marker while removing its event and the older {1,1}
    // marker. The remaining event is outside the only committed window.
    await removeTranscriptRecords(
      harness.transcriptPath,
      (record) =>
        (record.subtype === 'managed_session_event_v1' &&
          record.managedSession?.sequence === 2) ||
        (record.subtype === 'managed_session_commit_v1' &&
          record.managedSession?.firstSequence === 1),
    );

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({});
  });

  it('rejects a newer title beyond the upper bound of the latest commit window', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      for (const [sequence, title] of [
        [1, 'First title'],
        [2, 'Second title'],
      ] as const) {
        await authority.commitDomainRecord(
          renameCommand(`cmd-window-${sequence}`),
          {
            domain: 'session_metadata',
            content: { title, titleSource: 'manual' },
          },
          { class: 'trusted_entry' },
        );
      }
    });

    // Keep the real {1,1} marker and both events, but omit the newer marker.
    // The second title is therefore newer than any committed window.
    await removeTranscriptRecords(
      harness.transcriptPath,
      (record) =>
        record.subtype === 'managed_session_commit_v1' &&
        record.managedSession?.firstSequence === 2,
    );
    await moveRecordAfter(
      harness.transcriptPath,
      (record) =>
        record.subtype === 'managed_session_commit_v1' &&
        record.managedSession?.firstSequence === 1,
      domainEvent(2),
    );

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'First title', source: 'manual' });
  });

  it('fences delayed hosted titles across cold reopen and recorder renames', async () => {
    const harness = await createHarness();
    const write = (
      authority: LocalManagedSessionAuthority,
      revision: string,
      title: string,
    ) =>
      authority.commitDomainRecord(
        renameCommand(`hosted-title:${revision}`),
        {
          domain: 'session_metadata',
          content: { title, managedRenameRevision: revision },
        },
        { class: 'trusted_entry' },
      );
    await withAuthority(harness, async (authority) => {
      await write(authority, '2', 'B');
      const sequence = authority.committedSequence;
      await expect(write(authority, '1', 'A')).rejects.toMatchObject({
        code: 'managed_session_title_superseded',
      });
      expect(authority.committedSequence).toBe(sequence);
      await write(authority, '2', 'B');
      expect(authority.committedSequence).toBe(sequence);
      await authority.commitDomainRecord(
        renameCommand('recorder-title'),
        { domain: 'session_metadata', content: { title: 'Manual' } },
        { class: 'trusted_entry' },
      );
    });
    await withAuthority(harness, async (authority) => {
      const sequence = authority.committedSequence;
      await expect(write(authority, '1', 'A')).rejects.toMatchObject({
        code: 'managed_session_title_superseded',
      });
      expect(authority.committedSequence).toBe(sequence);
      await write(authority, '3', 'A');
    });
    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      )?.title,
    ).toBe('A');
  });

  it('projects a renamed title into the synchronous directory read', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const committed = await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'Design review notes', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
      expect(committed.revision).toBe(1);
      expect(committed.recordRef.kind).toBe('managed-session_metadata');
    });

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Design review notes', source: 'manual' });
  });

  it('projects the latest title and chains each revision', async () => {
    const harness = await createHarness();
    const refs: ManagedSessionDurableRef[] = [];
    await withAuthority(harness, async (authority) => {
      refs.push(
        (
          await authority.commitDomainRecord(
            renameCommand('cmd-rename-1'),
            {
              domain: 'session_metadata',
              content: { title: 'First title', titleSource: 'auto' },
            },
            { class: 'trusted_entry' },
          )
        ).recordRef,
      );
      const second = await authority.commitDomainRecord(
        renameCommand('cmd-rename-2'),
        {
          domain: 'session_metadata',
          content: { title: 'Second title', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
      expect(second.revision).toBe(2);
      refs.push(second.recordRef);
    });

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Second title', source: 'manual' });

    const body = JSON.parse(
      (await harness.store.read(refs[1])).toString('utf8'),
    ) as { revision: number; previousRecordRef: { resourceId: string } | null };
    expect(body.revision).toBe(2);
    expect(body.previousRecordRef?.resourceId).toBe(refs[0].resourceId);
  });

  it('replays a retried domain record command without publishing again', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const content = {
        title: 'First title',
        titleSource: 'auto',
      } as const;
      const first = await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        { domain: 'session_metadata', content },
        { class: 'trusted_entry' },
      );
      const sequence = authority.committedSequence;
      const bodies = path.join(
        harness.runtimeBaseDir,
        'resources',
        sessionId,
        'managed-session_metadata',
      );
      const published = (await fs.readdir(bodies)).length;

      const replay = await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        { domain: 'session_metadata', content },
        { class: 'trusted_entry' },
      );
      expect(replay.revision).toBe(1);
      expect(replay.recordRef).toEqual(first.recordRef);
      expect(replay.receipt).toMatchObject({ replayed: true });
      expect(authority.committedSequence).toBe(sequence);
      expect((await fs.readdir(bodies)).length).toBe(published);

      // A retry still returns its own committed revision after a later one.
      const second = await authority.commitDomainRecord(
        renameCommand('cmd-rename-2'),
        {
          domain: 'session_metadata',
          content: { title: 'Second title', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
      expect(second.revision).toBe(2);
      const stale = await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        { domain: 'session_metadata', content },
        { class: 'trusted_entry' },
      );
      expect(stale.revision).toBe(1);
      expect(stale.recordRef).toEqual(first.recordRef);
      expect(stale.receipt).toMatchObject({ replayed: true });
      expect((await fs.readdir(bodies)).length).toBe(published + 1);

      await expect(
        authority.commitDomainRecord(
          { ...renameCommand('cmd-rename-1'), contentDigest: 'e'.repeat(64) },
          { domain: 'session_metadata', content },
          { class: 'trusted_entry' },
        ),
      ).rejects.toThrow(/different content/);
      // Refused before publishing: no third body beside the two committed.
      expect((await fs.readdir(bodies)).length).toBe(published + 1);
    });
  });

  it('replays a retried domain record command after a cold reopen', async () => {
    const harness = await createHarness();
    let firstRef: ManagedSessionDurableRef | undefined;
    await withAuthority(harness, async (authority) => {
      firstRef = (
        await authority.commitDomainRecord(
          renameCommand('cmd-rename-1'),
          {
            domain: 'session_metadata',
            content: { title: 'First title', titleSource: 'auto' },
          },
          { class: 'trusted_entry' },
        )
      ).recordRef;
    });

    await withAuthority(
      harness,
      async (authority) => {
        const replay = await authority.commitDomainRecord(
          renameCommand('cmd-rename-1'),
          {
            domain: 'session_metadata',
            content: { title: 'First title', titleSource: 'auto' },
          },
          { class: 'trusted_entry' },
        );
        expect(replay.revision).toBe(1);
        expect(replay.recordRef).toEqual(firstRef);
        expect(replay.receipt).toMatchObject({ replayed: true });
      },
      { create: false },
    );
  });

  it('replays a committed domain record after its domain was disabled', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const first = await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'First title', titleSource: 'auto' },
        },
        { class: 'trusted_entry' },
      );
      const bodies = path.join(
        harness.runtimeBaseDir,
        'resources',
        sessionId,
        'managed-session_metadata',
      );
      const published = (await fs.readdir(bodies)).length;
      enablement.sessionMetadata = false;
      await expect(
        authority.commitDomainRecord(
          renameCommand('cmd-rename-1'),
          {
            domain: 'session_metadata',
            content: { title: 'First title', titleSource: 'auto' },
          },
          { class: 'trusted_entry' },
        ),
      ).resolves.toMatchObject({
        recordRef: first.recordRef,
        receipt: { replayed: true },
      });
      await expect(
        authority.commitDomainRecord(
          renameCommand('cmd-rename-2'),
          {
            domain: 'session_metadata',
            content: { title: 'Second title', titleSource: 'manual' },
          },
          { class: 'trusted_entry' },
        ),
      ).rejects.toThrow(/not enabled for submission/);
      // Refused before publishing: the refusal leaves no body behind.
      expect((await fs.readdir(bodies)).length).toBe(published);
    });
  });

  it('refuses a stale or foreign command before publishing it', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'First title', titleSource: 'auto' },
        },
        { class: 'trusted_entry' },
      );
      const bodies = path.join(
        harness.runtimeBaseDir,
        'resources',
        sessionId,
        'managed-session_metadata',
      );
      const published = (await fs.readdir(bodies)).length;
      await expect(
        authority.commitDomainRecord(
          { ...renameCommand('cmd-rename-2'), expectedSequence: 99 },
          {
            domain: 'session_metadata',
            content: { title: 'Stale title', titleSource: 'manual' },
          },
          { class: 'trusted_entry' },
        ),
      ).rejects.toThrow(/does not match the committed sequence/);
      await expect(
        authority.commitDomainRecord(
          {
            ...renameCommand('cmd-rename-3'),
            sessionKey: { ...sessionKey, sessionId: 'another-session' },
          },
          {
            domain: 'session_metadata',
            content: { title: 'Foreign title', titleSource: 'manual' },
          },
          { class: 'trusted_entry' },
        ),
      ).rejects.toThrow(/does not match this session/);
      // A committed command retried under a foreign session key must not
      // resolve as a replay of this session's record either.
      await expect(
        authority.commitDomainRecord(
          {
            ...renameCommand('cmd-rename-1'),
            sessionKey: { ...sessionKey, sessionId: 'another-session' },
          },
          {
            domain: 'session_metadata',
            content: { title: 'Foreign title', titleSource: 'manual' },
          },
          { class: 'trusted_entry' },
        ),
      ).rejects.toThrow(/does not match this session/);
      expect((await fs.readdir(bodies)).length).toBe(published);
    });
  });

  it('refuses a retry of a command committed without a domain record', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'First title', titleSource: 'auto' },
        },
        { class: 'trusted_entry' },
      );
      const bodies = path.join(
        harness.runtimeBaseDir,
        'resources',
        sessionId,
        'managed-session_metadata',
      );
      const published = (await fs.readdir(bodies)).length;
      // The command key is spent on an input, so its transaction holds no
      // domain record for the retried commit to replay.
      const shared = renameCommand('cmd-shared-input');
      await authority.submitInput(shared, {
        inputId: 'shared-1',
        turnId: 'shared-1',
        source: 'user',
        contentRef: await harness.store.publish(
          'managed-input',
          Buffer.from('{"text":"hello"}', 'utf8'),
        ),
        deadline: null,
        admissionRef: await harness.store.publish(
          'managed-admission',
          Buffer.from('{}', 'utf8'),
        ),
        wakeReason: 'input',
      });
      const sequence = authority.committedSequence;
      await expect(
        authority.commitDomainRecord(
          shared,
          {
            domain: 'session_metadata',
            content: { title: 'Shared title', titleSource: 'manual' },
          },
          { class: 'trusted_entry' },
        ),
      ).rejects.toThrow(/committed without a domain record/);
      expect(authority.committedSequence).toBe(sequence);
      expect((await fs.readdir(bodies)).length).toBe(published);
    });
  });

  it('refuses a retry of a committed command under a different domain', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'First title', titleSource: 'auto' },
        },
        { class: 'trusted_entry' },
      );
      // The command identity is spent on session_metadata: retrying it for
      // another domain refuses rather than resolving with that record.
      await expect(
        authority.commitDomainRecord(
          renameCommand('cmd-rename-1'),
          { domain: 'goal_state', content: { goal: 'another domain' } },
          { class: 'trusted_entry' },
        ),
      ).rejects.toThrow(/committed without a domain record/);
      expect(authority.domainRecord('goal_state')).toBeUndefined();
    });
  });

  it('keeps the authority-composed envelope over colliding content keys', async () => {
    const harness = await createHarness();
    let recordRef!: ManagedSessionDurableRef;
    await withAuthority(harness, async (authority) => {
      recordRef = (
        await authority.commitDomainRecord(
          renameCommand('cmd-rename-collide'),
          {
            domain: 'session_metadata',
            content: {
              title: 'x',
              revision: 999,
              previousRecordRef: 'bogus',
              operationId: 'caller-chosen',
            },
          },
          { class: 'trusted_entry' },
        )
      ).recordRef;
    });

    const body = JSON.parse(
      (await harness.store.read(recordRef)).toString('utf8'),
    ) as {
      operationId: string;
      revision: number;
      previousRecordRef: unknown;
      title: string;
    };
    expect(body.operationId).toBe('cmd-rename-collide');
    expect(body.revision).toBe(1);
    expect(body.previousRecordRef).toBeNull();
    expect(body.title).toBe('x');
  });

  it.each([
    ['session_metadata', 'missing'],
    ['session_metadata', 'incomplete'],
    ['session_source', 'missing'],
    ['session_source', 'incomplete'],
  ] as const)(
    'hides %s until its marker is complete (%s)',
    async (domain, tail) => {
      const harness = await createHarness();
      await withAuthority(harness, async (authority) => {
        for (const value of ['committed', 'uncommitted']) {
          await authority.commitDomainRecord(
            renameCommand(`cmd-${value}`),
            {
              domain,
              content:
                domain === 'session_metadata'
                  ? { title: value, titleSource: 'manual' }
                  : {
                      record: {
                        uuid: `rec-source-${value}`,
                        parentUuid: null,
                        sessionId,
                        timestamp: '2026-09-01T10:00:00.000Z',
                        type: 'system',
                        subtype: 'session_source',
                        cwd: '/workspace',
                        version: 'test',
                        systemPayload: { sourceType: 'fork', sourceId: value },
                      },
                    },
            },
            { class: 'trusted_entry' },
          );
        }
      });
      const text = await fs.readFile(harness.transcriptPath, 'utf8');
      const lines = text.trimEnd().split('\n');
      if (tail === 'missing') lines.pop();
      await fs.writeFile(
        harness.transcriptPath,
        lines.join('\n') + (tail === 'missing' ? '\n' : ''),
      );

      expect(
        domain === 'session_metadata'
          ? readManagedSessionTitleInfoSync(
              harness.transcriptPath,
              harness.runtimeBaseDir,
            )
          : readManagedSessionSourceSync(
              harness.transcriptPath,
              harness.runtimeBaseDir,
            ),
      ).toEqual(
        domain === 'session_metadata'
          ? { title: 'committed', source: 'manual' }
          : { sourceType: 'fork', sourceId: 'committed' },
      );
    },
  );

  async function writeLongTitleTranscript(
    authority: LocalManagedSessionAuthority,
  ): Promise<number> {
    await authority.commitDomainRecord(
      renameCommand('cmd-title-old'),
      {
        domain: 'session_metadata',
        content: { title: 'Title old', titleSource: 'manual' },
      },
      { class: 'trusted_entry' },
    );
    const activation = await authority.installActivation({
      activationId: 'activation-tail-padding',
      workerId: 'worker-tail-padding',
      leaseDurationMs: 60_000,
    });
    const firstPaddingSequence = authority.committedSequence + 1;
    await authority.appendExecution(
      {
        operation: 'appendMessageDeltaBatch',
        commandId: 'cmd-tail-padding-batch',
        sessionKey,
        contentDigest: 'd'.repeat(64),
      },
      Array.from({ length: 16 }, (_, index) => ({
        v: 1,
        sequence: firstPaddingSequence + index,
        eventId: `message-delta-tail-padding-${index}`,
        sessionKey,
        kind: 'message.delta',
        occurredAt: Date.now(),
        subject: {
          type: 'activation' as const,
          scopeId: activation.activationId,
          ...activation,
        },
        payload: {
          messageId: 'tail-padding-message',
          turnId: 'tail-padding-turn',
          role: 'assistant',
          text: 'x'.repeat(4096),
        },
      })),
      { class: 'harness', activation },
    );
    await authority.commitDomainRecord(
      renameCommand('cmd-title-previous'),
      {
        domain: 'session_metadata',
        content: { title: 'Title previous', titleSource: 'manual' },
      },
      { class: 'trusted_entry' },
    );
    await authority.commitDomainRecord(
      renameCommand('cmd-title-new'),
      {
        domain: 'session_metadata',
        content: { title: 'Title new', titleSource: 'manual' },
      },
      { class: 'trusted_entry' },
    );
    return authority.committedSequence;
  }

  it('finds the committed title in the bounded tail window of a long log', async () => {
    const harness = await createHarness();
    await withAuthority(harness, writeLongTitleTranscript);
    const text = await fs.readFile(harness.transcriptPath, 'utf8');
    const lines = text.trimEnd().split('\n');
    lines.pop();
    await fs.writeFile(harness.transcriptPath, `${lines.join('\n')}\n`);
    expect((await fs.stat(harness.transcriptPath)).size).toBeGreaterThan(
      LITE_READ_BUF_SIZE,
    );

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({
      title: 'Title previous',
      source: 'manual',
    });
  });

  // The tail window is the only call site of the tolerant reader that a long log
  // reaches: below the read-window size the offset is zero and the branch never
  // runs, so the short glue witnesses above leave it untested. And the title it has to find
  // lives in the tail, so the head fallback cannot answer for it — a tail that
  // gives up returns an older title, not this one.
  it('still reads the committed title from the tail window when a glued line sits inside it', async () => {
    const harness = await createHarness();
    const newestSequence = await withAuthority(
      harness,
      writeLongTitleTranscript,
    );
    const [marker] = await glueRecords(
      harness.transcriptPath,
      domainEvent(newestSequence),
      2,
    );
    expect(marker.subtype).toBe('managed_session_commit_v1');
    expect(marker.managedSession).toMatchObject({
      firstSequence: newestSequence,
      lastSequence: newestSequence,
    });

    // Glue costs the file one newline; assert the size after it,
    // because `tailOffset > 0` — and with it the whole tail
    // branch — holds exactly when the file is longer than the window. Without
    // this the fixture could drift under the limit and the case would quietly
    // stop covering anything.
    const fileSize = (await fs.stat(harness.transcriptPath)).size;
    expect(fileSize).toBeGreaterThan(LITE_READ_BUF_SIZE);

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({
      title: 'Title new',
      source: 'manual',
    });
  });

  it.each(['length', 'digest'] as const)(
    'hides a title resource with a mismatched %s',
    async (mismatch) => {
      const harness = await createHarness();
      const ref = await withAuthority(
        harness,
        async (authority) =>
          (
            await authority.commitDomainRecord(
              renameCommand('cmd-rename'),
              {
                domain: 'session_metadata',
                content: { title: 'original', titleSource: 'manual' },
              },
              { class: 'trusted_entry' },
            )
          ).recordRef,
      );
      const resourcePath = path.join(
        harness.store.sessionRoot,
        ref.kind,
        ref.resourceId,
      );
      const original = await fs.readFile(resourcePath, 'utf8');
      await fs.writeFile(
        resourcePath,
        original.replace(
          'original',
          mismatch === 'length' ? 'longer title' : 'tampered',
        ),
      );

      expect(
        readManagedSessionTitleInfoSync(
          harness.transcriptPath,
          harness.runtimeBaseDir,
        ),
      ).toEqual({});
    },
  );

  it('recovers the revision chain across a cold reopen', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'Before reopen', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
    });

    await withAuthority(
      harness,
      async (authority) => {
        expect(authority.domainRecord('session_metadata')?.revision).toBe(1);
        const next = await authority.commitDomainRecord(
          renameCommand('cmd-rename-2'),
          {
            domain: 'session_metadata',
            content: { title: 'After reopen', titleSource: 'manual' },
          },
          { class: 'trusted_entry' },
        );
        expect(next.revision).toBe(2);
      },
      { create: false },
    );

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'After reopen', source: 'manual' });
  });

  it('reports no custom title for a managed session never renamed', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async () => undefined);

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({});
  });

  it('defers to the legacy reader for a non-managed transcript', async () => {
    const harness = await createHarness();
    await fs.writeFile(
      harness.transcriptPath,
      `${JSON.stringify({
        uuid: 'legacy-1',
        parentUuid: null,
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'system',
        subtype: 'custom_title',
        customTitle: 'Legacy title',
        titleSource: 'manual',
      })}\n`,
      'utf8',
    );

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toBeUndefined();
  });

  it('defers to the legacy reader when marker text is glued onto a legacy line', async () => {
    const harness = await createHarness();
    // A torn append can glue unparseable marker-looking text onto a valid
    // legacy line; quoted marker text is not a Managed header record.
    const customTitle = JSON.stringify({
      uuid: 'legacy-1',
      parentUuid: null,
      sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'custom_title',
      customTitle: 'Legacy title',
      titleSource: 'manual',
    });
    await fs.writeFile(
      harness.transcriptPath,
      `${customTitle} and the raw bytes "subtype":"managed_session_header_v1" landed here\n`,
      'utf8',
    );

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toBeUndefined();
    // The callers compose managed ?? legacy, so the custom title survives.
    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ) ?? readSessionTitleInfoFromFileSync(harness.transcriptPath),
    ).toEqual({ title: 'Legacy title', source: 'manual' });
  });

  it('refuses a registered domain that is not enabled', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitDomainRecord(
          renameCommand('cmd-team-message'),
          // team_message is in the domain vocabulary but not in the
          // enabled list. child_run is per-kind exempt here; every
          // H-family body hits the extension funnel first instead.
          { domain: 'team_message', content: {} },
          { class: 'trusted_entry' },
        ),
      ).rejects.toThrow(/registered but not enabled for submission/);
    });
  });

  it('refuses a domain record when no resource store is available', async () => {
    const harness = await createHarness();
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionId,
      transcriptPath: harness.transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      create: {
        definitionRef: await harness.store.publish(
          'managed-definition',
          Buffer.from('{}', 'utf8'),
        ),
        rootSnapshotRef: await harness.store.publish(
          'managed-root',
          Buffer.from('{}', 'utf8'),
        ),
        createdBy: 'daemon',
      },
    });
    await expect(
      authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'No store', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      ),
    ).rejects.toThrow(/resource store is required/);
    await lease.release();
  });
});

describe('legacy maintenance on a managed session', () => {
  interface ProjectHarness {
    projectRoot: string;
    runtimeBaseDir: string;
    transcriptPath: string;
    service: SessionService;
  }

  async function createProject(): Promise<ProjectHarness> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-rn-'));
    temporaryDirectories.add(root);
    const projectRoot = path.join(root, 'project');
    const runtimeBaseDir = path.join(root, 'runtime');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(runtimeBaseDir, { recursive: true });
    const storage = new Storage(projectRoot, runtimeBaseDir);
    const transcriptPath = path.join(
      storage.getProjectDir(),
      'chats',
      `${sessionId}.jsonl`,
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    return {
      projectRoot,
      runtimeBaseDir,
      transcriptPath,
      service: new SessionService(projectRoot, { runtimeBaseDir }),
    };
  }

  it('refuses legacy rename and fork of a managed session without changing files', async () => {
    const harness = await createProject();
    const store = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionKey,
    });
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionId,
      transcriptPath: harness.transcriptPath,
    });
    await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: harness.projectRoot,
      version: 'test',
      resources: store,
      create: {
        definitionRef: await store.publish(
          'managed-definition',
          Buffer.from('{}', 'utf8'),
        ),
        rootSnapshotRef: await store.publish(
          'managed-root',
          Buffer.from('{}', 'utf8'),
        ),
        createdBy: 'daemon',
      },
    });
    await lease.release();

    expect(isManagedSessionTranscriptSync(harness.transcriptPath)).toBe(true);
    const before = await fs.readFile(harness.transcriptPath, 'utf8');

    expect(() =>
      harness.service.assertLegacySessionExecution(sessionId),
    ).toThrow(/belongs to managed/);

    await expect(
      harness.service.renameSession(sessionId, 'Renamed by the legacy path'),
    ).rejects.toThrow(/belongs to managed/);

    /* The legacy path would have appended a custom_title record, standing up a
       second title authority beside the committed session_metadata record. */
    const after = await fs.readFile(harness.transcriptPath, 'utf8');
    expect(after).toBe(before);
    expect(after).not.toContain('custom_title');
    const targetId = '650e8400-e29b-41d4-a716-446655440000';
    await expect(
      harness.service.forkSession(sessionId, targetId),
    ).rejects.toThrow(/belongs to managed/);
    await expect(
      fs.stat(
        path.join(path.dirname(harness.transcriptPath), `${targetId}.jsonl`),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(harness.transcriptPath, 'utf8')).toBe(before);
  });

  it('removes the private resources when the session is deleted', async () => {
    const harness = await createProject();
    const store = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionKey,
    });
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionId,
      transcriptPath: harness.transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: harness.projectRoot,
      version: 'test',
      resources: store,
      create: {
        definitionRef: await store.publish(
          'managed-definition',
          Buffer.from('{}', 'utf8'),
        ),
        rootSnapshotRef: await store.publish(
          'managed-root',
          Buffer.from('{}', 'utf8'),
        ),
        createdBy: 'daemon',
      },
    });
    await authority.commitDomainRecord(
      renameCommand('cmd-rename-1'),
      {
        domain: 'session_metadata',
        content: { title: 'Doomed session', titleSource: 'manual' },
      },
      { class: 'trusted_entry' },
    );
    await lease.release();

    await expect(fs.stat(store.sessionRoot)).resolves.toBeDefined();

    await expect(harness.service.removeSession(sessionId)).resolves.toBe(true);

    await expect(fs.stat(harness.transcriptPath)).rejects.toThrow();
    /* Leaving these behind would orphan every event body the session wrote. */
    await expect(fs.stat(store.sessionRoot)).rejects.toThrow();
  });

  it('still renames a legacy session', async () => {
    const harness = await createProject();
    await fs.writeFile(
      harness.transcriptPath,
      `${JSON.stringify({
        uuid: 'legacy-1',
        parentUuid: null,
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: harness.projectRoot,
      })}\n`,
      'utf8',
    );

    expect(isManagedSessionTranscriptSync(harness.transcriptPath)).toBe(false);
    expect(() =>
      harness.service.assertLegacySessionExecution(sessionId),
    ).not.toThrow();
    await expect(
      harness.service.renameSession(sessionId, 'Legacy rename'),
    ).resolves.toBe(true);
    expect(await fs.readFile(harness.transcriptPath, 'utf8')).toContain(
      'custom_title',
    );
  });
});

describe('maintenance on a sealed managed session', () => {
  interface SealedHarness {
    projectRoot: string;
    runtimeBaseDir: string;
    transcriptPath: string;
    service: SessionService;
    store: LocalManagedSessionResourceStore;
  }

  async function createSealed(): Promise<SealedHarness> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-seal-'));
    temporaryDirectories.add(root);
    const projectRoot = path.join(root, 'project');
    const runtimeBaseDir = path.join(root, 'runtime');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(runtimeBaseDir, { recursive: true });
    const storage = new Storage(projectRoot, runtimeBaseDir);
    const transcriptPath = path.join(
      storage.getProjectDir(),
      'chats',
      `${sessionId}.jsonl`,
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

    const store = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    const lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir,
      sessionId,
      transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: projectRoot,
      version: 'test',
      resources: store,
      create: {
        definitionRef: await store.publish(
          'managed-definition',
          Buffer.from('{}', 'utf8'),
        ),
        rootSnapshotRef: await store.publish(
          'managed-root',
          Buffer.from('{}', 'utf8'),
        ),
        createdBy: 'daemon',
      },
    });
    await authority.commitDomainRecord(
      renameCommand('cmd-rename-1'),
      {
        domain: 'session_metadata',
        content: { title: 'Sealed session', titleSource: 'manual' },
      },
      { class: 'trusted_entry' },
    );
    await authority.commitDomainRecord(
      renameCommand('cmd-source-1'),
      {
        domain: 'session_source',
        content: {
          record: {
            uuid: 'rec-source-channel',
            parentUuid: null,
            sessionId,
            timestamp: '2026-09-01T10:00:00.000Z',
            type: 'system',
            subtype: 'session_source',
            cwd: '/workspace',
            version: 'test',
            systemPayload: { sourceType: 'channel', sourceId: 'managed' },
          },
        },
      },
      { class: 'trusted_entry' },
    );
    /* Closing seals the lock, which is what leaves a barrier behind. Every
       maintenance path below now meets that sealed lock. */
    await authority.close();

    return {
      projectRoot,
      runtimeBaseDir,
      transcriptPath,
      service: new SessionService(projectRoot, { runtimeBaseDir }),
      store,
    };
  }

  it('still lists the session and projects its title', async () => {
    const harness = await createSealed();
    const listed = await harness.service.listSessions();
    expect(listed.items).toEqual([
      expect.objectContaining({
        sessionId,
        customTitle: 'Sealed session',
        titleSource: 'manual',
        sourceType: 'channel',
        sourceId: 'managed',
      }),
    ]);
    expect(await harness.service.getSessionListItem(sessionId)).toEqual(
      expect.objectContaining({
        customTitle: 'Sealed session',
        titleSource: 'manual',
        sourceType: 'channel',
        sourceId: 'managed',
      }),
    );
    expect(harness.service.getSessionTitleInfo(sessionId)).toEqual({
      title: 'Sealed session',
      source: 'manual',
    });
  });

  it('still refuses a legacy rename', async () => {
    const harness = await createSealed();
    await expect(
      harness.service.renameSession(sessionId, 'Renamed'),
    ).rejects.toThrow(/belongs to managed/);
  });

  it('still archives and unarchives', async () => {
    const harness = await createSealed();
    const archived = await harness.service.archiveSessions([sessionId]);
    expect(archived.errors).toEqual([]);
    expect(archived.archived).toEqual([sessionId]);

    const restored = await harness.service.unarchiveSessions([sessionId]);
    expect(restored.errors).toEqual([]);
  });

  it('archives and unarchives under a sealed maintenance claim without removing the writer fence', async () => {
    const harness = await createSealed();
    const lockPath = getSessionWriterLockPath(
      harness.runtimeBaseDir,
      sessionId,
    );
    const sealedLock = await fs.readFile(lockPath, 'utf8');
    const archiveLease =
      await harness.service.acquireSealedManagedMaintenanceLease(sessionId);
    expect(archiveLease).toBeDefined();
    await expect(
      harness.service.acquireSealedManagedMaintenanceLease(sessionId),
    ).rejects.toThrow();
    await expect(
      LocalManagedSessionAuthority.acquireWriter({
        runtimeBaseDir: harness.runtimeBaseDir,
        sessionId,
        transcriptPath: harness.transcriptPath,
      }),
    ).rejects.toThrow();
    const archived = await harness.service.archiveSessions([sessionId], {
      assertStorageUnchanged: () => archiveLease!.assertOwnedAndUnchanged(),
      assertCleanupOwned: () => archiveLease!.assertCleanupOwned(),
    });
    expect(archived.errors).toEqual([]);
    expect(archived.archived).toEqual([sessionId]);
    await archiveLease!.release();
    expect(await fs.readFile(lockPath, 'utf8')).toBe(sealedLock);

    const restoreLease =
      await harness.service.acquireSealedManagedMaintenanceLease(sessionId);
    expect(restoreLease).toBeDefined();
    const restored = await harness.service.unarchiveSessions([sessionId], {
      assertStorageUnchanged: () => restoreLease!.assertOwnedAndUnchanged(),
      assertCleanupOwned: () => restoreLease!.assertCleanupOwned(),
    });
    expect(restored.errors).toEqual([]);
    expect(restored.unarchived).toEqual([sessionId]);
    await restoreLease!.release();
    expect(await fs.readFile(lockPath, 'utf8')).toBe(sealedLock);

    const writer = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionId,
      transcriptPath: harness.transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease: writer,
      sessionKey,
      cwd: harness.projectRoot,
      version: 'test',
      resources: harness.store,
    });
    await authority.close();
  });

  it('deletes a sealed Managed session under a maintenance claim', async () => {
    const harness = await createSealed();
    const maintenance =
      await harness.service.acquireSealedManagedMaintenanceLease(sessionId);
    expect(maintenance).toBeDefined();
    await expect(
      harness.service.removeSession(sessionId, {
        assertStorageUnchanged: () => maintenance!.assertOwnedAndUnchanged(),
        assertCleanupOwned: () => maintenance!.assertCleanupOwned(),
      }),
    ).resolves.toBe(true);
    await maintenance!.release();
    await expect(fs.stat(harness.transcriptPath)).rejects.toThrow();
    await expect(fs.stat(harness.store.sessionRoot)).rejects.toThrow();
  });

  it('rejects a replaced transcript while a sealed maintenance claim is held', async () => {
    const harness = await createSealed();
    const maintenance =
      await harness.service.acquireSealedManagedMaintenanceLease(sessionId);
    expect(maintenance).toBeDefined();
    const replacement = `${harness.transcriptPath}.replacement`;
    await fs.copyFile(harness.transcriptPath, replacement);
    await fs.rename(replacement, harness.transcriptPath);
    await expect(maintenance!.assertOwnedAndUnchanged()).rejects.toThrow();
    await maintenance!.release();
  });

  it('still deletes the session and its resources', async () => {
    const harness = await createSealed();
    await expect(fs.stat(harness.store.sessionRoot)).resolves.toBeDefined();
    await expect(harness.service.removeSession(sessionId)).resolves.toBe(true);
    await expect(fs.stat(harness.transcriptPath)).rejects.toThrow();
    await expect(fs.stat(harness.store.sessionRoot)).rejects.toThrow();
  });
});
