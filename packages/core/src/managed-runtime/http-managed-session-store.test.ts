/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openManagedSession } from './managed-session-assembly.js';
import {
  ManagedSessionMessageProjection,
  projectManagedSessionRecords,
} from './managed-session-message-projection.js';
import type { ManagedSessionStoreHttpError } from './http-managed-session-store.js';
import { createHttpManagedSessionStores } from './http-managed-session-store.js';
import type { ManagedSessionKey } from './managed-session-records.js';
import {
  createInitialHarnessCheckpoint,
  encodeHarnessCheckpointV1,
} from './managed-harness-checkpoint.js';

const SESSION_KEY: ManagedSessionKey = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
};
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

describe('HTTP Managed Session store', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('commits staged resources and restores without a local transcript', async () => {
    const server = new FakeManagedSessionStore();
    const runtimeBaseDir = await mkdtemp(
      path.join(tmpdir(), 'managed-http-store-'),
    );
    temporaryDirectories.push(runtimeBaseDir);
    const transcriptPath = path.join(runtimeBaseDir, 'session.jsonl');
    const firstStores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: server.fetch,
    });
    const definitionRef = await firstStores.resourceStore.publish(
      'managed-session-definition',
      Buffer.from('{"model":"test"}', 'utf8'),
    );
    const rootSnapshotRef = await firstStores.resourceStore.publish(
      'managed-session-root-snapshot',
      Buffer.from('{"version":1,"messages":[]}', 'utf8'),
    );

    const first = await openManagedSession({
      runtimeBaseDir,
      sessionId: SESSION_KEY.sessionId,
      transcriptPath,
      sessionKey: SESSION_KEY,
      cwd: '/workspace',
      version: 'test',
      workerId: 'harness-a',
      activationLeaseDurationMs: 60_000,
      journalStore: firstStores.journalStore,
      resourceStore: firstStores.resourceStore,
      create: {
        definitionRef,
        rootSnapshotRef,
        createdBy: 'test',
      },
    });

    expect(server.commits[0]).toMatchObject({
      expectedJournalRevision: 0,
      expectedCommittedSequence: 0,
      operation: 'session.create',
      firstSequence: 0,
      lastSequence: 0,
      eventCount: 0,
      activationEpoch: 0,
      recordCount: 2,
    });
    expect(server.commits[0]?.['resources']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: definitionRef.resourceId,
          bytesBase64: Buffer.from('{"model":"test"}').toString('base64'),
        }),
        expect.objectContaining({
          resourceId: rootSnapshotRef.resourceId,
          bytesBase64: Buffer.from('{"version":1,"messages":[]}').toString(
            'base64',
          ),
        }),
      ]),
    );
    expect(server.commits[1]).toMatchObject({
      expectedJournalRevision: 1,
      expectedCommittedSequence: 0,
      operation: 'installActivation',
      firstSequence: 1,
      lastSequence: 1,
      eventCount: 1,
      activationEpoch: 1,
      recordCount: 2,
    });
    const genesisRecords = Buffer.from(
      String(server.commits[0]?.['recordBytesBase64']),
      'base64',
    )
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    const foreignHeader = genesisRecords[1] as {
      managedSession: { sessionKey: { sessionId: string } };
    };
    foreignHeader.managedSession.sessionKey.sessionId =
      '550e8400-e29b-41d4-a716-446655440001';
    const firstJournal = await firstStores.journalStore.open({
      sessionKey: SESSION_KEY,
    });
    await expect(
      firstJournal.appendTransaction(genesisRecords),
    ).rejects.toThrow(/different session/);
    expect(server.commits).toHaveLength(2);
    foreignHeader.managedSession.sessionKey.sessionId = SESSION_KEY.sessionId;
    (foreignHeader as unknown as { sessionId: string }).sessionId =
      '550e8400-e29b-41d4-a716-446655440001';
    await expect(
      firstJournal.appendTransaction(genesisRecords),
    ).rejects.toThrow(/different session/);
    expect(server.commits).toHaveLength(2);
    const record = {
      uuid: 'record-user-1',
      parentUuid: null,
      sessionId: SESSION_KEY.sessionId,
      timestamp: '2026-09-22T00:00:00.000Z',
      type: 'user' as const,
      cwd: '/workspace',
      version: 'test',
      message: { role: 'user' as const, parts: [{ text: 'restore me' }] },
    };
    await new ManagedSessionMessageProjection(
      first.authority,
      first.resources,
    ).commit(
      {
        operation: 'message.commit',
        commandId: 'message-1',
        sessionKey: SESSION_KEY,
        contentDigest: 'c'.repeat(64),
      },
      { record },
      {
        class: 'harness',
        activation: first.activation,
      },
    );
    const messageCommitCount = server.commits.length;
    const foreignEventRecords = Buffer.from(
      String(server.commits.at(-1)?.['recordBytesBase64']),
      'base64',
    )
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    const foreignEvent = foreignEventRecords[0] as {
      managedSession: { sessionKey: { tenantId: string } };
    };
    foreignEvent.managedSession.sessionKey.tenantId = 'tenant-b';
    await expect(
      firstJournal.appendTransaction(foreignEventRecords),
    ).rejects.toThrow(/different session/);
    expect(server.commits).toHaveLength(messageCommitCount);
    await expect(stat(transcriptPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await first.close();
    const committedBeforeRestore = server.commits.length;
    const secondStores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-b',
      writerToken: TOKEN_B,
      fetchFn: server.fetch,
    });
    const [reader, repeatedReader] = await Promise.all([
      secondStores.journalStore.open({ sessionKey: SESSION_KEY }),
      secondStores.journalStore.open({ sessionKey: SESSION_KEY }),
    ]);
    expect(repeatedReader).toBe(reader);
    const scan = await reader.read();
    await expect(
      projectManagedSessionRecords({
        scan,
        resources: secondStores.resourceStore,
      }),
    ).resolves.toEqual([record]);
    const restored = await openManagedSession({
      runtimeBaseDir,
      sessionId: SESSION_KEY.sessionId,
      transcriptPath,
      sessionKey: SESSION_KEY,
      cwd: '/workspace',
      version: 'test',
      workerId: 'harness-b',
      activationLeaseDurationMs: 60_000,
      journalStore: secondStores.journalStore,
      resourceStore: secondStores.resourceStore,
    });

    expect(server.transactionReads).toBeGreaterThan(0);
    expect(server.commits).toHaveLength(committedBeforeRestore + 1);
    expect(server.commits.at(-1)).toMatchObject({
      operation: 'installActivation',
      activationEpoch: 2,
    });
    expect(restored.activation.epoch).toBe(2);
    expect(await restored.authority.restoreBundle()).toMatchObject({
      sessionKey: SESSION_KEY,
      recoveryStatus: 'ok',
    });
    await restored.close();
  });

  it('commits only checkpoint resources and their dependencies for a cold owner', async () => {
    const server = new FakeManagedSessionStore();
    const runtimeBaseDir = await mkdtemp(
      path.join(tmpdir(), 'managed-http-store-'),
    );

    temporaryDirectories.push(runtimeBaseDir);
    const transcriptPath = path.join(runtimeBaseDir, 'session.jsonl');
    const firstStores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: server.fetch,
    });
    const definitionRef = await firstStores.resourceStore.publish(
      'managed-session-definition',
      Buffer.from('{"model":"test"}', 'utf8'),
    );
    const rootSnapshotRef = await firstStores.resourceStore.publish(
      'managed-session-root-snapshot',
      Buffer.from('{"version":1,"messages":[]}', 'utf8'),
    );

    const first = await openManagedSession({
      runtimeBaseDir,
      sessionId: SESSION_KEY.sessionId,
      transcriptPath,
      sessionKey: SESSION_KEY,
      cwd: '/workspace',
      version: 'test',
      workerId: 'harness-a',
      activationLeaseDurationMs: 60_000,
      journalStore: firstStores.journalStore,
      resourceStore: firstStores.resourceStore,
      create: {
        definitionRef,
        rootSnapshotRef,
        createdBy: 'test',
      },
    });

    const historyBytes = Buffer.from(
      '[{"role":"user","parts":[{"text":"earlier context"}]}]',
    );
    const historyRef = await first.resources.publish(
      'managed-api-history',
      historyBytes,
    );
    const unusedRef = await first.resources.publish(
      'managed-api-history',
      Buffer.from('[]'),
    );
    const checkpoint = createInitialHarnessCheckpoint({
      sessionKey: SESSION_KEY,
      checkpointId: 'ckpt-2',
      coveredSequence: 1,
      activationId: first.activation.activationId,
      turnId: null,
      promptId: null,
      definitionRevision: definitionRef.resourceId,
      configRevision: rootSnapshotRef.resourceId,
      inputDigest: definitionRef.digest,
      previousCheckpointId: null,
    });
    const state = encodeHarnessCheckpointV1({
      ...checkpoint,
      resume: { ...checkpoint.resume, apiHistoryRef: historyRef },
    });
    await first.authority.commitCheckpoint(
      {
        operation: 'commitCheckpoint',
        commandId: 'test-checkpoint',
        sessionKey: SESSION_KEY,
        contentDigest: 'c'.repeat(64),
      },
      { state, boundary: null },
      { class: 'harness', activation: first.activation },
    );
    const checkpointRef = first.authority.latestCheckpoint!.stateRef;
    const committedResources = server.commits.at(-1)!['resources'] as Array<{
      resourceId: string;
    }>;
    expect(
      committedResources.map(({ resourceId }) => resourceId).sort(),
    ).toEqual([checkpointRef.resourceId, historyRef.resourceId].sort());
    await first.close();

    const secondStores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-b',
      writerToken: TOKEN_B,
      fetchFn: server.fetch,
    });
    const restored = await openManagedSession({
      runtimeBaseDir,
      sessionId: SESSION_KEY.sessionId,
      transcriptPath,
      sessionKey: SESSION_KEY,
      cwd: '/workspace',
      version: 'test',
      workerId: 'harness-b',
      activationLeaseDurationMs: 60_000,
      journalStore: secondStores.journalStore,
      resourceStore: secondStores.resourceStore,
    });
    try {
      await expect(restored.authority.readCheckpointState()).resolves.toEqual(
        state,
      );
      await expect(restored.resources.read(historyRef)).resolves.toEqual(
        historyBytes,
      );
      await expect(restored.resources.read(unusedRef)).rejects.toMatchObject({
        status: 404,
        remoteCode: 'managed_session_resource_not_found',
      });
    } finally {
      await restored.close();
    }
  });

  it('surfaces structured Java errors without exposing the token', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'managed_session_writer_conflict',
            message: 'The Managed Session has another writer.',
          },
        },
        409,
      ),
    );
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn,
    });

    const error = await stores.journalStore
      .open({ sessionKey: SESSION_KEY })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject<Partial<ManagedSessionStoreHttpError>>({
      status: 409,
      remoteCode: 'managed_session_writer_conflict',
      message: 'The Managed Session has another writer.',
    });
    expect(String(error)).not.toContain(TOKEN_A);
  });

  it('persists a fenced recovery block through the active writer', async () => {
    const server = new FakeManagedSessionStore();
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: server.fetch,
    });
    const handle = await stores.journalStore.open({ sessionKey: SESSION_KEY });

    await handle.blockRecovery?.({
      status: 'BLOCKED_EXECUTION',
      detailCode: 'runtime_execution_outcome_unknown',
    });

    expect(server.recoveryBlocks).toEqual([
      {
        workspaceId: SESSION_KEY.workspaceId,
        writerId: 'harness-a',
        writerGeneration: 1,
        recoveryStatus: 'BLOCKED_EXECUTION',
        recoveryDetailCode: 'runtime_execution_outcome_unknown',
      },
    ]);
    await stores.close();
  });

  it('seals without committing an activation boundary after recovery is blocked', async () => {
    const server = new FakeManagedSessionStore();
    const runtimeBaseDir = await mkdtemp(
      path.join(tmpdir(), 'managed-http-store-blocked-'),
    );
    temporaryDirectories.push(runtimeBaseDir);
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: server.fetch,
    });
    const definitionRef = await stores.resourceStore.publish(
      'managed-session-definition',
      Buffer.from('{"model":"test"}', 'utf8'),
    );
    const rootSnapshotRef = await stores.resourceStore.publish(
      'managed-session-root-snapshot',
      Buffer.from('{"version":1,"messages":[]}', 'utf8'),
    );
    const session = await openManagedSession({
      runtimeBaseDir,
      sessionId: SESSION_KEY.sessionId,
      transcriptPath: path.join(runtimeBaseDir, 'session.jsonl'),
      sessionKey: SESSION_KEY,
      cwd: '/workspace',
      version: 'test',
      workerId: 'harness-a',
      activationLeaseDurationMs: 60_000,
      journalStore: stores.journalStore,
      resourceStore: stores.resourceStore,
      create: {
        definitionRef,
        rootSnapshotRef,
        createdBy: 'test',
      },
    });
    await session.authority.blockRecovery({
      status: 'BLOCKED_EXECUTION',
      detailCode: 'runtime_execution_outcome_unknown',
    });
    const committedBeforeClose = server.commits.length;

    await session.close();

    expect(server.commits).toHaveLength(committedBeforeClose);
    expect(server.sealCount).toBe(1);
  });

  it('does not restart renewal while an in-flight renewal races sealing', async () => {
    vi.useFakeTimers();
    const server = new FakeManagedSessionStore();
    let finishRenewal!: () => void;
    let finishSeal!: () => void;
    const renewalGate = new Promise<void>((resolve) => {
      finishRenewal = resolve;
    });
    const sealGate = new Promise<void>((resolve) => {
      finishSeal = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const response = await server.fetch(input, init);
      if (requestUrl(input).endsWith('/writers:renew')) await renewalGate;
      if (requestUrl(input).endsWith('/writers:seal')) await sealGate;
      return response;
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      leaseDurationMs: 1000,
      fetchFn,
    });
    try {
      await stores.journalStore.open({ sessionKey: SESSION_KEY });
      await vi.advanceTimersByTimeAsync(500);
      expect(
        fetchFn.mock.calls.some(([input]) =>
          requestUrl(input).endsWith('/writers:renew'),
        ),
      ).toBe(true);
      const closing = stores.close();
      finishRenewal();
      await vi.advanceTimersByTimeAsync(0);
      finishSeal();
      await closing;
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/writers:renew'),
        ),
      ).toHaveLength(1);
    } finally {
      finishRenewal();
      finishSeal();
      await stores.close();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('rejects resources that require the unimplemented OSS path', async () => {
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: vi.fn<typeof fetch>(),
    });

    await expect(
      stores.resourceStore.publish(
        'managed-context',
        Buffer.alloc(64 * 1024 + 1),
      ),
    ).rejects.toThrow(/OSS storage is not enabled/);
  });
});

