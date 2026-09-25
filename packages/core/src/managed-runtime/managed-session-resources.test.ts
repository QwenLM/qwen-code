/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-managed-resources-'),
  );
  temporaryDirectories.add(root);
  return root;
}

const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
};

async function createStore(): Promise<{
  store: LocalManagedSessionResourceStore;
  runtimeBaseDir: string;
}> {
  const root = await createRoot();
  const runtimeBaseDir = path.join(root, 'runtime');
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  return {
    store: LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    }),
    runtimeBaseDir,
  };
}

describe('managed session resource store', () => {
  it('round trips published bytes', async () => {
    const { store } = await createStore();
    const content = Buffer.from('list the files in this repository', 'utf8');
    const ref = await store.publish('managed-input', content);

    expect(ref.kind).toBe('managed-input');
    expect(ref.schemaVersion).toBe(1);
    expect(ref.byteLength).toBe(content.byteLength);
    expect(ref.digest).toBe(createHash('sha256').update(content).digest('hex'));
    expect(await store.read(ref)).toEqual(content);
  });

  it('names resources opaquely rather than by content digest', async () => {
    const { store } = await createStore();
    const content = Buffer.from('same bytes', 'utf8');
    const first = await store.publish('managed-input', content);
    const second = await store.publish('managed-input', content);

    expect(first.digest).toBe(second.digest);
    expect(first.resourceId).not.toBe(second.resourceId);
    expect(first.resourceId).not.toContain(first.digest);
    expect(await store.read(first)).toEqual(content);
    expect(await store.read(second)).toEqual(content);
  });

  it('leaves no pending file behind', async () => {
    const { store } = await createStore();
    const ref = await store.publish('managed-input', Buffer.from('x', 'utf8'));
    const entries = await fs.readdir(path.join(store.sessionRoot, ref.kind));
    expect(entries).toEqual([ref.resourceId]);
  });

  it('stores resources under the controlled runtime directory', async () => {
    const { store, runtimeBaseDir } = await createStore();
    const ref = await store.publish('managed-input', Buffer.from('x', 'utf8'));
    expect(store.sessionRoot).toBe(
      path.join(runtimeBaseDir, 'resources', sessionKey.sessionId),
    );
    await expect(
      fs.stat(path.join(store.sessionRoot, ref.kind, ref.resourceId)),
    ).resolves.toBeDefined();
  });

  it('rejects content that no longer matches its digest', async () => {
    const { store } = await createStore();
    const ref = await store.publish(
      'managed-input',
      Buffer.from('original', 'utf8'),
    );
    await fs.writeFile(
      path.join(store.sessionRoot, ref.kind, ref.resourceId),
      'tampered',
      'utf8',
    );
    await expect(store.read(ref)).rejects.toThrow(
      /does not match its recorded digest/,
    );
  });

  it('rejects content whose length changed', async () => {
    const { store } = await createStore();
    const ref = await store.publish(
      'managed-input',
      Buffer.from('original', 'utf8'),
    );
    await fs.writeFile(
      path.join(store.sessionRoot, ref.kind, ref.resourceId),
      'short',
      'utf8',
    );
    await expect(store.read(ref)).rejects.toThrow(/bytes where 8 was recorded/);
  });

  it('reports a missing resource rather than returning empty content', async () => {
    const { store } = await createStore();
    const ref: ManagedSessionDurableRef = {
      resourceId: 'absent',
      kind: 'managed-input',
      schemaVersion: 1,
      byteLength: 1,
      digest: 'a'.repeat(64),
    };
    await expect(store.read(ref)).rejects.toThrow(/is not present for session/);
  });

  it('refuses a kind or resource id that escapes its directory', async () => {
    const { store } = await createStore();
    await expect(
      store.publish('../escape', Buffer.from('x', 'utf8')),
    ).rejects.toThrow(/kind must be a single path segment/);
    await expect(
      store.read({
        resourceId: '../../etc/passwd',
        kind: 'managed-input',
        schemaVersion: 1,
        byteLength: 1,
        digest: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/resourceId must be a single path segment/);
  });
});

describe('managed session input durability', () => {
  it('recovers the original prompt content after a cold reopen', async () => {
    const root = await createRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const transcriptPath = path.join(root, 'chats', 'session-1.jsonl');
    await fs.mkdir(runtimeBaseDir, { recursive: true });
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

    const store = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    const prompt = Buffer.from('summarise the design docs', 'utf8');
    const contentRef = await store.publish('managed-input', prompt);
    const admissionRef = await store.publish(
      'managed-admission',
      Buffer.from('{"source":"web_shell"}', 'utf8'),
    );

    const definitionRef = await store.publish(
      'managed-definition',
      Buffer.from('{}', 'utf8'),
    );
    const rootSnapshotRef = await store.publish(
      'managed-root',
      Buffer.from('{}', 'utf8'),
    );

    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      create: { definitionRef, rootSnapshotRef, createdBy: 'daemon' },
    });
    await authority.submitInput(
      {
        operation: 'submitInput',
        commandId: 'cmd-1',
        sessionKey,
        contentDigest: contentRef.digest,
      },
      {
        inputId: 'in-1',
        turnId: 'turn-1',
        source: 'web_shell',
        contentRef,
        deadline: null,
        admissionRef,
        wakeReason: 'input',
      },
    );
    await lease.release();

    // Cold reopen: nothing from the first authority survives in memory.
    const reopenLease = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    const reopened = await LocalManagedSessionAuthority.open({
      lease: reopenLease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
    });
    const accepted = reopened.readEvents()[0];
    expect(accepted.kind).toBe('input.accepted');

    const recoveredRef = accepted.payload[
      'contentRef'
    ] as unknown as ManagedSessionDurableRef;
    const recoveredStore = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    expect(await recoveredStore.read(recoveredRef)).toEqual(prompt);
    await reopenLease.release();
  });
});
