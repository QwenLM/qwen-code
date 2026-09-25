/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import {
  MANAGED_SESSION_COMMIT_SUBTYPE,
  MANAGED_SESSION_EVENT_SUBTYPE,
  MANAGED_SESSION_HEADER_SUBTYPE,
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  managedSessionKeysEqual,
  parseManagedSessionCommitMarker,
  parseManagedSessionEvent,
  parseManagedSessionHeader,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionKey,
} from './managed-session-records.js';
import type { ManagedSessionJsonValue } from './managed-session-inbox.js';
import {
  scanManagedSessionJournal,
  type ManagedSessionJournalHandle,
  type ManagedSessionJournalScan,
  type ManagedSessionJournalStore,
  type ManagedSessionResourceStore,
} from './managed-session-storage.js';

export const HTTP_MANAGED_SESSION_STORE_CONTRACT = {
  tenantHeader: 'X-Qwen-Tenant-Id',
  writerTokenHeader: 'X-Qwen-Managed-Writer-Token',
  maxInlineResourceBytes: 64 * 1024,
  maxResourcesPerTransaction: 1024,
  minimumWriterTokenLength: 32,
  maximumWriterTokenLength: 512,
  minimumLeaseDurationMs: 1_000,
  maximumLeaseDurationMs: 300_000,
} as const;

const WRITER_TOKEN = new RegExp(
  `^[A-Za-z0-9_-]{${HTTP_MANAGED_SESSION_STORE_CONTRACT.minimumWriterTokenLength},${HTTP_MANAGED_SESSION_STORE_CONTRACT.maximumWriterTokenLength}}$`,
);
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface HttpManagedSessionStoreOptions {
  readonly baseUrl: string;
  readonly sessionKey: ManagedSessionKey;
  readonly writerId: string;
  readonly leaseDurationMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  /** Test and controlled-recovery hook. Normal callers generate a fresh token. */
  readonly writerToken?: string;
}

export interface HttpManagedSessionStores {
  readonly journalStore: ManagedSessionJournalStore;
  readonly resourceStore: ManagedSessionResourceStore;
  close(): Promise<void>;
}

export class ManagedSessionStoreHttpError extends ManagedSessionRecordError {
  constructor(
    readonly status: number,
    readonly remoteCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedSessionStoreHttpError';
  }
}

export function createHttpManagedSessionStores(
  options: HttpManagedSessionStoreOptions,
): HttpManagedSessionStores {
  const resources = new HttpManagedSessionResourceStore();
  const client = new ManagedSessionStoreHttpClient(options, resources);
  resources.bind(client);
  return {
    journalStore: new HttpManagedSessionJournalStore(client),
    resourceStore: resources,
    close: () => client.seal(),
  };
}

class HttpManagedSessionJournalStore implements ManagedSessionJournalStore {
  private handle: ManagedSessionJournalHandle | undefined;
  private opening: Promise<ManagedSessionJournalHandle> | undefined;

  constructor(private readonly client: ManagedSessionStoreHttpClient) {}

  async open(request: {
    readonly sessionKey: ManagedSessionKey;
  }): Promise<ManagedSessionJournalHandle> {
    if (!managedSessionKeysEqual(request.sessionKey, this.client.sessionKey)) {
      throw new ManagedSessionRecordError(
        'the HTTP Managed Session store belongs to a different session.',
      );
    }
    if (this.handle !== undefined) return this.handle;
    if (this.opening !== undefined) return this.opening;
    const opening = (async () => {
      await this.client.acquireWriter();
      const handle = new HttpManagedSessionJournalHandle(this.client);
      this.handle = handle;
      return handle;
    })();
    this.opening = opening;
    try {
      return await opening;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }
}

class HttpManagedSessionJournalHandle implements ManagedSessionJournalHandle {
  readonly sessionKey: ManagedSessionKey;

  constructor(private readonly client: ManagedSessionStoreHttpClient) {
    this.sessionKey = client.sessionKey;
  }

  read(
    options: {
      readonly maxBytes?: number;
    } = {},
  ): Promise<ManagedSessionJournalScan> {
    return this.client.readJournal(options.maxBytes);
  }

  appendTransaction(records: readonly unknown[]): Promise<void> {
    return this.client.appendTransaction(records);
  }

  blockRecovery(request: {
    readonly status:
      | 'BLOCKED_RESOURCE'
      | 'BLOCKED_WORKSPACE'
      | 'BLOCKED_EXECUTION';
    readonly detailCode: string;
  }): Promise<void> {
    return this.client.blockRecovery(request);
  }

