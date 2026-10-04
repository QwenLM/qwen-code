/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  createHttpManagedSessionStores,
  HTTP_MANAGED_SESSION_STORE_CONTRACT,
  type ManagedSessionStoreHttpError,
} from './http-managed-session-store.js';
import {
  ACTIVATION_SUBJECT_KINDS,
  EVENT_SCHEMAS,
  LIFECYCLE_TRANSITIONS,
  MANAGED_SESSION_ACTION_SOURCES,
  MANAGED_SESSION_ACTION_STATES,
  MANAGED_SESSION_ACTIVATION_PHASES,
  MANAGED_SESSION_DOMAINS,
  MANAGED_SESSION_EVENT_KINDS,
  MANAGED_SESSION_LIFECYCLE_STATES,
  MANAGED_SESSION_LIMITS,
  MANAGED_SESSION_MODEL_ATTEMPT_STATES,
} from './managed-session-records.js';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';

interface ContractFixture {
  contractVersion: number;
  headers: {
    tenant: string;
    writerToken: string;
  };
  limits: {
    maxInlineResourceBytes: number;
    maxResourcesPerTransaction: number;
    maxTransactionBytes: number;
    maxTransactionEvents: number;
    maxJsonDepth: number;
    maxHeaderBytes: number;
    maxEventBytes: number;
    maxCommitMarkerBytes: number;
    minimumWriterTokenLength: number;
    maximumWriterTokenLength: number;
    minimumLeaseDurationMs: number;
    maximumLeaseDurationMs: number;
    maxTextBytes: number;
  };
  eventKinds: string[];
  domains: string[];
  activationSubjectKinds: Record<string, boolean>;
  eventPayloadSchemas: Record<
    string,
    { fields: Record<string, string>; optional: string[] }
  >;
  activationPhases: string[];
  modelAttemptStates: string[];
  actionSources: string[];
  actionStates: string[];
  lifecycleStates: string[];
  lifecycleTransitions: Record<string, string[]>;
  canonicalJsonCases: Array<{ json: string; digest: string }>;
  sessionKey: {
    tenantId: string;
    workspaceId: string;
    sessionId: string;
  };
  resources: Array<{
    resourceId: string;
    kind: string;
    schemaVersion: number;
    utf8: string;
    bytesBase64: string;
    byteLength: number;
    digest: string;
  }>;
  genesisTransaction: {
    records: unknown[];
    jsonl: string;
    recordBytesBase64: string;
    byteLength: number;
    recordDigest: string;
    expectedRequest: Record<string, unknown>;
  };
  errors: Record<string, { status: number; code: string }>;
}

