/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../config/storage.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import {
  ManagedSessionAlreadyExistsError,
  ManagedSessionNotFoundError,
} from './managed-session-authority.js';
import {
  openManagedSession,
  type ManagedSession,
} from './managed-session-assembly.js';
import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import { readManagedSessionTitleInfoSync } from '../utils/sessionStorageUtils.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type {
  ManagedSessionJournalStore,
  ManagedSessionResourceStore,
} from './managed-session-storage.js';

const DIGEST = '9'.repeat(64);
const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = { tenantId: 't1', workspaceId: 'w1', sessionId };
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function ref(kind = 'managed-test'): ManagedSessionDurableRef {
  return {
    resourceId: 'res-1',
    kind,
    schemaVersion: 1,
    byteLength: 4,
    digest: DIGEST,
  };
}

interface Workspace {
  runtimeBaseDir: string;
  projectRoot: string;
  transcriptPath: string;
}

async function createWorkspace(): Promise<Workspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-asm-'));
  temporaryDirectories.add(root);
  const projectRoot = path.join(root, 'project');
  const runtimeBaseDir = path.join(root, 'runtime');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  const transcriptPath = path.join(
    new Storage(projectRoot, runtimeBaseDir).getProjectDir(),
    'chats',
    `${sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return { runtimeBaseDir, projectRoot, transcriptPath };
}

function open(
  workspace: Workspace,
  options: {
    create?: boolean;
    lease?: SessionWriterLease;
    journalStore?: ManagedSessionJournalStore;
    resourceStore?: ManagedSessionResourceStore;
    requireNew?: boolean;
  } = {},
): Promise<ManagedSession> {
  return openManagedSession({
    runtimeBaseDir: workspace.runtimeBaseDir,
    sessionId,
    transcriptPath: workspace.transcriptPath,
    sessionKey,
    cwd: workspace.projectRoot,
    version: 'test',
    workerId: 'worker-1',
    activationLeaseDurationMs: 60_000,
    ...(options.lease === undefined ? {} : { lease: options.lease }),
    ...(options.journalStore === undefined
      ? {}
      : { journalStore: options.journalStore }),
    ...(options.resourceStore === undefined
      ? {}
      : { resourceStore: options.resourceStore }),
    ...(options.requireNew === true ? { requireNew: true } : {}),
    ...(options.create === false
      ? {}
      : {
          create: {
            definitionRef: ref('managed-definition'),
            rootSnapshotRef: ref('managed-root'),
            createdBy: 'daemon',
          },
        }),
  });
}

function record(overrides: Partial<ChatRecord>): ChatRecord {
  return {
    uuid: 'rec-1',
    parentUuid: null,
    sessionId,
    timestamp: '2026-09-01T10:00:00.000Z',
    type: 'user',
    cwd: '/workspace',
    version: 'test',
    ...overrides,
  } as ChatRecord;
}

describe('managed session assembly', () => {
  it('accepts injected journal and resource stores', async () => {
    const workspace = await createWorkspace();
    const journalStore = new LocalJsonlManagedSessionJournalStore({
      runtimeBaseDir: workspace.runtimeBaseDir,
      sessionId,
      transcriptPath: workspace.transcriptPath,
    });
    const resourceStore = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: workspace.runtimeBaseDir,
      sessionKey,
    });

    const session = await open(workspace, { journalStore, resourceStore });
    await session.sink.write(record({ uuid: 'rec-user-injected' }));

    expect(await session.sink.project()).toHaveLength(1);
    await session.close();
  });

  it('carries one whole turn from input to terminal state', async () => {
    const workspace = await createWorkspace();
    const session = await open(workspace);

    // Opening installed the activation, so every record names it as its harness
    // without the caller arranging anything.
    expect(session.activation.epoch).toBe(1);
    const installed = session.authority
      .readEvents()
      .filter((event) => event.kind === 'activation.changed');
    expect(installed).toHaveLength(1);
    expect(installed[0].payload['workerId']).toBe('worker-1');
    expect(installed[0].payload['phase']).toBe('active');

    const userRecord = record({
      uuid: 'rec-user-1',
      message: { role: 'user', parts: [{ text: 'summarise the docs' }] },
    });
    await session.sink.write(userRecord);

    const assistantRecord = record({
      uuid: 'rec-assistant-1',
      parentUuid: 'rec-user-1',
      type: 'assistant',
      model: 'qwen3-coder-plus',
      message: { role: 'model', parts: [{ text: 'Here it is.' }] },
    });
    await session.sink.write(assistantRecord);

    await session.sink.write(
      record({
        uuid: 'rec-title-1',
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { customTitle: 'Doc summary', titleSource: 'auto' },
      }),
    );

    await session.sink.write(
      record({
        uuid: 'rec-turn-1',
        type: 'system',
        subtype: 'turn_result',
        systemPayload: {
          promptId: 'turn-1',
          state: 'completed',
          stopReason: 'end_turn',
          endedAt: Date.parse('2026-09-01T10:00:10.000Z'),
        },
      }),
    );

    const settled = session.authority
      .readEvents()
      .filter((event) => event.kind === 'turn.settled');
    expect(settled).toHaveLength(1);
    expect(settled[0].payload['outcome']).toBe('completed');

    expect(await session.sink.project()).toEqual([userRecord, assistantRecord]);
    await session.close();

    // Reopening reads the same history back, and the title reaches the session
    // directory through the metadata record rather than the message channel.
    const reopened = await open(workspace, { create: false });
    expect(await reopened.sink.project()).toEqual([
      userRecord,
      assistantRecord,
    ]);
    expect(
      readManagedSessionTitleInfoSync(
        workspace.transcriptPath,
        workspace.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Doc summary', source: 'auto' });
    await reopened.close();
  });

  it('leaves the sealed barrier in place after closing', async () => {
    const workspace = await createWorkspace();
    const session = await open(workspace);
    await session.sink.write(record({ uuid: 'rec-user-1' }));
    await session.close();

    await expect(
      SessionWriterLease.acquire({
        runtimeBaseDir: workspace.runtimeBaseDir,
        sessionId,
        transcriptPath: workspace.transcriptPath,
      }),
    ).rejects.toThrow();
  });

  it('does not hold the writer when opening fails', async () => {
    const workspace = await createWorkspace();

    // No creation parameters and no existing header: opening cannot succeed.
    await expect(open(workspace, { create: false })).rejects.toBeInstanceOf(
      ManagedSessionNotFoundError,
    );

    // The writer was released rather than left held or sealed, so a fresh open
    // succeeds instead of colliding with an abandoned lock.
    const session = await open(workspace);
    expect(session.authority.committedSequence).toBe(1);
    await session.close();
  });

  it('does not reopen an existing authority through a create path', async () => {
    const workspace = await createWorkspace();
    const created = await open(workspace);
    await created.close();

    await expect(open(workspace, { requireNew: true })).rejects.toBeInstanceOf(
      ManagedSessionAlreadyExistsError,
    );

    const restored = await open(workspace, { create: false });
    await restored.close();
  });

  it('leaves an adopted writer to its owner', async () => {
    const workspace = await createWorkspace();
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: workspace.runtimeBaseDir,
      sessionId,
      transcriptPath: workspace.transcriptPath,
    });
    const session = await open(workspace, { lease });
    await session.sink.write(record({ uuid: 'rec-user-1' }));
    await session.close();

    // Closing the session must not end a lease it never acquired: the owner is
    // still writing through it after this point.
    expect(lease.isReleased).toBe(false);

    // The barrier arrives when the owner seals, which is the owner's decision
    // to make -- releasing instead would leave the Managed log unguarded.
    await lease.sealForHandoff();
    await expect(
      SessionWriterLease.acquire({
        runtimeBaseDir: workspace.runtimeBaseDir,
        sessionId,
        transcriptPath: workspace.transcriptPath,
      }),
    ).rejects.toThrow();
  });

  it('leaves an adopted writer intact when opening fails', async () => {
    const workspace = await createWorkspace();
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: workspace.runtimeBaseDir,
      sessionId,
      transcriptPath: workspace.transcriptPath,
    });

    await expect(open(workspace, { create: false, lease })).rejects.toThrow();
    expect(lease.isReleased).toBe(false);

    // Still the same writer, so the owner can retry through it.
    const session = await open(workspace, { lease });
    await session.sink.write(record({ uuid: 'rec-user-1' }));
    expect(await session.sink.project()).toHaveLength(1);
    await session.close();
    await lease.sealForHandoff();
  });

  it('names a replacement activation on later records', async () => {
    const workspace = await createWorkspace();
    const session = await open(workspace);
    const first = session.activation.activationId;
    await session.sink.write(record({ uuid: 'rec-user-1' }));

    const replaced = await session.replaceActivation();
    expect(replaced.activationId).not.toBe(first);
    expect(session.activation.activationId).toBe(replaced.activationId);

    await session.sink.write(record({ uuid: 'rec-user-2' }));
    const messages = session.authority
      .readEvents()
      .filter((event) => event.kind === 'message.committed');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.subject).toMatchObject({
      type: 'activation',
      activationId: first,
    });
    expect(messages[1]?.subject).toMatchObject({
      type: 'activation',
      activationId: replaced.activationId,
    });
    await session.close();
  });
});
