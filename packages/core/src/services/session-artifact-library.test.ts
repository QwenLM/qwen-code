/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SessionArtifactLibraryError,
  SessionStorageEntryError,
  SessionService,
} from './sessionService.js';
import { SessionTranscriptTooLargeError } from './session-transcript-reader.js';
import { saveArtifactSnapshot } from '../tools/artifact/artifact-snapshots.js';
import { fileURLToPath } from 'node:url';
import { Storage } from '../config/storage.js';
import {
  stableSessionArtifactId,
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
} from './session-artifact-persistence.js';

let temp: string;
let cwd: string;
let runtime: string;
let id: string;
let file: string;
let artifactId: string;
let service: SessionService;
const stamp = '2026-10-20T00:00:00.000Z';

async function seed(archived = false) {
  const storage = new Storage(cwd, runtime);
  const dir = path.join(
    storage.getProjectDir(),
    'chats',
    archived ? 'archive' : '',
  );
  await fs.mkdir(dir, { recursive: true });
  file = path.join(dir, `${id}.jsonl`);
  const common = { sessionId: id, cwd, timestamp: stamp, version: '0.25.3' };
  const records = [
    {
      ...common,
      uuid: 'user-1',
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'Make a report' },
    },
    {
      ...common,
      uuid: 'artifact-1',
      parentUuid: 'user-1',
      type: 'system',
      subtype: 'session_artifact_event',
      systemPayload: {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: id,
        sequence: 1,
        recordedAt: stamp,
        changes: [
          {
            action: 'created',
            artifactId,
            artifact: {
              id: artifactId,
              title: 'Report',
              kind: 'file',
              storage: 'workspace',
              workspacePath: 'report.md',
              source: 'tool',
              status: 'available',
              retention: 'restorable',
              clientRetained: false,
              createdAt: stamp,
              updatedAt: stamp,
            },
          },
        ],
      },
    },
    {
      ...common,
      uuid: 'assistant-1',
      parentUuid: 'user-1',
      type: 'assistant',
      message: { role: 'assistant', content: 'Done' },
    },
  ];
  await fs.writeFile(
    file,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
}

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-library-test-'));
  cwd = path.join(temp, 'workspace');
  runtime = path.join(temp, 'runtime');
  await fs.mkdir(cwd);
  id = randomUUID();
  artifactId = stableSessionArtifactId(id, 'workspace:report.md');
  service = new SessionService(cwd, { runtimeBaseDir: runtime });
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

