/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import { getSessionWriterLockPath } from '../services/session-writer-lease.js';
import {
  managedSessionEventsDigest,
  parseManagedSessionCommitMarker,
  parseManagedSessionEvent,
  parseManagedSessionHeader,
  MANAGED_SESSION_LIMITS,
} from './managed-session-records.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import {
  acquireLocalManagedSessionWriter,
  prepareLocalManagedSessionWriter,
} from './local-managed-session-writer.js';
import {
  parseLocalJournalBase,
  LocalManagedResourceCensus,
  readLocalJournalManifest,
  scanLocalManagedJournal,
} from './local-managed-journal-snapshot.js';
import { FileManagedSessionHistory } from './managed-session-history.js';

const limits = vi.hoisted(() => ({ maxResourceBytes: 64 * 1024 * 1024 }));
vi.mock('./managed-session-resources.js', async (original) => ({
  ...(await original<typeof import('./managed-session-resources.js')>()),
  MANAGED_SESSION_RESOURCE_LIMITS: limits,
}));
vi.mock('./local-managed-journal-snapshot.js', async (original) => ({
  ...(await original<typeof import('./local-managed-journal-snapshot.js')>()),
  LOCAL_MANAGED_SNAPSHOT_PAGE_BYTES: 1024 * 1024,
}));

const roots: string[] = [];

it('does not persist already verified resource dependencies in the census queue', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-census-queue-'));
  roots.push(root);
  const history = await FileManagedSessionHistory.create(root);
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey: {
      tenantId: 'local',
      workspaceId: 'workspace',
      sessionId: randomUUID(),
    },
  });
  const read = vi.fn((ref: Parameters<typeof resources.read>[0]) =>
    resources.read(ref),
  );
  const census = new LocalManagedResourceCensus(history, read);
  try {
    const shared = await resources.publish('shared', Buffer.from('{}'));
    await census.verify([shared]);
    for (let index = 0; index < 20; index++) {
      const ref = await resources.publish(
        'managed-definition',
        Buffer.from(JSON.stringify({ index, sessionSkillsRef: shared })),
      );
      await census.verify([ref]);
    }
    expect(read).toHaveBeenCalledTimes(21);
    expect(history.count('resource')).toBe(21);
    expect(history.count('resource-pending')).toBe(21);
    const conflicting = await resources.publish(
      'managed-definition',
      Buffer.from(
        JSON.stringify({
          sessionSkillsRef: { ...shared, kind: 'conflicting-kind' },
        }),
      ),
    );
    await expect(census.verify([conflicting])).rejects.toThrow(
      /resource references conflict/,
    );
    expect(
      read.mock.calls.filter(([ref]) => ref.resourceId === shared.resourceId),
    ).toHaveLength(1);
  } finally {
    await history.close();
  }
});

