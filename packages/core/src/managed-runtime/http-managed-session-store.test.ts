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
  collectNestedResourceRefs,
  createHttpManagedSessionStores,
  readOnlyManagedSessionSnapshot,
} from './http-managed-session-store.js';
import type { McpConfiguration } from './managed-mcp-record.js';
import type { HookExecution, HookRegistration } from './managed-hook-record.js';
import {
  MANAGED_SESSION_EVENT_SUBTYPE,
  MANAGED_SESSION_HEADER_SUBTYPE,
  managedSessionEventRefs,
  managedSessionEventsDigest,
  parseManagedSessionEvent,
  parseManagedSessionHeader,
} from './managed-session-records.js';
import { ManagedSessionCommitRejectedError } from './managed-session-storage.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from './managed-session-records.js';
import {
  createInitialHarnessCheckpoint,
  encodeHarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import { MANAGED_TOOL_RESULT_KINDS } from './managed-tool-result.js';

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

  it.each(['instructions', 'skills', 'both'])(
    'includes nested %s after the definition leaves the staged transaction closure',
    async (extensions) => {
      const server = new FakeManagedSessionStore();
      const runtimeBaseDir = await mkdtemp(
        path.join(tmpdir(), 'definition-closure-'),
      );
      temporaryDirectories.push(runtimeBaseDir);
      const stores = createHttpManagedSessionStores({
        baseUrl: 'http://127.0.0.1:8080',
        sessionKey: SESSION_KEY,
        writerId: 'harness-a',
        writerToken: TOKEN_A,
        fetchFn: server.fetch,
      });
      const instructionsBytes = Buffer.from('Definition instructions');
      const skillsBytes = Buffer.from(
        JSON.stringify([
          { name: 'review', description: 'Review', body: 'Read the diff.' },
        ]),
      );
      const instructionsRef = await stores.resourceStore.publish(
        'managed-agent-instructions',
        instructionsBytes,
      );
      const skillsRef = await stores.resourceStore.publish(
        'managed-agent-skills',
        skillsBytes,
      );
      const nested = [
        ...(extensions !== 'skills' ? [instructionsRef] : []),
        ...(extensions !== 'instructions' ? [skillsRef] : []),
      ];
      const definitionRef = await stores.resourceStore.publish(
        'managed-definition',
        Buffer.from(
          JSON.stringify({
            engine: 'managed',
            agentDefinition: {
              agentId: `agent_${'a'.repeat(32)}`,
              revision: '1',
              digest: 'b'.repeat(64),
              ...(extensions !== 'skills' ? { instructionsRef } : {}),
              ...(extensions !== 'instructions' ? { skillsRef } : {}),
            },
          }),
        ),
      );
      const rootSnapshotRef = await stores.resourceStore.publish(
        'managed-root',
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
        activationLeaseDurationMs: 60000,
        journalStore: stores.journalStore,
        resourceStore: stores.resourceStore,
        create: { definitionRef, rootSnapshotRef, createdBy: 'test' },
      });
      expect(server.commits[0]?.['resources']).toEqual(
        expect.arrayContaining(
          nested.map((ref) => expect.objectContaining(ref)),
        ),
      );
      const recoveryRef = await session.resources.publish(
        'hosted-model-request',
        Buffer.from(
          JSON.stringify({
            v: 1,
            sessionKey: SESSION_KEY,
            promptId: 'prompt',
            definitionRef,
            rootSnapshotRef,
          }),
        ),
      );
      await session.authority.appendExecutionEvent(
        {
          operation: 'model.attempt',
          commandId: 'model-1',
          sessionKey: SESSION_KEY,
          contentDigest: 'e'.repeat(64),
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: 'model-1',
          sessionKey: SESSION_KEY,
          kind: 'model.attempt',
          occurredAt: Date.now(),
          subject: {
            type: 'activation',
            scopeId: session.activation.activationId,
            ...session.activation,
          },
          payload: {
            attemptId: 'prompt:main:0',
            routeRef: rootSnapshotRef,
            inputCheckpointRef: null,
            state: 'started',
            usageRef: null,
            recoveryRef,
          },
        }),
        { class: 'harness', activation: session.activation },
      );
      expect(server.commits.at(-1)?.['resources']).toEqual(
        expect.arrayContaining([
          expect.objectContaining(definitionRef),
          ...nested.map((ref) => expect.objectContaining(ref)),
        ]),
      );
      for (const ref of [definitionRef, ...nested])
        expect(
          (
            server.commits.at(-1)?.['resources'] as Array<
              Record<string, unknown>
            >
          ).find((entry) => entry['resourceId'] === ref.resourceId),
        ).not.toHaveProperty('bytesBase64');
      await session.close();
      const restored = createHttpManagedSessionStores({
        baseUrl: 'http://127.0.0.1:8080',
        sessionKey: SESSION_KEY,
        writerId: 'harness-b',
        writerToken: TOKEN_B,
        fetchFn: server.fetch,
      });
      await restored.journalStore.open({ sessionKey: SESSION_KEY });
      for (const ref of nested)
        expect(await restored.resourceStore.read(ref)).toEqual(
          ref === instructionsRef ? instructionsBytes : skillsBytes,
        );
    },
  );

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
    requestTimeoutMs?: number,
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
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
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

  it.each([undefined, 1, 2])(
    'requires Store acknowledgement before a bounded retraction (version=%s)',
    async (version) => {
      const server = new FakeManagedSessionStore();
      server.supportedStorageVersion = version;
      const { session } = await bootStoresAndSession(server);
      try {
        const before = server.commits.length;
        const commit = session.authority.appendExecutionEvent(
          {
            operation: 'assistantRetract',
            commandId: 'bounded',
            sessionKey: SESSION_KEY,
            contentDigest: 'a'.repeat(64),
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: 'bounded',
            sessionKey: SESSION_KEY,
            kind: 'message.retracted',
            occurredAt: Date.now(),
            subject: {
              type: 'activation',
              scopeId: session.activation.activationId,
              ...session.activation,
            },
            payload: {
              messageId: 'message',
              turnId: 'turn',
              fromSequence: 1,
              sourceBootId: 'boot',
              sourceEventEpoch: 'epoch',
              throughSequence: 1,
            },
          }),
          { class: 'harness', activation: session.activation },
        );
        if (version === 2) {
          await commit;
          expect(server.commits.length).toBe(before + 1);
        } else {
          await expect(commit).rejects.toThrow(
            'does not support Hosted recovery storage version 2',
          );
          expect(server.commits.length).toBe(before);
        }
      } finally {
        await session.close().catch(() => undefined);
      }
    },
  );

  // A committed message body must be the reader-facing record the cold
  // projection will replay: the commit-time fence refuses anything else.
  const MESSAGE_BODY = Buffer.from(
    JSON.stringify({
      uuid: 'rec-message-1',
      parentUuid: null,
      sessionId: SESSION_KEY.sessionId,
      timestamp: '2026-09-01T10:00:00.000Z',
      type: 'user',
      cwd: '/workspace',
      version: 'test',
      message: { role: 'user', parts: [{ text: 'hi' }] },
    }),
    'utf8',
  );

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
        expect(headers.get('X-Qwen-Managed-Max-Readable-Storage-Version')).toBe(
          '2',
        );
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

  it('scopes lifecycle authorization to the current claim and preserves writer identity', async () => {
    const server = new FakeManagedSessionStore();
    const observed: Array<{
      path: string;
      claim: string | null;
      operation: string | null;
    }> = [];
    const stores = createHttpManagedSessionStores({
      baseUrl: 'https://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: async (input, init) => {
        const url = new URL(requestUrl(input));
        if (!url.pathname.endsWith(':authorize'))
          return server.fetch(input, init);
        const headers = new Headers(init?.headers);
        expect(headers.get('X-Qwen-Managed-Writer-Token')).toBe(TOKEN_A);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          workspaceId: SESSION_KEY.workspaceId,
          writerId: 'harness-a',
          writerGeneration: 1,
        });
        observed.push({
          path: url.pathname.split('/').at(-1)!,
          claim: headers.get('X-Qwen-Lifecycle-Claim-Generation'),
          operation: headers.get('X-Qwen-Lifecycle-Operation-Id'),
        });
        return jsonResponse({});
      },
    });
    try {
      await stores.journalStore.open({ sessionKey: SESSION_KEY });
      stores.setLifecycleAuthority({
        operationId: 'delete-original',
        claimGeneration: 1,
      });
      await stores.authorizeLifecycle('delete');
      stores.setLifecycleAuthority({
        operationId: 'delete-original',
        claimGeneration: 2,
      });
      await stores.authorizeLifecycle();
      stores.setLifecycleAuthority();
      await stores.authorizeOrdinary();
      expect(observed).toEqual([
        {
          path: 'lifecycle:authorize',
          operation: 'delete-original',
          claim: '1',
        },
        {
          path: 'lifecycle:authorize',
          operation: 'delete-original',
          claim: '2',
        },
        { path: 'execution:authorize', operation: null, claim: null },
      ]);
    } finally {
      await stores.close();
    }
  });

  it('authorizes cleanup with the original expired or sealed writer without renewing it', async () => {
    vi.useFakeTimers({ now: 1_790_000_000_000, toFake: ['Date'] });
    const server = new FakeManagedSessionStore();
    const authorize = vi.fn();
    const stores = createHttpManagedSessionStores({
      baseUrl: 'https://session-store.test',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: async (input, init) => {
        const path = new URL(requestUrl(input)).pathname;
        if (path.endsWith('/writers:renew'))
          throw new Error('Original writer lease expired');
        if (path.endsWith('/lifecycle:authorize')) {
          authorize();
          expect(JSON.parse(String(init?.body))).toEqual({
            workspaceId: SESSION_KEY.workspaceId,
            writerId: 'harness-a',
            writerGeneration: 1,
          });
          const headers = new Headers(init?.headers);
          expect(headers.get('X-Qwen-Managed-Writer-Token')).toBe(TOKEN_A);
          expect(headers.get('X-Qwen-Lifecycle-Operation-Id')).toBe(
            'delete-original',
          );
          expect(headers.get('X-Qwen-Lifecycle-Claim-Generation')).toBe('2');
          return jsonResponse({});
        }
        return server.fetch(input, init);
      },
    });
    try {
      await stores.journalStore.open({ sessionKey: SESSION_KEY });
      vi.setSystemTime(1_790_000_400_000);
      stores.setLifecycleAuthority({
        operationId: 'delete-original',
        claimGeneration: 2,
      });
      await stores.authorizeLifecycle();
      expect(authorize).toHaveBeenCalledTimes(1);
      await expect(stores.authorizeLifecycle('delete')).rejects.toThrow(
        'Original writer lease expired',
      );
      expect(authorize).toHaveBeenCalledTimes(1);
      await stores.close();
      await stores.authorizeLifecycle();
      expect(authorize).toHaveBeenCalledTimes(2);
      await expect(stores.authorizeLifecycle('delete')).rejects.toThrow(
        'writer is not active',
      );
      expect(authorize).toHaveBeenCalledTimes(2);
    } finally {
      await stores.close();
      vi.useRealTimers();
    }
  });

  it.each([
    ['ordinary', false],
    ['previous', false],
    ['same', false],
    ['ordinary', true],
  ] as const)(
    'rechecks a changed claim after an in-flight %s renewal (refused=%s)',
    async (previous, refused) => {
      const server = new FakeManagedSessionStore();
      const claims: Array<string | null> = [];
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stores = createHttpManagedSessionStores({
        baseUrl: 'https://session-store.test',
        sessionKey: SESSION_KEY,
        writerId: 'harness-a',
        writerToken: TOKEN_A,
        fetchFn: async (input, init) => {
          if (requestUrl(input).endsWith('/writers:renew')) {
            const headers = new Headers(init?.headers);
            claims.push(headers.get('X-Qwen-Lifecycle-Claim-Generation'));
            if (claims.length === 1) await barrier;
            else if (refused)
              return jsonResponse(
                {
                  error: {
                    code: 'workspace_lifecycle_claim_fenced',
                    message: 'The lifecycle claim is fenced.',
                  },
                },
                409,
              );
          }
          return server.fetch(input, init);
        },
      });
      try {
        await stores.journalStore.open({ sessionKey: SESSION_KEY });
        if (previous !== 'ordinary')
          stores.setLifecycleAuthority({
            operationId: 'delete',
            claimGeneration: previous === 'same' ? 2 : 1,
          });
        const old = stores.assertWritable();
        await vi.waitFor(() => expect(claims).toHaveLength(1));
        stores.setLifecycleAuthority({
          operationId: 'delete',
          claimGeneration: 2,
        });
        const current = stores.assertWritable();
        release();
        await old;
        if (refused)
          await expect(current).rejects.toMatchObject({
            status: 409,
            remoteCode: 'workspace_lifecycle_claim_fenced',
          });
        else await current;
        expect(claims).toEqual(
          previous === 'same'
            ? ['2']
            : [previous === 'ordinary' ? null : '1', '2'],
        );
      } finally {
        release();
        await stores.close();
      }
    },
  );

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
    // The first refusal lands ~200 ms before the shared budget ends. A gate
    // that infers the spend from wall-clock time alone throws here and the
    // second fetch never happens (#13800 R2-2).
    ['a contended refusal near the deadline', 'contended'],
    // A stall that alone burns the whole request budget used to leave the
    // earned restart with an already-expired timeout (#13800 R2-2).
    ['a first attempt that stalls until its deadline', 'stall'],
  ] as const)(
    'restarts a publication commit after %s',
    async (_label, firstAttempt) => {
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
        requestTimeoutMs: 1_200,
        fetchFn: async (input, init) => {
          if (!new URL(requestUrl(input)).pathname.endsWith('/receipts/commit'))
            return server.fetch(input, init);
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          requests.push(body);
          if (requests.length === 1) {
            if (firstAttempt === 'stall') {
              // Never answers: only the request's own timeout ends it.
              await abortableDelay(60_000, init?.signal);
            }
            await abortableDelay(1_000, init?.signal);
            return jsonResponse(
              { error: { code: 'tenant_guard_contended', message: 'held' } },
              503,
            );
          }
          // The restart honours its signal like a real fetch, so one issued
          // with the spent shared deadline as its timeout aborts before this
          // answer arrives.
          await abortableDelay(100, init?.signal);
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
    },
  );

  it.each([
    'uncommitted-503',
    'lost-commit-response',
    'lost-response-body',
    'permanent-409',
    'exhausted-503',
    'changed-receipt',
    'invalid-json',
    'lifecycle-403',
    'lifecycle-409',
    'uncertain-lifecycle-403',
    'ordinary-lifecycle-409',
    'uncertain-ordinary-lifecycle-409',
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
      const refused =
        failure === 'lifecycle-403' ||
        failure === 'lifecycle-409' ||
        failure === 'ordinary-lifecycle-409';
      const ordinaryLifecycle = failure.includes('ordinary-lifecycle-409');
      const uncertainLifecycle =
        failure === 'uncertain-lifecycle-403' ||
        failure === 'uncertain-ordinary-lifecycle-409';
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
              if (ordinaryLifecycle)
                expect(
                  new Headers(init?.headers).has(
                    'X-Qwen-Lifecycle-Operation-Id',
                  ),
                ).toBe(false);
              if (refused || uncertainLifecycle)
                return jsonResponse(
                  {
                    error: {
                      message: 'Lifecycle authorization revoked',
                      code: ordinaryLifecycle
                        ? 'workspace_lifecycle_admission_closed'
                        : failure === 'lifecycle-409'
                          ? 'workspace_lifecycle_authorization_revoked'
                          : 'workspace_access_denied',
                    },
                  },
                  uncertainLifecycle && requests.length === 1
                    ? 503
                    : ordinaryLifecycle || failure === 'lifecycle-409'
                      ? 409
                      : 403,
                );
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
        if ((refused || uncertainLifecycle) && !ordinaryLifecycle)
          stores.setLifecycleAuthority({
            operationId: 'lifecycle',
            claimGeneration: 1,
          });
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
        } else if (refused) {
          await expect(operation).rejects.toThrow();
          expect(run).not.toHaveBeenCalled();
          expect(requests).toHaveLength(2);
          expect(JSON.parse(requests[1])).toMatchObject({
            firstSequence: JSON.parse(requests[0]).firstSequence,
            previousCommitDigest: JSON.parse(requests[0]).previousCommitDigest,
          });
          expect(session.authority.writesStopped).toBe(false);
          armed = false;
          if (ordinaryLifecycle)
            stores.setLifecycleAuthority({
              operationId: 'lifecycle',
              claimGeneration: 1,
            });
          await expect(
            controller.runHookOperation(
              {
                operationId: 'notification-retry',
                occurrenceId: 'notification-retry',
                originTurnId: null,
              },
              run,
            ),
          ).resolves.toBe('completed');
          expect(run).toHaveBeenCalledOnce();
        } else {
          await expect(operation).rejects.toThrow('writes stopped');
          expect(run).not.toHaveBeenCalled();
          expect(requests).toHaveLength(
            failure === 'exhausted-503' ? 3 : uncertainLifecycle ? 2 : 1,
          );
          expect(session.authority.writesStopped).toBe(true);
          await expect(controller.runTurn('next-turn', run)).rejects.toThrow(
            'current Session activation',
          );
        }
        if (!refused)
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
    // The turn.settled fence reads the result body back, so the event must
    // carry a genuine reader-facing record; the old checkpoint rides in
    // pendingOwnersRef to prove a later commit ships a previously committed
    // resource.
    const turnResultRef = await first.resources.publish(
      'managed-turn-result',
      Buffer.from(
        JSON.stringify({
          uuid: 'record-turn-old-root',
          parentUuid: null,
          sessionId: SESSION_KEY.sessionId,
          timestamp: '2026-09-22T00:00:01.000Z',
          type: 'system',
          subtype: 'turn_result',
          cwd: '/workspace',
          version: 'test',
          systemPayload: {
            promptId: 'old-root',
            state: 'completed',
            stopReason: 'end_turn',
          },
        }),
        'utf8',
      ),
    );
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
          resultRef: turnResultRef,
          usageRef: null,
          pendingOwnersRef: checkpointRef,
        },
      }),
      { class: 'harness', activation: first.activation },
    );
    const referencedResources = server.commits.at(-1)!['resources'] as Array<{
      resourceId: string;
    }>;
    // The settled Turn carries the checkpoint, the checkpoint's own api
    // history dependency, and the payload-referenced result record a cold
    // projection replays.
    expect(
      referencedResources.map(({ resourceId }) => resourceId).sort(),
    ).toEqual(
      [
        checkpointRef.resourceId,
        historyRef.resourceId,
        turnResultRef.resourceId,
      ].sort(),
    );
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
            request_id: 'request-2',
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
    expect((error as ManagedSessionStoreHttpError).details).toEqual({
      request_id: 'request-2',
    });
    expect(String(error)).not.toContain(TOKEN_A);
  });

  it('carries the scalar fields of a publication refusal envelope', async () => {
    const server = new FakeManagedSessionStore();
    let grants = 0;
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:8080',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: async (input, init) => {
        if (!new URL(requestUrl(input)).pathname.endsWith('/grants'))
          return server.fetch(input, init);
        if (++grants === 1)
          return jsonResponse(
            { error: { code: 'invalid_request', message: 'invalid' } },
            400,
          );
        return jsonResponse(
          {
            error: {
              code: 'managed_tool_publication_capacity_exhausted',
              message:
                'Tool publication reservation refused at the active_captures limit',
              request_id: 'request-1',
              limit: 'active_captures',
              admits: 2,
              retryable: false,
              nested: { admits: 9 },
              list: [9],
              missing: null,
            },
          },
          429,
        );
      },
    });
    try {
      await stores.journalStore.open({ sessionKey: SESSION_KEY });
      // An envelope with nothing beyond its code and message has no details.
      const invalid = await stores.publication
        .request('/grants', { operation: 'reserve' })
        .catch((cause: unknown) => cause);
      expect(invalid).toMatchObject({
        status: 400,
        remoteCode: 'invalid_request',
      });
      expect((invalid as ManagedSessionStoreHttpError).details).toBeUndefined();
      const error = await stores.publication
        .request('/grants', { operation: 'reserve' })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ManagedSessionStoreHttpError);
      expect(error).toMatchObject<Partial<ManagedSessionStoreHttpError>>({
        status: 429,
        remoteCode: 'managed_tool_publication_capacity_exhausted',
        message:
          'Tool publication reservation refused at the active_captures limit',
      });
      expect((error as ManagedSessionStoreHttpError).details).toEqual({
        request_id: 'request-1',
        limit: 'active_captures',
        admits: 2,
        retryable: false,
      });
    } finally {
      await stores.close();
    }
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

  it.each(['uncommitted-503', 'lost-ack'])(
    'recovers activation renewal after its HTTP retry budget is exhausted (%s)',
    async (failure) => {
      vi.useFakeTimers({ now: 1_790_000_000_000 });
      const server = new FakeManagedSessionStore();
      const originalFetch = server.fetch.getMockImplementation()!;
      const failedRequests: string[] = [];
      let unavailable = false;
      let lostReceipt: unknown;
      server.fetch.mockImplementation(async (input, init) => {
        if (/\/transactions:commit(?:-v2)?$/.test(requestUrl(input))) {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          if (body['operation'] === 'renewActivation' && unavailable) {
            failedRequests.push(String(init?.body));
            if (failure === 'lost-ack') {
              lostReceipt ??= await (await originalFetch(input, init)).json();
              throw new TypeError('Activation commit acknowledgement lost');
            }
            return jsonResponse(
              {
                error: {
                  code: 'store_unavailable',
                  message: 'temporary outage',
                },
              },
              503,
            );
          }
          if (
            lostReceipt !== undefined &&
            String(init?.body) === failedRequests[0]
          ) {
            return jsonResponse(lostReceipt);
          }
        }
        return originalFetch(input, init);
      });
      const { stores, session } = await bootStoresAndSession(server);
      try {
        const originalActivation = session.authority.currentActivation!;
        const contentRef = await stores.resourceStore.publish(
          'managed-input',
          Buffer.from('after-transient-outage'),
        );
        unavailable = true;
        await vi.advanceTimersByTimeAsync(21_000);
        expect(failedRequests).toHaveLength(3);
        expect(new Set(failedRequests).size).toBe(1);
        unavailable = false;
        await vi.advanceTimersByTimeAsync(44_000);
        const outcome = await session.authority
          .submitInput(
            {
              operation: 'submitInput',
              commandId: 'after-transient-outage',
              sessionKey: SESSION_KEY,
              contentDigest: createHash('sha256')
                .update('after-transient-outage')
                .digest('hex'),
            },
            {
              inputId: 'after-transient-outage',
              turnId: 'after-transient-outage',
              source: 'web_shell',
              contentRef,
              deadline: null,
              admissionRef: contentRef,
              wakeReason: 'input',
            },
          )
          .then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({
              value: undefined,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        const observation = {
          failure,
          failedActivationRequests: failedRequests.length,
          writerRenewals: server.renewCount,
          writesStopped: session.authority.writesStopped,
          activationIdUnchanged:
            session.authority.currentActivation?.activationId ===
            originalActivation.activationId,
          originalActivationExpiry: originalActivation.expiresAt,
          currentActivationExpiry:
            session.authority.currentActivation?.expiresAt,
          now: Date.now(),
          inputAccepted: session.authority
            .readEvents()
            .filter(
              (event) =>
                event.kind === 'input.accepted' &&
                event.payload['inputId'] === 'after-transient-outage',
            ).length,
          submitError: outcome.error,
        };
        console.info('ACTIVATION_RENEWAL_OUTAGE_OBSERVATION', observation);
        expect(server.renewCount).toBeGreaterThan(0);
        expect(observation).toMatchObject({
          writesStopped: false,
          activationIdUnchanged: true,
          inputAccepted: 1,
          submitError: undefined,
        });
        expect(observation.currentActivationExpiry).toBeGreaterThan(
          observation.now,
        );
        expect(outcome.value).toMatchObject({ replayed: false });
        const transaction = JSON.parse(failedRequests[0]) as Record<
          string,
          unknown
        >;
        expect(
          server.commits.filter(
            (commit) => commit['commandId'] === transaction['commandId'],
          ),
        ).toEqual([transaction]);
      } finally {
        await session.close().catch(() => undefined);
        await stores.close().catch(() => undefined);
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it('does not reopen a spent tenant guard budget for activation renewal', async () => {
    const startedAt = 1_790_000_000_000;
    vi.useFakeTimers({ now: startedAt });
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server, 1200);
    const originalFetch = server.fetch.getMockImplementation()!;
    const attempts: Array<{ at: number; body: string }> = [];
    const renewal = vi.spyOn(session.authority, 'renewActivation');
    server.fetch.mockImplementation(async (input, init) => {
      if (/\/transactions:commit(?:-v2)?$/.test(requestUrl(input))) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body['operation'] === 'renewActivation') {
          attempts.push({ at: Date.now(), body: String(init?.body) });
          return jsonResponse(
            { error: { code: 'tenant_guard_contended', message: 'held' } },
            503,
          );
        }
      }
      return originalFetch(input, init);
    });
    try {
      await vi.advanceTimersByTimeAsync(22_000);
      await expect(renewal.mock.results[0]?.value).rejects.toMatchObject({
        status: 503,
        remoteCode: 'tenant_guard_contended',
        contentionExhausted: true,
      });
      expect(session.authority.writesStopped).toBe(true);
      expect(attempts.length).toBeGreaterThan(3);
      expect(attempts.length).toBeLessThanOrEqual(6);
      expect(new Set(attempts.map((attempt) => attempt.body)).size).toBe(1);
      expect(attempts.at(-1)!.at - (startedAt + 20_000)).toBeLessThanOrEqual(
        1200,
      );
      const spentAttempts = attempts.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(attempts).toHaveLength(spentAttempts);
      expect(server.renewCount).toBe(0);
      expect(server.sealCount).toBe(0);
      expect(
        server.fetch.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/writers:acquire'),
        ),
      ).toHaveLength(1);
    } finally {
      await stores.close().catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1000);
      await session.close().catch(() => undefined);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(['slow-first-guard', 'timeout-then-guard'])(
    'does not restart activation contention without an internal guard retry (%s)',
    async (failure) => {
      const startedAt = 1_790_000_000_000;
      vi.useFakeTimers({ now: startedAt });
      const server = new FakeManagedSessionStore();
      const originalFetch = server.fetch.getMockImplementation()!;
      const attempts: Array<{ at: number; body: string }> = [];
      server.fetch.mockImplementation(async (input, init) => {
        const url = requestUrl(input);
        if (/\/transactions:commit(?:-v2)?$/.test(url)) {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          if (body['operation'] === 'renewActivation') {
            attempts.push({ at: Date.now(), body: String(init?.body) });
            if (failure === 'slow-first-guard') {
              await new Promise((resolve) => setTimeout(resolve, 1100));
            } else if (attempts.length === 1) {
              await new Promise((resolve) => setTimeout(resolve, 1200));
              throw new DOMException('request budget elapsed', 'TimeoutError');
            }
            return jsonResponse(
              { error: { code: 'tenant_guard_contended', message: 'held' } },
              503,
            );
          }
        }
        const response = await originalFetch(input, init);
        if (/\/writers:(?:acquire|renew)$/.test(url)) {
          return jsonResponse({
            ...(await response.json()),
            leaseUntil: Date.now() + 60_000,
          });
        }
        return response;
      });
      const { stores, session } = await bootStoresAndSession(server, 1200);
      const renewal = vi.spyOn(session.authority, 'renewActivation');
      try {
        await vi.advanceTimersByTimeAsync(24_000);
        const after24s = {
          attempts: attempts.length,
          writesStopped: session.authority.writesStopped,
        };
        await vi.advanceTimersByTimeAsync(41_000);
        console.info('ACTIVATION_CONTENTION_WITHOUT_GUARD_RETRY', {
          failure,
          after24s,
          totalAttempts: attempts.length,
          firstAttemptMs: attempts[0]!.at - startedAt,
          lastAttemptMs: attempts.at(-1)!.at - startedAt,
          writesStopped: session.authority.writesStopped,
        });
        await expect(renewal.mock.results[0]?.value).rejects.toMatchObject({
          status: 503,
          remoteCode: 'tenant_guard_contended',
        });
        expect.soft(after24s.writesStopped).toBe(true);
        expect
          .soft(attempts.length)
          .toBe(failure === 'slow-first-guard' ? 1 : 2);
        expect(new Set(attempts.map((attempt) => attempt.body)).size).toBe(1);
        expect(
          server.fetch.mock.calls.filter(([input]) =>
            requestUrl(input).endsWith('/writers:acquire'),
          ),
        ).toHaveLength(1);
        expect(server.sealCount).toBe(0);
      } finally {
        await stores.close().catch(() => undefined);
        await vi.advanceTimersByTimeAsync(2000);
        await session.close().catch(() => undefined);
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it('preserves a newer writer lease when a delayed activation commit returns', async () => {
    const startedAt = 1_790_000_000_000;
    vi.useFakeTimers({ now: startedAt });
    const server = new FakeManagedSessionStore();
    const originalFetch = server.fetch.getMockImplementation()!;
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let waiting = false;
    server.fetch.mockImplementation(async (input, init) => {
      if (/\/transactions:commit(?:-v2)?$/.test(requestUrl(input))) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body['operation'] === 'renewActivation') {
          waiting = true;
          await commitGate;
        }
      }
      return originalFetch(input, init);
    });
    const { stores, session } = await bootStoresAndSession(server);
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(waiting).toBe(true);
      expect(server.renewCount).toBe(0);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(server.renewCount).toBe(1);
      releaseCommit();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.authority.writesStopped).toBe(false);
      expect(session.authority.currentActivation?.renewalSeq).toBe(1);
      expect(
        server.commits.filter(
          (commit) => commit['operation'] === 'renewActivation',
        ),
      ).toHaveLength(1);
      // The initial lease expired at +300s; the concurrent renewal granted
      // +330s. A read at +305s must use that newer grant without renewing.
      vi.setSystemTime(startedAt + 305_000);
      const journal = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      await journal.read();
      expect(server.renewCount).toBe(1);
      expect(
        server.fetch.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/writers:acquire'),
        ),
      ).toHaveLength(1);
      const renewals = server.fetch.mock.calls.filter(([input]) =>
        requestUrl(input).endsWith('/writers:renew'),
      );
      expect(
        renewals.map(([, init]) => JSON.parse(String(init?.body))),
      ).toMatchObject([{ writerId: 'harness-a', writerGeneration: 1 }]);
    } finally {
      releaseCommit();
      await session.close().catch(() => undefined);
      await stores.close().catch(() => undefined);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(['grant-expired', 'permanent-fence'])(
    'stops writer keepalive after activation append fails (%s)',
    async (failure) => {
      vi.useFakeTimers({ now: 1_790_000_000_000 });
      const server = new FakeManagedSessionStore();
      const originalFetch = server.fetch.getMockImplementation()!;
      let activationRequests = 0;
      server.fetch.mockImplementation(async (input, init) => {
        const url = requestUrl(input);
        if (/\/transactions:commit(?:-v2)?$/.test(url)) {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          if (body['operation'] === 'renewActivation') {
            activationRequests++;
            return jsonResponse(
              {
                error: {
                  code:
                    failure === 'grant-expired'
                      ? 'store_unavailable'
                      : 'managed_session_writer_conflict',
                  message: failure,
                },
              },
              failure === 'grant-expired' ? 503 : 409,
            );
          }
        }
        const response = await originalFetch(input, init);
        if (url.endsWith('/writers:acquire')) {
          return jsonResponse({
            ...(await response.json()),
            leaseUntil: Date.now() + 50_000,
          });
        }
        return response;
      });
      const { stores, session } = await bootStoresAndSession(server);
      try {
        await vi.advanceTimersByTimeAsync(21_000);
        expect(session.authority.writesStopped).toBe(
          failure === 'permanent-fence',
        );
        await vi.advanceTimersByTimeAsync(34_000);
        expect(session.authority.writesStopped).toBe(true);
        expect(server.renewCount).toBe(failure === 'grant-expired' ? 1 : 0);
        expect(activationRequests).toBeGreaterThanOrEqual(
          failure === 'grant-expired' ? 3 : 1,
        );
        const stoppedAt = {
          renewals: server.renewCount,
          activationRequests,
        };
        await vi.advanceTimersByTimeAsync(90_000);
        expect(server.renewCount).toBe(stoppedAt.renewals);
        expect(activationRequests).toBe(stoppedAt.activationRequests);
        expect(
          server.fetch.mock.calls.filter(([input]) =>
            requestUrl(input).endsWith('/writers:acquire'),
          ),
        ).toHaveLength(1);
        expect(server.sealCount).toBe(0);
        expect(server.state).toBe('ACTIVE');
      } finally {
        await stores.close().catch(() => undefined);
        await vi.advanceTimersByTimeAsync(1000);
        await session.close().catch(() => undefined);
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it('keeps writer renewal after a rollbackable append rejection', async () => {
    vi.useFakeTimers({ now: 1_790_000_000_000 });
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    const originalFetch = server.fetch.getMockImplementation()!;
    let refused = false;
    server.fetch.mockImplementation(async (input, init) => {
      if (/\/transactions:commit(?:-v2)?$/.test(requestUrl(input))) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body['operation'] === 'message.commit' && !refused) {
          refused = true;
          return jsonResponse(
            {
              error: {
                code: 'workspace_lifecycle_admission_closed',
                message: 'temporarily held by lifecycle',
              },
            },
            409,
          );
        }
      }
      return originalFetch(input, init);
    });
    try {
      const messageRef = await stores.resourceStore.publish(
        'managed-message',
        MESSAGE_BODY,
      );
      await expect(appendMessage(session, 1, messageRef)).rejects.toThrow(
        ManagedSessionCommitRejectedError,
      );
      expect(session.authority.writesStopped).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(server.renewCount).toBe(1);
      await appendMessage(session, 2, messageRef);
      expect(session.authority.writesStopped).toBe(false);
      expect(
        server.commits.filter(
          (commit) => commit['operation'] === 'message.commit',
        ),
      ).toHaveLength(1);
      expect(
        server.fetch.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/writers:acquire'),
        ),
      ).toHaveLength(1);
      expect(server.sealCount).toBe(0);
    } finally {
      await session.close().catch(() => undefined);
      await stores.close().catch(() => undefined);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('stops activation retries when its writer is explicitly sealed', async () => {
    vi.useFakeTimers({ now: 1_790_000_000_000 });
    const server = new FakeManagedSessionStore();
    const originalFetch = server.fetch.getMockImplementation()!;
    let activationRequests = 0;
    server.fetch.mockImplementation(async (input, init) => {
      if (/\/transactions:commit(?:-v2)?$/.test(requestUrl(input))) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body['operation'] === 'renewActivation') {
          activationRequests++;
          return jsonResponse(
            { error: { code: 'store_unavailable', message: 'outage' } },
            503,
          );
        }
      }
      return originalFetch(input, init);
    });
    const { stores, session } = await bootStoresAndSession(server);
    try {
      await vi.advanceTimersByTimeAsync(21_000);
      expect(activationRequests).toBe(3);
      expect(session.authority.writesStopped).toBe(false);
      await stores.close();
      expect(server.sealCount).toBe(1);
      expect(server.state).toBe('SEALED');
      await vi.advanceTimersByTimeAsync(90_000);
      expect(activationRequests).toBe(3);
      expect(session.authority.writesStopped).toBe(true);
      expect(server.renewCount).toBe(0);
      expect(
        server.fetch.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/writers:acquire'),
        ),
      ).toHaveLength(1);
    } finally {
      await session.close().catch(() => undefined);
      await stores.close().catch(() => undefined);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'keeps background renewal after an outage (request retries exhausted=%s)',
    async (exhausted) => {
      vi.useFakeTimers();
      const server = new FakeManagedSessionStore();
      let unavailable = true;
      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        if (requestUrl(input).endsWith('/writers:renew') && unavailable) {
          return jsonResponse(
            {
              error: { code: 'store_unavailable', message: 'temporary outage' },
            },
            503,
          );
        }
        return server.fetch(input, init);
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
        if (exhausted) await vi.advanceTimersByTimeAsync(1000);
        expect(
          fetchFn.mock.calls.filter(([input]) =>
            requestUrl(input).endsWith('/writers:renew'),
          ).length,
        ).toBeGreaterThanOrEqual(exhausted ? 3 : 1);
        unavailable = false;
        await vi.advanceTimersByTimeAsync(1500);
        expect(server.renewCount).toBeGreaterThan(0);
      } finally {
        await stores.close();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each([403, 409])(
    'does not retry a refused writer renewal (%s)',
    async (status) => {
      vi.useFakeTimers();
      const server = new FakeManagedSessionStore();
      const fetchFn = vi.fn<typeof fetch>(async (input, init) =>
        requestUrl(input).endsWith('/writers:renew')
          ? jsonResponse(
              { error: { code: 'writer_refused', message: 'refused' } },
              status,
            )
          : server.fetch(input, init),
      );
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
        await vi.advanceTimersByTimeAsync(10_000);
        expect(
          fetchFn.mock.calls.filter(([input]) =>
            requestUrl(input).endsWith('/writers:renew'),
          ),
        ).toHaveLength(1);
      } finally {
        await stores.close();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it('stops outage retries when the original writer grant expires', async () => {
    vi.useFakeTimers();
    const server = new FakeManagedSessionStore();
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/writers:renew')) {
        return jsonResponse(
          { error: { code: 'store_unavailable', message: 'outage' } },
          503,
        );
      }
      const response = await server.fetch(input, init);
      if (url.endsWith('/writers:acquire')) {
        return jsonResponse({
          ...(await response.json()),
          leaseUntil: Date.now() + 2000,
        });
      }
      return response;
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:8080',
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      leaseDurationMs: 1000,
      requestTimeoutMs: 100,
      fetchFn,
    });
    try {
      await stores.journalStore.open({ sessionKey: SESSION_KEY });
      await vi.advanceTimersByTimeAsync(5000);
      const renewals = fetchFn.mock.calls.filter(([input]) =>
        requestUrl(input).endsWith('/writers:renew'),
      ).length;
      expect(renewals).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/writers:renew'),
        ),
      ).toHaveLength(renewals);
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/writers:acquire'),
        ),
      ).toHaveLength(1);
    } finally {
      await stores.close();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('stops locally by joining renewal without sealing or losing staged resources', async () => {
    vi.useFakeTimers();
    const server = new FakeManagedSessionStore();
    let finishRenewal!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishRenewal = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const response = await server.fetch(input, init);
      if (requestUrl(input).endsWith('/writers:renew')) await gate;
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
      const bytes = Buffer.from('{"retained":true}');
      const ref = await stores.resourceStore.publish('managed-input', bytes);
      await vi.advanceTimersByTimeAsync(500);
      let joined = false;
      const stopped = stores.stopLocal().then(() => {
        joined = true;
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(joined).toBe(false);
      finishRenewal();
      await stopped;
      await vi.advanceTimersByTimeAsync(5000);
      await expect(stores.assertWritable()).rejects.toThrow('locally stopped');
      await expect(stores.close()).rejects.toThrow('locally stopped');
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/writers:renew'),
        ),
      ).toHaveLength(1);
      expect(server.sealCount).toBe(0);
      expect(await stores.resourceStore.read(ref)).toEqual(bytes);
    } finally {
      finishRenewal();
      await stores.stopLocal();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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

  // Regression for R1-38: a failed close-time seal must not keep the grant
  // on the renewal cadence. The backend re-issues the same writer generation
  // to a same-credential re-acquire during a live lease (the replay branch in
  // ManagedSessionStore.acquireWriter), so a stale client still renewing
  // would seal the journal out from under the freshly re-attached session.
  // The grant simply lapses; a later close() still retries the seal, which
  // the backend accepts without a live lease.
  it('lets a same-credential re-attach keep writing after a close-time seal failure', async () => {
    vi.useFakeTimers();
    const server = new FakeManagedSessionStore();
    const options = {
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: server.fetch,
    } as const;
    const first = createHttpManagedSessionStores(options);
    const second = createHttpManagedSessionStores(options);
    try {
      await first.journalStore.open({ sessionKey: SESSION_KEY });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(server.renewCount).toBe(1);

      server.sealFailuresRemaining = 1;
      await expect(first.close()).rejects.toThrow('backend down');
      expect(server.sealCount).toBe(1);
      expect(server.state).toBe('ACTIVE');
      // `first` is the only writer in this window, so any renewal here is
      // the failed close's cadence surviving; the later assertions cannot
      // see it, because both stores share one writer identity (review round
      // 2, R2-10).
      await vi.advanceTimersByTimeAsync(60_000);
      expect(server.renewCount).toBe(1);

      // The broker redrives the attach with byte-identical credentials; the
      // backend replays the live lease and hands over the same generation.
      const secondJournal = await second.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      expect(server.replayedGrants).toBe(1);

      // No renewal cadence survives the failed close: nothing seals the
      // journal from the stale client while the re-attached one works.
      await vi.advanceTimersByTimeAsync(400_000);
      expect(server.sealCount).toBe(1);
      expect(server.state).toBe('ACTIVE');
      await expect(secondJournal.read()).resolves.toBeDefined();

      // The lapsed grant stays sealable by its own writer, so a caller that
      // retries close() still converges the journal to SEALED.
      await first.close();
      expect(server.state).toBe('SEALED');
    } finally {
      await first.close().catch(() => undefined);
      await second.close().catch(() => undefined);
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
          { error: { code: 'boom', message: 'stored', request_id: 'r-3' } },
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
        details: { request_id: 'r-3' },
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

  it('keeps retrying a contended tenant guard past the attempt cap within one request budget', async () => {
    const server = new FakeManagedSessionStore();
    let contended = 5;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (requestUrl(input).includes('/restore?') && contended > 0) {
        contended--;
        return jsonResponse(
          { error: { code: 'tenant_guard_contended', message: 'held' } },
          503,
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
      await expect(handle.read()).resolves.toBeDefined();
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).includes('/restore?'),
        ),
      ).toHaveLength(6);
    } finally {
      await stores.close();
    }
  });

  it('keeps the transient retry allowance after spending guard retries', async () => {
    const server = new FakeManagedSessionStore();
    let contended = 4;
    let dropped = 2;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (requestUrl(input).includes('/restore?')) {
        if (contended > 0) {
          contended--;
          return jsonResponse(
            { error: { code: 'tenant_guard_contended', message: 'held' } },
            503,
          );
        }
        if (dropped > 0) {
          dropped--;
          throw new TypeError('fetch failed');
        }
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
      const started = Date.now();
      await expect(handle.read()).resolves.toBeDefined();
      const elapsedMs = Date.now() - started;
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).includes('/restore?'),
        ),
      ).toHaveLength(7);
      // Four 250 ms guard pauses, then the two transient backoffs at
      // their first and second steps (~200 ms and ~400 ms): about 1.7 s.
      // Scaling the transient backoff by the total attempt count instead
      // would sleep ~1.0 s and ~1.2 s there, about 3.3 s in all (#13800
      // R2-6).
      expect(elapsedMs).toBeLessThan(2_600);
    } finally {
      await stores.close();
    }
  });

  it('retries a contended guard on a non-retryable POST because the store rolled it back', async () => {
    const server = new FakeManagedSessionStore();
    let contended = 4;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (requestUrl(input).endsWith('/recovery:block') && contended > 0) {
        contended--;
        return jsonResponse(
          { error: { code: 'tenant_guard_contended', message: 'held' } },
          503,
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
      await stores.assertWritable();
      await handle.blockRecovery!({
        status: 'BLOCKED_RESOURCE',
        detailCode: 'managed_session_test',
      });
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/recovery:block'),
        ),
      ).toHaveLength(5);
    } finally {
      await stores.close();
    }
  });

  it('gives up on a persistently contended guard at the request deadline', async () => {
    const server = new FakeManagedSessionStore();
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (requestUrl(input).includes('/restore?'))
        return jsonResponse(
          { error: { code: 'tenant_guard_contended', message: 'held' } },
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
      requestTimeoutMs: 1_500,
    });
    try {
      const handle = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      const started = Date.now();
      await expect(handle.read()).rejects.toMatchObject({
        status: 503,
        remoteCode: 'tenant_guard_contended',
      });
      // The guard retries run until less than one 250 ms pause of the
      // 1 500 ms budget remains, so the give-up lands at about 1 250 ms:
      // pin it from below too, or a client that quits early stays green.
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_200);
      expect(Date.now() - started).toBeLessThan(1_500 + 1_000);
      expect(
        fetchFn.mock.calls.filter(([input]) =>
          requestUrl(input).includes('/restore?'),
        ).length,
      ).toBeGreaterThan(3);
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
      vi.setSystemTime(1_790_000_002_000);
      // A free-form cancel target names the five ref fields in a json
      // position: the writer must not collect it, and the oracle below
      // answers from the writer's own contract, so the two cannot drift.
      await session.authority.appendExecutionEvent(
        {
          operation: 'requestCancel',
          commandId: 'cancel-1',
          sessionKey: SESSION_KEY,
          contentDigest: 'e'.repeat(64),
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: 'cancel:req-1',
          sessionKey: SESSION_KEY,
          kind: 'cancel.requested',
          occurredAt: 1_790_000_002_000,
          payload: {
            requestId: 'req-1',
            target: {
              resourceId: 'not-a-ref',
              kind: 'not-a-ref-kind',
              schemaVersion: 1,
              byteLength: 2,
              digest: 'not-a-digest',
            },
            reason: 'user asked',
            requestedBy: 'test',
          },
        }),
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
      // Every ref a commit's own records declare must ship in that commit's
      // resources. This reads the writer's output rather than the fixture, so
      // regenerating the golden cannot launder a ref-collection regression
      // into a pass. One-directional by design: resources also carries the
      // transitive closure of refs nested inside resource bodies.
      for (const commit of written.commits) {
        const declared = refsDeclaredBy(String(commit['recordBytesBase64']));
        const shipped = new Set(
          (commit['resources'] as ManagedSessionDurableRef[]).map(
            (ref) => ref.resourceId,
          ),
        );
        for (const ref of declared) {
          expect(shipped.has(ref.resourceId)).toBe(true);
        }
      }
      expect(written).toEqual(JSON.parse(readFileSync(fixture, 'utf8')));
    } finally {
      ids.fixed = false;
      vi.useRealTimers();
    }
  });

  it('commits a cancel.requested whose free-form target names the five ref fields', async () => {
    const server = new FakeManagedSessionStore();
    const { session } = await bootStoresAndSession(server);
    try {
      // The target is a well-formed ref in a free-form json position: only a
      // harvester that collects refs beyond the schema-declared positions
      // would ship it, and this assertion fails on exactly that widening.
      const outcomeRef = await session.resources.publish(
        'managed-tool-outcome',
        Buffer.from('{}', 'utf8'),
      );
      await session.authority.appendExecutionEvent(
        {
          operation: 'requestCancel',
          commandId: 'cancel-1',
          sessionKey: SESSION_KEY,
          contentDigest: 'd'.repeat(64),
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: 'cancel:req-1',
          sessionKey: SESSION_KEY,
          kind: 'cancel.requested',
          occurredAt: 1,
          payload: {
            requestId: 'req-1',
            target: { ...outcomeRef },
            reason: 'user asked',
            requestedBy: 'test',
          },
        }),
        { class: 'trusted_entry' },
      );
      const commit = server.commits.at(-1);
      expect(commit).toMatchObject({ operation: 'requestCancel' });
      expect(commit?.['resources']).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('commits the base transcript proof a reopen-over-existing-transcript header names', async () => {
    const server = new FakeManagedSessionStore();
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      allowInsecureHttp: true,
      sessionKey: SESSION_KEY,
      writerId: 'harness-a',
      writerToken: TOKEN_A,
      fetchFn: server.fetch,
    });
    try {
      const definitionRef = await stores.resourceStore.publish(
        'managed-session-definition',
        Buffer.from('{}', 'utf8'),
      );
      const rootSnapshotRef = await stores.resourceStore.publish(
        'managed-session-root-snapshot',
        Buffer.from('{}', 'utf8'),
      );
      const proofRef = await stores.resourceStore.publish(
        'managed-transcript-proof',
        Buffer.from('proof', 'utf8'),
      );
      const journal = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      // A replacement writer adopting a sealed session reopens over the base
      // transcript and its header names the proof; no writer in this repo
      // emits one yet, so the genesis records are written by hand.
      await journal.appendTransaction([
        {
          uuid: 'record-engine',
          parentUuid: null,
          sessionId: SESSION_KEY.sessionId,
          timestamp: '2026-09-22T00:00:00.000Z',
          type: 'system',
          subtype: 'session_execution_engine',
          cwd: '/workspace',
          version: 'test',
          systemPayload: { version: 1, engine: 'managed' },
        },
        {
          uuid: 'record-header',
          parentUuid: 'record-engine',
          sessionId: SESSION_KEY.sessionId,
          timestamp: '2026-09-22T00:00:00.000Z',
          type: 'system',
          subtype: 'managed_session_header_v1',
          cwd: '/workspace',
          version: 'test',
          managedSession: {
            formatVersion: 1,
            minimumReader: 'managed-session/1',
            sessionKey: SESSION_KEY,
            engine: 'managed',
            definitionRef,
            rootSnapshotRef,
            createdBy: 'test',
            baseTranscriptProof: proofRef,
          },
        },
      ]);
      expect(server.commits).toHaveLength(1);
      expect(server.commits[0]).toMatchObject({ operation: 'session.create' });
      const resources = server.commits[0]?.['resources'] as Array<
        Record<string, unknown>
      >;
      expect(resources).toHaveLength(3);
      expect(resources.map((resource) => resource['resourceId'])).toEqual(
        expect.arrayContaining([
          definitionRef.resourceId,
          rootSnapshotRef.resourceId,
          proofRef.resourceId,
        ]),
      );
    } finally {
      await stores.close();
    }
  });

  it('commits the manifest a blocked tool receipt carries only in its resources', async () => {
    const server = new FakeManagedSessionStore();
    const { session } = await bootStoresAndSession(server);
    try {
      // A blocked Shell capture commits its receipt with resultRef null, so
      // the manifest reaches the store only through the receipt's resources.
      const outcomeRef = await session.resources.publish(
        'managed-tool-outcome',
        Buffer.from('{}', 'utf8'),
      );
      const manifestRef = await session.resources.publish(
        MANAGED_TOOL_RESULT_KINDS.manifest,
        Buffer.from('{}', 'utf8'),
      );
      await session.authority.appendExecutionEvent(
        {
          operation: 'recordToolResult',
          commandId: 'receipt-blocked',
          sessionKey: SESSION_KEY,
          contentDigest: 'a'.repeat(64),
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: 'receipt:blocked',
          sessionKey: SESSION_KEY,
          kind: 'tool.receipt',
          occurredAt: 1,
          payload: {
            executionCallId: 'execution-blocked',
            toolOutcomeRef: outcomeRef,
            resultRef: null,
            resources: [manifestRef],
            historyRevision: sequence,
          },
        }),
        { class: 'trusted_entry' },
      );
      const commit = server.commits.at(-1);
      expect(commit).toMatchObject({ operation: 'recordToolResult' });
      expect(
        (commit?.['resources'] as Array<Record<string, unknown>>).map(
          (resource) => resource['resourceId'],
        ),
      ).toContain(manifestRef.resourceId);
    } finally {
      await session.close();
    }
  });

  it('still inspects a snapshot whose manifest names an unstaged page (#13930 R1-43)', async () => {
    // A manifest committed before the closure edge shipped names page
    // envelopes the store never uploaded. The read-side walk drops the
    // dangling page ref instead of ruling the whole snapshot corrupt —
    // remove the tolerance and the construction below throws.
    const server = new FakeManagedSessionStore();
    const { session } = await bootStoresAndSession(server);
    try {
      const pageRef = await session.resources.publish(
        MANAGED_TOOL_RESULT_KINDS.page,
        Buffer.from('abc', 'utf8'),
      );
      const manifest = Buffer.from(
        JSON.stringify({
          toolResult: 'managed-tool-result/1',
          type: 'manifest',
          tenantId: 'tenant',
          sessionId: 'session',
          turnId: 'turn',
          executionCallId: 'execution',
          callId: 'call',
          invocationDigest: `sha256:${'a'.repeat(64)}`,
          bindingGeneration: '1',
          captureId: 'capture',
          revision: 1,
          executionStatus: 'success',
          exitCode: 0,
          signal: null,
          captureScope: 'process_pipes',
          capturePolicy: 'complete_required',
          captureStatus: 'complete',
          captureReason: null,
          upstreamTruncated: false,
          contents: [
            {
              streamId: 'stdout',
              role: 'stdout',
              mimeType: 'application/octet-stream',
              state: 'sealed',
              byteLength: 3,
              digest: 'b'.repeat(64),
              missingRanges: [],
              body: {
                pages: [{ ref: pageRef, segmentCount: 1, byteLength: 3 }],
              },
            },
            {
              streamId: 'stderr',
              role: 'stderr',
              mimeType: 'application/octet-stream',
              state: 'sealed',
              byteLength: 0,
              digest: 'c'.repeat(64),
              missingRanges: [],
              body: { pages: [] },
            },
          ],
        }),
        'utf8',
      );
      const manifestRef = await session.resources.publish(
        MANAGED_TOOL_RESULT_KINDS.manifest,
        manifest,
      );
      const outcomeRef = await session.resources.publish(
        'managed-tool-outcome',
        Buffer.from('{}', 'utf8'),
      );
      await session.authority.appendExecutionEvent(
        {
          operation: 'recordToolResult',
          commandId: 'receipt-paged',
          sessionKey: SESSION_KEY,
          contentDigest: 'a'.repeat(64),
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: 'receipt:paged',
          sessionKey: SESSION_KEY,
          kind: 'tool.receipt',
          occurredAt: 1,
          payload: {
            executionCallId: 'execution-paged',
            toolOutcomeRef: outcomeRef,
            resultRef: null,
            resources: [manifestRef],
            historyRevision: sequence,
          },
        }),
        { class: 'trusted_entry' },
      );
      // Build the snapshot rows exactly the way the writer shipped them,
      // then drop the page body — the pre-closure-edge shape.
      const transactions = server.commits.map((commit, index) => ({
        ...commit,
        journalRevision: index + 1,
        recordEncoding: 'identity',
        byteLength: Buffer.from(String(commit['recordBytesBase64']), 'base64')
          .length,
      }));
      const resources = [] as Array<{
        ref: ManagedSessionDurableRef;
        bytesBase64: string;
        referencedRevisions: number[];
      }>;
      for (const [index, commit] of server.commits.entries()) {
        for (const raw of commit['resources'] as ManagedSessionDurableRef[]) {
          const ref = {
            resourceId: raw.resourceId,
            kind: raw.kind,
            schemaVersion: raw.schemaVersion,
            byteLength: raw.byteLength,
            digest: raw.digest,
          };
          resources.push({
            ref,
            bytesBase64: (await session.resources.read(ref)).toString('base64'),
            referencedRevisions: [index + 1],
          });
        }
      }
      const snapshotInput = {
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
        resources,
      };
      const snapshot = readOnlyManagedSessionSnapshot({
        ...snapshotInput,
        resources: snapshotInput.resources.filter(
          ({ ref }) => ref.resourceId !== pageRef.resourceId,
        ),
      });
      expect(await snapshot.resources.read(manifestRef)).toEqual(
        await session.resources.read(manifestRef),
      );
      // Reading the absent page honestly reports its absence; the load
      // just no longer condemns the entire snapshot for it.
      await expect(snapshot.resources.read(pageRef)).rejects.toThrow(
        'snapshot resource is missing.',
      );
      // The tolerance is page-scoped: the manifest itself is a direct
      // reference of the receipt event, so dropping it is condemned by the
      // direct-reference guard before the walk ever runs.
      expect(() =>
        readOnlyManagedSessionSnapshot({
          ...snapshotInput,
          resources: snapshotInput.resources.filter(
            ({ ref }) => ref.resourceId !== manifestRef.resourceId,
          ),
        }),
      ).toThrow('snapshot direct resource reference is missing.');
    } finally {
      await session.close();
    }
  });

  it("rejects a restore head regressed below the writer's committed position", async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    try {
      const journal = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      // The honest head reads fine, then the server forgets a commit.
      await expect(journal.read()).resolves.toBeDefined();
      server.headOverrides['journalRevision'] = 0;
      server.headOverrides['committedSequence'] = 0;
      await expect(journal.read()).rejects.toThrow(/restore head regressed/);
      // The grant is not re-baselined onto a regressed head.
      await expect(journal.read()).rejects.toThrow(/restore head regressed/);
      expect(server.transactionReads).toBe(1);
    } finally {
      await session.close();
    }
  });

  it.each(['journalRevision', 'committedSequence'] as const)(
    'rejects a restore head regressed only in %s',
    async (override) => {
      const server = new FakeManagedSessionStore();
      const { stores, session } = await bootStoresAndSession(server);
      try {
        const journal = await stores.journalStore.open({
          sessionKey: SESSION_KEY,
        });
        // The honest head reads fine, then the server regresses one counter.
        await expect(journal.read()).resolves.toBeDefined();
        server.headOverrides[override] = 0;
        await expect(journal.read()).rejects.toThrow(/restore head regressed/);
      } finally {
        await session.close();
      }
    },
  );

  it('does not re-baseline the grant onto a self-consistent regressed head', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    try {
      const messageRef = await stores.resourceStore.publish(
        'managed-message',
        MESSAGE_BODY,
      );
      await appendMessage(session, 1, messageRef);
      const journal = await stores.journalStore.open({
        sessionKey: SESSION_KEY,
      });
      await expect(journal.read()).resolves.toBeDefined();

      // Roll the server back to the create commit, consistently: page and
      // head agree on the prefix, so no digest or contiguity check can
      // refuse it — only the writer's own committed position can.
      const first = server.storedTransactions[0]!;
      server.pageOverrides['transactions'] = [first];
      server.pageOverrides['nextRevision'] = 1;
      server.pageOverrides['hasMore'] = false;
      server.headOverrides['journalRevision'] = first['journalRevision'];
      server.headOverrides['committedSequence'] = first['lastSequence'];
      server.headOverrides['lastCommitDigest'] = first['commitDigest'];
      server.headOverrides['activationEpoch'] = first['activationEpoch'];

      await expect(journal.read()).rejects.toThrow(/restore head regressed/);
      // A refusal that re-baselined the grant anyway would let the same
      // consistent head read through on the retry; the position must hold.
      await expect(journal.read()).rejects.toThrow(/restore head regressed/);
      expect(server.transactionReads).toBe(1);

      delete server.pageOverrides['transactions'];
      delete server.pageOverrides['nextRevision'];
      delete server.pageOverrides['hasMore'];
      delete server.headOverrides['journalRevision'];
      delete server.headOverrides['committedSequence'];
      delete server.headOverrides['lastCommitDigest'];
      delete server.headOverrides['activationEpoch'];
      await expect(journal.read()).resolves.toBeDefined();
    } finally {
      await session.close();
    }
  });

  it('restores a journal spanning more than one transaction page', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server);
    const messageRef = await stores.resourceStore.publish(
      'managed-message',
      MESSAGE_BODY,
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
    ['storageVersion', 3],
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
        /not readable by this writer/,
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
      await stores.resourceStore.publish('managed-message', MESSAGE_BODY),
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
      MESSAGE_BODY,
    );
    await expect(appendMessage(session, 1, messageRef)).rejects.toThrow(
      /receipt does not match/,
    );
    // The write-failure latch stops every later write through this authority,
    // including the release close() would commit.
    expect(session.authority.writesStopped).toBe(true);
    await session.close().catch(() => undefined);
  });

  it.each([
    // The verdict/mint gate (R24).
    'child_run_lineage_minted',
    // A session message the store's lineage refuses (H4d).
    'session_message_lineage_refused',
  ])(
    'treats the %s refusal as rollbackable and commits the corrected retry',
    async (code) => {
      const server = new FakeManagedSessionStore();
      const { stores, session } = await bootStoresAndSession(server);
      const defaultImpl = server.fetch.getMockImplementation()!;
      let armed = true;
      let attempts = 0;
      server.fetch.mockImplementation(async (input, init) => {
        if (requestUrl(input).endsWith('/transactions:commit')) {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          if (body['operation'] === 'message.commit') {
            attempts++;
            if (armed) {
              armed = false;
              return jsonResponse(
                {
                  error: {
                    code,
                    message: 'the store refused the revision',
                  },
                },
                409,
              );
            }
          }
        }
        return defaultImpl(input, init);
      });
      const messageRef = await stores.resourceStore.publish(
        'managed-message',
        MESSAGE_BODY,
      );
      // The refusal is a rollbackable non-commit, never the write failure
      // that latches the authority's log shut behind it.
      await expect(appendMessage(session, 1, messageRef)).rejects.toThrow(
        ManagedSessionCommitRejectedError,
      );
      expect(session.authority.writesStopped).toBe(false);
      // The corrected retry commits on the same resident authority.
      await appendMessage(session, 2, messageRef);
      expect(session.authority.writesStopped).toBe(false);
      expect(attempts).toBe(2);
      const landed = server.commits.filter(
        (body) => body['operation'] === 'message.commit',
      ).length;
      expect(landed).toBe(1);
      await session.close();
    },
  );

  it('spends one contention budget across the commit retries', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server, 1_200);
    const defaultImpl = server.fetch.getMockImplementation()!;
    let attempts = 0;
    server.fetch.mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith('/transactions:commit')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body['operation'] === 'message.commit') {
          attempts++;
          return jsonResponse(
            {
              error: {
                code: 'tenant_guard_contended',
                message: 'held',
                request_id: 'r-4',
              },
            },
            503,
          );
        }
      }
      return defaultImpl(input, init);
    });
    const messageRef = await stores.resourceStore.publish(
      'managed-message',
      MESSAGE_BODY,
    );
    const started = Date.now();
    const error = await appendMessage(session, 1, messageRef).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ManagedSessionStoreHttpError);
    expect((error as Error).message).toMatch(
      /POST \/transactions:commit failed after \d+ attempts: held/,
    );
    expect((error as ManagedSessionStoreHttpError).details).toEqual({
      request_id: 'r-4',
    });
    // Each of the commit's three attempts restarting its own 1 200 ms of
    // guard retries would take ~3.6 s and ~15 fetches.
    expect(Date.now() - started).toBeLessThan(1_200 + 1_000);
    expect(attempts).toBeLessThanOrEqual(6);
    // The failed commit latched the log shut, so closing cannot settle.
    await session.close().catch(() => undefined);
  });

  it('lets a deadline abort after a slow guard answer close the shared commit budget', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server, 1_200);
    const defaultImpl = server.fetch.getMockImplementation()!;
    let attempts = 0;
    // The guard holds its answer for 500 ms, slower than an instant 503:
    // the second attempt aborts at the shared deadline instead of
    // returning a contended refusal the outer loop would recognize.
    server.fetch.mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith('/transactions:commit')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body['operation'] === 'message.commit') {
          attempts++;
          return new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve(
                jsonResponse(
                  {
                    error: { code: 'tenant_guard_contended', message: 'held' },
                  },
                  503,
                ),
              );
            }, 500);
            const signal = init?.signal;
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(signal.reason as Error);
            });
          });
        }
      }
      return defaultImpl(input, init);
    });
    const messageRef = await stores.resourceStore.publish(
      'managed-message',
      MESSAGE_BODY,
    );
    const started = Date.now();
    await expect(appendMessage(session, 1, messageRef)).rejects.toThrow(
      /POST \/transactions:commit failed after \d+ attempts/,
    );
    const elapsedMs = Date.now() - started;
    // The deadline abort arrives as a transport error, so the outer commit
    // loop used to restart a fresh 1 200 ms attempt behind the spent budget
    // (a third fetch at ~1 450 ms and the settle at ~1 950 ms). Once the
    // shared deadline governs restarts, the loop stops at the first abort.
    expect(elapsedMs).toBeGreaterThanOrEqual(1_000);
    expect(elapsedMs).toBeLessThan(1_600);
    expect(attempts).toBe(2);
    await session.close().catch(() => undefined);
  });

  it('names a budget-closing slow guard after its earlier contended refusal', async () => {
    const server = new FakeManagedSessionStore();
    const { stores, session } = await bootStoresAndSession(server, 1_200);
    const defaultImpl = server.fetch.getMockImplementation()!;
    let attempts = 0;
    // The first attempt answers contended inside the window; the second
    // outlives the shared deadline and is aborted, so the terminal error
    // used to arrive as a transport failure that renamed the guard
    // contention an unavailable store (#13800 R1-7).
    server.fetch.mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith('/transactions:commit')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body['operation'] === 'message.commit') {
          attempts++;
          return new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve(
                jsonResponse(
                  {
                    error: { code: 'tenant_guard_contended', message: 'held' },
                  },
                  503,
                ),
              );
            }, 500);
            const signal = init?.signal;
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(signal.reason as Error);
            });
          });
        }
      }
      return defaultImpl(input, init);
    });
    const messageRef = await stores.resourceStore.publish(
      'managed-message',
      MESSAGE_BODY,
    );
    const started = Date.now();
    const rejection = appendMessage(session, 1, messageRef);
    await expect(rejection).rejects.toMatchObject({
      status: 503,
      remoteCode: 'tenant_guard_contended',
      contentionExhausted: true,
    });
    await expect(rejection).rejects.not.toThrow(
      ManagedSessionStoreTransportError,
    );
    // Named at the deadline abort itself: the commit stops there instead
    // of the outer loop restarting until a later attempt happens to end
    // in the store's own refusal (four fetches, ~2.7 s).
    expect(attempts).toBe(2);
    expect(Date.now() - started).toBeLessThan(1_600);
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

  it('commits and reuses every part of a private outcome manifest after reopen', async () => {
    const server = new FakeManagedSessionStore();
    const open = await createSessionOpener(server);
    const first = await open('harness-a', TOKEN_A);
    const parts = [
      await first.resources.publish(
        'managed-tool-outcome-part',
        Buffer.alloc(60 * 1024, 0x61),
      ),
      await first.resources.publish(
        'managed-tool-outcome-part',
        Buffer.alloc(20 * 1024, 0x62),
      ),
    ];
    const ref = await first.resources.publish(
      'managed-tool-outcome-chunks',
      Buffer.from(JSON.stringify({ parts })),
    );
    async function receipt(session: typeof first, call: string) {
      await session.authority.appendExecutionEvent(
        {
          operation: 'recordToolResult',
          commandId: call,
          sessionKey: SESSION_KEY,
          contentDigest: ref.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `tool-receipt:${call}`,
          sessionKey: SESSION_KEY,
          kind: 'tool.receipt',
          occurredAt: 1,
          payload: {
            executionCallId: call,
            toolOutcomeRef: ref,
            resultRef: null,
            resources: [],
            historyRevision: sequence,
          },
        }),
        { class: 'trusted_entry' },
      );
    }
    try {
      await receipt(first, 'first-call');
      const uploaded = server.commits.at(-1)?.['resources'] as Array<
        ManagedSessionDurableRef & { bytesBase64?: string }
      >;
      expect(uploaded.map((item) => item.resourceId).sort()).toEqual(
        [ref, ...parts].map((item) => item.resourceId).sort(),
      );
      expect(
        uploaded.every(
          (item) =>
            item.bytesBase64 !== undefined && item.byteLength <= 64 * 1024,
        ),
      ).toBe(true);
    } finally {
      await first.close();
    }
    const reopened = await open('harness-b', TOKEN_B);
    try {
      await receipt(reopened, 'second-call');
      const reused = server.commits.at(-1)?.['resources'] as Array<
        ManagedSessionDurableRef & { bytesBase64?: string }
      >;
      expect(reused.map((item) => item.resourceId).sort()).toEqual(
        [ref, ...parts].map((item) => item.resourceId).sort(),
      );
      expect(reused.every((item) => item.bytesBase64 === undefined)).toBe(true);
      for (const part of parts) {
        expect((await reopened.resources.read(part)).byteLength).toBe(
          part.byteLength,
        );
      }
    } finally {
      await reopened.close();
    }
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
  supportedStorageVersion: number | undefined = 2;
  readonly commits: Array<Record<string, unknown>> = [];
  readonly recoveryBlocks: Array<Record<string, unknown>> = [];
  readonly headOverrides: Record<string, unknown> = {};
  readonly pageOverrides: Record<string, unknown> = {};
  readonly receiptOverrides: Record<string, unknown> = {};
  transactionReads = 0;
  sealCount = 0;
  renewCount = 0;
  sealFailuresRemaining = 0;

  editStoredTransaction(index: number, patch: Record<string, unknown>): void {
    Object.assign(this.transactions[index]!, patch);
  }

  /** The stored transaction records, for a test that rebuilds a page. */
  get storedTransactions(): ReadonlyArray<Record<string, unknown>> {
    return this.transactions;
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
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const token = headers.get('X-Qwen-Managed-Writer-Token');
      // The real backend re-issues the same writer generation to a
      // same-credential acquire while the lease is live
      // (ManagedSessionStore.acquireWriter's replay branch); only a lapsed
      // lease or a sealed head bumps the generation.
      if (
        this.state === 'ACTIVE' &&
        Date.now() < this.leaseUntil &&
        body['writerId'] === this.writerId &&
        token === this.writerToken
      ) {
        this.replayedGrants++;
        this.leaseUntil = Math.max(this.leaseUntil, Date.now() + 300_000);
        return jsonResponse({ ...this.grant(), replayed: true });
      }
      this.writerGeneration++;
      this.state = 'ACTIVE';
      this.leaseUntil = Date.now() + 300_000;
      this.writerId = String(body['writerId']);
      this.writerToken = token;
      return jsonResponse(this.grant());
    }
    if (suffix === '/writers:renew') {
      // The real backend refuses to renew a lapsed lease
      // (ManagedSessionStore.requireWriter with requireUnexpired); the seal
      // endpoint below intentionally keeps accepting one.
      if (Date.now() >= this.leaseUntil) {
        return jsonResponse(
          {
            error: {
              code: 'managed_session_writer_conflict',
              message: 'The writer lease has lapsed.',
            },
          },
          409,
        );
      }
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
      this.renewCount++;
      this.leaseUntil = Date.now() + 300_000;
      return jsonResponse(this.grant());
    }
    if (suffix === '/writers:seal') {
      this.sealCount++;
      if (this.sealFailuresRemaining > 0) {
        this.sealFailuresRemaining--;
        return jsonResponse(
          { error: { code: 'store_unavailable', message: 'backend down' } },
          500,
        );
      }
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
    if (
      suffix === '/transactions:commit' ||
      suffix === '/transactions:commit-v2'
    ) {
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

  state = 'SEALED';
  replayedGrants = 0;
  private writerGeneration = 0;
  private leaseUntil = 0;
  private writerId: string | undefined;
  private writerToken: string | null = null;
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
      ...(this.supportedStorageVersion === undefined
        ? {}
        : { supportedStorageVersion: this.supportedStorageVersion }),
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

// Declared refs are the writer's contract, not a shape guess: the header's
// own fields for the genesis commit, and the schema-declared positions of
// each event after it. A ref-shaped value in a free-form json position (like
// a cancel target) is deliberately not declared — a harvester widened to
// collect it changes what the writer ships, and this oracle moves with it.
function refsDeclaredBy(recordBytesBase64: string): ManagedSessionDurableRef[] {
  const refs: ManagedSessionDurableRef[] = [];
  for (const line of Buffer.from(recordBytesBase64, 'base64')
    .toString('utf8')
    .trimEnd()
    .split('\n')) {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['subtype'] === MANAGED_SESSION_HEADER_SUBTYPE) {
      const header = parseManagedSessionHeader(record['managedSession']);
      refs.push(header.definitionRef, header.rootSnapshotRef);
      if (header.baseTranscriptProof !== undefined) {
        refs.push(header.baseTranscriptProof);
      }
    } else if (record['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE) {
      refs.push(
        ...managedSessionEventRefs(
          parseManagedSessionEvent(record['managedSession']),
        ),
      );
    }
  }
  return refs;
}

function abortableDelay(
  ms: number,
  signal?: AbortSignal | null,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    });
  });
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