const fixture = JSON.parse(
  await readFile(
    new URL(
      './contracts/managed-session-store-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as ContractFixture;

describe('Managed Session store shared contract', () => {
  it('pins headers, limits, bytes, and digests', () => {
    expect(fixture.contractVersion).toBe(1);
    expect(HTTP_MANAGED_SESSION_STORE_CONTRACT).toEqual({
      tenantHeader: fixture.headers.tenant,
      writerTokenHeader: fixture.headers.writerToken,
      maxInlineResourceBytes: fixture.limits.maxInlineResourceBytes,
      maxResourcesPerTransaction: fixture.limits.maxResourcesPerTransaction,
      minimumWriterTokenLength: fixture.limits.minimumWriterTokenLength,
      maximumWriterTokenLength: fixture.limits.maximumWriterTokenLength,
      minimumLeaseDurationMs: fixture.limits.minimumLeaseDurationMs,
      maximumLeaseDurationMs: fixture.limits.maximumLeaseDurationMs,
    });
    expect(MANAGED_SESSION_LIMITS.maxTransactionBytes).toBe(
      fixture.limits.maxTransactionBytes,
    );
    expect(MANAGED_SESSION_LIMITS.maxTransactionEvents).toBe(
      fixture.limits.maxTransactionEvents,
    );
    // The Java store parses record lines no deeper than the reader does.
    expect(MANAGED_SESSION_LIMITS.maxJsonDepth).toBe(
      fixture.limits.maxJsonDepth,
    );
    // The Java store caps each record-line kind as the reader does.
    expect(MANAGED_SESSION_LIMITS.maxHeaderBytes).toBe(
      fixture.limits.maxHeaderBytes,
    );
    expect(MANAGED_SESSION_LIMITS.maxEventBytes).toBe(
      fixture.limits.maxEventBytes,
    );
    expect(MANAGED_SESSION_LIMITS.maxCommitMarkerBytes).toBe(
      fixture.limits.maxCommitMarkerBytes,
    );
    // The free-text payload bound, covering both `text` and `rawText`.
    expect(MANAGED_SESSION_LIMITS.maxTextBytes).toBe(
      fixture.limits.maxTextBytes,
    );

    // The Java store mirrors the event vocabulary and payload contract out
    // of this fixture, so the authority's tables must match it exactly — a
    // kind or field added on one side only fails here and in
    // ManagedSessionStoreContractFixtureTest.
    expect([...MANAGED_SESSION_EVENT_KINDS]).toStrictEqual(fixture.eventKinds);
    expect([...MANAGED_SESSION_DOMAINS]).toStrictEqual(fixture.domains);
    expect(ACTIVATION_SUBJECT_KINDS).toStrictEqual(
      fixture.activationSubjectKinds,
    );
    expect(Object.keys(EVENT_SCHEMAS).sort()).toStrictEqual(
      Object.keys(fixture.eventPayloadSchemas).sort(),
    );
    for (const kind of MANAGED_SESSION_EVENT_KINDS) {
      const schema = EVENT_SCHEMAS[kind];
      const shared = fixture.eventPayloadSchemas[kind]!;
      expect(JSON.parse(JSON.stringify(schema.fields))).toStrictEqual(
        shared.fields,
      );
      expect([...(schema.optional ?? [])]).toStrictEqual(shared.optional);
    }
    expect([...MANAGED_SESSION_ACTIVATION_PHASES]).toStrictEqual(
      fixture.activationPhases,
    );
    expect([...MANAGED_SESSION_MODEL_ATTEMPT_STATES]).toStrictEqual(
      fixture.modelAttemptStates,
    );
    expect([...MANAGED_SESSION_ACTION_SOURCES]).toStrictEqual(
      fixture.actionSources,
    );
    expect([...MANAGED_SESSION_ACTION_STATES]).toStrictEqual(
      fixture.actionStates,
    );
    expect([...MANAGED_SESSION_LIFECYCLE_STATES]).toStrictEqual(
      fixture.lifecycleStates,
    );
    expect(JSON.parse(JSON.stringify(LIFECYCLE_TRANSITIONS))).toStrictEqual(
      fixture.lifecycleTransitions,
    );

    // The one canonical-JSON implementation both content digests come
    // from; the Java mirror recomputes the same digests case by case.
    for (const caze of fixture.canonicalJsonCases) {
      expect(managedToolDigest(JSON.parse(caze.json))).toBe(caze.digest);
    }

    for (const resource of fixture.resources) {
      const bytes = Buffer.from(resource.utf8, 'utf8');
      expect(bytes.toString('base64')).toBe(resource.bytesBase64);
      expect(bytes.byteLength).toBe(resource.byteLength);
      expect(sha256(bytes)).toBe(resource.digest);
    }

    const bytes = Buffer.from(fixture.genesisTransaction.jsonl, 'utf8');
    expect(bytes.toString('base64')).toBe(
      fixture.genesisTransaction.recordBytesBase64,
    );
    expect(bytes.byteLength).toBe(fixture.genesisTransaction.byteLength);
    expect(sha256(bytes)).toBe(fixture.genesisTransaction.recordDigest);
  });

  it('serializes the golden transaction without language drift', async () => {
    let committed: Record<string, unknown> | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(requestUrl(input)).pathname;
      if (path.endsWith('/writers:acquire')) {
        return jsonResponse({
          writerGeneration: 1,
          leaseUntil: Date.now() + 60_000,
          journalRevision: 0,
          committedSequence: 0,
          lastCommitDigest: null,
          activationEpoch: 0,
          replayed: false,
        });
      }
      if (path.endsWith('/transactions:commit')) {
        committed = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          journalRevision: 1,
          ...fixture.genesisTransaction.expectedRequest,
          committedSequence: 0,
          replayed: false,
        });
      }
      if (path.endsWith('/writers:seal')) {
        return jsonResponse({
          writerGeneration: 1,
          state: 'SEALED',
          replayed: false,
        });
      }
      return jsonResponse(
        { error: { code: 'not_found', message: 'Not found.' } },
        404,
      );
    });
    const stores = createHttpManagedSessionStores({
      baseUrl: 'http://session-store.test',
      sessionKey: fixture.sessionKey,
      writerId: 'fixture-writer',
      writerToken: 'a'.repeat(32),
      fetchFn,
    });

    const writer = await stores.journalStore.open({
      sessionKey: fixture.sessionKey,
    });
    await writer.appendTransaction(fixture.genesisTransaction.records);
    await stores.close();

    expect(committed).toMatchObject({
      workspaceId: fixture.sessionKey.workspaceId,
      writerId: 'fixture-writer',
      writerGeneration: 1,
      expectedJournalRevision: 0,
      expectedCommittedSequence: 0,
      ...fixture.genesisTransaction.expectedRequest,
      recordBytesBase64: fixture.genesisTransaction.recordBytesBase64,
      recordDigest: fixture.genesisTransaction.recordDigest,
    });
    const expectedResources = fixture.resources.map(
      ({ resourceId, kind, schemaVersion, byteLength, digest }) => ({
        resourceId,
        kind,
        schemaVersion,
        byteLength,
        digest,
      }),
    );
    expect(committed?.['resources']).toEqual(
      expect.arrayContaining(expectedResources),
    );
    expect(committed?.['resources']).toHaveLength(expectedResources.length);
  });

  it('preserves every shared Java error classification', async () => {
    for (const expected of Object.values(fixture.errors)) {
      const stores = createHttpManagedSessionStores({
        baseUrl: 'http://session-store.test',
        sessionKey: fixture.sessionKey,
        writerId: 'fixture-writer',
        writerToken: 'a'.repeat(32),
        fetchFn: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            jsonResponse(
              { error: { code: expected.code, message: 'Fixture error.' } },
              expected.status,
            ),
          ),
      });
      const error = await stores.journalStore
        .open({ sessionKey: fixture.sessionKey })
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject<Partial<ManagedSessionStoreHttpError>>({
        status: expected.status,
        remoteCode: expected.code,
      });
    }
  });
});

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

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