afterEach(async () => {
  limits.maxResourceBytes = 64 * 1024 * 1024;
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(count = 3, padding = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-local-stream-'));
  roots.push(root);
  const sessionId = randomUUID();
  const sessionKey = {
    tenantId: 'local-stream',
    workspaceId: 'workspace',
    sessionId,
  };
  const options = {
    sessionId,
    runtimeBaseDir: path.join(root, 'runtime'),
    transcriptPath: path.join(
      root,
      'runtime',
      'transcripts',
      `${sessionId}.jsonl`,
    ),
  };
  await fs.mkdir(path.dirname(options.transcriptPath), { recursive: true });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: options.runtimeBaseDir,
    sessionKey,
  });
  const definitionRef = await resources.publish(
    'managed-session-definition',
    Buffer.from('{}'),
  );
  const rootSnapshotRef = await resources.publish(
    'managed-session-root-snapshot',
    Buffer.from('{}'),
  );
  const header = parseManagedSessionHeader({
    formatVersion: 1,
    minimumReader: 'managed-session/1',
    sessionKey,
    engine: 'managed',
    definitionRef,
    rootSnapshotRef,
    createdBy: 'local-stream-test',
  });
  const lease = await acquireLocalManagedSessionWriter(options);
  const journal = LocalJsonlManagedSessionJournalStore.fromLease(
    lease,
    sessionKey,
  );
  let parentUuid: string | null = null;
  const envelope = (subtype: string, fields: object) => {
    const record = {
      uuid: randomUUID(),
      parentUuid,
      sessionId,
      timestamp: '2026-10-27T00:00:00.000Z',
      cwd: root,
      version: 'test',
      type: 'system',
      subtype,
      ...fields,
    };
    parentUuid = record.uuid;
    return record;
  };
  await journal.appendTransaction([
    envelope('session_execution_engine', {
      systemPayload: { version: 1, engine: 'managed' },
    }),
    envelope('managed_session_header_v1', { managedSession: header }),
  ]);
  let previousCommitDigest: string | null = null;
  for (let index = 0; index < count; index++) {
    const event = parseManagedSessionEvent({
      v: 1,
      sequence: index + 1,
      eventId: `cancel:${index}`,
      sessionKey,
      kind: 'cancel.requested',
      occurredAt: index + 1,
      payload: {
        requestId: `request:${index}`,
        target: { turnId: 'turn', text: '中文'.repeat(padding) },
        reason: 'test',
        requestedBy: 'user',
      },
    });
    const marker = parseManagedSessionCommitMarker({
      transactionId: `transaction:${index}`,
      commandId: `command:${index}`,
      operation: 'cancel',
      contentDigest: createHash('sha256').update(String(index)).digest('hex'),
      firstSequence: index + 1,
      lastSequence: index + 1,
      eventCount: 1,
      eventsDigest: managedSessionEventsDigest([event]),
      previousCommitDigest,
    });
    await journal.appendTransaction([
      envelope('managed_session_event_v1', { managedSession: event }),
      envelope('managed_session_commit_v1', { managedSession: marker }),
    ]);
    previousCommitDigest = managedToolDigest(
      marker,
      MANAGED_SESSION_LIMITS.maxCommitMarkerBytes,
    );
  }
  const commit = {
    lastCommitSequence: count,
    committedPrefixHash: previousCommitDigest!,
  };
  return {
    root,
    options,
    sessionKey,
    resources,
    definitionRef,
    lease,
    journal,
    commit,
  };
}