  seal(): Promise<void> {
    return this.client.seal();
  }

  abort(): Promise<void> {
    return this.client.seal();
  }
}

class HttpManagedSessionResourceStore implements ManagedSessionResourceStore {
  private readonly staged = new Map<
    string,
    { ref: ManagedSessionDurableRef; bytes: Buffer }
  >();
  private client: ManagedSessionStoreHttpClient | undefined;

  bind(client: ManagedSessionStoreHttpClient): void {
    this.client = client;
  }

  async publish(
    kind: string,
    source: Buffer,
  ): Promise<ManagedSessionDurableRef> {
    const safeKind = assertManagedSessionStableId(kind, 'resource kind');
    if (
      source.byteLength >
      HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
    ) {
      throw new ManagedSessionRecordError(
        `resource bytes exceed the ${HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes}-byte inline limit; OSS storage is not enabled.`,
      );
    }
    const bytes = Buffer.from(source);
    const ref: ManagedSessionDurableRef = {
      resourceId: randomUUID(),
      kind: safeKind,
      schemaVersion: 1,
      byteLength: bytes.byteLength,
      digest: sha256(bytes),
    };
    this.staged.set(ref.resourceId, { ref, bytes });
    return ref;
  }

  async read(ref: ManagedSessionDurableRef): Promise<Buffer> {
    const validated = assertManagedSessionDurableRef(
      ref as unknown as ManagedSessionJsonValue,
      'resource',
    );
    const staged = this.staged.get(validated.resourceId);
    if (staged !== undefined) {
      requireSameRef(staged.ref, validated);
      return Buffer.from(staged.bytes);
    }
    if (this.client === undefined) {
      throw new ManagedSessionRecordError(
        'the HTTP Managed Session resource store is not bound.',
      );
    }
    return this.client.readResource(validated);
  }

  commitResources(refs: readonly ManagedSessionDurableRef[]): CommitResource[] {
    if (
      refs.length >
      HTTP_MANAGED_SESSION_STORE_CONTRACT.maxResourcesPerTransaction
    ) {
      throw new ManagedSessionRecordError(
        `a Managed Session transaction references more than ${HTTP_MANAGED_SESSION_STORE_CONTRACT.maxResourcesPerTransaction} resources.`,
      );
    }
    return refs.map((ref) => {
      const staged = this.staged.get(ref.resourceId);
      if (staged !== undefined) requireSameRef(staged.ref, ref);
      return {
        resourceId: ref.resourceId,
        kind: ref.kind,
        schemaVersion: ref.schemaVersion,
        byteLength: ref.byteLength,
        digest: ref.digest,
        ...(staged === undefined
          ? {}
          : { bytesBase64: staged.bytes.toString('base64') }),
      };
    });
  }

  releaseCommitted(refs: readonly ManagedSessionDurableRef[]): void {
    for (const ref of refs) this.staged.delete(ref.resourceId);
  }

  clear(): void {
    this.staged.clear();
  }
}

interface WriterGrant {
  readonly writerGeneration: number;
  readonly leaseUntil: number;
  readonly journalRevision: number;
  readonly committedSequence: number;
  readonly lastCommitDigest: string | null;
  readonly activationEpoch: number;
}

interface RestoreHead {
  readonly state: string;
  readonly storageVersion: number;
  readonly writerGeneration: number;
  readonly journalRevision: number;
  readonly committedSequence: number;
  readonly lastCommitDigest: string | null;
  readonly activationEpoch: number;
  readonly latestCheckpointResourceId: string | null;
  readonly compactedThroughRevision: number;
  readonly recoveryStatus: string;
  readonly recoveryDetailCode: string | null;
}

interface CommitResource {
  readonly resourceId: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly byteLength: number;
  readonly digest: string;
  readonly bytesBase64?: string;
}

interface TransactionDescriptor {
  readonly transactionId: string;
  readonly operation: string;
  readonly commandId: string;
  readonly contentDigest: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly eventCount: number;
  readonly eventsDigest: string | null;
  readonly previousCommitDigest: string | null;
  readonly commitDigest: string | null;
  readonly activationEpoch: number;
  readonly latestCheckpointResourceId: string | null;
  readonly refs: ManagedSessionDurableRef[];
}

class ManagedSessionStoreHttpClient {
  readonly sessionKey: ManagedSessionKey;
  private readonly baseUrl: string;
  private readonly writerId: string;
  private readonly writerToken: string;
  private readonly leaseDurationMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private grant: WriterGrant | undefined;
  private renewPromise: Promise<void> | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private sealed = false;

