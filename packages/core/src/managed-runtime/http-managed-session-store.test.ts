/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openManagedSession } from './managed-session-assembly.js';
import { ManagedHookActivationController } from './managed-hook-activation.js';
import {
  ManagedSessionMessageProjection,
  projectManagedSessionRecords,
} from './managed-session-message-projection.js';
import {
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
  createHttpManagedSessionStores,
  readOnlyManagedSessionSnapshot,
} from './http-managed-session-store.js';
import type { McpConfiguration } from './managed-mcp-record.js';
import type { HookExecution, HookRegistration } from './managed-hook-record.js';
import {
  managedSessionEventsDigest,
  parseManagedSessionEvent,
} from './managed-session-records.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from './managed-session-records.js';
import {
  createInitialHarnessCheckpoint,
  encodeHarnessCheckpointV1,
} from './managed-harness-checkpoint.js';

// monitor_run is enabled by H3; the Stage H case below runs ahead of it.
vi.mock('./managed-session-records.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-session-records.js')>();
  return {
    ...actual,
    assertManagedSessionDomainEnabled: (
      domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
    ) => {
      if (domain !== 'monitor_run') {
        actual.assertManagedSessionDomainEnabled(domain);
      }
    },
  };
});

// The Stage H golden case needs the IDs a writer draws to repeat.
const ids = vi.hoisted(() => ({ fixed: false, next: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () =>
      ids.fixed
        ? `00000000-0000-4000-8000-${String(++ids.next).padStart(12, '0')}`
        : actual.randomUUID(),
  };
});

const SESSION_KEY: ManagedSessionKey = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
};
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