describe('local Managed streamed recovery', () => {
  it('scans native transaction batches with physical offsets and frozen bounds', async () => {
    const f = await fixture(4, 15_000);
    const expected = await f.journal.read();
    let events = 0;
    let lastOffset = 0;
    const summary = await f.journal.scan!(async (batch) => {
      expect(batch.sourceOffset).toBe(lastOffset);
      expect(batch.sourceBytes.byteLength).toBeLessThanOrEqual(
        MANAGED_SESSION_LIMITS.maxTransactionBytes,
      );
      lastOffset += batch.sourceBytes.byteLength;
      events += batch.events.length;
    });
    expect(events).toBe(4);
    expect(summary).toMatchObject({
      committed: expected.committed,
      committedBytes: expected.committedBytes,
      headerBytes: expected.headerBytes,
      lastMarkerDigest: expected.lastMarkerDigest,
      lastRecordUuid: expected.lastRecordUuid,
    });
    const bounded = await f.journal.scan!(async () => {}, {
      maxBytes: summary.headerBytes,
    });
    expect(bounded.committed).toBe(0);
    expect(bounded.headerBytes).toBe(summary.headerBytes);
    await f.journal.seal(f.commit);
  });

  it('freezes a static scan bound and scope before asynchronous consumers run', async () => {
    const f = await fixture();
    const expected = await f.journal.read();
    const options = {
      ...f.options,
      sessionKey: { ...f.sessionKey },
      maxBytes: expected.headerBytes,
    };
    const summary = await scanLocalManagedJournal(options, async () => {
      options.maxBytes = Number.MAX_SAFE_INTEGER;
      options.sessionKey.sessionId = '00000000-0000-0000-0000-000000000001';
    });
    expect(summary.committed).toBe(0);
    expect(summary.header?.sessionKey).toEqual(f.sessionKey);
    expect(summary.headerBytes).toBe(expected.headerBytes);
    await f.journal.seal(f.commit);
  });

  it('converts multiple pages and verifies replacement without whole-transcript reads', async () => {
    const f = await fixture(4, 110_000);
    const original = await fs.readFile(f.options.transcriptPath);
    await f.journal.seal(f.commit);
    const replacement = await acquireLocalManagedSessionWriter(f.options);
    vi.spyOn(replacement, 'readTranscript').mockRejectedValue(
      new Error('whole transcript read'),
    );
    await expect(
      prepareLocalManagedSessionWriter(replacement, f.sessionKey),
    ).resolves.toBe(true);
    const physical = await fs.readFile(f.options.transcriptPath);
    const base = parseLocalJournalBase(physical, f.sessionKey)!;
    const manifest = readLocalJournalManifest(
      f.options.runtimeBaseDir,
      f.sessionKey,
      base.manifest,
    );
    expect(manifest.pages.length).toBeGreaterThan(1);
    const pages: Buffer[] = [];
    for (const ref of manifest.pages) {
      expect(ref.byteLength).toBeLessThanOrEqual(1024 * 1024);
      pages.push(await f.resources.read(ref));
    }
    expect(Buffer.concat(pages)).toEqual(original);
    let committedEvents = 0;
    const restored = await scanLocalManagedJournal(
      { ...f.options, sessionKey: f.sessionKey },
      async (batch) => {
        committedEvents += batch.events.length;
      },
    );
    expect(committedEvents).toBe(4);
    expect(restored.committed).toBe(4);
    expect(restored.lastMarkerDigest).toBe(f.commit.committedPrefixHash);
    expect(restored.committedBytes).toBe(physical.byteLength);
    expect(restored.uncommittedBytes).toBe(0);
    await replacement.sealForHandoff({
      last_commit_sequence: 4,
      committed_prefix_hash: f.commit.committedPrefixHash,
    });
  });

  it('declines only manifest capacity after complete validation without publication or barrier downgrade', async () => {
    const f = await fixture();
    const original = await fs.readFile(f.options.transcriptPath);
    await f.journal.seal(f.commit);
    limits.maxResourceBytes = 64;
    const publish = vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publishJournalSnapshot',
    );
    const replacement = await acquireLocalManagedSessionWriter(f.options);
    await expect(
      prepareLocalManagedSessionWriter(replacement, f.sessionKey),
    ).resolves.toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(await fs.readFile(f.options.transcriptPath)).toEqual(original);
    expect(
      JSON.parse(
        await fs.readFile(
          getSessionWriterLockPath(
            f.options.runtimeBaseDir,
            f.options.sessionId,
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ schema_version: 3, format_version: 2, state: 'active' });
    await replacement.sealForHandoff({
      last_commit_sequence: 3,
      committed_prefix_hash: f.commit.committedPrefixHash,
    });
  });

  it('still rejects a missing old resource when manifest capacity is exhausted', async () => {
    const f = await fixture();
    const original = await fs.readFile(f.options.transcriptPath);
    await f.journal.seal(f.commit);
    limits.maxResourceBytes = 64;
    await fs.unlink(
      path.join(
        f.resources.sessionRoot,
        f.definitionRef.kind,
        f.definitionRef.resourceId,
      ),
    );
    const publish = vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publishJournalSnapshot',
    );
    const replacement = await acquireLocalManagedSessionWriter(f.options);
    await expect(
      prepareLocalManagedSessionWriter(replacement, f.sessionKey),
    ).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
    expect(await fs.readFile(f.options.transcriptPath)).toEqual(original);
    expect(
      JSON.parse(
        await fs.readFile(
          getSessionWriterLockPath(
            f.options.runtimeBaseDir,
            f.options.sessionId,
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ schema_version: 3, format_version: 2, state: 'sealed' });
  });
});