  constructor(
    options: HttpManagedSessionStoreOptions,
    private readonly resources: HttpManagedSessionResourceStore,
  ) {
    this.sessionKey = options.sessionKey;
    this.writerId = assertManagedSessionStableId(options.writerId, 'writerId');
    this.writerToken =
      options.writerToken ?? randomBytes(32).toString('base64url');
    if (!WRITER_TOKEN.test(this.writerToken)) {
      throw new ManagedSessionRecordError(
        'writerToken must be a 32-512 character Base64URL secret.',
      );
    }
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    if (
      !Number.isInteger(this.leaseDurationMs) ||
      this.leaseDurationMs <
        HTTP_MANAGED_SESSION_STORE_CONTRACT.minimumLeaseDurationMs ||
      this.leaseDurationMs >
        HTTP_MANAGED_SESSION_STORE_CONTRACT.maximumLeaseDurationMs
    ) {
      throw new ManagedSessionRecordError(
        'leaseDurationMs must be an integer from 1000 through 300000.',
      );
    }
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new ManagedSessionRecordError(
        'requestTimeoutMs must be a positive integer.',
      );
    }
    const parsed = new URL(options.baseUrl);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new ManagedSessionRecordError(
        'baseUrl must be an HTTP(S) URL without credentials, query, or fragment.',
      );
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async acquireWriter(): Promise<void> {
    if (this.grant !== undefined || this.sealed) {
      throw new ManagedSessionRecordError(
        'the HTTP Managed Session writer is already opened or sealed.',
      );
    }
    const grant = parseWriterGrant(
      await this.json('/writers:acquire', 'POST', {
        workspaceId: this.sessionKey.workspaceId,
        writerId: this.writerId,
        leaseMillis: this.leaseDurationMs,
      }),
    );
    this.grant = grant;
    this.scheduleRenewal();
  }

  async readJournal(maxBytes?: number): Promise<ManagedSessionJournalScan> {
    await this.ensureWriter();
    const head = parseRestoreHead(
      await this.json(
        `/restore?workspaceId=${encodeURIComponent(this.sessionKey.workspaceId)}`,
        'GET',
      ),
    );
    this.requireHeadMatchesGrant(head);
    const chunks: Buffer[] = [];
    let afterRevision = 0;
    let activationEpoch = 0;
    while (afterRevision < head.journalRevision) {
      await this.ensureWriter();
      const page = asRecord(
        await this.json(
          `/transactions?workspaceId=${encodeURIComponent(this.sessionKey.workspaceId)}&afterRevision=${afterRevision}&limit=100`,
          'GET',
        ),
        'transaction page',
      );
      const transactions = asArray(page['transactions'], 'transactions');
      if (transactions.length === 0) {
        throw corrupt('transaction page did not advance the journal.');
      }
      for (const value of transactions) {
        const transaction = parseStoredTransaction(value);
        if (transaction.journalRevision !== afterRevision + 1) {
          throw corrupt('transaction revisions are not contiguous.');
        }
        const bytes = decodeBase64(
          transaction.recordBytesBase64,
          'recordBytesBase64',
        );
        if (
          bytes.byteLength !== transaction.byteLength ||
          sha256(bytes) !== transaction.recordDigest
        ) {
          throw corrupt('transaction bytes do not match their metadata.');
        }
        const descriptor = describeTransaction(
          decodeRecords(bytes),
          bytes,
          activationEpoch,
          this.sessionKey,
        );
        requireStoredTransactionMatches(transaction, descriptor);
        activationEpoch = descriptor.activationEpoch;
        chunks.push(bytes);
        afterRevision = transaction.journalRevision;
      }
      const nextRevision = safeCounter(page['nextRevision'], 'nextRevision');
      const hasMore = boolean(page['hasMore'], 'hasMore');
      if (nextRevision !== afterRevision) {
        throw corrupt('transaction page nextRevision is inconsistent.');
      }
      if (!hasMore && afterRevision !== head.journalRevision) {
        throw corrupt('transaction page ended before the journal head.');
      }
    }
    const bytes = Buffer.concat(chunks);
    const scan = scanManagedSessionJournal(bytes, this.sessionKey, maxBytes);
    if (
      maxBytes === undefined &&
      (scan.committed !== head.committedSequence ||
        scan.lastMarkerDigest !== head.lastCommitDigest ||
        (scan.activation?.epoch ?? 0) !== head.activationEpoch)
    ) {
      throw corrupt('journal bytes do not match the durable head.');
    }
    this.grant = {
      writerGeneration: head.writerGeneration,
      leaseUntil: this.requireGrant().leaseUntil,
      journalRevision: head.journalRevision,
      committedSequence: head.committedSequence,
      lastCommitDigest: head.lastCommitDigest,
      activationEpoch: head.activationEpoch,
    };
    return scan;
  }

