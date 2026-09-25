/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionService } from '../services/sessionService.js';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { Storage } from '../config/storage.js';
import { isManagedSessionTranscriptSync } from '../utils/sessionStorageUtils.js';
import { readManagedSessionTitleInfoSync } from '../utils/sessionStorageUtils.js';
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

  it('refuses a registered domain that is not enabled', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitDomainRecord(
          renameCommand('cmd-schedule'),
          { domain: 'schedule', content: {} },
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

  it('refuses to rename a managed session and leaves it untouched', async () => {
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

    await expect(
      harness.service.renameSession(sessionId, 'Renamed by the legacy path'),
    ).rejects.toThrow(/belongs to managed/);

    /* The legacy path would have appended a custom_title record, standing up a
       second title authority beside the committed session_metadata record. */
    const after = await fs.readFile(harness.transcriptPath, 'utf8');
    expect(after).toBe(before);
    expect(after).not.toContain('custom_title');
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
    expect(listed.items.map((entry) => entry.sessionId)).toContain(sessionId);
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

  it('still deletes the session and its resources', async () => {
    const harness = await createSealed();
    await expect(fs.stat(harness.store.sessionRoot)).resolves.toBeDefined();
    await expect(harness.service.removeSession(sessionId)).resolves.toBe(true);
    await expect(fs.stat(harness.transcriptPath)).rejects.toThrow();
    await expect(fs.stat(harness.store.sessionRoot)).rejects.toThrow();
  });
});