describe('HTTP Managed Session store', () => {
  const temporaryDirectories: string[] = [];

  async function createSessionOpener(server: FakeManagedSessionStore) {
    const runtimeBaseDir = await mkdtemp(
      path.join(tmpdir(), 'managed-http-store-'),
    );
    temporaryDirectories.push(runtimeBaseDir);
    const transcriptPath = path.join(runtimeBaseDir, 'session.jsonl');
    return async (writerId: string, writerToken: string) => {
      const stores = createHttpManagedSessionStores({
        baseUrl: 'http://127.0.0.1:8080',
        sessionKey: SESSION_KEY,
        writerId,
        writerToken,
        fetchFn: server.fetch,
      });
      const create =
        writerId === 'harness-a'
          ? {
              definitionRef: await stores.resourceStore.publish(
                'managed-session-definition',
                Buffer.from('{}', 'utf8'),
              ),
              rootSnapshotRef: await stores.resourceStore.publish(
                'managed-session-root-snapshot',
                Buffer.from('{}', 'utf8'),
              ),
              createdBy: 'test',
            }
          : undefined;
      return openManagedSession({
        runtimeBaseDir,
        sessionId: SESSION_KEY.sessionId,
        transcriptPath,
        sessionKey: SESSION_KEY,
        cwd: '/workspace',
        version: 'test',
        workerId: writerId,
        activationLeaseDurationMs: 60_000,
        journalStore: stores.journalStore,
        resourceStore: stores.resourceStore,
        ...(create === undefined ? {} : { create }),
      });
    };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function bootStoresAndSession(
    server: FakeManagedSessionStore,
  ): Promise<{
    stores: ReturnType<typeof createHttpManagedSessionStores>;
    session: Awaited<ReturnType<typeof openManagedSession>>;
  }> {
    const runtimeBaseDir = await mkdtemp(
      path.join(tmpdir(), 'managed-http-store-'),
    );
    temporaryDirectories.push(runtimeBaseDir);
    const transcriptPath = path.join(runtimeBaseDir, 'session.jsonl');
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
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
      transcriptPath,
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
    return { stores, session };
  }

  async function appendMessage(
    session: Awaited<ReturnType<typeof openManagedSession>>,
    index: number,
    contentRef: ManagedSessionDurableRef,
  ): Promise<void> {
    await session.authority.appendExecutionEvent(
      {
        operation: 'message.commit',
        commandId: `m-${index}`,
        sessionKey: SESSION_KEY,
        contentDigest: 'e'.repeat(64),
      },
      (sequence) => ({
        v: 1,
        sequence,
        eventId: `message:m-${index}`,
        sessionKey: SESSION_KEY,
        kind: 'message.committed',
        occurredAt: index,
        subject: {
          type: 'activation',
          scopeId: session.activation.activationId,
          activationId: session.activation.activationId,
          epoch: session.activation.epoch,
        },
        payload: {
          messageId: `m-${index}`,
          role: 'user',
          contentRef,
          parentMessageId: index === 1 ? null : `m-${index - 1}`,
        },
      }),
      {
        class: 'harness',
        activation: session.activation,
      },
    );
  }

  it('verifies committed publication receipts with the scoped Session writer', async () => {
    const server = new FakeManagedSessionStore();
    const request = { executionCallId: 'execution-1', historyRevision: 7 };
    const verified = vi.fn();
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:8080',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: async (input, init) => {
        const url = new URL(requestUrl(input));
        if (!url.pathname.endsWith('/receipts/verify'))
          return server.fetch(input, init);
        verified();
        expect(url.pathname).toBe(
          `/internal/managed-tool-publications/v1/sessions/${SESSION_KEY.sessionId}/receipts/verify`,
        );
        expect(url.searchParams.get('workspaceId')).toBe(
          SESSION_KEY.workspaceId,
        );
        const headers = new Headers(init?.headers);
        expect(headers.get('X-Qwen-Tenant-Id')).toBe(SESSION_KEY.tenantId);
        expect(headers.get('X-Qwen-Managed-Writer-Token')).toBe(TOKEN_A);
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual(request);
        return jsonResponse(request);
      },
    });
    try {
      await stores.journalStore.open({ sessionKey: SESSION_KEY });
      await expect(
        stores.publication.request('/receipts/verify', request),
      ).resolves.toEqual(request);
      expect(verified).toHaveBeenCalledOnce();
      await expect(
        stores.publication.request('/receipts/other', request),
      ).rejects.toThrow('owner path is invalid');
    } finally {
      await stores.close();
    }
  });

  it('refuses plaintext http on non-loopback hosts without an opt-in', () => {
    const options = {
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: (async () => jsonResponse({})) as typeof fetch,
    };
    for (const baseUrl of [
      'http://session-store.test',
      'http://203.0.113.10:8080',
      'http://[fd00::1]:8080',
      'http://127.example.com:8080',
    ]) {
      expect(() =>
        createHttpManagedSessionStores({ ...options, baseUrl }),
      ).toThrow(/plaintext HTTP/);
    }
    for (const baseUrl of [
      'http://127.0.0.1:8080',
      'http://127.1:8080',
      'http://localhost:8080',
      'http://broker.localhost',
      'http://[::1]:8080',
      'https://broker.example.com',
    ]) {
      expect(() =>
        createHttpManagedSessionStores({ ...options, baseUrl }),
      ).not.toThrow();
    }
    expect(() =>
      createHttpManagedSessionStores({
        ...options,
        baseUrl: 'http://session-store.test',
        allowInsecureHttp: true,
      }),
    ).not.toThrow();
  });

  it('publishes bounded tool output immediately under the original writer grant', async () => {
    const server = new FakeManagedSessionStore();
    let publication: Record<string, unknown> | undefined;
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:8080',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: async (input, init) => {
        if (!requestUrl(input).endsWith('/tool-results:publish'))
          return server.fetch(input, init);
        expect(
          new Headers(init?.headers).get('X-Qwen-Managed-Writer-Token'),
        ).toBe(TOKEN_A);
        publication = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const { resourceId, kind, schemaVersion, byteLength, digest } =
          publication;
        return jsonResponse({
          resourceId,
          kind,
          schemaVersion,
          byteLength,
          digest,
        });
      },
    });
    await stores.journalStore.open({ sessionKey: SESSION_KEY });
    try {
      const bytes = Buffer.alloc(1024 * 1024, 0x91);
      const ref = await stores.toolResultResources.publish(
        'managed-tool-result-content',
        bytes,
        'segment-id',
      );
      expect(publication).toMatchObject({
        resourceId: 'segment-id',
        workspaceId: SESSION_KEY.workspaceId,
        writerId: 'harness-a',
        writerGeneration: 1,
        byteLength: bytes.length,
        bytesBase64: bytes.toString('base64'),
      });
      expect(ref.byteLength).toBe(bytes.length);
      expect(server.commits).toHaveLength(0);
      await expect(
        stores.resourceStore.publish('ordinary', bytes),
      ).rejects.toThrow('inline limit');
      await expect(
        stores.toolResultResources.publish('ordinary', bytes),
      ).rejects.toThrow('Unsupported');
      await expect(
        stores.toolResultResources.publish(
          'managed-tool-result-content',
          Buffer.alloc(bytes.length + 1),
        ),
      ).rejects.toThrow('Unsupported');
      await stores.assertWritable();
      expect(
        server.fetch.mock.calls.some(([input]) =>
          requestUrl(input).endsWith('/writers:renew'),
        ),
      ).toBe(true);
    } finally {
      await stores.close();
    }
  });

  it('refuses a changed durable publication receipt rather than staging it', async () => {
    const server = new FakeManagedSessionStore();
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:8080',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: async (input, init) => {
        if (!requestUrl(input).endsWith('/tool-results:publish'))
          return server.fetch(input, init);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          resourceId: 'other',
          kind: body['kind'],
          schemaVersion: 1,
          byteLength: body['byteLength'],
          digest: body['digest'],
        });
      },
    });
    await stores.journalStore.open({ sessionKey: SESSION_KEY });
    try {
      await expect(
        stores.toolResultResources.publish(
          'managed-tool-result-content',
          Buffer.from('bytes'),
          'original',
        ),
      ).rejects.toThrow('different metadata');
      expect(server.commits).toHaveLength(0);
    } finally {
      await stores.close();
    }
  });

  it('retries a busy receipt commit with the original transaction', async () => {
    const server = new FakeManagedSessionStore();
    const runtimeBaseDir = await mkdtemp(
      path.join(tmpdir(), 'managed-http-store-'),
    );
    temporaryDirectories.push(runtimeBaseDir);
    const requests: Array<Record<string, unknown>> = [];
    let outcomeRef: ManagedSessionDurableRef;
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:8080',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: async (input, init) => {
        if (!new URL(requestUrl(input)).pathname.endsWith('/receipts/commit'))
          return server.fetch(input, init);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        if (requests.length === 1)
          return jsonResponse(
            { error: { code: 'managed_tool_publication_busy' } },
            429,
          );
        const committed = await server.fetch(
          `http://127.0.0.1:8080/internal/managed-session-store/v1/sessions/${SESSION_KEY.sessionId}/transactions:commit`,
          init,
        );
        return jsonResponse({
          ...(await committed.json()),
          historyRevision: body['lastSequence'],
          toolOutcomeRef: outcomeRef,
        });
      },
    });
    const definitionRef = await stores.resourceStore.publish(
      'managed-session-definition',
      Buffer.from('{}'),
    );
    const rootSnapshotRef = await stores.resourceStore.publish(
      'managed-session-root-snapshot',
      Buffer.from('{}'),
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
      create: { definitionRef, rootSnapshotRef, createdBy: 'test' },
    });
    try {
      outcomeRef = await session.resources.publish(
        'managed-tool-outcome',
        Buffer.from('{}'),
      );
      stores.publication.rememberAdmission('publication-a', outcomeRef);
      await session.authority.appendExecutionEvent(
        {
          operation: 'recordToolResult',
          commandId: 'receipt-a',
          sessionKey: SESSION_KEY,
          contentDigest: 'a'.repeat(64),
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: 'receipt:a',
          sessionKey: SESSION_KEY,
          kind: 'tool.receipt',
          occurredAt: 1,
          payload: {
            executionCallId: 'execution-a',
            toolOutcomeRef: outcomeRef,
            resultRef: null,
            resources: [],
            historyRevision: sequence,
          },
        }),
        { class: 'trusted_entry' },
      );
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(
        server.commits.filter(
          (commit) => commit['operation'] === 'recordToolResult',
        ),
      ).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it.each([
    'uncommitted-503',
    'lost-commit-response',
    'lost-response-body',
    'permanent-409',
    'exhausted-503',
    'changed-receipt',
    'invalid-json',
  ])(
    'preserves activation transaction identity and failure fencing after %s',
    async (failure) => {
      const server = new FakeManagedSessionStore();
      const runtimeBaseDir = await mkdtemp(
        path.join(tmpdir(), 'managed-http-store-'),
      );
      temporaryDirectories.push(runtimeBaseDir);
      const requests: string[] = [];
      const recoverable =
        failure === 'uncommitted-503' ||
        failure === 'lost-commit-response' ||
        failure === 'lost-response-body';
      let armed = false;
      let replay: unknown;
      const stores = createHttpManagedSessionStores({
        baseUrl: 'http://127.0.0.1:8080',
        sessionKey: SESSION_KEY,
        writerId: 'harness-a',
        writerToken: TOKEN_A,
        fetchFn: async (input, init) => {
          if (armed && requestUrl(input).endsWith('/transactions:commit')) {
            const body = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            if (body['operation'] === 'installActivation') {
              requests.push(String(init?.body));
              if (failure === 'permanent-409' || failure === 'exhausted-503')
                return jsonResponse(
                  { error: { code: 'commit_rejected' } },
                  failure === 'permanent-409' ? 409 : 503,
                );
              if (failure === 'changed-receipt') {
                const receipt = (await (
                  await server.fetch(input, init)
                ).json()) as Record<string, unknown>;
                return jsonResponse({ ...receipt, transactionId: 'different' });
              }
              if (failure === 'invalid-json')
                return new Response('{', {
                  headers: { 'Cache-Control': 'no-store' },
                });
              if (requests.length === 1) {
                if (failure === 'uncommitted-503')
                  return jsonResponse(
                    { error: { code: 'temporary_failure' } },
                    503,
                  );
                replay = await (await server.fetch(input, init)).json();
                if (failure === 'lost-response-body')
                  return new Response(
                    new ReadableStream({
                      start(controller) {
                        controller.error(
                          new TypeError('Response stream terminated'),
                        );
                      },
                    }),
                    { headers: { 'Cache-Control': 'no-store' } },
                  );
                throw new TypeError('Commit response lost');
              }
              armed = false;
              if (replay !== undefined) return jsonResponse(replay);
            }
          }
          return server.fetch(input, init);
        },
      });
      const definitionRef = await stores.resourceStore.publish(
        'managed-session-definition',
        Buffer.from('{}'),
      );
      const rootSnapshotRef = await stores.resourceStore.publish(
        'managed-session-root-snapshot',
        Buffer.from('{}'),
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
        create: { definitionRef, rootSnapshotRef, createdBy: 'test' },
      });
      try {
        armed = true;
        const controller = new ManagedHookActivationController(session);
        const run = vi.fn(async () => 'completed');
        const operation = controller.runHookOperation(
          {
            operationId: 'notification',
            occurrenceId: 'notification',
            originTurnId: null,
          },
          run,
        );
        if (recoverable) {
          await expect(operation).resolves.toBe('completed');
          expect(run).toHaveBeenCalledOnce();
          expect(requests).toHaveLength(2);
          const transaction = JSON.parse(requests[0]) as Record<
            string,
            unknown
          >;
          expect(
            server.commits.filter(
              (commit) =>
                commit['transactionId'] === transaction['transactionId'],
            ),
          ).toHaveLength(1);
          expect(session.authority.writesStopped).toBe(false);
          expect(session.authority.currentActivation).toMatchObject({
            ...session.activation,
            phase: 'active',
            epoch: 3,
          });
          expect(session.authority.currentActivationSubject?.type).not.toBe(
            'hook_operation',
          );
          await expect(
            controller.runTurn('next-turn', async () => 'accepted'),
          ).resolves.toBe('accepted');
        } else {
          await expect(operation).rejects.toThrow('writes stopped');
          expect(run).not.toHaveBeenCalled();
          expect(requests).toHaveLength(failure === 'exhausted-503' ? 3 : 1);
          expect(session.authority.writesStopped).toBe(true);
          await expect(controller.runTurn('next-turn', run)).rejects.toThrow(
            'current Session activation',
          );
        }
        expect(requests.every((body) => body === requests[0])).toBe(true);
      } finally {
        await session.close();
      }
    },
  );

  it('commits staged resources and restores without a local transcript', async () => {
    const server = new FakeManagedSessionStore();
    const runtimeBaseDir = await mkdtemp(
      path.join(tmpdir(), 'managed-http-store-'),
    );
    temporaryDirectories.push(runtimeBaseDir);
    const transcriptPath = path.join(runtimeBaseDir, 'session.jsonl');
    const firstStores = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:8080',
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
      baseUrl: 'http://127.0.0.1:8080',
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

  it('commits Action input before a checkpoint without uploading unrelated staged input', async () => {
    const server = new FakeManagedSessionStore();
    const runtimeBaseDir = await mkdtemp(
      path.join(tmpdir(), 'managed-action-input-'),
    );
    temporaryDirectories.push(runtimeBaseDir);
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: server.fetch,
    });
    const definitionRef = await stores.resourceStore.publish(
      'managed-session-definition',
      Buffer.from('{}'),
    );
    const rootSnapshotRef = await stores.resourceStore.publish(
      'managed-session-root-snapshot',
      Buffer.from('{}'),
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
      create: { definitionRef, rootSnapshotRef, createdBy: 'test' },
    });
    try {
      const inputRef = await session.resources.publish(
        'managed-tool-input',
        Buffer.from('{"input":"approved"}'),
      );
      const unrelated = await session.resources.publish(
        'managed-tool-input',
        Buffer.from('{"input":"unrelated"}'),
      );
      const optionsRef = await session.resources.publish(
        'managed-action-options',
        Buffer.from(JSON.stringify({ v: 2, inputRef })),
      );
      await session.authority.requestToolAction(
        {
          operation: 'requestToolAction',
          commandId: 'approval-first',
          sessionKey: SESSION_KEY,
          contentDigest: 'a'.repeat(64),
        },
        {
          requestId: 'approval-first',
          kind: 'permission',
          inputRevision: 1,
          optionsRef,
        },
        { class: 'harness', activation: session.activation },
      );
      expect(session.authority.latestCheckpoint).toBeUndefined();
      const resources = server.commits.at(-1)!['resources'] as Array<{
        resourceId: string;
        bytesBase64?: string;
      }>;
      expect(resources.map(({ resourceId }) => resourceId).sort()).toEqual(
        [optionsRef.resourceId, inputRef.resourceId].sort(),
      );
      expect(
        resources.find(({ resourceId }) => resourceId === inputRef.resourceId)
          ?.bytesBase64,
      ).toBe(Buffer.from('{"input":"approved"}').toString('base64'));
      expect(
        resources.some(({ resourceId }) => resourceId === unrelated.resourceId),
      ).toBe(false);

      // The read-only snapshot inspector walks the same options -> input edge.
      // Without it the committed input is enumerated but never referenced, so
      // restoring a Session that raised a native approval would fail closed.
      const snapshotResources = new Map<
        string,
        {
          ref: ManagedSessionDurableRef;
          bytesBase64: string;
          referencedRevisions: number[];
        }
      >();
      for (const [index, commit] of server.commits.entries()) {
        for (const raw of commit['resources'] as ManagedSessionDurableRef[]) {
          const ref = {
            resourceId: raw.resourceId,
            kind: raw.kind,
            schemaVersion: raw.schemaVersion,
            byteLength: raw.byteLength,
            digest: raw.digest,
          };
          const resource = snapshotResources.get(ref.resourceId) ?? {
            ref,
            bytesBase64: (await session.resources.read(ref)).toString('base64'),
            referencedRevisions: [],
          };
          resource.referencedRevisions.push(index + 1);
          snapshotResources.set(ref.resourceId, resource);
        }
      }
      const transactions = server.commits.map((commit, index) => ({
        ...commit,
        journalRevision: index + 1,
        recordEncoding: 'identity',
        byteLength: Buffer.from(String(commit['recordBytesBase64']), 'base64')
          .length,
      }));
      const snapshot = readOnlyManagedSessionSnapshot({
        format: 'qwen-csi-receipt-checkpoint-snapshot/1',
        sessionKey: SESSION_KEY,
        head: {
          state: 'ACTIVE',
          storageVersion: 1,
          writerGeneration: 1,
          journalRevision: transactions.length,
          committedSequence: session.authority.committedSequence,
          lastCommitDigest: session.authority.commitProof.committedPrefixHash,
          activationEpoch: session.activation.epoch,
          latestCheckpointResourceId: null,
          compactedThroughRevision: 0,
          recoveryStatus: 'READY',
          recoveryDetailCode: null,
        },
        transactions,
        resources: [...snapshotResources.values()],
      });
      await expect(snapshot.resources.read(inputRef)).resolves.toEqual(
        Buffer.from('{"input":"approved"}'),
      );
      await expect(snapshot.resources.read(unrelated)).rejects.toThrow(
        'Managed Session Store: snapshot resource is missing.',
      );
    } finally {
      await session.close();
    }
  });

  it('commits only checkpoint resources and their dependencies for a cold owner', async () => {
    const server = new FakeManagedSessionStore();
    const runtimeBaseDir = await mkdtemp(
      path.join(tmpdir(), 'managed-http-store-'),
    );

    temporaryDirectories.push(runtimeBaseDir);
    const transcriptPath = path.join(runtimeBaseDir, 'session.jsonl');
    const firstStores = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:8080',
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
    await first.authority.appendExecutionEvent(
      {
        operation: 'referenceOldCheckpoint',
        commandId: 'old-root',
        sessionKey: SESSION_KEY,
        contentDigest: 'd'.repeat(64),
      },
      (sequence) => ({
        v: 1,
        sequence,
        eventId: 'old-root',
        sessionKey: SESSION_KEY,
        kind: 'turn.settled',
        occurredAt: Date.now(),
        subject: {
          type: 'activation',
          scopeId: first.activation.activationId,
          ...first.activation,
        },
        payload: {
          turnId: 'old-root',
          outcome: 'completed',
          stopReason: 'end_turn',
          resultRef: checkpointRef,
          usageRef: null,
          pendingOwnersRef: null,
        },
      }),
      { class: 'harness', activation: first.activation },
    );
    expect(server.commits.at(-1)!['resources']).toEqual([
      {
        ...checkpointRef,
      },
    ]);
    const snapshotResources = new Map<
      string,
      {
        ref: ManagedSessionDurableRef;
        bytesBase64: string;
        referencedRevisions: number[];
      }
    >();
    for (const [index, commit] of server.commits.entries()) {
      for (const raw of commit['resources'] as ManagedSessionDurableRef[]) {
        const ref = {
          resourceId: raw.resourceId,
          kind: raw.kind,
          schemaVersion: raw.schemaVersion,
          byteLength: raw.byteLength,
          digest: raw.digest,
        };
        const resource = snapshotResources.get(ref.resourceId) ?? {
          ref,
          bytesBase64: (await first.resources.read(ref)).toString('base64'),
          referencedRevisions: [],
        };
        resource.referencedRevisions.push(index + 1);
        snapshotResources.set(ref.resourceId, resource);
      }
    }
    const transactions = server.commits.map((commit, index) => ({
      ...commit,
      journalRevision: index + 1,
      recordEncoding: 'identity',
      byteLength: Buffer.from(String(commit['recordBytesBase64']), 'base64')
        .length,
    }));
    const fetchCount = server.fetch.mock.calls.length;
    const snapshot = readOnlyManagedSessionSnapshot({
      format: 'qwen-csi-receipt-checkpoint-snapshot/1',
      sessionKey: SESSION_KEY,
      head: {
        state: 'ACTIVE',
        storageVersion: 1,
        writerGeneration: 1,
        journalRevision: transactions.length,
        committedSequence: first.authority.committedSequence,
        lastCommitDigest: first.authority.commitProof.committedPrefixHash,
        activationEpoch: first.activation.epoch,
        latestCheckpointResourceId: checkpointRef.resourceId,
        compactedThroughRevision: 0,
        recoveryStatus: 'READY',
        recoveryDetailCode: null,
      },
      transactions,
      resources: [...snapshotResources.values()],
    });
    expect((await snapshot.journal.read()).committed).toBe(
      first.authority.committedSequence,
    );
    expect(await snapshot.resources.read(historyRef)).toEqual(historyBytes);
    expect(server.fetch.mock.calls.length).toBe(fetchCount);
    await first.close();

    const secondStores = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:8080',
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
      baseUrl: 'http://127.0.0.1:8080',
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
      baseUrl: 'http://127.0.0.1:8080',
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
      baseUrl: 'http://127.0.0.1:8080',
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
      baseUrl: 'http://127.0.0.1:8080',
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

  it('swallows a renewal the Store fences after its writer sealed', async () => {
    vi.useFakeTimers();
    const server = new FakeManagedSessionStore();
    let finishRenewal!: () => void;
    const renewalGate = new Promise<void>((resolve) => {
      finishRenewal = resolve;
    });
    let fencedRenewals = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const renewal = requestUrl(input).endsWith('/writers:renew');
      if (renewal) await renewalGate;
      const response = await server.fetch(input, init);
      if (renewal && response.status === 409) fencedRenewals++;
      return response;
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      leaseDurationMs: 1000,
      fetchFn,
    });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await stores.journalStore.open({ sessionKey: SESSION_KEY });
      await vi.advanceTimersByTimeAsync(500);
      const closing = stores.close();
      await vi.advanceTimersByTimeAsync(0);
      finishRenewal();
      await closing;
      await vi.advanceTimersByTimeAsync(0);
      expect(fencedRenewals).toBe(1);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      finishRenewal();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retries journal reads through a transport failure and a transient 5xx', async () => {
    const server = new FakeManagedSessionStore();
    const failures = [
      new TypeError('fetch failed'),
      jsonResponse({ error: { code: 'boom', message: 'stored' } }, 503),
    ];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (requestUrl(input).includes('/restore?') && failures.length > 0) {
        const failure = failures.shift()!;
        if (failure instanceof Error) throw failure;
        return failure;
      }
      return server.fetch(input, init);
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn,
    });
    try {
      const handle = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      await handle.read();
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).includes('/restore?'),
        ),
      ).toHaveLength(3);
    } finally {
      await stores.close();
    }
  });

  it.each([500, 502, 503, 504])(
    'recovers a journal read through two transient %i answers',
    async (status) => {
      const server = new FakeManagedSessionStore();
      let dropped = 2;
      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        if (requestUrl(input).includes('/restore?') && dropped > 0) {
          dropped--;
          return jsonResponse(
            { error: { code: 'boom', message: 'stored' } },
            status,
          );
        }
        return server.fetch(input, init);
      });
      const stores = createHttpManagedSessionStores({
        baseUrl: 'http://session-store.test',
        allowInsecureHttp: true,
        sessionKey: SESSION_KEY,
        writerId: 'harness-a',
        writerToken: TOKEN_A,
        fetchFn,
      });
      try {
        const handle = await stores.journalStore.open({
          sessionKey: SESSION_KEY,
        });
        await handle.read();
        expect(
          fetchFn.mock.calls.filter(([input]) =>
            requestUrl(input).includes('/restore?'),
          ),
        ).toHaveLength(3);
      } finally {
        await stores.close();
      }
    },
  );

  it('answers the last consecutive transient read failure with the path and attempt count', async () => {
    const server = new FakeManagedSessionStore();
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (requestUrl(input).includes('/restore?'))
        return jsonResponse(
          { error: { code: 'boom', message: 'stored' } },
          503,
        );
      return server.fetch(input, init);
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn,
    });
    try {
      const handle = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      await expect(handle.read()).rejects.toThrow(ManagedSessionStoreHttpError);
      await expect(handle.read()).rejects.toMatchObject({
        status: 503,
        remoteCode: 'boom',
      });
      await expect(handle.read()).rejects.toThrow(
        /GET \/restore\?[^ ]* failed after 3 attempts/,
      );
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).includes('/restore?'),
        ),
      ).toHaveLength(9);
    } finally {
      await stores.close();
    }
  });

  it('answers the last consecutive transport failure with the path and attempt count', async () => {
    const server = new FakeManagedSessionStore();
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (requestUrl(input).includes('/restore?'))
        throw new TypeError('fetch failed');
      return server.fetch(input, init);
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn,
    });
    try {
      const handle = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      await expect(handle.read()).rejects.toThrow(
        ManagedSessionStoreTransportError,
      );
      await expect(handle.read()).rejects.toThrow(
        /GET \/restore\?[^ ]* failed after 3 attempts/,
      );
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).includes('/restore?'),
        ),
      ).toHaveLength(6);
    } finally {
      await stores.close();
    }
  });

  it('retries a journal read whose response body drops mid-stream', async () => {
    const server = new FakeManagedSessionStore();
    let dropped = true;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (dropped && requestUrl(input).includes('/restore?')) {
        dropped = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"part'));
              controller.error(new TypeError('terminated'));
            },
          }),
          {
            status: 200,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json',
            },
          },
        );
      }
      return server.fetch(input, init);
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn,
    });
    try {
      const handle = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      await handle.read();
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).includes('/restore?'),
        ),
      ).toHaveLength(2);
    } finally {
      await stores.close();
    }
  });

  it('retries a resource read whose response body drops mid-stream', async () => {
    const bytes = Buffer.from('{"captured":true}');
    const ref = {
      resourceId: 'segment-mid-stream',
      kind: 'managed-tool-result-content',
      schemaVersion: 1,
      byteLength: bytes.byteLength,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
    let dropped = true;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith('/writers:acquire'))
        return jsonResponse({
          writerGeneration: 1,
          leaseUntil: Date.now() + 300_000,
          journalRevision: 0,
          committedSequence: 0,
          activationEpoch: 0,
        });
      if (url.endsWith('/writers:seal'))
        return jsonResponse({
          writerGeneration: 1,
          state: 'SEALED',
          replayed: false,
        });
      if (url.includes('/resources/')) {
        if (dropped) {
          dropped = false;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 4));
                controller.error(new TypeError('terminated'));
              },
            }),
            {
              status: 200,
              headers: {
                'Cache-Control': 'no-store',
                'Content-Type': 'application/octet-stream',
              },
            },
          );
        }
        return new Response(bytes, {
          status: 200,
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'application/octet-stream',
            'X-Qwen-Resource-Kind': ref.kind,
            'X-Qwen-Resource-Schema-Version': String(ref.schemaVersion),
            'X-Qwen-Resource-Digest': ref.digest,
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn,
    });
    try {
      await stores.journalStore.open({ sessionKey: SESSION_KEY });
      await expect(stores.resourceStore.read(ref)).resolves.toEqual(bytes);
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).includes('/resources/'),
        ),
      ).toHaveLength(2);
    } finally {
      await stores.close();
    }
  });

  it('blocks a wedged read for no longer than one requestTimeoutMs', async () => {
    const server = new FakeManagedSessionStore();
    const fetchFn = vi.fn<typeof fetch>((input, init) =>
      requestUrl(input).includes('/restore?')
        ? new Promise<Response>((_resolve, reject) => {
            const signal = (init as RequestInit | undefined)?.signal;
            signal?.addEventListener('abort', () =>
              reject(signal.reason as Error),
            );
          })
        : server.fetch(input, init),
    );
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      requestTimeoutMs: 60,
      fetchFn,
    });
    try {
      const handle = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      const started = Date.now();
      await expect(handle.read()).rejects.toThrow(
        ManagedSessionStoreTransportError,
      );
      await expect(handle.read()).rejects.toThrow(/GET \/restore\?/);
      const elapsed = Date.now() - started;
      // One wedged read must settle near one timeout, never three: the
      // deadline-boundary guard races the libuv timer, so a sub-millisecond
      // early abort can add one doomed ~1ms attempt plus backoff; bound the
      // result by the guarantee, not an exact count.
      expect(elapsed).toBeLessThan(900);
      const restores = fetchFn.mock.calls.filter(([input]) =>
        requestUrl(input).includes('/restore?'),
      );
      expect(restores.length).toBeGreaterThanOrEqual(1);
      expect(restores.length).toBeLessThanOrEqual(3);
    } finally {
      await stores.close();
    }
  });

  it('does not retry a read answered with a refusal status', async () => {
    const server = new FakeManagedSessionStore();
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (requestUrl(input).includes('/restore?'))
        return jsonResponse(
          { error: { code: 'managed_session_not_found', message: 'gone' } },
          404,
        );
      return server.fetch(input, init);
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn,
    });
    try {
      const handle = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      await expect(handle.read()).rejects.toThrow(ManagedSessionStoreHttpError);
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).includes('/restore?'),
        ),
      ).toHaveLength(1);
    } finally {
      await stores.close();
    }
  });

  it('retries a lease renewal dropped mid-flight but never a commit', async () => {
    const server = new FakeManagedSessionStore();
    let dropRenew = true;
    let dropBlock = true;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (dropRenew && url.endsWith('/writers:renew')) {
        dropRenew = false;
        throw new TypeError('fetch failed');
      }
      if (dropBlock && url.endsWith('/recovery:block')) {
        dropBlock = false;
        throw new TypeError('fetch failed');
      }
      return server.fetch(input, init);
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn,
    });
    try {
      const handle = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      await stores.assertWritable();
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/writers:renew'),
        ),
      ).toHaveLength(2);
      await expect(
        handle.blockRecovery!({
          status: 'BLOCKED_RESOURCE',
          detailCode: 'managed_session_test',
        }),
      ).rejects.toThrow(ManagedSessionStoreTransportError);
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/recovery:block'),
        ),
      ).toHaveLength(1);
    } finally {
      await stores.close();
    }
  });

  it('commits the resources a Stage H record names and rebuilds it cold', async () => {
    const server = new FakeManagedSessionStore();
    const open = await createSessionOpener(server);
    const first = await open('harness-a', TOKEN_A);
    const commandRef = await first.resources.publish(
      'managed-tool-args',
      Buffer.from('{"command":"tail -f build.log"}', 'utf8'),
    );
    const start = {
      monitorId: 'monitor-1',
      ownerScopeId: 'scope-main',
      commandRef,
      maxEvents: 100,
      idleTimeoutMs: 60_000,
      debounceMs: 0,
      startReceiptRef: null,
      observationSequence: 0,
      lastObservationRef: null,
      notifiedThrough: 0,
      stopReason: null,
      outputRef: null,
      run: {
        state: 'admitted',
        reason: null,
        definition: null,
        executionCallId: 'call-monitor-1',
        effectId: null,
        dispatchId: null,
        deliveryId: null,
        execution: 'intent',
        runtime: null,
        delivery: null,
      },
    };
    const committed = await first.authority.commitExtensionRecord(
      {
        operation: 'commitMonitorRun',
        commandId: 'monitor-1:1',
        sessionKey: SESSION_KEY,
        contentDigest: 'e'.repeat(64),
      },
      { domain: 'monitor_run', record: start },
      { class: 'trusted_entry' },
    );
    // The args are named only inside the body, and still travel with it.
    expect(server.commits.at(-1)?.['resources']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: committed.recordRef.resourceId,
          kind: 'managed-monitor_run',
          bytesBase64: expect.any(String),
        }),
        expect.objectContaining({
          resourceId: commandRef.resourceId,
          bytesBase64: Buffer.from('{"command":"tail -f build.log"}').toString(
            'base64',
          ),
        }),
      ]),
    );
    const mcpTemplate = JSON.parse(
      readFileSync(
        new URL(
          './contracts/managed-mcp-record-v1.fixtures.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).templates.mcp_configuration as McpConfiguration;
    const commitMcp = (commandId: string, record: unknown) =>
      first.authority.commitExtensionRecord(
        {
          operation: 'commitMcpConfiguration',
          commandId,
          sessionKey: SESSION_KEY,
          contentDigest: 'a'.repeat(64),
        },
        { domain: 'mcp_configuration', record },
        { class: 'trusted_entry' },
      );
    await commitMcp('configure-1', mcpTemplate);
    const dispatched = {
      ...mcpTemplate,
      run: {
        ...mcpTemplate.run,
        state: 'running',
        execution: 'dispatch_started',
        runtime: { runtimeBindingId: 'binding', generation: '1' },
      },
    };
    await commitMcp('configure-dispatch', dispatched);
    const catalogRef = await first.resources.publish(
      'mcp-catalog',
      Buffer.from('{"tools":[]}'),
    );
    const configured = {
      ...dispatched,
      catalogRef,
      catalogRevision: 1,
      connectionGeneration: 1,
      run: { ...dispatched.run, state: 'settled', execution: 'settled' },
    };
    await commitMcp('configure-settled', configured);
    expect(server.commits.at(-1)?.['resources']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: catalogRef.resourceId,
          bytesBase64: Buffer.from('{"tools":[]}').toString('base64'),
        }),
      ]),
    );
    const hookTemplates = JSON.parse(
      readFileSync(
        new URL(
          './contracts/managed-hook-record-v1.fixtures.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).templates as {
      hook_registration: HookRegistration;
      hook_execution: HookExecution;
    };
    const registration = { ...hookTemplates.hook_registration, catalogRef };
    const commitHook = (
      commandId: string,
      domain: 'hook_registration' | 'hook_execution',
      record: unknown,
    ) =>
      first.authority.commitExtensionRecord(
        {
          operation: 'commitHookRecord',
          commandId,
          sessionKey: SESSION_KEY,
          contentDigest: 'b'.repeat(64),
        },
        { domain, record },
        { class: 'trusted_entry' },
      );
    for (const state of ['admitted', 'running', 'settled'] as const)
      await commitHook(`register-${state}`, 'hook_registration', {
        ...registration,
        run: { ...registration.run, state },
      });
    const orphanRef = await first.resources.publish(
      'untrusted-user-object',
      Buffer.from('{}'),
    );
    const messageCases = [
      [{ role: 'user', content: 'small snapshot' }],
      [{ role: 'user', content: '😀'.repeat(40_000) }],
    ];
    for (const [index, messages] of messageCases.entries()) {
      const bytes = Buffer.from(JSON.stringify(messages));
      const parts: ManagedSessionDurableRef[] = [];
      if (bytes.length > 60 * 1024) {
        for (let offset = 0; offset < bytes.length; offset += 60 * 1024)
          parts.push(
            await first.resources.publish(
              'managed-hook-message-part',
              bytes.subarray(offset, offset + 60 * 1024),
            ),
          );
      }
      const messagesRef = await first.resources.publish(
        parts.length ? 'managed-hook-message-chunks' : 'managed-hook-messages',
        parts.length ? Buffer.from(JSON.stringify({ parts })) : bytes,
      );
      const planRef = await first.resources.publish(
        'managed-hook-plan',
        Buffer.from(
          JSON.stringify({
            input: { userObject: orphanRef },
            messagesRef,
          }),
        ),
      );
      const executionId = `messages-${index}`;
      await commitHook(executionId, 'hook_execution', {
        ...hookTemplates.hook_execution,
        hookExecutionId: executionId,
        occurrenceId: executionId,
        planRef,
        inputRef: catalogRef,
        onceKey: null,
        run: { ...hookTemplates.hook_execution.run, effectId: executionId },
      });
      const uploaded = server.commits.at(-1)!['resources'] as Array<{
        resourceId: string;
      }>;
      expect(uploaded.map((ref) => ref.resourceId)).toEqual(
        expect.arrayContaining([
          planRef.resourceId,
          messagesRef.resourceId,
          ...parts.map((ref) => ref.resourceId),
        ]),
      );
      expect(uploaded.map((ref) => ref.resourceId)).not.toContain(
        orphanRef.resourceId,
      );
      const snapshotResources = new Map<
        string,
        {
          ref: ManagedSessionDurableRef;
          bytesBase64: string;
          referencedRevisions: number[];
        }
      >();
      for (const [revision, commit] of server.commits.entries()) {
        for (const raw of commit['resources'] as ManagedSessionDurableRef[]) {
          const { resourceId, kind, schemaVersion, byteLength, digest } = raw;
          const ref = { resourceId, kind, schemaVersion, byteLength, digest };
          const resource = snapshotResources.get(resourceId) ?? {
            ref,
            bytesBase64: (await first.resources.read(ref)).toString('base64'),
            referencedRevisions: [],
          };
          resource.referencedRevisions.push(revision + 1);
          snapshotResources.set(resourceId, resource);
        }
      }
      const transactions = server.commits.map((commit, revision) => ({
        ...commit,
        journalRevision: revision + 1,
        recordEncoding: 'identity',
        byteLength: Buffer.from(String(commit['recordBytesBase64']), 'base64')
          .length,
      }));
      const snapshotInput = {
        format: 'qwen-csi-receipt-checkpoint-snapshot/1',
        sessionKey: SESSION_KEY,
        head: {
          state: 'ACTIVE',
          storageVersion: 1,
          writerGeneration: 1,
          journalRevision: transactions.length,
          committedSequence: first.authority.committedSequence,
          lastCommitDigest: first.authority.commitProof.committedPrefixHash,
          activationEpoch: first.activation.epoch,
          latestCheckpointResourceId: null,
          compactedThroughRevision: 0,
          recoveryStatus: 'READY',
          recoveryDetailCode: null,
        },
        transactions,
        resources: [...snapshotResources.values()],
      };
      const snapshot = readOnlyManagedSessionSnapshot(snapshotInput);
      expect((await snapshot.journal.read()).committed).toBe(
        first.authority.committedSequence,
      );
      expect(await snapshot.resources.read(messagesRef)).toEqual(
        await first.resources.read(messagesRef),
      );
      for (const part of parts)
        expect(await snapshot.resources.read(part)).toEqual(
          await first.resources.read(part),
        );
      expect(() =>
        readOnlyManagedSessionSnapshot({
          ...snapshotInput,
          resources: [
            ...snapshotInput.resources,
            {
              ref: orphanRef,
              bytesBase64: Buffer.from('{}').toString('base64'),
              referencedRevisions: [transactions.length],
            },
          ],
        }),
      ).toThrow('snapshot resource enumeration conflicts.');
    }
    const views = first.authority.taskViews();
    expect(views).toHaveLength(1);
    await first.close();

    const restored = await open('harness-b', TOKEN_B);
    expect(restored.authority.taskViews()).toEqual(views);
    expect(
      restored.authority.extensionRecordsInDomain('mcp_configuration')[0],
    ).toMatchObject({
      task: null,
      record: configured,
    });
    expect(await restored.resources.read(catalogRef)).toEqual(
      Buffer.from('{"tools":[]}'),
    );
    expect(
      restored.authority.extensionRecord('monitor_run', 'monitor-1'),
    ).toMatchObject({ revision: 1, recordRef: committed.recordRef });
    for (const [index, messages] of messageCases.entries()) {
      const execution = restored.authority.extensionRecord(
        'hook_execution',
        `messages-${index}`,
      )!.record as HookExecution;
      const plan = JSON.parse(
        (await restored.resources.read(execution.planRef)).toString(),
      ) as { messagesRef: ManagedSessionDurableRef };
      let bytes = await restored.resources.read(plan.messagesRef);
      if (plan.messagesRef.kind === 'managed-hook-message-chunks') {
        const manifest = JSON.parse(bytes.toString()) as {
          parts: ManagedSessionDurableRef[];
        };
        bytes = Buffer.concat(
          await Promise.all(
            manifest.parts.map((ref) => restored.resources.read(ref)),
          ),
        );
      }
      expect(JSON.parse(bytes.toString('utf8'))).toEqual(messages);
    }
    await expect(restored.resources.read(orphanRef)).rejects.toMatchObject({
      status: 404,
    });
    await restored.close();
  });

  it('writes the Stage H transactions that the Java store replays', async () => {
    // ManagedSessionStoreIntegrationTest sends these requests to the Java
    // Session store, which must accept them and project the same tasks.
    const fixture = new URL(
      './contracts/managed-extension-journal-v1.fixtures.json',
      import.meta.url,
    );
    vi.useFakeTimers({ now: 1_790_000_000_000, toFake: ['Date'] });
    ids.fixed = true;
    ids.next = 0;
    try {
      const server = new FakeManagedSessionStore();
      const runtimeBaseDir = await mkdtemp(
        path.join(tmpdir(), 'managed-http-golden-'),
      );
      temporaryDirectories.push(runtimeBaseDir);
      const stores = createHttpManagedSessionStores({
        baseUrl: 'http://127.0.0.1:8080',
        sessionKey: SESSION_KEY,
        writerId: 'harness-a',
        writerToken: TOKEN_A,
        fetchFn: server.fetch,
      });
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
          definitionRef: await stores.resourceStore.publish(
            'managed-session-definition',
            Buffer.from('{}', 'utf8'),
          ),
          rootSnapshotRef: await stores.resourceStore.publish(
            'managed-session-root-snapshot',
            Buffer.from('{}', 'utf8'),
          ),
          createdBy: 'test',
        },
      });
      const command = (commandId: string) => ({
        operation: 'commitMonitorRun',
        commandId,
        sessionKey: SESSION_KEY,
        contentDigest: 'e'.repeat(64),
      });
      const start = {
        monitorId: 'monitor-1',
        ownerScopeId: 'scope-main',
        commandRef: await session.resources.publish(
          'managed-tool-args',
          Buffer.from('{"command":"tail -f build.log"}', 'utf8'),
        ),
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 0,
        startReceiptRef: null,
        observationSequence: 0,
        lastObservationRef: null,
        notifiedThrough: 0,
        stopReason: null,
        outputRef: null,
        run: {
          state: 'admitted',
          reason: null,
          definition: null,
          executionCallId: 'call-monitor-1',
          effectId: null,
          dispatchId: null,
          deliveryId: null,
          execution: 'intent',
          runtime: null,
          delivery: null,
        },
      };
      await session.authority.commitExtensionRecord(
        command('monitor-1:1'),
        { domain: 'monitor_run', record: start },
        { class: 'trusted_entry' },
      );
      vi.setSystemTime(1_790_000_001_000);
      // The second revision also queues a notification, so its transaction
      // holds the record event, the input and the wake.
      await session.authority.commitExtensionRecord(
        command('monitor-1:2'),
        {
          domain: 'monitor_run',
          record: {
            ...start,
            run: {
              ...start.run,
              execution: 'dispatch_started',
              runtime: { runtimeBindingId: 'binding-1', generation: '1' },
            },
          },
          input: {
            inputId: 'monitor-1:notify:1',
            turnId: 'monitor-1:notify:1',
            source: 'monitor',
            contentRef: await session.resources.publish(
              'managed-input',
              Buffer.from('{"text":"build.log changed"}', 'utf8'),
            ),
            deadline: null,
            admissionRef: await session.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            wakeReason: 'input',
          },
        },
        { class: 'trusted_entry' },
      );
      const written = {
        contractVersion: 1,
        sessionKey: SESSION_KEY,
        writerId: 'harness-a',
        commits: server.commits,
        tasks: session.authority.taskViews(),
      };
      await session.close();
      if (process.env['QWEN_WRITE_GOLDEN'] === '1') {
        writeFileSync(fixture, `${JSON.stringify(written, null, 2)}\n`);
      }
      expect(written).toEqual(JSON.parse(readFileSync(fixture, 'utf8')));
    } finally {
      ids.fixed = false;
      vi.useRealTimers();
    }
  });

  it('restores a journal spanning more than one transaction page', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    const messageRef = await stores.resourceStore.publish(
      'managed-message',
      Buffer.from('{"role":"user","parts":[{"text":"hi"}]}', 'utf8'),
    );
    for (let index = 1; index <= 105; index++) {
      await appendMessage(session, index, messageRef);
    }
    const journal = await stores.journalStore.open({ sessionKey: SESSION_KEY });
    const scan = await journal.read();
    expect(scan.committed).toBe(session.authority.committedSequence);
    // 107 transactions over a 100-per-page limit takes two page fetches.
    expect(server.transactionReads).toBe(2);
    await session.close();
  });

  it('rejects a journal whose stored revisions are not contiguous', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    const journal = await stores.journalStore.open({ sessionKey: SESSION_KEY });
    await expect(journal.read()).resolves.toBeDefined();
    server.editStoredTransaction(1, { journalRevision: 42 });
    await expect(journal.read()).rejects.toThrow(/not contiguous/);
    await session.close();
  });

  it('rejects a journal whose transaction bytes do not match their metadata', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    const journal = await stores.journalStore.open({ sessionKey: SESSION_KEY });
    await expect(journal.read()).resolves.toBeDefined();
    server.editStoredTransaction(0, { recordDigest: '0'.repeat(64) });
    await expect(journal.read()).rejects.toThrow(/do not match their metadata/);
    await session.close();
  });

  it.each([
    ['committedSequence', 99],
    ['lastCommitDigest', 'a'.repeat(64)],
    ['activationEpoch', 7],
  ])(
    'rejects a journal that does not match the durable head (%s=%s)',
    async (key, value) => {
      const server = new FakeManagedSessionStore();
      const { stores, session } = await bootStoresAndSession(server);
      const journal = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      await expect(journal.read()).resolves.toBeDefined();
      server.headOverrides[key] = value;
      await expect(journal.read()).rejects.toThrow(
        /do not match the durable head/,
      );
      await session.close();
    },
  );

  it.each([
    ['recoveryStatus', 'BLOCKED_RESOURCE'],
    ['storageVersion', 2],
    ['state', 'SEALED'],
    ['writerGeneration', 2],
    ['compactedThroughRevision', 1],
  ])(
    'rejects a restore head not addressable by this writer (%s=%s)',
    async (key, value) => {
      const server = new FakeManagedSessionStore();
      const { stores, session } = await bootStoresAndSession(server);
      const journal = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      await expect(journal.read()).resolves.toBeDefined();
      server.headOverrides[key] = value;
      await expect(journal.read()).rejects.toThrow(
        /not readable by this v1 writer/,
      );
      await session.close();
    },
  );

  it('rejects stored transaction metadata that disagrees with its records', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    const journal = await stores.journalStore.open({ sessionKey: SESSION_KEY });
    await expect(journal.read()).resolves.toBeDefined();
    // The metadata/records equality runs after the byte/digest check, so a
    // eventsDigest tamper — not a byte tamper — is what reaches it.
    server.editStoredTransaction(0, { eventsDigest: '1'.repeat(64) });
    await expect(journal.read()).rejects.toThrow(
      /metadata does not match its records/,
    );
    await session.close();
  });

  it('rejects when a page reports no more while the head is still ahead', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    await appendMessage(
      session,
      1,
      await stores.resourceStore.publish(
        'managed-message',
        Buffer.from('{"role":"user","parts":[{"text":"hi"}]}', 'utf8'),
      ),
    );
    const journal = await stores.journalStore.open({ sessionKey: SESSION_KEY });
    // A real (non-empty) page that claims to end the journal while the head
    // says otherwise must fail the read, not silently truncate history.
    server.pageOverrides['hasMore'] = false;
    server.headOverrides['journalRevision'] = 99;
    await expect(journal.read()).rejects.toThrow(
      /ended before the journal head/,
    );
    await session.close();
  });

  it('rejects an empty transaction page while the journal head is ahead', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    const journal = await stores.journalStore.open({ sessionKey: SESSION_KEY });
    server.pageOverrides['transactions'] = [];
    await expect(journal.read()).rejects.toThrow(/did not advance the journal/);
    await session.close();
  });

  it('rejects a transaction page whose nextRevision disagrees with itself', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    const journal = await stores.journalStore.open({ sessionKey: SESSION_KEY });
    server.pageOverrides['nextRevision'] = 0;
    await expect(journal.read()).rejects.toThrow(
      /nextRevision is inconsistent/,
    );
    await session.close();
  });

  it('rejects a commit receipt that does not echo the submitted transaction', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    server.receiptOverrides['journalRevision'] = 42;
    const messageRef = await stores.resourceStore.publish(
      'managed-message',
      Buffer.from('{"role":"user","parts":[{"text":"hi"}]}', 'utf8'),
    );
    await expect(appendMessage(session, 1, messageRef)).rejects.toThrow(
      /receipt does not match/,
    );
    // The write-failure latch stops every later write through this authority,
    // including the release close() would commit.
    expect(session.authority.writesStopped).toBe(true);
    await session.close().catch(() => undefined);
  });

  it('surfaces a typed 409 for a resource missing server-side and keeps staged bytes for retry', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    const journal = await stores.journalStore.open({ sessionKey: SESSION_KEY });

    // A staged-but-never-committed body must survive the failed append.
    const retryRef = await stores.resourceStore.publish(
      'managed-message',
      Buffer.from('{"retry":true}', 'utf8'),
    );
    // A staged ref the failed transaction actually carries, so the retry
    // assertion below measures bytes the commit body posts, not just
    // clear() not running.
    const stagedRef = await stores.resourceStore.publish(
      'managed-session_metadata',
      Buffer.from('{"title":"t"}', 'utf8'),
    );
    const missingRef: ManagedSessionDurableRef = {
      resourceId: 'res-never-staged',
      kind: 'managed-session_metadata',
      schemaVersion: 1,
      byteLength: 2,
      digest: createHash('sha256').update('{}').digest('hex'),
    };
    const committedSoFar = session.authority.committedSequence;
    const events = [
      {
        v: 1,
        sequence: committedSoFar + 1,
        eventId: 'domain:missing:1',
        sessionKey: SESSION_KEY,
        kind: 'domain.committed' as const,
        occurredAt: 1,
        payload: {
          domain: 'session_metadata',
          version: 1,
          operationId: 'op-missing',
          recordRef: missingRef,
        },
      },
      {
        v: 1,
        sequence: committedSoFar + 2,
        eventId: 'domain:staged:2',
        sessionKey: SESSION_KEY,
        kind: 'domain.committed' as const,
        occurredAt: 2,
        payload: {
          domain: 'session_metadata',
          version: 1,
          operationId: 'op-staged',
          recordRef: stagedRef,
        },
      },
    ];
    const marker = {
      transactionId: 'txn-missing',
      commandId: 'op-missing',
      operation: 'commitDomainRecord',
      contentDigest: 'f'.repeat(64),
      firstSequence: events[0].sequence,
      lastSequence: events[1].sequence,
      eventCount: 2,
      eventsDigest: managedSessionEventsDigest(
        events.map((event) => parseManagedSessionEvent(event)),
      ),
      previousCommitDigest: session.authority.commitProof.committedPrefixHash,
    };
    const envelope = (
      subtype: string,
      managedSession: unknown,
      uuid: string,
    ) => ({
      uuid,
      parentUuid: null,
      sessionId: SESSION_KEY.sessionId,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'system',
      subtype,
      cwd: '/workspace',
      version: 'test',
      managedSession,
    });
    await expect(
      journal.appendTransaction([
        envelope('managed_session_event_v1', events[0], 'rec-missing-event'),
        envelope('managed_session_event_v1', events[1], 'rec-staged-event'),
        envelope('managed_session_commit_v1', marker, 'rec-missing-marker'),
      ]),
    ).rejects.toMatchObject({
      status: 409,
      remoteCode: 'managed_session_resource_missing',
    } satisfies Partial<ManagedSessionStoreHttpError>);

    // Re-post the same transaction: a failed commit must not release the
    // bytes it carries, or the retry loses them to the same 409 forever.
    await expect(
      journal.appendTransaction([
        envelope('managed_session_event_v1', events[0], 'rec-retry-event'),
        envelope('managed_session_event_v1', events[1], 'rec-retry-event-2'),
        envelope('managed_session_commit_v1', marker, 'rec-retry-marker'),
      ]),
    ).rejects.toMatchObject({ status: 409 });
    const retried = server.commits.at(-1);
    const stagedInRetry = (
      retried?.['resources'] as Array<Record<string, unknown>>
    ).find(
      (resource) => String(resource['resourceId']) === stagedRef.resourceId,
    );
    expect(stagedInRetry?.['bytesBase64']).toBeDefined();

    // The 409 landed before anything committed, so the failed commit released
    // nothing: the head is unmoved and the previously staged body is still
    // readable.
    await expect(journal.read()).resolves.toMatchObject({
      committed: session.authority.committedSequence,
    });
    await expect(stores.resourceStore.read(retryRef)).resolves.toEqual(
      Buffer.from('{"retry":true}', 'utf8'),
    );
    await session.close();
  });

  it('rejects resources that require the unimplemented OSS path', async () => {
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:8080',
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

  it('commits an oversized message as chunks and projects it after a cold reopen', async () => {
    const server = new FakeManagedSessionStore();
    const open = await createSessionOpener(server);
    const first = await open('harness-a', TOKEN_A);
    const record = {
      uuid: 'record-assistant-big',
      parentUuid: null,
      sessionId: SESSION_KEY.sessionId,
      timestamp: '2026-09-22T00:00:00.000Z',
      type: 'assistant' as const,
      cwd: '/workspace',
      version: 'test',
      message: {
        role: 'model' as const,
        parts: [{ text: '长回答'.repeat(25_000) }],
      },
    };
    await new ManagedSessionMessageProjection(
      first.authority,
      first.resources,
    ).commit(
      {
        operation: 'message.commit',
        commandId: 'message-big',
        sessionKey: SESSION_KEY,
        contentDigest: 'c'.repeat(64),
      },
      { record },
      { class: 'harness', activation: first.activation },
    );
    const uploaded = server.commits.at(-1)?.['resources'] as Array<{
      resourceId: string;
      kind: string;
      bytesBase64?: string;
    }>;
    const manifests = uploaded.filter(
      (resource) => resource.kind === 'managed-message-chunks',
    );
    const parts = uploaded.filter(
      (resource) => resource.kind === 'managed-message-part',
    );
    expect(manifests).toHaveLength(1);
    expect(parts.length).toBeGreaterThan(1);
    // Every part travels with the transaction, each under the inline limit.
    for (const part of parts) {
      expect(
        Buffer.from(String(part.bytesBase64), 'base64').byteLength,
      ).toBeLessThanOrEqual(64 * 1024);
    }
    const snapshotResources = new Map<
      string,
      {
        ref: ManagedSessionDurableRef;
        bytesBase64: string;
        referencedRevisions: number[];
      }
    >();
    for (const [index, commit] of server.commits.entries()) {
      for (const raw of commit['resources'] as ManagedSessionDurableRef[]) {
        const { resourceId, kind, schemaVersion, byteLength, digest } = raw;
        const ref = { resourceId, kind, schemaVersion, byteLength, digest };
        const resource = snapshotResources.get(resourceId) ?? {
          ref,
          bytesBase64: (await first.resources.read(ref)).toString('base64'),
          referencedRevisions: [],
        };
        resource.referencedRevisions.push(index + 1);
        snapshotResources.set(resourceId, resource);
      }
    }
    const transactions = server.commits.map((commit, index) => ({
      ...commit,
      journalRevision: index + 1,
      recordEncoding: 'identity',
      byteLength: Buffer.from(String(commit['recordBytesBase64']), 'base64')
        .length,
    }));
    const snapshotInput = {
      format: 'qwen-csi-receipt-checkpoint-snapshot/1',
      sessionKey: SESSION_KEY,
      head: {
        state: 'ACTIVE',
        storageVersion: 1,
        writerGeneration: 1,
        journalRevision: transactions.length,
        committedSequence: first.authority.committedSequence,
        lastCommitDigest: first.authority.commitProof.committedPrefixHash,
        activationEpoch: first.activation.epoch,
        latestCheckpointResourceId: null,
        compactedThroughRevision: 0,
        recoveryStatus: 'READY',
        recoveryDetailCode: null,
      },
      transactions,
      resources: [...snapshotResources.values()],
    };
    const fetchCount = server.fetch.mock.calls.length;
    const snapshot = readOnlyManagedSessionSnapshot(snapshotInput);
    await expect(
      projectManagedSessionRecords({
        scan: await snapshot.journal.read(),
        resources: snapshot.resources,
      }),
    ).resolves.toEqual([record]);
    expect(server.fetch.mock.calls.length).toBe(fetchCount);
    const partId = parts[0].resourceId;
    expect(() =>
      readOnlyManagedSessionSnapshot({
        ...snapshotInput,
        resources: snapshotInput.resources.filter(
          ({ ref }) => ref.resourceId !== partId,
        ),
      }),
    ).toThrow('snapshot resource is missing.');
    expect(() =>
      readOnlyManagedSessionSnapshot({
        ...snapshotInput,
        resources: snapshotInput.resources.map((resource) => {
          if (resource.ref.resourceId !== partId) return resource;
          const bytes = Buffer.from(resource.bytesBase64, 'base64');
          bytes[0] ^= 1;
          return { ...resource, bytesBase64: bytes.toString('base64') };
        }),
      }),
    ).toThrow('snapshot resource bytes conflict.');
    await first.close();

    const second = await open('harness-b', TOKEN_B);
    const projected = await new ManagedSessionMessageProjection(
      second.authority,
      second.resources,
    ).project();
    expect(projected).toEqual([record]);
    await second.close();
  });
});

class FakeManagedSessionStore {
  readonly commits: Array<Record<string, unknown>> = [];
  readonly recoveryBlocks: Array<Record<string, unknown>> = [];
  readonly headOverrides: Record<string, unknown> = {};
  readonly pageOverrides: Record<string, unknown> = {};
  readonly receiptOverrides: Record<string, unknown> = {};
  transactionReads = 0;
  sealCount = 0;

  editStoredTransaction(index: number, patch: Record<string, unknown>): void {
    Object.assign(this.transactions[index]!, patch);
  }

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
      if (this.state === 'SEALED')
        return jsonResponse(
          {
            error: {
              code: 'managed_session_writer_conflict',
              message:
                'The Managed Session writer grant is stale or unavailable.',
            },
          },
          409,
        );
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
        ...this.headOverrides,
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
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const transactions = this.transactions.slice(after, after + limit);
      return jsonResponse({
        transactions,
        nextRevision: after + transactions.length,
        hasMore: after + transactions.length < this.transactions.length,
        ...this.pageOverrides,
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
        ...this.receiptOverrides,
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