  async appendTransaction(records: readonly unknown[]): Promise<void> {
    await this.ensureWriter();
    const grant = this.requireGrant();
    const recordBytes = encodeRecords(records);
    const descriptor = describeTransaction(
      records,
      recordBytes,
      grant.activationEpoch,
      this.sessionKey,
    );
    if (descriptor.previousCommitDigest !== grant.lastCommitDigest) {
      throw new ManagedSessionRecordError(
        'the transaction does not extend the HTTP journal head.',
      );
    }
    const commitResources = this.resources.commitResources(descriptor.refs);
    const receipt = asRecord(
      await this.json('/transactions:commit', 'POST', {
        workspaceId: this.sessionKey.workspaceId,
        writerId: this.writerId,
        writerGeneration: grant.writerGeneration,
        expectedJournalRevision: grant.journalRevision,
        expectedCommittedSequence: grant.committedSequence,
        transactionId: descriptor.transactionId,
        operation: descriptor.operation,
        commandId: descriptor.commandId,
        contentDigest: descriptor.contentDigest,
        firstSequence: descriptor.firstSequence,
        lastSequence: descriptor.lastSequence,
        eventCount: descriptor.eventCount,
        eventsDigest: descriptor.eventsDigest,
        previousCommitDigest: descriptor.previousCommitDigest,
        commitDigest: descriptor.commitDigest,
        activationEpoch: descriptor.activationEpoch,
        latestCheckpointResourceId: descriptor.latestCheckpointResourceId,
        recordCount: records.length,
        recordBytesBase64: recordBytes.toString('base64'),
        recordDigest: sha256(recordBytes),
        resources: commitResources,
      }),
      'commit receipt',
    );
    const revision = safeCounter(receipt['journalRevision'], 'journalRevision');
    if (
      revision !== grant.journalRevision + 1 ||
      string(receipt['transactionId'], 'transactionId') !==
        descriptor.transactionId ||
      string(receipt['commandId'], 'commandId') !== descriptor.commandId ||
      string(receipt['operation'], 'operation') !== descriptor.operation ||
      safeCounter(receipt['firstSequence'], 'firstSequence') !==
        descriptor.firstSequence ||
      safeCounter(receipt['lastSequence'], 'lastSequence') !==
        descriptor.lastSequence ||
      safeCounter(receipt['committedSequence'], 'committedSequence') !==
        descriptor.lastSequence ||
      nullableDigest(receipt['commitDigest'], 'commitDigest') !==
        descriptor.commitDigest
    ) {
      throw corrupt('commit receipt does not match the submitted transaction.');
    }
    this.grant = {
      ...grant,
      journalRevision: revision,
      committedSequence: descriptor.lastSequence,
      lastCommitDigest: descriptor.commitDigest,
      activationEpoch: descriptor.activationEpoch,
    };
    this.resources.releaseCommitted(descriptor.refs);
  }

  async readResource(ref: ManagedSessionDurableRef): Promise<Buffer> {
    await this.ensureWriter();
    const response = await this.request(
      `/resources/${encodeURIComponent(ref.resourceId)}?workspaceId=${encodeURIComponent(this.sessionKey.workspaceId)}`,
      'GET',
      undefined,
      'application/octet-stream, application/json',
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      response.headers.get('X-Qwen-Resource-Kind') !== ref.kind ||
      response.headers.get('X-Qwen-Resource-Schema-Version') !==
        String(ref.schemaVersion) ||
      response.headers.get('X-Qwen-Resource-Digest') !== ref.digest ||
      bytes.byteLength !== ref.byteLength ||
      sha256(bytes) !== ref.digest
    ) {
      throw corrupt(
        `resource ${ref.resourceId} failed integrity verification.`,
      );
    }
    return bytes;
  }