describe('collectNestedResourceRefs', () => {
  function closureRef(kind: string, seed: string): ManagedSessionDurableRef {
    const bytes = Buffer.from(seed, 'utf8');
    return {
      kind,
      resourceId: crypto.randomUUID(),
      schemaVersion: 1,
      byteLength: bytes.byteLength,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  it('includes private file history admission refs by walking only preparation', () => {
    const ref = closureRef('managed-file_history', 'prepared');
    const inputRef = closureRef('managed-tool-input', 'input');
    const toolDefinitionRef = closureRef(
      'managed-tool-definition',
      'definition',
    );
    // A prepared record's previousRecordRef and preparation.intentRef denote
    // one resource: SQL admission requires both to equal the predecessor's
    // file-history ref, and reads that ref from this transaction.
    const predecessorRef = closureRef('managed-file_history', 'predecessor');
    const body = {
      schemaVersion: 2,
      profile: 'csi-files-retirement/1',
      previousRecordRef: predecessorRef,
      preparation: {
        stage: 'prepared',
        intentRef: predecessorRef,
        invocations: [
          { inputRef, toolDefinitionRef },
          { inputRef, toolDefinitionRef },
        ],
      },
    };
    const nested = collectNestedResourceRefs(
      ref,
      Buffer.from(JSON.stringify(body)),
    );
    expect(nested).toHaveLength(3);
    expect(nested).toEqual(
      expect.arrayContaining([inputRef, toolDefinitionRef, predecessorRef]),
    );
    for (const ordinary of [
      { snapshots: [] },
      { ...body, preparation: null },
      { ...body, schemaVersion: 1 },
      { ...body, profile: 'ordinary' },
    ]) {
      expect(
        collectNestedResourceRefs(ref, Buffer.from(JSON.stringify(ordinary))),
      ).toEqual([]);
    }
  });

  it('refuses a malformed file history record instead of collapsing its closure', () => {
    const ref = closureRef('managed-file_history', 'malformed');
    expect(() =>
      collectNestedResourceRefs(ref, Buffer.from('null', 'utf8')),
    ).toThrow(/file history must be an object/);
    expect(() =>
      collectNestedResourceRefs(ref, Buffer.from('{', 'utf8')),
    ).toThrow(/record is not valid JSON/);
  });

  it('closes over every private outcome part and rejects malformed manifests', () => {
    const ref = closureRef('managed-tool-outcome-chunks', 'manifest');
    const parts = [
      closureRef('managed-tool-outcome-part', 'first'),
      closureRef('managed-tool-outcome-part', 'second'),
    ];
    expect(
      collectNestedResourceRefs(ref, Buffer.from(JSON.stringify({ parts }))),
    ).toEqual(parts);
    for (const manifest of [
      { parts: [] },
      { parts: [parts[0]] },
      { parts: Array(70).fill(parts[0]) },
      { parts, foreign: true },
      { parts: [parts[0], { ...parts[1], kind: 'managed-message-part' }] },
    ]) {
      expect(() =>
        collectNestedResourceRefs(ref, Buffer.from(JSON.stringify(manifest))),
      ).toThrow();
    }
  });

  it('closes over attachment refs embedded in a managed-input envelope (R8 P1)', () => {
    // The leak: the commit uploaded the envelope but never the attachment
    // bytes it admits — a reopened reader found the envelope and 404'd on
    // its attachments.
    const envelopeRef = closureRef('managed-input', 'envelope');
    const attachmentRef = closureRef('managed-channel-attachment', 'bytes-1');
    const secondAttachmentRef = closureRef(
      'managed-channel-attachment',
      'bytes-2',
    );
    const envelope = Buffer.from(
      JSON.stringify({
        v: 1,
        inputId: 'chin-a',
        attachments: [
          {
            fileName: 'a.txt',
            mimeType: 'text/plain',
            byteLength: 7,
            ref: attachmentRef,
          },
          {
            fileName: 'b.png',
            mimeType: 'image/png',
            byteLength: 9,
            digest: 'x'.repeat(64),
            ref: secondAttachmentRef,
          },
          { fileName: 'huge.mov', omitted: 'too_large' },
        ],
      }),
      'utf8',
    );
    const nested = collectNestedResourceRefs(envelopeRef, envelope);
    expect(nested.map((ref) => ref.resourceId).sort()).toEqual(
      [attachmentRef.resourceId, secondAttachmentRef.resourceId].sort(),
    );
    expect(
      nested.every((ref) => ref.kind === 'managed-channel-attachment'),
    ).toBe(true);
  });

  it('keeps a managed-input body it cannot represent out of the closure', () => {
    const envelopeRef = closureRef('managed-input', 'plain-string-body');
    expect(
      collectNestedResourceRefs(
        envelopeRef,
        Buffer.from('{"text":"<task-notification />"}', 'utf8'),
      ),
    ).toEqual([]);
  });

  it('closes over the page envelopes a result manifest names (#13856)', () => {
    // The gap the B2 rig arm proved: the walker traversed checkpoints and
    // records but never the manifest → page hop, so a staged page envelope
    // never reached the commit's resource closure and the Artifact's read
    // chain 404'd on it.
    const pageRef = closureRef('managed-tool-result-page', 'page-envelope');
    const manifestRef = closureRef('managed-tool-result-manifest', 'manifest');
    const manifest = Buffer.from(
      JSON.stringify({
        toolResult: 'managed-tool-result/1',
        type: 'manifest',
        tenantId: 'tenant',
        sessionId: 'session',
        turnId: 'turn',
        executionCallId: 'execution',
        callId: 'call',
        invocationDigest: `sha256:${'a'.repeat(64)}`,
        bindingGeneration: '1',
        captureId: 'capture',
        revision: 1,
        executionStatus: 'success',
        exitCode: 0,
        signal: null,
        captureScope: 'process_pipes',
        capturePolicy: 'complete_required',
        captureStatus: 'complete',
        captureReason: null,
        upstreamTruncated: false,
        contents: [
          {
            streamId: 'stdout',
            role: 'stdout',
            mimeType: 'application/octet-stream',
            state: 'sealed',
            byteLength: 3,
            digest: 'b'.repeat(64),
            missingRanges: [],
            body: {
              pages: [{ ref: pageRef, segmentCount: 1, byteLength: 3 }],
            },
          },
          {
            streamId: 'stderr',
            role: 'stderr',
            mimeType: 'application/octet-stream',
            state: 'sealed',
            byteLength: 0,
            digest: 'c'.repeat(64),
            missingRanges: [],
            body: { pages: [] },
          },
        ],
      }),
      'utf8',
    );
    const nested = collectNestedResourceRefs(manifestRef, manifest);
    expect(nested).toEqual([pageRef]);
  });
});