describe('persisted artifact library', () => {
  it.each([false, true])(
    'reads and unregisters cold artifacts without changing archive state (%s)',
    async (archived) => {
      await seed(archived);
      const before = await fs.readFile(file, 'utf8');
      expect(
        (await service.readSessionArtifactSnapshot(id))?.artifacts.map(
          (item) => item.id,
        ),
      ).toEqual([artifactId]);
      expect(await fs.readFile(file, 'utf8')).toBe(before);
      const lease = await service.acquireSessionMaintenanceLease(id, {
        processKind: 'daemon',
        reclaimPolicy: 'never',
      });
      try {
        await expect(
          service.removeSessionArtifactForLibrary(id, artifactId, {
            assertStorageUnchanged: () => lease.assertOwnedAndUnchanged(),
            assertCanMutate: () => {},
          }),
        ).resolves.toBe(true);
      } finally {
        await lease.release();
      }
      const snapshot = await new SessionService(cwd, {
        runtimeBaseDir: runtime,
      }).readSessionArtifactSnapshot(id);
      expect(snapshot?.artifacts).toEqual([]);
      expect(snapshot?.tombstonedIds).toContain(artifactId);
      expect(snapshot?.markerArtifacts?.[0]?.id).toBe(artifactId);
      expect(await service.getSessionLocation(id)).toBe(
        archived ? 'archived' : 'active',
      );
      const loaded = archived
        ? await service.loadArchivedSession(id, { maxBytes: 1024 * 1024 })
        : await service.loadSession(id);
      expect(
        loaded?.conversation.messages
          .filter(
            (record) => record.type === 'user' || record.type === 'assistant',
          )
          .map((record) => record.uuid),
      ).toEqual(['user-1', 'assistant-1']);
      const after = await fs.readFile(file, 'utf8');
      await expect(
        service.removeSessionArtifactForLibrary(id, artifactId, {
          assertStorageUnchanged: async () => {},
          assertCanMutate: () => {},
        }),
      ).resolves.toBe(false);
      expect(await fs.readFile(file, 'utf8')).toBe(after);
    },
  );

  it.each([
    { archived: false, subtype: 'session_sources_snapshot' },
    { archived: true, subtype: 'session_sources_snapshot' },
    { archived: false, subtype: 'custom_title' },
    { archived: true, subtype: 'custom_title' },
  ])(
    'keeps unregister visible after a trailing side record and reload ($archived, $subtype)',
    async ({ archived, subtype }) => {
      await seed(archived);
      await fs.appendFile(
        file,
        JSON.stringify({
          uuid: 'trailing-metadata',
          parentUuid: 'assistant-1',
          sessionId: id,
          cwd,
          timestamp: stamp,
          version: '0.25.3',
          type: 'system',
          subtype,
          systemPayload:
            subtype === 'session_sources_snapshot'
              ? { version: 1, revision: 1, sources: [] }
              : { customTitle: 'Report title', titleSource: 'manual' },
        }) + '\n',
      );
      const before = await fs.readFile(file, 'utf8');
      expect(
        (await service.readSessionArtifactSnapshot(id))?.artifacts.map(
          (artifact) => artifact.id,
        ),
      ).toEqual([artifactId]);
      const options = {
        processKind: 'daemon' as const,
        reclaimPolicy: 'never' as const,
      };
      const lease = archived
        ? await service.acquireSessionMaintenanceLease(id, options)
        : await service.acquireSessionWriterLease(id, options);
      try {
        await expect(
          service.removeSessionArtifactForLibrary(id, artifactId, {
            assertStorageUnchanged: () => lease.assertOwnedAndUnchanged(),
            assertCanMutate: () => {},
          }),
        ).resolves.toBe(true);
      } finally {
        await lease.release();
      }
      const fresh = new SessionService(cwd, { runtimeBaseDir: runtime });
      const snapshot = await fresh.readSessionArtifactSnapshot(id);
      expect(snapshot?.artifacts).toEqual([]);
      expect(snapshot?.tombstonedIds).toContain(artifactId);
      const loaded = archived
        ? await fresh.loadArchivedSession(id, { maxBytes: 1024 * 1024 })
        : await fresh.loadSession(id);
      expect(loaded?.artifactSnapshot?.artifacts).toEqual([]);
      expect(loaded?.artifactSnapshot?.tombstonedIds).toContain(artifactId);
      expect(await fresh.getSessionLocation(id)).toBe(
        archived ? 'archived' : 'active',
      );
      expect((await fs.readFile(file, 'utf8')).startsWith(before)).toBe(true);
    },
  );

  it.each([
    { archived: false, titled: false },
    { archived: true, titled: false },
    { archived: false, titled: true },
    { archived: true, titled: true },
  ])(
    'preserves first-prompt artifact journals across unregister and a fresh service ($archived, $titled)',
    async ({ archived, titled }) => {
      await seed(archived);
      const records: Array<Record<string, unknown>> = (
        await fs.readFile(file, 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record['subtype'] === 'session_artifact_event')
        .map((record) => ({ ...record, parentUuid: null }));
      if (titled) {
        records.push({
          uuid: 'title-before-prompt',
          parentUuid: null,
          sessionId: id,
          cwd,
          timestamp: stamp,
          version: '0.25.3',
          type: 'system',
          subtype: 'custom_title',
          systemPayload: {
            customTitle: 'Before first prompt',
            titleSource: 'manual',
          },
        });
      }
      await fs.writeFile(
        file,
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
      const before = await fs.readFile(file, 'utf8');
      expect(
        (await service.readSessionArtifactSnapshot(id))?.artifacts.map(
          (artifact) => artifact.id,
        ),
      ).toEqual([artifactId]);
      expect(await fs.readFile(file, 'utf8')).toBe(before);
      const options = {
        processKind: 'daemon' as const,
        reclaimPolicy: 'never' as const,
      };
      const lease = archived
        ? await service.acquireSessionMaintenanceLease(id, options)
        : await service.acquireSessionWriterLease(id, options);
      try {
        await expect(
          service.removeSessionArtifactForLibrary(id, artifactId, {
            assertStorageUnchanged: () => lease.assertOwnedAndUnchanged(),
            assertCanMutate: () => {},
          }),
        ).resolves.toBe(true);
      } finally {
        await lease.release();
      }
      const fresh = new SessionService(cwd, { runtimeBaseDir: runtime });
      const restored = await fresh.readSessionArtifactSnapshot(id);
      expect(restored?.artifacts).toEqual([]);
      expect(restored?.tombstonedIds).toContain(artifactId);
      expect(restored?.markerArtifacts?.map((artifact) => artifact.id)).toEqual(
        [artifactId],
      );
      expect(await fresh.getSessionLocation(id)).toBe(
        archived ? 'archived' : 'active',
      );
      expect((await fs.readFile(file, 'utf8')).startsWith(before)).toBe(true);
    },
  );

  it('does not append when a writer/runtime guard fails', async () => {
    await seed();
    const before = await fs.readFile(file, 'utf8');
    await expect(
      service.removeSessionArtifactForLibrary(id, artifactId, {
        assertStorageUnchanged: async () => {
          throw new Error('lease lost');
        },
        assertCanMutate: () => {},
      }),
    ).rejects.toThrow('lease lost');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(
      (await service.readSessionArtifactSnapshot(id))?.artifacts,
    ).toHaveLength(1);
  });

  it('rejects a transcript changed while a guard was pending', async () => {
    await seed();
    await expect(
      service.removeSessionArtifactForLibrary(id, artifactId, {
        assertStorageUnchanged: async () => {
          await fs.appendFile(file, ' ');
        },
        assertCanMutate: () => {},
      }),
    ).rejects.toThrow();
    expect(
      (await fs.readFile(file, 'utf8')).includes('"action":"removed"'),
    ).toBe(false);
  });

  it.each(['broken', 'foreign'])(
    'rejects incomplete or mixed-session records (%s)',
    async (kind) => {
      await seed();
      await fs.appendFile(
        file,
        kind === 'broken'
          ? '{broken\n'
          : JSON.stringify({
              uuid: 'foreign',
              sessionId: randomUUID(),
              cwd,
              type: 'user',
              timestamp: stamp,
              parentUuid: 'assistant-1',
            }) + '\n',
      );
      await expect(service.readSessionArtifactSnapshot(id)).rejects.toThrow(
        SessionArtifactLibraryError,
      );
    },
  );

  it('rejects an oversized transcript before reading its body', async () => {
    await seed();
    await fs.truncate(file, 64 * 1024 * 1024 + 1);
    await expect(service.readSessionArtifactSnapshot(id)).rejects.toThrow(
      SessionTranscriptTooLargeError,
    );
  });

  it('refuses legacy mutation of a managed-owned transcript', async () => {
    await seed();
    const record = {
      uuid: 'managed-owner',
      parentUuid: 'assistant-1',
      sessionId: id,
      cwd,
      timestamp: stamp,
      version: '0.25.3',
      type: 'system',
      subtype: 'session_execution_engine',
      systemPayload: { engine: 'managed' },
    };
    await fs.appendFile(file, JSON.stringify(record) + '\n');
    const before = await fs.readFile(file, 'utf8');
    await expect(
      service.removeSessionArtifactForLibrary(id, artifactId, {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      }),
    ).rejects.toThrow('managed session authority');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('cannot obtain management ownership while another writer holds the session', async () => {
    await seed();
    const live = await service.acquireSessionWriterLease(id, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });
    try {
      await expect(
        service.acquireSessionWriterLease(id, {
          processKind: 'daemon',
          reclaimPolicy: 'never',
          takeoverPolicy: 'certified',
        }),
      ).rejects.toThrow();
      expect(
        (await service.readSessionArtifactSnapshot(id))?.artifacts,
      ).toHaveLength(1);
    } finally {
      await live.release();
    }
  });

  it('never resolves a foreign workspace or a path traversal', async () => {
    await seed();
    const other = path.join(temp, 'other');
    await fs.mkdir(other);
    expect(
      await new SessionService(other, {
        runtimeBaseDir: runtime,
      }).readSessionArtifactSnapshot(id),
    ).toBeUndefined();
    expect(
      await service.readSessionArtifactSnapshot('../outside'),
    ).toBeUndefined();
  });
  it.each([false, true])(
    'preserves history after cold deletion and rename with a large side tail (%s)',
    async (largeTail) => {
      await seed();
      await service.removeSessionArtifactForLibrary(id, artifactId, {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      });
      if (largeTail) {
        await fs.appendFile(
          file,
          JSON.stringify({
            sessionId: id,
            cwd,
            uuid: 'sources',
            parentUuid: 'assistant-1',
            timestamp: stamp,
            version: '0.25.3',
            type: 'system',
            subtype: 'session_sources_snapshot',
            systemPayload: { padding: 'x'.repeat(100_000) },
          }) + '\n',
        );
      }
      expect(await service.renameSession(id, 'Renamed')).toBe(true);
      expect(await service.readSessionArtifactSnapshot(id)).toMatchObject({
        artifacts: [],
        tombstonedIds: [artifactId],
      });
      const loaded = await service.loadSession(id);
      expect(loaded?.historyGaps ?? []).toEqual([]);
      expect(
        loaded?.conversation.messages
          .filter(
            (record) => record.type === 'user' || record.type === 'assistant',
          )
          .map((record) => record.uuid),
      ).toEqual(['user-1', 'assistant-1']);
      expect(loaded?.artifactSnapshot?.tombstonedIds).toContain(artifactId);
    },
  );

  it('selects only the requested artifact after a snapshot and skips an unknown artifact kind', async () => {
    await seed();
    const original = (await service.readSessionArtifactSnapshot(id))!
      .artifacts[0];
    const second = {
      ...original,
      id: stableSessionArtifactId(id, 'workspace:second.md'),
      workspacePath: 'second.md',
    };
    const future = {
      ...original,
      id: stableSessionArtifactId(id, 'workspace:future.md'),
      workspacePath: 'future.md',
      kind: 'future-kind',
    };
    await fs.appendFile(
      file,
      JSON.stringify({
        sessionId: id,
        cwd,
        uuid: 'snapshot',
        parentUuid: 'assistant-1',
        timestamp: stamp,
        version: '0.25.3',
        type: 'system',
        subtype: 'session_artifact_snapshot',
        systemPayload: {
          v: 2,
          sessionId: id,
          sequence: 50,
          recordedAt: stamp,
          artifacts: [original, second, future],
          tombstonedIds: [],
          stickyEphemeralIds: [],
        },
      }) + '\n',
    );
    const before = await service.readSessionArtifactSnapshot(id);
    expect(before?.artifacts.map((artifact) => artifact.id)).toEqual([
      artifactId,
      second.id,
    ]);
    expect(before?.warnings).toEqual([
      `skipped malformed artifact ${future.id}`,
    ]);
    expect(
      await service.removeSessionArtifactForLibrary(id, second.id, {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      }),
    ).toBe(true);
    const after = await service.readSessionArtifactSnapshot(id);
    expect(after?.sequence).toBe(51);
    expect(after?.artifacts.map((artifact) => artifact.id)).toEqual([
      artifactId,
    ]);
    expect(after?.tombstonedIds).toEqual([second.id]);
  });

  it('reports partial reads but refuses mutations with a stale journal sequence', async () => {
    await seed();
    const original = (await service.readSessionArtifactSnapshot(id))!
      .artifacts[0];
    const base = {
      sessionId: id,
      cwd,
      parentUuid: 'assistant-1',
      timestamp: stamp,
      version: '0.25.3',
      type: 'system',
    };
    await fs.appendFile(
      file,
      [
        {
          ...base,
          uuid: 'snapshot',
          subtype: 'session_artifact_snapshot',
          systemPayload: {
            v: 2,
            sessionId: id,
            sequence: 50,
            recordedAt: stamp,
            artifacts: [original],
          },
        },
        {
          ...base,
          uuid: 'stale',
          subtype: 'session_artifact_event',
          systemPayload: {
            v: 2,
            sessionId: id,
            sequence: 49,
            recordedAt: stamp,
            changes: [],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    expect((await service.readSessionArtifactSnapshot(id))?.warnings).toEqual([
      expect.stringContaining('skipped stale event sequence'),
    ]);
    const before = await fs.readFile(file, 'utf8');
    await expect(
      service.removeSessionArtifactForLibrary(id, artifactId, {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      }),
    ).rejects.toMatchObject({ code: 'session_transcript_corrupt' });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('returns an empty library for a conversation with no registrations', async () => {
    await seed();
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    await fs.writeFile(file, [lines[0], lines[2]].join('\n') + '\n');
    expect(await service.readSessionArtifactSnapshot(id)).toMatchObject({
      sequence: 0,
      artifacts: [],
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: [],
    });
    const before = await fs.readFile(file, 'utf8');
    expect(
      await service.removeSessionArtifactForLibrary(id, artifactId, {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      }),
    ).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('rechecks runtime authority after the asynchronous storage guard', async () => {
    await seed();
    const before = await fs.readFile(file, 'utf8');
    let mutable = true;
    await expect(
      service.removeSessionArtifactForLibrary(id, artifactId, {
        assertStorageUnchanged: async () => {
          await Promise.resolve();
          mutable = false;
        },
        assertCanMutate: () => {
          if (!mutable) throw new Error('runtime drained');
        },
      }),
    ).rejects.toThrow('runtime drained');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('returns not found for an empty journal', async () => {
    await seed();
    await fs.writeFile(file, '');
    expect(await service.readSessionArtifactSnapshot(id)).toBeUndefined();
    expect(
      await service.removeSessionArtifactForLibrary(id, artifactId, {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      }),
    ).toBeUndefined();
  });

  it('rejects foreign ownership even when a transcript exists at the expected path', async () => {
    await seed();
    const other = path.join(temp, 'other');
    await fs.mkdir(other);
    const dir = path.join(new Storage(other, runtime).getProjectDir(), 'chats');
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(file, path.join(dir, `${id}.jsonl`));
    await expect(
      new SessionService(other, {
        runtimeBaseDir: runtime,
      }).readSessionArtifactSnapshot(id),
    ).rejects.toThrow(SessionStorageEntryError);
  });

  it('refuses traversal even when an escaped transcript exists', async () => {
    await seed();
    const escaped = (await fs.readFile(file, 'utf8')).replaceAll(
      id,
      '../outside',
    );
    await fs.writeFile(
      path.resolve(path.dirname(file), '../outside.jsonl'),
      escaped,
    );
    expect(
      await service.readSessionArtifactSnapshot('../outside'),
    ).toBeUndefined();
  });

  it('releases a removed web-preview snapshot reference without deleting workspace files', async () => {
    await seed();
    const report = path.join(cwd, 'report.md');
    await fs.writeFile(report, 'Keep workspace output');
    const capture = await saveArtifactSnapshot(
      '<html>Capture</html>',
      'Capture',
      'https://example.com',
      id,
      runtime,
    );
    const snapshotId = stableSessionArtifactId(id, `url:${capture.url}`);
    const artifact = {
      ...capture,
      id: snapshotId,
      toolName: 'artifact',
      source: 'tool',
      status: 'available',
      retention: 'restorable',
      clientRetained: false,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await fs.appendFile(
      file,
      JSON.stringify({
        sessionId: id,
        cwd,
        uuid: 'capture',
        parentUuid: 'assistant-1',
        timestamp: stamp,
        version: '0.25.3',
        type: 'system',
        subtype: 'session_artifact_event',
        systemPayload: {
          v: 2,
          sessionId: id,
          sequence: 2,
          recordedAt: stamp,
          changes: [{ action: 'created', artifactId: snapshotId, artifact }],
        },
      }) + '\n',
    );
    const captured = fileURLToPath(capture.url!);
    expect(await fs.readFile(captured, 'utf8')).toBe('<html>Capture</html>');
    expect(
      await service.removeSessionArtifactForLibrary(id, snapshotId, {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      }),
    ).toBe(true);
    await expect(fs.stat(captured)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(report, 'utf8')).toBe('Keep workspace output');
    expect(
      (await service.readSessionArtifactSnapshot(id))?.artifacts.map(
        (item) => item.id,
      ),
    ).toEqual([artifactId]);
  });
});