  async blockRecovery(request: {
    readonly status:
      | 'BLOCKED_RESOURCE'
      | 'BLOCKED_WORKSPACE'
      | 'BLOCKED_EXECUTION';
    readonly detailCode: string;
  }): Promise<void> {
    await this.ensureWriter();
    const grant = this.requireGrant();
    const receipt = asRecord(
      await this.json('/recovery:block', 'POST', {
        workspaceId: this.sessionKey.workspaceId,
        writerId: this.writerId,
        writerGeneration: grant.writerGeneration,
        recoveryStatus: request.status,
        recoveryDetailCode: request.detailCode,
      }),
      'recovery state receipt',
    );
    if (
      safeCounter(receipt['writerGeneration'], 'writerGeneration') !==
        grant.writerGeneration ||
      string(receipt['recoveryStatus'], 'recoveryStatus') !== request.status ||
      string(receipt['recoveryDetailCode'], 'recoveryDetailCode') !==
        request.detailCode
    ) {
      throw corrupt(
        'recovery state receipt does not match the active writer request.',
      );
    }
  }

  async seal(): Promise<void> {
    if (this.sealed) return;
    const grant = this.grant;
    this.stopRenewal();
    if (grant === undefined) {
      this.sealed = true;
      this.resources.clear();
      return;
    }
    const receipt = asRecord(
      await this.json('/writers:seal', 'POST', {
        workspaceId: this.sessionKey.workspaceId,
        writerId: this.writerId,
        writerGeneration: grant.writerGeneration,
      }),
      'seal receipt',
    );
    if (
      safeCounter(receipt['writerGeneration'], 'writerGeneration') !==
        grant.writerGeneration ||
      string(receipt['state'], 'state') !== 'SEALED'
    ) {
      throw corrupt('seal receipt does not match the active writer.');
    }
    this.sealed = true;
    this.resources.clear();
  }

  private async ensureWriter(): Promise<void> {
    const grant = this.requireGrant();
    if (grant.leaseUntil - Date.now() <= this.leaseDurationMs / 3) {
      await this.renewWriter();
    }
  }

  private renewWriter(): Promise<void> {
    if (this.renewPromise !== undefined) return this.renewPromise;
    const grant = this.requireGrant();
    const renewal = (async () => {
      const renewed = parseWriterGrant(
        await this.json('/writers:renew', 'POST', {
          workspaceId: this.sessionKey.workspaceId,
          writerId: this.writerId,
          writerGeneration: grant.writerGeneration,
          leaseMillis: this.leaseDurationMs,
        }),
      );
      if (renewed.writerGeneration !== grant.writerGeneration) {
        throw corrupt('writer generation changed during renewal.');
      }
      this.grant = { ...this.requireGrant(), leaseUntil: renewed.leaseUntil };
      this.scheduleRenewal();
    })();
    this.renewPromise = renewal.finally(() => {
      this.renewPromise = undefined;
    });
    return this.renewPromise;
  }

  private scheduleRenewal(): void {
    this.stopRenewal();
    if (this.sealed || this.grant === undefined) return;
    const delay = Math.max(
      250,
      Math.min(
        Math.floor(this.leaseDurationMs / 2),
        this.grant.leaseUntil - Date.now() - 500,
      ),
    );
    this.renewTimer = setTimeout(() => {
      void this.renewWriter().catch(() => undefined);
    }, delay);
    this.renewTimer.unref();
  }

  private stopRenewal(): void {
    if (this.renewTimer !== undefined) clearTimeout(this.renewTimer);
    this.renewTimer = undefined;
  }

  private requireHeadMatchesGrant(head: RestoreHead): void {
    const grant = this.requireGrant();
    if (
      head.state !== 'ACTIVE' ||
      head.storageVersion !== 1 ||
      head.writerGeneration !== grant.writerGeneration ||
      head.recoveryStatus !== 'READY' ||
      head.compactedThroughRevision !== 0
    ) {
      throw corrupt('restore head is not readable by this v1 writer.');
    }
  }

  private requireGrant(): WriterGrant {
    if (this.grant === undefined || this.sealed) {
      throw new ManagedSessionRecordError(
        'the HTTP Managed Session writer is not active.',
      );
    }
    return this.grant;
  }