class FakeManagedSessionStore {
  readonly commits: Array<Record<string, unknown>> = [];
  readonly recoveryBlocks: Array<Record<string, unknown>> = [];
  transactionReads = 0;
  sealCount = 0;
  readonly fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(requestUrl(input));
    const headers = new Headers(init?.headers);
    expect(headers.get('X-Qwen-Tenant-Id')).toBe(SESSION_KEY.tenantId);
    expect(headers.get('X-Qwen-Managed-Writer-Token')).toMatch(/^[ab]{32}$/);
    const suffix = url.pathname.slice(
      url.pathname.indexOf('/internal/managed-session-store/v1/sessions/') +
        `/internal/managed-session-store/v1/sessions/${SESSION_KEY.sessionId}`
          .length,
    );
    expect(headers.get('Accept')).toBe(
      suffix.startsWith('/resources/')
        ? 'application/octet-stream, application/json'
        : 'application/json',
    );
    if (suffix === '/writers:acquire') {
      this.writerGeneration++;
      this.state = 'ACTIVE';
      this.leaseUntil = Date.now() + 300_000;
      return jsonResponse(this.grant());
    }
    if (suffix === '/writers:renew') {
      this.leaseUntil = Date.now() + 300_000;
      return jsonResponse(this.grant());
    }
    if (suffix === '/writers:seal') {
      this.sealCount++;
      this.state = 'SEALED';
      return jsonResponse({
        writerGeneration: this.writerGeneration,
        state: 'SEALED',
        replayed: false,
      });
    }
    if (suffix === '/restore') {
      return jsonResponse({
        state: this.state,
        storageVersion: 1,
        writerGeneration: this.writerGeneration,
        journalRevision: this.transactions.length,
        committedSequence: this.committedSequence,
        ...(this.lastCommitDigest === null
          ? {}
          : { lastCommitDigest: this.lastCommitDigest }),
        activationEpoch: this.activationEpoch,
        compactedThroughRevision: 0,
        recoveryStatus: this.recoveryStatus,
        ...(this.recoveryDetailCode === null
          ? {}
          : { recoveryDetailCode: this.recoveryDetailCode }),
      });
    }
    if (suffix === '/recovery:block') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      this.recoveryBlocks.push(body);
      this.recoveryStatus = String(body['recoveryStatus']);
      this.recoveryDetailCode = String(body['recoveryDetailCode']);
      return jsonResponse({
        writerGeneration: this.writerGeneration,
        recoveryStatus: this.recoveryStatus,
        recoveryDetailCode: this.recoveryDetailCode,
        replayed: false,
      });
    }
    if (suffix === '/transactions') {
      this.transactionReads++;
      const after = Number(url.searchParams.get('afterRevision') ?? 0);
      const transactions = this.transactions.slice(after, after + 100);
      return jsonResponse({
        transactions,
        nextRevision: after + transactions.length,
        hasMore: after + transactions.length < this.transactions.length,
      });
    }
    if (suffix === '/transactions:commit') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      this.commits.push(body);
      const resources = body['resources'] as Array<Record<string, unknown>>;
      for (const resource of resources) {
        const resourceId = String(resource['resourceId']);
        const encoded = resource['bytesBase64'];
        if (typeof encoded === 'string') {
          this.resources.set(resourceId, {
            bytes: Buffer.from(encoded, 'base64'),
            kind: String(resource['kind']),
            schemaVersion: Number(resource['schemaVersion']),
            digest: String(resource['digest']),
          });
        } else if (!this.resources.has(resourceId)) {
          return jsonResponse(
            {
              error: {
                code: 'managed_session_resource_missing',
                message: 'A referenced resource is missing.',
              },
            },
            409,
          );
        }
      }
      const journalRevision = this.transactions.length + 1;
      const recordBytes = Buffer.from(
        String(body['recordBytesBase64']),
        'base64',
      );
      this.transactions.push({
        journalRevision,
        transactionId: body['transactionId'],
        operation: body['operation'],
        commandId: body['commandId'],
        contentDigest: body['contentDigest'],
        firstSequence: body['firstSequence'],
        lastSequence: body['lastSequence'],
        eventCount: body['eventCount'],
        eventsDigest: body['eventsDigest'],
        previousCommitDigest: body['previousCommitDigest'],
        commitDigest: body['commitDigest'],
        writerGeneration: body['writerGeneration'],
        activationEpoch: body['activationEpoch'],
        latestCheckpointResourceId: body['latestCheckpointResourceId'],
        recordEncoding: 'identity',
        recordBytesBase64: body['recordBytesBase64'],
        byteLength: recordBytes.byteLength,
        recordDigest: body['recordDigest'],
      });
      this.committedSequence = Number(body['lastSequence']);
      this.lastCommitDigest = (body['commitDigest'] as string | null) ?? null;
      this.activationEpoch = Number(body['activationEpoch']);
      return jsonResponse({
        journalRevision,
        transactionId: body['transactionId'],
        commandId: body['commandId'],
        operation: body['operation'],
        firstSequence: body['firstSequence'],
        lastSequence: body['lastSequence'],
        committedSequence: body['lastSequence'],
        commitDigest: body['commitDigest'],
        replayed: false,
      });
    }
    if (suffix.startsWith('/resources/')) {
      const resourceId = decodeURIComponent(suffix.slice('/resources/'.length));
      const resource = this.resources.get(resourceId);
      if (resource === undefined) {
        return jsonResponse(
          {
            error: {
              code: 'managed_session_resource_not_found',
              message: 'Resource not found.',
            },
          },
          404,
        );
      }
      return new Response(resource.bytes, {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/octet-stream',
          'X-Qwen-Resource-Kind': resource.kind,
          'X-Qwen-Resource-Schema-Version': String(resource.schemaVersion),
          'X-Qwen-Resource-Digest': resource.digest,
        },
      });
    }
    return jsonResponse(
      { error: { code: 'not_found', message: `Unknown ${suffix}` } },
      404,
    );
  });

  private state = 'SEALED';
  private writerGeneration = 0;
  private leaseUntil = 0;
  private committedSequence = 0;
  private lastCommitDigest: string | null = null;
  private activationEpoch = 0;
  private recoveryStatus = 'READY';
  private recoveryDetailCode: string | null = null;
  private readonly transactions: Array<Record<string, unknown>> = [];
  private readonly resources = new Map<
    string,
    {
      bytes: Buffer;
      kind: string;
      schemaVersion: number;
      digest: string;
    }
  >();

  private grant(): Record<string, unknown> {
    return {
      writerGeneration: this.writerGeneration,
      leaseUntil: this.leaseUntil,
      journalRevision: this.transactions.length,
      committedSequence: this.committedSequence,
      ...(this.lastCommitDigest === null
        ? {}
        : { lastCommitDigest: this.lastCommitDigest }),
      activationEpoch: this.activationEpoch,
      replayed: false,
    };
  }
}

function requestUrl(input: URL | RequestInfo): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    },
  });
}