  private async json(
    path: string,
    method: 'GET' | 'POST',
    body?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const response = await this.request(path, method, body);
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw corrupt(
        `Managed Session Store returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Readonly<Record<string, unknown>>,
    accept = 'application/json',
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.sessionUrl()}${path}`, {
        method,
        redirect: 'error',
        headers: {
          Accept: accept,
          [HTTP_MANAGED_SESSION_STORE_CONTRACT.tenantHeader]:
            this.sessionKey.tenantId,
          [HTTP_MANAGED_SESSION_STORE_CONTRACT.writerTokenHeader]:
            this.writerToken,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new ManagedSessionRecordError(
        `Managed Session Store request failed: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    if (!response.ok) {
      const error = await readHttpError(response);
      throw new ManagedSessionStoreHttpError(
        response.status,
        error.code,
        error.message,
      );
    }
    if (response.headers.get('Cache-Control') !== 'no-store') {
      throw corrupt(
        'Managed Session Store response is missing Cache-Control: no-store.',
      );
    }
    return response;
  }

  private sessionUrl(): string {
    return `${this.baseUrl}/internal/managed-session-store/v1/sessions/${encodeURIComponent(this.sessionKey.sessionId)}`;
  }
}

function describeTransaction(
  records: readonly unknown[],
  bytes: Buffer,
  currentActivationEpoch: number,
  expectedSessionKey: ManagedSessionKey,
): TransactionDescriptor {
  const possibleHeader =
    records.length === 2
      ? envelope(records[1], 'possible genesis header record')
      : undefined;
  if (possibleHeader?.['subtype'] === MANAGED_SESSION_HEADER_SUBTYPE) {
    const first = envelope(records[0], 'genesis engine record');
    if (first['subtype'] !== 'session_execution_engine') {
      throw new ManagedSessionRecordError(
        'the genesis transaction must contain the engine and Managed header.',
      );
    }
    const header = parseManagedSessionHeader(possibleHeader['managedSession']);
    if (
      !managedSessionKeysEqual(header.sessionKey, expectedSessionKey) ||
      first['sessionId'] !== expectedSessionKey.sessionId ||
      possibleHeader['sessionId'] !== expectedSessionKey.sessionId
    ) {
      throw new ManagedSessionRecordError(
        'the genesis transaction belongs to a different session.',
      );
    }
    const digest = sha256(bytes);
    return {
      transactionId: `session.create:${header.sessionKey.sessionId}`,
      operation: 'session.create',
      commandId: `session.create:${header.sessionKey.sessionId}`,
      contentDigest: digest,
      firstSequence: 0,
      lastSequence: 0,
      eventCount: 0,
      eventsDigest: null,
      previousCommitDigest: null,
      commitDigest: null,
      activationEpoch: currentActivationEpoch,
      latestCheckpointResourceId: null,
      refs: collectRefs(records),
    };
  }
  if (records.length < 2) {
    throw new ManagedSessionRecordError(
      'a Managed Session transaction must include events and a commit marker.',
    );
  }
  const eventRecords = records.slice(0, -1).map((record, index) => {
    const parsed = envelope(record, `event record ${index + 1}`);
    if (parsed['subtype'] !== MANAGED_SESSION_EVENT_SUBTYPE) {
      throw new ManagedSessionRecordError(
        'a Managed Session transaction contains a non-event record.',
      );
    }
    const event = parseManagedSessionEvent(parsed['managedSession']);
    if (
      !managedSessionKeysEqual(event.sessionKey, expectedSessionKey) ||
      parsed['sessionId'] !== expectedSessionKey.sessionId
    ) {
      throw new ManagedSessionRecordError(
        'the event transaction belongs to a different session.',
      );
    }
    return event;
  });
  const markerRecord = envelope(records[records.length - 1], 'commit record');
  if (markerRecord['subtype'] !== MANAGED_SESSION_COMMIT_SUBTYPE) {
    throw new ManagedSessionRecordError(
      'a Managed Session transaction must end with a commit marker.',
    );
  }
  if (markerRecord['sessionId'] !== expectedSessionKey.sessionId) {
    throw new ManagedSessionRecordError(
      'the commit marker belongs to a different session.',
    );
  }
  const marker = parseManagedSessionCommitMarker(
    markerRecord['managedSession'],
  );
  let activationEpoch = currentActivationEpoch;
  let latestCheckpointResourceId: string | null = null;
  for (const event of eventRecords) {
    if (event.kind === 'activation.changed') {
      activationEpoch = event.payload['epoch'] as number;
    }
    if (event.kind === 'checkpoint.committed') {
      const ref = assertManagedSessionDurableRef(
        event.payload['stateRef'],
        'checkpoint state',
      );
      if (ref.kind === 'managed-checkpoint') {
        latestCheckpointResourceId = ref.resourceId;
      }
    }
  }
  return {
    transactionId: marker.transactionId,
    operation: marker.operation,
    commandId: marker.commandId,
    contentDigest: marker.contentDigest,
    firstSequence: marker.firstSequence,
    lastSequence: marker.lastSequence,
    eventCount: marker.eventCount,
    eventsDigest: marker.eventsDigest,
    previousCommitDigest: marker.previousCommitDigest,
    commitDigest: managedToolDigest(
      marker,
      MANAGED_SESSION_LIMITS.maxCommitMarkerBytes,
    ),
    activationEpoch,
    latestCheckpointResourceId,
    refs: collectRefs(records),
  };
}

function collectRefs(records: readonly unknown[]): ManagedSessionDurableRef[] {
  const refs = new Map<string, ManagedSessionDurableRef>();
  const pending: unknown[] = [...records];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (
      Object.hasOwn(record, 'resourceId') &&
      Object.hasOwn(record, 'kind') &&
      Object.hasOwn(record, 'schemaVersion') &&
      Object.hasOwn(record, 'byteLength') &&
      Object.hasOwn(record, 'digest')
    ) {
      const ref = assertManagedSessionDurableRef(
        record as ManagedSessionJsonValue,
        'resource ref',
      );
      const existing = refs.get(ref.resourceId);
      if (existing !== undefined) requireSameRef(existing, ref);
      else refs.set(ref.resourceId, ref);
      continue;
    }
    pending.push(...Object.values(record));
  }
  return [...refs.values()];
}

function encodeRecords(records: readonly unknown[]): Buffer {
  if (records.length < 1) {
    throw new ManagedSessionRecordError(
      'a Managed Session transaction must contain records.',
    );
  }
  const bytes = Buffer.from(
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
  if (bytes.byteLength > MANAGED_SESSION_LIMITS.maxTransactionBytes) {
    throw new ManagedSessionRecordError(
      `transaction exceeds ${MANAGED_SESSION_LIMITS.maxTransactionBytes} bytes.`,
    );
  }
  return bytes;
}

function decodeRecords(bytes: Buffer): unknown[] {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) throw corrupt('transaction is not complete JSONL.');
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) =>
      parseManagedSessionRecordJson(line, MANAGED_SESSION_LIMITS.maxEventBytes),
    );
}

function envelope(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseManagedSessionRecordJson(
    JSON.stringify(value),
    MANAGED_SESSION_LIMITS.maxEventBytes,
  );
  return asRecord(parsed, label);
}

interface StoredTransaction {
  readonly journalRevision: number;
  readonly transactionId: string;
  readonly operation: string;
  readonly commandId: string;
  readonly contentDigest: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly eventCount: number;
  readonly eventsDigest: string | null;
  readonly previousCommitDigest: string | null;
  readonly commitDigest: string | null;
  readonly activationEpoch: number;
  readonly latestCheckpointResourceId: string | null;
  readonly recordBytesBase64: string;
  readonly byteLength: number;
  readonly recordDigest: string;
}

function parseStoredTransaction(value: unknown): StoredTransaction {
  const record = asRecord(value, 'stored transaction');
  if (string(record['recordEncoding'], 'recordEncoding') !== 'identity') {
    throw corrupt('stored transaction encoding is not supported.');
  }
  return {
    journalRevision: safeCounter(record['journalRevision'], 'journalRevision'),
    transactionId: string(record['transactionId'], 'transactionId'),
    operation: string(record['operation'], 'operation'),
    commandId: string(record['commandId'], 'commandId'),
    contentDigest: digest(record['contentDigest'], 'contentDigest'),
    firstSequence: safeCounter(record['firstSequence'], 'firstSequence'),
    lastSequence: safeCounter(record['lastSequence'], 'lastSequence'),
    eventCount: safeCounter(record['eventCount'], 'eventCount'),
    eventsDigest: nullableDigest(record['eventsDigest'], 'eventsDigest'),
    previousCommitDigest: nullableDigest(
      record['previousCommitDigest'],
      'previousCommitDigest',
    ),
    commitDigest: nullableDigest(record['commitDigest'], 'commitDigest'),
    activationEpoch: safeCounter(record['activationEpoch'], 'activationEpoch'),
    latestCheckpointResourceId: nullableString(
      record['latestCheckpointResourceId'],
      'latestCheckpointResourceId',
    ),
    recordBytesBase64: string(record['recordBytesBase64'], 'recordBytesBase64'),
    byteLength: safeCounter(record['byteLength'], 'byteLength'),
    recordDigest: digest(record['recordDigest'], 'recordDigest'),
  };
}

function requireStoredTransactionMatches(
  stored: StoredTransaction,
  descriptor: TransactionDescriptor,
): void {
  if (
    stored.transactionId !== descriptor.transactionId ||
    stored.operation !== descriptor.operation ||
    stored.commandId !== descriptor.commandId ||
    stored.contentDigest !== descriptor.contentDigest ||
    stored.firstSequence !== descriptor.firstSequence ||
    stored.lastSequence !== descriptor.lastSequence ||
    stored.eventCount !== descriptor.eventCount ||
    stored.eventsDigest !== descriptor.eventsDigest ||
    stored.previousCommitDigest !== descriptor.previousCommitDigest ||
    stored.commitDigest !== descriptor.commitDigest ||
    stored.activationEpoch !== descriptor.activationEpoch ||
    stored.latestCheckpointResourceId !== descriptor.latestCheckpointResourceId
  ) {
    throw corrupt('stored transaction metadata does not match its records.');
  }
}

function parseWriterGrant(value: unknown): WriterGrant {
  const record = asRecord(value, 'writer grant');
  return {
    writerGeneration: safeCounter(
      record['writerGeneration'],
      'writerGeneration',
    ),
    leaseUntil: safeCounter(record['leaseUntil'], 'leaseUntil'),
    journalRevision: safeCounter(record['journalRevision'], 'journalRevision'),
    committedSequence: safeCounter(
      record['committedSequence'],
      'committedSequence',
    ),
    lastCommitDigest: nullableDigest(
      record['lastCommitDigest'],
      'lastCommitDigest',
    ),
    activationEpoch: safeCounter(record['activationEpoch'], 'activationEpoch'),
  };
}

function parseRestoreHead(value: unknown): RestoreHead {
  const record = asRecord(value, 'restore head');
  return {
    state: string(record['state'], 'state'),
    storageVersion: safeCounter(record['storageVersion'], 'storageVersion'),
    writerGeneration: safeCounter(
      record['writerGeneration'],
      'writerGeneration',
    ),
    journalRevision: safeCounter(record['journalRevision'], 'journalRevision'),
    committedSequence: safeCounter(
      record['committedSequence'],
      'committedSequence',
    ),
    lastCommitDigest: nullableDigest(
      record['lastCommitDigest'],
      'lastCommitDigest',
    ),
    activationEpoch: safeCounter(record['activationEpoch'], 'activationEpoch'),
    latestCheckpointResourceId: nullableString(
      record['latestCheckpointResourceId'],
      'latestCheckpointResourceId',
    ),
    compactedThroughRevision: safeCounter(
      record['compactedThroughRevision'],
      'compactedThroughRevision',
    ),
    recoveryStatus: string(record['recoveryStatus'], 'recoveryStatus'),
    recoveryDetailCode: nullableString(
      record['recoveryDetailCode'],
      'recoveryDetailCode',
    ),
  };
}

function requireSameRef(
  left: ManagedSessionDurableRef,
  right: ManagedSessionDurableRef,
): void {
  if (
    left.resourceId !== right.resourceId ||
    left.kind !== right.kind ||
    left.schemaVersion !== right.schemaVersion ||
    left.byteLength !== right.byteLength ||
    left.digest !== right.digest
  ) {
    throw new ManagedSessionRecordError(
      `resource ${right.resourceId} was reused with different metadata.`,
    );
  }
}

async function readHttpError(
  response: Response,
): Promise<{ code: string; message: string }> {
  try {
    const body = asRecord((await response.json()) as unknown, 'error response');
    const error = asRecord(body['error'], 'error');
    return {
      code: string(error['code'], 'error.code'),
      message: string(error['message'], 'error.message'),
    };
  } catch {
    return {
      code: 'managed_session_store_http_error',
      message: `Managed Session Store returned HTTP ${response.status}.`,
    };
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw corrupt(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw corrupt(`${label} must be an array.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw corrupt(`${label} must be a non-empty string.`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : string(value, label);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw corrupt(`${label} must be boolean.`);
  return value;
}

function safeCounter(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw corrupt(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(result)) {
    throw corrupt(`${label} must be a lowercase SHA-256 digest.`);
  }
  return result;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : digest(value, label);
}

function decodeBase64(value: string, label: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw corrupt(`${label} must be canonical Base64.`);
  }
  return Buffer.from(value, 'base64');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function corrupt(message: string): ManagedSessionRecordError {
  return new ManagedSessionRecordError(`Managed Session Store: ${message}`);
}
