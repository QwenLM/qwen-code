/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  MANAGED_SESSION_COMMIT_SUBTYPE,
  MANAGED_SESSION_EVENT_SUBTYPE,
  MANAGED_SESSION_HEADER_SUBTYPE,
  MANAGED_SESSION_LIMITS,
  ManagedSessionAppendUnsettledError,
  ManagedSessionJournalFencedError,
  ManagedSessionRecordError,
  assertManagedSessionKey,
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  managedSessionEventRefs,
  managedSessionKeysEqual,
  parseManagedSessionCommitMarker,
  parseManagedSessionEvent,
  parseManagedSessionHeader,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionKey,
} from './managed-session-records.js';
import type { ManagedSessionJsonValue } from './managed-session-inbox.js';
import { tryParseHarnessCheckpointV1 } from './managed-harness-checkpoint.js';
import {
  HOSTED_RECOVERY_RESOURCE_KINDS,
  HOSTED_MODEL_REQUEST_BYTES,
  hostedRecoveryReferences,
  parseHostedRecoveryResource,
} from './hosted-recovery-records.js';
import { MANAGED_EXTENSION_RECORD_BODIES } from './managed-extension-projection.js';
import {
  MANAGED_TOOL_RESULT_KINDS,
  parseToolResultManifestBytes,
} from './managed-tool-result.js';
import {
  MANAGED_MESSAGE_CHUNKS_KIND,
  managedMessageChunkParts,
} from './managed-message-chunks.js';
import {
  HOSTED_TOOL_RESULT_RESOURCE_LIMITS,
  type DurableToolResultResourceStore,
} from './resource-tool-result-store.js';
import {
  ManagedSessionCommitRejectedError,
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

const MAX_ATTACHMENT_INPUT_BYTES = 8 * 1024 * 1024;

export function managedSessionInlineResourceBytes(kind: string): number {
  if (kind === 'managed-input') return MAX_ATTACHMENT_INPUT_BYTES;
  if (kind === 'hosted-model-request') return HOSTED_MODEL_REQUEST_BYTES;
  return HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
}

const WRITER_TOKEN = new RegExp(
  `^[A-Za-z0-9_-]{${HTTP_MANAGED_SESSION_STORE_CONTRACT.minimumWriterTokenLength},${HTTP_MANAGED_SESSION_STORE_CONTRACT.maximumWriterTokenLength}}$`,
);
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const debugLogger = createDebugLogger('MANAGED_SESSION_STORE');

// WHATWG URL normalizes IPv4 literals (127.1 → 127.0.0.1) and keeps IPv6
// brackets; a 127.-prefixed DNS name (127.example.com) is not an IPv4 literal.
function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    (isIPv4(lower) && lower.startsWith('127.')) ||
    lower === '[::1]'
  );
}

export interface HttpManagedSessionStoreOptions {
  readonly baseUrl: string;
  readonly sessionKey: ManagedSessionKey;
  readonly writerId: string;
  readonly leaseDurationMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  /** Test and controlled-recovery hook. Normal callers generate a fresh token. */
  readonly writerToken?: string;
  /**
   * Opt-in for plaintext http:// broker URLs on non-loopback hosts. Writer
   * tokens cross the wire unencrypted on such URLs, so they are refused
   * without this flag.
   */
  readonly allowInsecureHttp?: boolean;
}

export interface ManagedSessionLifecycleAuthority {
  readonly operationId: string;
  readonly claimGeneration: number;
}

export interface CsiApplicationRetirementStatus {
  readonly format: 'qwen-csi-application-retirement/1';
  readonly retirementId: string;
  readonly stage: 'SETTLING' | 'FROZEN' | 'CUT' | 'DRAINED';
  readonly progressVersion: number;
  readonly frozenRequestSha256: string | null;
  readonly cutSha256: string | null;
  readonly finalizeReceiptSha256: string | null;
}

export interface HttpManagedSessionStores {
  readonly journalStore: ManagedSessionJournalStore;
  readonly resourceStore: ManagedSessionResourceStore;
  readonly publication: HttpToolPublicationOwner;
  readonly toolResultResources: DurableToolResultResourceStore;
  readonly csiRetirement: {
    joinWriter(): Promise<void>;
    prepare(records: readonly unknown[]): Promise<{
      readonly commitBodyBase64: string;
      readonly preparedCommitSha256: string;
    }>;
    complete(retirementId: string): Promise<CsiApplicationRetirementStatus>;
  };
  assertWritable(): Promise<void>;
  stopLocal(): Promise<void>;
  close(): Promise<void>;
  setLifecycleAuthority(authority?: ManagedSessionLifecycleAuthority): void;
  authorizeLifecycle(kind?: 'close' | 'delete'): Promise<void>;
  authorizeOrdinary(kind?: 'legacy-close'): Promise<void>;
}

export interface HttpToolPublicationOwner {
  owner(): Promise<{ writerId: string; writerGeneration: number }>;
  request(
    path: string,
    body: Record<string, unknown>,
    token?: string,
  ): Promise<unknown>;
  rememberAdmission(publicationId: string, ref: ManagedSessionDurableRef): void;
}

export class ManagedSessionStoreHttpError extends ManagedSessionRecordError {
  constructor(
    readonly status: number,
    readonly remoteCode: string,
    message: string,
    readonly contentionExhausted?: boolean,
    // The envelope's other scalar fields, such as the limit a refusal names.
    readonly details?: Readonly<Record<string, string | number | boolean>>,
    // The refusing store route ("POST /writers:renew", "GET /restore", …).
    // The public message is shared across server predicates (review
    // #14522), so the route travels in its own field.
    readonly route?: string,
  ) {
    super(message);
    this.name = 'ManagedSessionStoreHttpError';
  }
  // Sanitized writer-vs-store-head pairing captured at the moment of the
  // refusal (review #14522), when the refusal carried that context.
  writerRefusalContext?: string;
}

export class ManagedSessionStoreTransportError extends ManagedSessionRecordError {}

/**
 * Failures that leave the commit's outcome unknown: the request may have
 * reached the store. A retry is safe only against a proved head, which the
 * writer re-establishes after its lease lapses.
 */
function isUncertainStoreFailure(error: unknown): boolean {
  return (
    (error instanceof ManagedSessionStoreHttpError &&
      (error.status === 429 || error.status >= 500)) ||
    error instanceof ManagedSessionStoreTransportError ||
    error instanceof TypeError ||
    (error instanceof DOMException &&
      ['AbortError', 'TimeoutError'].includes(error.name))
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
    publication: {
      owner: () => client.publicationOwner(),
      request: (path, body, token) =>
        client.publicationRequest(path, body, token),
      rememberAdmission: (publicationId, ref) =>
        client.rememberAdmission(publicationId, ref),
    },
    toolResultResources: {
      publish: (kind, bytes, resourceId) =>
        client.publishToolResult(kind, bytes, resourceId),
      read: (ref) => client.readResource(ref),
    },
    csiRetirement: {
      joinWriter: () => client.joinOriginalCsiWriter(),
      prepare: (records) => client.prepareOriginalCsiCommit(records),
      complete: (retirementId) =>
        client.completeOriginalCsiRetirement(retirementId),
    },
    assertWritable: () => client.assertWritable(),
    stopLocal: () => client.stopLocal(),
    close: () => client.seal(),
    setLifecycleAuthority: (authority) =>
      client.setLifecycleAuthority(authority),
    authorizeLifecycle: (kind) => client.authorizeLifecycle(kind),
    authorizeOrdinary: (kind) => client.authorizeOrdinary(kind),
  };
}

/** Fixed inline observation; never opens the HTTP store or acquires a writer. */
export function readOnlyManagedSessionSnapshot(value: unknown) {
  const snapshot = asRecord(value, 'snapshot');
  if (snapshot['format'] !== 'qwen-csi-receipt-checkpoint-snapshot/1') {
    throw corrupt('snapshot format is unsupported.');
  }
  const sessionKey = assertManagedSessionKey(
    snapshot['sessionKey'] as ManagedSessionJsonValue,
    'snapshot sessionKey',
  );
  const head = parseRestoreHead(snapshot['head']);
  if (
    ![1, 2].includes(head.storageVersion) ||
    !['ACTIVE', 'SEALED'].includes(head.state) ||
    head.recoveryStatus !== 'READY' ||
    head.compactedThroughRevision !== 0
  ) {
    throw corrupt('snapshot recovery or compaction is unsupported.');
  }
  const rows = asArray(snapshot['transactions'], 'snapshot transactions');
  if (rows.length !== head.journalRevision || rows.length > 4096) {
    throw corrupt('snapshot transaction enumeration is incomplete.');
  }
  const transactions = rows.map(parseStoredTransaction);
  const chunks: Buffer[] = [];
  const references = new Map<string, Map<number, ManagedSessionDurableRef>>();
  let activationEpoch = 0;
  let checkpointResourceId: string | null = null;
  let totalBytes = 0;
  for (const [index, transaction] of transactions.entries()) {
    if (transaction.journalRevision !== index + 1) {
      throw corrupt('snapshot revisions are not contiguous.');
    }
    const bytes = decodeBase64(transaction.recordBytesBase64, 'recordBytes');
    totalBytes += bytes.length;
    if (
      bytes.length > MANAGED_SESSION_LIMITS.maxTransactionBytes ||
      totalBytes > 128 * 1024 * 1024 ||
      bytes.length !== transaction.byteLength ||
      sha256(bytes) !== transaction.recordDigest
    ) {
      throw corrupt('snapshot transaction bytes conflict.');
    }
    const descriptor = describeTransaction(
      decodeRecords(bytes),
      bytes,
      activationEpoch,
      sessionKey,
    );
    requireStoredTransactionMatches(transaction, descriptor);
    if ((index === 0) !== (descriptor.operation === 'session.create')) {
      throw corrupt('snapshot genesis is missing or repeated.');
    }
    activationEpoch = descriptor.activationEpoch;
    checkpointResourceId =
      descriptor.latestCheckpointResourceId ?? checkpointResourceId;
    for (const ref of descriptor.refs) {
      const revisions = references.get(ref.resourceId) ?? new Map();
      for (const prior of revisions.values()) requireSameRef(prior, ref);
      revisions.set(transaction.journalRevision, ref);
      references.set(ref.resourceId, revisions);
    }
    chunks.push(bytes);
  }
  const journalBytes = Buffer.concat(chunks);
  const scan = scanManagedSessionJournal(journalBytes, sessionKey);
  if (
    scan.header === undefined ||
    scan.uncommitted !== 0 ||
    scan.uncommittedBytes !== 0 ||
    scan.committed !== head.committedSequence ||
    scan.lastMarkerDigest !== head.lastCommitDigest ||
    (scan.activation?.epoch ?? 0) !== head.activationEpoch ||
    checkpointResourceId !== head.latestCheckpointResourceId
  ) {
    throw corrupt('snapshot bytes do not match its complete head.');
  }
  const resources = new Map<
    string,
    { ref: ManagedSessionDurableRef; bytes: Buffer }
  >();
  const resourceRevisions = new Map<string, number[]>();
  const resourceRows = asArray(snapshot['resources'], 'snapshot resources');
  let referenceRows = 0;
  if (resourceRows.length > 4096) {
    throw corrupt('snapshot resource enumeration is incomplete.');
  }
  for (const value of resourceRows) {
    const row = asRecord(value, 'snapshot resource');
    const ref = assertManagedSessionDurableRef(
      row['ref'] as ManagedSessionJsonValue,
      'snapshot resource ref',
    );
    if (resources.has(ref.resourceId))
      throw corrupt('snapshot resource is repeated.');
    const committedRevisions = asArray(
      row['referencedRevisions'],
      'resource revisions',
    ).map((value) => safeCounter(value, 'resource revision'));
    referenceRows += committedRevisions.length;
    if (
      referenceRows > 4096 ||
      committedRevisions.length === 0 ||
      committedRevisions.some(
        (revision, index) =>
          revision < 1 ||
          revision > head.journalRevision ||
          (index > 0 && revision <= committedRevisions[index - 1]),
      )
    ) {
      throw corrupt('snapshot resource reference revisions conflict.');
    }
    resourceRevisions.set(ref.resourceId, committedRevisions);
    const bytes = decodeBase64(
      string(row['bytesBase64'], 'bytesBase64'),
      'resource bytes',
    );
    totalBytes += bytes.length;
    if (
      totalBytes > 128 * 1024 * 1024 ||
      bytes.length !== ref.byteLength ||
      sha256(bytes) !== ref.digest
    ) {
      throw corrupt('snapshot resource bytes conflict.');
    }
    resources.set(ref.resourceId, { ref, bytes });
  }
  const pending = [...references.values()].flatMap((revisions) =>
    [...revisions.entries()].map(([revision, ref]) => ({ revision, ref })),
  );
  for (const { revision, ref } of pending) {
    if (!resourceRevisions.get(ref.resourceId)?.includes(revision)) {
      throw corrupt('snapshot direct resource reference is missing.');
    }
  }
  const visited = new Set<string>();
  while (pending.length > 0) {
    const { revision, ref } = pending.pop()!;
    const key = `${revision}\u0000${ref.resourceId}`;
    const stored = resources.get(ref.resourceId);
    if (stored === undefined) {
      // A manifest committed before the closure edge shipped names page
      // envelopes the Session never staged. Keep such a snapshot
      // inspectable by dropping the dangling page ref from the walk
      // without registering it — adding it would fire the enumeration
      // check below for exactly the snapshots this keeps readable
      // (#13930 R1-43).
      if (ref.kind === MANAGED_TOOL_RESULT_KINDS.page) continue;
      throw corrupt('snapshot resource is missing.');
    }
    if (resourceRevisions.get(ref.resourceId)![0] > revision) {
      throw corrupt('snapshot dependency was not committed at its use.');
    }
    requireSameRef(stored.ref, ref);
    if (visited.has(key)) continue;
    visited.add(key);
    const revisions = references.get(ref.resourceId) ?? new Map();
    for (const prior of revisions.values()) requireSameRef(prior, ref);
    revisions.set(revision, ref);
    references.set(ref.resourceId, revisions);
    const nested = collectNestedResourceRefs(ref, stored.bytes);
    pending.push(...nested.map((ref) => ({ revision, ref })));
  }
  if (resources.size !== references.size) {
    throw corrupt('snapshot resource enumeration conflicts.');
  }
  for (const [resourceId, revisions] of references) {
    const actual = resourceRevisions.get(resourceId)!;
    if (actual.some((revision) => !revisions.has(revision))) {
      throw corrupt('snapshot resource reference revisions conflict.');
    }
  }
  const rejectWrite = async (): Promise<never> => {
    throw corrupt('snapshot inspection cannot write.');
  };
  const journal: ManagedSessionJournalHandle = {
    sessionKey,
    read: async () => scanManagedSessionJournal(journalBytes, sessionKey),
    appendTransaction: rejectWrite,
    blockRecovery: rejectWrite,
    seal: rejectWrite,
    // A snapshot-inspection handle has no open writer; nothing can append.
    writerSealed: true,
    abort: rejectWrite,
  };
  const resourceStore: ManagedSessionResourceStore = {
    publish: rejectWrite,
    read: async (ref) => {
      const stored = resources.get(ref.resourceId);
      if (stored === undefined) throw corrupt('snapshot resource is missing.');
      requireSameRef(stored.ref, ref);
      return Buffer.from(stored.bytes);
    },
  };
  return { sessionKey, head, transactions, journal, resources: resourceStore };
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

  async appendTransaction(records: readonly unknown[]): Promise<void> {
    try {
      await this.client.appendTransaction(records);
    } catch (error) {
      if (
        !(error instanceof ManagedSessionCommitRejectedError) &&
        !(error instanceof ManagedSessionAppendUnsettledError)
      )
        this.client.stopWriterRenewal();
      throw error;
    }
  }

  async settleAppend(): Promise<'landed' | 'absent'> {
    try {
      return await this.client.settleAppend();
    } catch (error) {
      // A permanent settlement failure (another writer owns the position, a
      // malformed head) fences the log exactly like a failed append, so the
      // keepalive must stop instead of extending a lease this writer can no
      // longer use. An unsettled answer stays recoverable.
      if (!(error instanceof ManagedSessionAppendUnsettledError)) {
        this.client.stopWriterRenewal();
        // A settlement may have acquired a fresh lease just before proving
        // the fence. Seal it so the takeover it asks for can start.
        await this.client.seal().catch(() => undefined);
      }
      throw error;
    }
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

  get writerSealed(): boolean {
    return this.client.writerSealed;
  }

  abort(): Promise<void> {
    return this.client.seal();
  }
}

const EXTENSION_RECORD_KINDS = new Set(
  Object.keys(MANAGED_EXTENSION_RECORD_BODIES).map(
    (domain) => `managed-${domain}`,
  ),
);

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
    const maxBytes = managedSessionInlineResourceBytes(safeKind);
    if (source.byteLength > maxBytes) {
      throw new ManagedSessionRecordError(
        `resource bytes exceed the ${maxBytes}-byte inline limit; OSS storage is not enabled.`,
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

  async commitResources(
    refs: readonly ManagedSessionDurableRef[],
  ): Promise<CommitResource[]> {
    const closure = new Map<string, ManagedSessionDurableRef>();
    const pending = [...refs];
    while (pending.length > 0) {
      const ref = pending.pop()!;
      const existing = closure.get(ref.resourceId);
      if (existing !== undefined) {
        requireSameRef(existing, ref);
        continue;
      }
      closure.set(ref.resourceId, ref);
      if (
        closure.size >
        HTTP_MANAGED_SESSION_STORE_CONTRACT.maxResourcesPerTransaction
      ) {
        throw new ManagedSessionRecordError(
          `a Managed Session transaction references more than ${HTTP_MANAGED_SESSION_STORE_CONTRACT.maxResourcesPerTransaction} resources.`,
        );
      }
      const staged = this.staged.get(ref.resourceId);
      if (staged !== undefined) {
        requireSameRef(staged.ref, ref);
        pending.push(...collectNestedResourceRefs(ref, staged.bytes));
      } else if (isReferenceContainer(ref.kind)) {
        pending.push(...collectNestedResourceRefs(ref, await this.read(ref)));
      }
    }
    return [...closure.values()].map((ref) => {
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
  readonly supportedStorageVersion: number;
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
  /**
   * The re-acquisition a lapsed lease started. Seal and local stop await it
   * so they never read the grant-less window as "never held a writer", and a
   * late grant is sealed instead of adopted by a closed client.
   */
  private acquirePromise: Promise<void> | undefined;
  private renewingAuthority?: ManagedSessionLifecycleAuthority;
  private renewTimer: NodeJS.Timeout | undefined;
  private renewalStopped = false;
  private retirementJoin?: Promise<void>;
  private readonly writerRenewalFailures: unknown[] = [];
  private preparedRetirement?: {
    recordDigest: string;
    commitBodyBase64: string;
    preparedCommitSha256: string;
  };
  private sealed = false;
  private locallyStopped = false;
  private lifecycleAuthority?: ManagedSessionLifecycleAuthority;
  /**
   * The commit whose outcome the store could not observe. Its record digest
   * and the revision it was submitted against are kept so the next attempt
   * can ask the durable head whether it landed instead of assuming the log is
   * dead; a lapsed writer lease is re-acquirable, so the answer is knowable.
   */
  private pendingAppend:
    | {
        readonly recordDigest: string;
        readonly baseRevision: number;
        readonly commitResources?: readonly CommitResource[];
        readonly descriptor?: TransactionDescriptor;
      }
    | undefined;

  get writerSealed(): boolean {
    return this.sealed;
  }

  setLifecycleAuthority(authority?: ManagedSessionLifecycleAuthority): void {
    this.lifecycleAuthority = authority;
  }

  async authorizeOrdinary(kind?: 'legacy-close'): Promise<void> {
    await this.assertWritable();
    await this.json('/execution:authorize', 'POST', {
      ...(kind ? { kind } : {}),
      workspaceId: this.sessionKey.workspaceId,
      writerId: this.writerId,
      writerGeneration: this.grant!.writerGeneration,
    });
  }

  async authorizeLifecycle(kind?: 'close' | 'delete'): Promise<void> {
    if (kind) await this.assertWritable();
    const grant = this.grant;
    if (!grant)
      throw new ManagedSessionRecordError(
        'the HTTP Managed Session writer is not active.',
      );
    await this.json('/lifecycle:authorize', 'POST', {
      ...(kind ? { kind } : {}),
      workspaceId: this.sessionKey.workspaceId,
      writerId: this.writerId,
      writerGeneration: grant.writerGeneration,
    });
  }
  private readonly publicationAdmissions = new Map<string, string>();

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
    if (
      parsed.protocol === 'http:' &&
      !isLoopbackHostname(parsed.hostname) &&
      options.allowInsecureHttp !== true
    ) {
      throw new ManagedSessionRecordError(
        'baseUrl uses plaintext HTTP on a non-loopback host; writer tokens would cross the wire unencrypted. Pass allowInsecureHttp: true to opt in.',
      );
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async acquireWriter(): Promise<void> {
    if (this.grant !== undefined || this.sealed || this.locallyStopped) {
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
    // Sanitized writer-grant observation (review #14522): the boot id and
    // generation, never the lease token.
    debugLogger.debug(
      `Managed Session Store writer acquired: session=${this.sessionKey.sessionId} writerId=${this.writerId} acquiredWriterGeneration=${grant.writerGeneration} journalRevision=${grant.journalRevision} committedSequence=${grant.committedSequence} leaseUntil=${new Date(grant.leaseUntil).toISOString()}`,
    );
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
    // Sanitized grant/head pair (review #14522): a restored head that
    // matches the acquired writer generation proves the previous boot's
    // writer stayed fenced; the lease-active verdict is implied by the
    // acquire itself succeeding.
    debugLogger.debug(
      `Managed Session Store restore head matches grant: session=${this.sessionKey.sessionId} writerId=${this.writerId} acquiredWriterGeneration=${this.requireGrant().writerGeneration} headGeneration=${head.writerGeneration} journalRevision=${head.journalRevision} committedSequence=${head.committedSequence} state=${head.state} storageVersion=${head.storageVersion}`,
    );
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
      ...this.requireGrant(),
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
    if (this.pendingAppend !== undefined) await this.settleAppend();
    try {
      await this.ensureWriter();
    } catch (error) {
      const grant = this.grant;
      if (
        isUncertainStoreFailure(error) ||
        (grant !== undefined &&
          grant.leaseUntil <= Date.now() &&
          error instanceof ManagedSessionStoreHttpError &&
          error.status === 409)
      ) {
        this.pendingAppend = {
          recordDigest: sha256(encodeRecords(records)),
          baseRevision: grant?.journalRevision ?? 0,
        };
        throw new ManagedSessionAppendUnsettledError(asError(error));
      }
      throw error;
    }
    const grant = this.requireGrant();
    const {
      recordBytes,
      descriptor,
      commitResources,
      publicationId,
      commitBody,
      needsVersionTwo,
    } = await this.commitBody(records, grant);
    let committed: unknown;
    // One contention budget shared by the whole commit: the guard retries
    // inside json() and publicationRequest() stop at this deadline and each
    // guard retry's own timeout shrinks to it, and once guard retries have
    // spent it the outer loop starts no restart either — so three attempts
    // cannot each spend a fresh requestTimeoutMs behind one held tenant
    // guard (#13800).
    const contentionDeadline = Date.now() + this.requestTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        committed =
          publicationId === undefined
            ? await this.json(
                needsVersionTwo
                  ? '/transactions:commit-v2'
                  : '/transactions:commit',
                'POST',
                commitBody,
                contentionDeadline,
              )
            : await this.publicationRequest(
                `/publications/${encodeURIComponent(publicationId)}/receipts/commit`,
                commitBody,
                undefined,
                contentionDeadline,
              );
        break;
      } catch (error) {
        await this.annotateWriterRefusal(error);
        if (
          attempt === 0 &&
          error instanceof ManagedSessionStoreHttpError &&
          ((error.status === 409 &&
            (error.remoteCode === 'workspace_lifecycle_admission_closed' ||
              // The verdict/mint gate's refusal is a rollbackable
              // non-commit: the corrected retry must reach the backend
              // without the authority latching a write failure behind it.
              error.remoteCode === 'child_run_lineage_minted' ||
              // So is a session message the lineage refuses: only the
              // store holds a child's lineage, so the authority could not
              // refuse it first, and the Session's log stays writable.
              error.remoteCode === 'session_message_lineage_refused')) ||
            (this.lifecycleAuthority &&
              (error.status === 403 ||
                (error.status === 409 &&
                  (error.remoteCode.startsWith('workspace_lifecycle_') ||
                    error.remoteCode === 'workspace_unavailable')))))
        )
          throw new ManagedSessionCommitRejectedError(error);
        const uncertain = isUncertainStoreFailure(error);
        // Activation can retry beyond the usual attempt cap. A guard refusal
        // must still stop that lane once the shared budget cannot fit another
        // guard retry, even when the inner call never retried the guard.
        // A contended refusal is a definite non-commit the store rolled back.
        // Once the shared budget cannot fit another guard retry it is
        // terminal for every operation, not only for activation renewal:
        // treating it as an unknown outcome would keep a phantom append
        // pending and name a bounded contention as a store outage.
        const contentionSpent =
          error instanceof ManagedSessionStoreHttpError &&
          (error.contentionExhausted === true ||
            (publicationId === undefined &&
              error.status === 503 &&
              error.remoteCode === 'tenant_guard_contended' &&
              contentionDeadline - Date.now() <= 250));
        const exhausted = attempt >= 2;
        // A spent guard budget is a definite non-commit the store rolled back,
        // so it stays the terminal failure it already was. Everything else
        // that left the outcome unknown keeps the attempt: the next append
        // proves from the durable head whether it landed, instead of fencing
        // a journal whose writer lease only lapsed.
        const unsettled =
          !contentionSpent &&
          (isUncertainStoreFailure(error) ||
            (grant.leaseUntil <= Date.now() &&
              error instanceof ManagedSessionStoreHttpError &&
              error.status === 409));
        if (
          !uncertain ||
          contentionSpent ||
          (exhausted &&
            (descriptor.operation !== 'renewActivation' ||
              this.renewalStopped ||
              grant.leaseUntil <= Date.now()))
        ) {
          if (unsettled) {
            this.pendingAppend = {
              recordDigest: sha256(recordBytes),
              baseRevision: grant.journalRevision,
              commitResources,
              descriptor,
            };
            throw new ManagedSessionAppendUnsettledError(asError(error));
          }
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            exhausted ? Math.min(1000, grant.leaseUntil - Date.now()) : 250,
          ),
        );
        if (
          exhausted &&
          (this.renewalStopped || grant.leaseUntil <= Date.now())
        ) {
          if (unsettled) {
            this.pendingAppend = {
              recordDigest: sha256(recordBytes),
              baseRevision: grant.journalRevision,
              commitResources,
              descriptor,
            };
            throw new ManagedSessionAppendUnsettledError(asError(error));
          }
          throw error;
        }
      }
    }
    const receipt = asRecord(committed, 'commit receipt');
    const revision = safeCounter(receipt['journalRevision'], 'journalRevision');
    if (
      revision !== grant.journalRevision + 1 ||
      (publicationId === undefined
        ? string(receipt['transactionId'], 'transactionId') !==
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
        : safeCounter(receipt['historyRevision'], 'historyRevision') !==
            descriptor.lastSequence ||
          !descriptor.refs.some(
            (ref) =>
              ref.resourceId ===
              asRecord(receipt['toolOutcomeRef'], 'toolOutcomeRef')[
                'resourceId'
              ],
          ))
    ) {
      throw corrupt('commit receipt does not match the submitted transaction.');
    }
    this.grant = {
      ...this.requireGrant(),
      journalRevision: revision,
      committedSequence: descriptor.lastSequence,
      lastCommitDigest: descriptor.commitDigest,
      activationEpoch: descriptor.activationEpoch,
    };
    this.resources.releaseCommitted(commitResources);
    for (const ref of descriptor.refs)
      this.publicationAdmissions.delete(ref.resourceId);
  }

  /**
   * Asks the durable head whether the commit whose acknowledgement was lost
   * landed. A lapsed writer lease is re-acquired first, which is what lets a
   * Session outlive an outage longer than its lease: the head, not the dead
   * grant, decides. A head that advanced by someone else is fatal, because
   * this writer's in-memory position can no longer extend it.
   */
  async settleAppend(): Promise<'landed' | 'absent'> {
    const pending = this.pendingAppend;
    if (pending === undefined) return 'absent';
    let reacquired = false;
    for (;;) {
      try {
        if (this.grant === undefined) {
          throw new ManagedSessionRecordError(
            'the HTTP Managed Session writer is not active.',
          );
        }
        if (this.grant.leaseUntil <= Date.now()) await this.reacquireWriter();
        const head = parseRestoreHead(
          await this.json(
            `/restore?workspaceId=${encodeURIComponent(this.sessionKey.workspaceId)}`,
            'GET',
          ),
        );
        this.requireHeadMatchesGrant(head);
        if (head.journalRevision === pending.baseRevision) {
          this.pendingAppend = undefined;
          this.adoptHead(head);
          return 'absent';
        }
        if (
          pending.descriptor === undefined ||
          head.journalRevision !== pending.baseRevision + 1
        ) {
          throw new ManagedSessionJournalFencedError(
            `the journal advanced to revision ${head.journalRevision} past this writer's ${pending.baseRevision} while its append outcome was unknown; the Session needs a takeover.`,
          );
        }
        const page = asRecord(
          await this.json(
            `/transactions?workspaceId=${encodeURIComponent(this.sessionKey.workspaceId)}&afterRevision=${pending.baseRevision}&limit=1`,
            'GET',
          ),
          'transaction page',
        );
        const rows = asArray(page['transactions'], 'transactions');
        const stored = parseStoredTransaction(rows[0]);
        if (
          stored.journalRevision !== head.journalRevision ||
          stored.recordDigest !== pending.recordDigest
        ) {
          throw new ManagedSessionJournalFencedError(
            'the journal holds a different transaction at this append position; the Session needs a takeover.',
          );
        }
        this.resources.releaseCommitted(pending.commitResources ?? []);
        for (const ref of pending.descriptor.refs)
          this.publicationAdmissions.delete(ref.resourceId);
        this.pendingAppend = undefined;
        this.adoptHead(head);
        return 'landed';
      } catch (error) {
        if (error instanceof ManagedSessionAppendUnsettledError) throw error;
        // The read grant can lapse after the check above but before the Store
        // answers, and a real backend then refuses with a writer conflict.
        // That is recoverable once by re-acquiring and re-reading; a conflict
        // with a lease that is still live, or a second one, means another
        // writer holds the log and stays permanent.
        const lapsed =
          this.grant !== undefined && this.grant.leaseUntil <= Date.now();
        if (
          !reacquired &&
          lapsed &&
          error instanceof ManagedSessionStoreHttpError &&
          error.status === 409
        ) {
          reacquired = true;
          continue;
        }
        if (isUncertainStoreFailure(error))
          throw new ManagedSessionAppendUnsettledError(asError(error));
        throw error;
      }
    }
  }

  /**
   * Adopts the committed head from a store read. The writer generation must
   * already match (the caller checked), so only the log position and the
   * activation epoch move.
   */
  private adoptHead(head: RestoreHead): void {
    this.grant = {
      ...this.requireGrant(),
      journalRevision: head.journalRevision,
      committedSequence: head.committedSequence,
      lastCommitDigest: head.lastCommitDigest,
      activationEpoch: head.activationEpoch,
    };
    this.scheduleRenewal();
  }

  private async commitBody(records: readonly unknown[], grant: WriterGrant) {
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
    const commitResources = await this.resources.commitResources(
      descriptor.refs,
    );
    const needsVersionTwo =
      commitResources.some(
        (resource) =>
          HOSTED_RECOVERY_RESOURCE_KINDS.has(resource.kind) ||
          (resource.kind === 'managed-action-options' &&
            resource.bytesBase64 &&
            JSON.parse(
              Buffer.from(resource.bytesBase64, 'base64').toString('utf8'),
            ).v === 3),
      ) ||
      records.some((record) => {
        const event = (
          record as {
            managedSession?: {
              kind?: string;
              payload?: Record<string, unknown>;
            };
          }
        ).managedSession;
        return (
          event?.kind === 'message.retracted' &&
          event.payload?.['sourceBootId'] !== undefined
        );
      });
    if (needsVersionTwo && grant.supportedStorageVersion < 2)
      throw new ManagedSessionRecordError(
        'Managed Session Store does not support Hosted recovery storage version 2.',
      );
    const publicationIds = new Set(
      descriptor.refs.flatMap((ref) => {
        const id = this.publicationAdmissions.get(ref.resourceId);
        return id === undefined ? [] : [id];
      }),
    );
    if (publicationIds.size > 1) {
      throw new ManagedSessionRecordError(
        'Transaction mixes publication admissions.',
      );
    }
    const publicationId = [...publicationIds][0];
    const commitBody = {
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
    };
    return {
      recordBytes,
      descriptor,
      commitResources,
      publicationId,
      commitBody,
      needsVersionTwo,
    };
  }

  joinOriginalCsiWriter(): Promise<void> {
    if (this.retirementJoin) return this.retirementJoin;
    this.stopRenewal();
    const renewal = this.renewPromise;
    if (this.acquirePromise || this.pendingAppend)
      return Promise.reject(
        corrupt('original CSI writer has unresolved authority.'),
      );
    this.retirementJoin = (async () => {
      await renewal;
      if (this.writerRenewalFailures.length)
        throw this.writerRenewalFailures[0];
      const grant = this.requireGrant();
      if (
        grant.writerGeneration !== 1 ||
        grant.activationEpoch !== 1 ||
        grant.leaseUntil <= Date.now()
      ) {
        throw corrupt('original CSI writer cannot prepare retirement.');
      }
    })();
    return this.retirementJoin;
  }

  async prepareOriginalCsiCommit(records: readonly unknown[]) {
    if (!this.retirementJoin)
      throw corrupt('original CSI writer has not joined.');
    await this.retirementJoin;
    const recordDigest = sha256(encodeRecords(records));
    if (this.preparedRetirement) {
      if (recordDigest !== this.preparedRetirement.recordDigest)
        throw corrupt('original CSI preparation conflicts.');
      const { commitBodyBase64, preparedCommitSha256 } =
        this.preparedRetirement;
      return { commitBodyBase64, preparedCommitSha256 };
    }
    const { descriptor, commitResources, publicationId, commitBody } =
      await this.commitBody(records, this.requireGrant());
    if (
      descriptor.operation !== 'releaseActivation' ||
      descriptor.eventCount !== 1 ||
      records.length !== 2 ||
      descriptor.latestCheckpointResourceId !== null ||
      publicationId !== undefined ||
      commitResources.length !== 1 ||
      commitResources[0]!.kind !== 'managed-activation-boundary' ||
      commitResources[0]!.bytesBase64 === undefined
    ) {
      throw corrupt('original CSI release preparation is invalid.');
    }
    const bytes = Buffer.from(JSON.stringify(commitBody), 'utf8');
    this.preparedRetirement = {
      recordDigest,
      commitBodyBase64: bytes.toString('base64'),
      preparedCommitSha256: sha256(bytes),
    };
    const { commitBodyBase64, preparedCommitSha256 } = this.preparedRetirement;
    return { commitBodyBase64, preparedCommitSha256 };
  }

  async completeOriginalCsiRetirement(
    retirementId: string,
  ): Promise<CsiApplicationRetirementStatus> {
    assertManagedSessionStableId(retirementId, 'retirementId');
    const readStatus = (
      value: unknown,
      previous?: CsiApplicationRetirementStatus,
    ): CsiApplicationRetirementStatus => {
      const status = asRecord(value, 'CSI retirement status');
      const stage = status['stage'];
      if (
        Object.keys(status).sort().join(',') !==
          'cutSha256,finalizeReceiptSha256,format,frozenRequestSha256,progressVersion,retirementId,stage' ||
        status['format'] !== 'qwen-csi-application-retirement/1' ||
        status['retirementId'] !== retirementId ||
        !['SETTLING', 'FROZEN', 'CUT', 'DRAINED'].includes(String(stage))
      ) {
        throw corrupt('original CSI retirement status conflicts.');
      }
      const progressVersion = safeCounter(
        status['progressVersion'],
        'progressVersion',
      );
      const frozenRequestSha256 = nullableDigest(
        status['frozenRequestSha256'],
        'frozenRequestSha256',
      );
      const cutSha256 = nullableDigest(status['cutSha256'], 'cutSha256');
      const finalizeReceiptSha256 = nullableDigest(
        status['finalizeReceiptSha256'],
        'finalizeReceiptSha256',
      );
      if (
        progressVersion !==
          ['SETTLING', 'FROZEN', 'CUT', 'DRAINED'].indexOf(String(stage)) + 1 ||
        (stage === 'SETTLING') !== (frozenRequestSha256 === null) ||
        ['SETTLING', 'FROZEN'].includes(String(stage)) !==
          (cutSha256 === null) ||
        (stage === 'DRAINED') !== (finalizeReceiptSha256 !== null)
      ) {
        throw corrupt('original CSI retirement progress is incomplete.');
      }
      if (
        previous &&
        (progressVersion < previous.progressVersion ||
          (previous.frozenRequestSha256 !== null &&
            frozenRequestSha256 !== previous.frozenRequestSha256) ||
          (previous.cutSha256 !== null && cutSha256 !== previous.cutSha256))
      ) {
        throw corrupt(
          'original CSI retirement status changed its saved progress.',
        );
      }
      return {
        format: 'qwen-csi-application-retirement/1',
        retirementId,
        stage: stage as CsiApplicationRetirementStatus['stage'],
        progressVersion,
        frozenRequestSha256,
        cutSha256,
        finalizeReceiptSha256,
      };
    };
    let status = readStatus(
      await this.json(
        `/csi-retirement?workspaceId=${encodeURIComponent(this.sessionKey.workspaceId)}&retirementId=${encodeURIComponent(retirementId)}`,
        'GET',
      ),
    );
    const identity = {
      format: 'qwen-csi-application-retirement/1',
      workspaceId: this.sessionKey.workspaceId,
      retirementId,
    };
    if (status.stage === 'SETTLING') {
      if (!this.preparedRetirement)
        throw corrupt('original CSI retirement has no prepared body.');
      status = readStatus(
        await this.json('/csi-retirement:freeze', 'POST', {
          ...identity,
          commitBodyBase64: this.preparedRetirement.commitBodyBase64,
        }),
        status,
      );
      if (status.stage === 'SETTLING')
        throw corrupt('original CSI retirement did not freeze.');
    }
    if (status.stage === 'FROZEN') {
      status = readStatus(
        await this.json('/csi-retirement:cut', 'POST', {
          ...identity,
          frozenRequestSha256: status.frozenRequestSha256,
        }),
        status,
      );
      if (status.stage !== 'CUT' && status.stage !== 'DRAINED')
        throw corrupt('original CSI retirement did not commit its cut.');
    }
    if (status.stage === 'CUT') {
      status = readStatus(
        await this.json('/csi-retirement:finalize', 'POST', {
          ...identity,
          cutSha256: status.cutSha256,
        }),
        status,
      );
    }
    if (status.stage !== 'DRAINED')
      throw corrupt('original CSI retirement has not drained.');
    return status;
  }

  async publicationOwner(): Promise<{
    writerId: string;
    writerGeneration: number;
  }> {
    await this.ensureWriter();
    return {
      writerId: this.writerId,
      writerGeneration: this.requireGrant().writerGeneration,
    };
  }

  rememberAdmission(
    publicationId: string,
    ref: ManagedSessionDurableRef,
  ): void {
    assertManagedSessionStableId(publicationId, 'publicationId');
    const checked = assertManagedSessionDurableRef(
      ref as unknown as ManagedSessionJsonValue,
      'admission ref',
    );
    if (checked.kind !== 'managed-tool-outcome')
      throw new ManagedSessionRecordError(
        'Publication admission kind is invalid.',
      );
    const previous = this.publicationAdmissions.get(checked.resourceId);
    if (previous !== undefined && previous !== publicationId)
      throw new ManagedSessionRecordError('Publication admission conflicts.');
    this.publicationAdmissions.set(checked.resourceId, publicationId);
  }

  async publicationRequest(
    path: string,
    body: Record<string, unknown>,
    token?: string,
    contentionDeadline?: number,
  ): Promise<unknown> {
    await this.ensureWriter();
    if (
      !/^\/(?:grants|receipts\/verify|publications\/[a-z0-9_-]{1,128}\/(?:finished|admissions\/prepare|receipts\/commit))$/u.test(
        path,
      )
    )
      throw new ManagedSessionRecordError('Publication owner path is invalid.');
    const readOnly = path.endsWith('/finished');
    const method = readOnly ? 'GET' : 'POST';
    // Same engine as the commit lane: the caller's shared contention
    // deadline caps each attempt, and a contended 503 earns the guard
    // retry instead of returning uncapped (#13800 R2-2).
    return this.withRetry(
      readOnly,
      method,
      path,
      async (timeoutMs) => {
        const url = `${this.baseUrl}/internal/managed-tool-publications/v1/sessions/${encodeURIComponent(
          this.sessionKey.sessionId,
        )}${path}?workspaceId=${encodeURIComponent(this.sessionKey.workspaceId)}`;
        const response = await this.fetchFn(url, {
          method,
          headers: {
            Accept: 'application/json',
            'X-Qwen-Managed-Max-Readable-Storage-Version': '2',
            ...(readOnly ? {} : { 'Content-Type': 'application/json' }),
            [HTTP_MANAGED_SESSION_STORE_CONTRACT.tenantHeader]:
              this.sessionKey.tenantId,
            [HTTP_MANAGED_SESSION_STORE_CONTRACT.writerTokenHeader]:
              this.writerToken,
            'X-Qwen-Managed-Writer-Id': this.writerId,
            'X-Qwen-Managed-Writer-Generation': String(
              this.requireGrant().writerGeneration,
            ),
            ...(token ? { 'X-Qwen-Tool-Publication-Token': token } : {}),
          },
          ...(readOnly ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const error = await readHttpError(response);
          // Record the refusing route alongside the code (review #14522):
          // the public message is shared across server predicates, so the
          // route must travel in its own field, not the printable text.
          throw new ManagedSessionStoreHttpError(
            response.status,
            error.code,
            error.message,
            undefined,
            error.details,
            `${method} ${path}`,
          );
        }
        if (response.headers.get('Cache-Control') !== 'no-store')
          throw corrupt(
            'Publication response is missing Cache-Control: no-store.',
          );
        return readBoundedPublicationJson(response);
      },
      contentionDeadline,
    );
  }

  async readResource(ref: ManagedSessionDurableRef): Promise<Buffer> {
    await this.ensureWriter();
    const path = `/resources/${encodeURIComponent(ref.resourceId)}?workspaceId=${encodeURIComponent(this.sessionKey.workspaceId)}`;
    return this.withRetry(true, 'GET', path, async (timeoutMs) => {
      const response = await this.request(
        path,
        'GET',
        undefined,
        timeoutMs,
        'application/octet-stream, application/json',
      );
      if (!response.body) throw corrupt('resource response has no body.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (error) {
            if (error instanceof TypeError || error instanceof DOMException) {
              throw new ManagedSessionStoreTransportError(
                `Managed Session Store response failed: ${error.message}.`,
              );
            }
            throw error;
          }
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > ref.byteLength) {
            await reader.cancel();
            throw corrupt('resource response exceeds its declared length.');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
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
    });
  }

  async assertWritable(): Promise<void> {
    await this.renewWriter();
  }

  async publishToolResult(
    kind: string,
    source: Buffer,
    resourceId: string = randomUUID(),
  ): Promise<ManagedSessionDurableRef> {
    const limit = HOSTED_TOOL_RESULT_RESOURCE_LIMITS[kind];
    if (
      !Object.hasOwn(HOSTED_TOOL_RESULT_RESOURCE_LIMITS, kind) ||
      source.byteLength < 1 ||
      source.byteLength > limit
    ) {
      throw new ManagedSessionRecordError(
        'Unsupported tool result resource or size.',
      );
    }
    assertManagedSessionStableId(resourceId, 'tool result resourceId');
    const bytes = Buffer.from(source);
    const ref: ManagedSessionDurableRef = {
      resourceId,
      kind,
      schemaVersion: 1,
      byteLength: bytes.length,
      digest: sha256(bytes),
    };
    await this.ensureWriter();
    const grant = this.requireGrant();
    const receipt = assertManagedSessionDurableRef(
      (await this.json('/tool-results:publish', 'POST', {
        workspaceId: this.sessionKey.workspaceId,
        writerId: this.writerId,
        writerGeneration: grant.writerGeneration,
        ...ref,
        bytesBase64: bytes.toString('base64'),
      })) as ManagedSessionJsonValue,
      'tool result publication',
    );
    requireSameRef(receipt, ref);
    return ref;
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
    if (this.retirementJoin)
      throw corrupt('original CSI retirement owns the final boundary.');
    await this.acquirePromise?.catch(() => undefined);
    return this.sealGrant();
  }

  private async sealGrant(): Promise<void> {
    if (this.sealed) return;
    const grant = this.grant;
    this.stopWriterRenewal();
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
    this.stopRenewal();
    this.resources.clear();
  }

  async stopLocal(): Promise<void> {
    this.locallyStopped = true;
    this.stopRenewal();
    await this.renewPromise?.catch(() => undefined);
    await this.acquirePromise?.catch(() => undefined);
  }

  stopWriterRenewal(): void {
    this.renewalStopped = true;
    this.stopRenewal();
  }

  private async ensureWriter(): Promise<void> {
    if (this.retirementJoin)
      throw corrupt('original CSI writer admission is closed.');
    // A concurrent re-acquisition owns the grant-less window; wait for it
    // instead of reading it as a writer that was never acquired.
    if (this.acquirePromise !== undefined)
      await this.acquirePromise.catch(() => undefined);
    const grant = this.requireGrant();
    if (grant.leaseUntil - Date.now() <= this.leaseDurationMs / 3) {
      await this.renewWriter();
    }
  }

  /**
   * Replaces a writer lease that lapsed. The expired grant is put back when
   * the acquisition itself fails, so a later settlement asks the Store again
   * instead of finding a writer-less client and fencing the log.
   */
  private async reacquireWriter(): Promise<void> {
    const expired = this.grant;
    this.stopRenewal();
    await this.renewPromise?.catch(() => undefined);
    this.grant = undefined;
    const acquire = (async () => {
      await this.acquireWriter();
      // A seal or local stop that started while the POST was in flight must
      // not leave the newly acquired lease live on a closed client.
      if (this.sealed || this.locallyStopped) await this.sealGrant();
    })();
    this.acquirePromise = acquire;
    try {
      await acquire;
    } catch (error) {
      this.grant = expired;
      throw error;
    } finally {
      if (this.acquirePromise === acquire) this.acquirePromise = undefined;
    }
  }

  private renewWriter(): Promise<void> {
    if (this.retirementJoin)
      return Promise.reject(corrupt('original CSI writer renewal is closed.'));
    if (this.locallyStopped) {
      return Promise.reject(
        new ManagedSessionRecordError(
          'the HTTP Managed Session writer is locally stopped.',
        ),
      );
    }
    if (this.renewPromise !== undefined) {
      if (
        this.lifecycleAuthority?.operationId ===
          this.renewingAuthority?.operationId &&
        this.lifecycleAuthority?.claimGeneration ===
          this.renewingAuthority?.claimGeneration
      )
        return this.renewPromise;
      return this.renewPromise.then(() => this.renewWriter());
    }
    const grant = this.requireGrant();
    this.renewingAuthority = this.lifecycleAuthority
      ? { ...this.lifecycleAuthority }
      : undefined;
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
      this.grant = {
        ...this.requireGrant(),
        leaseUntil: renewed.leaseUntil,
        supportedStorageVersion: renewed.supportedStorageVersion,
      };
      this.scheduleRenewal();
    })();
    const noted = renewal.catch(async (error: unknown) => {
      this.writerRenewalFailures.push(error);
      // A refused renewal currently stops the timer silently; the lease
      // then expires and every later write meets the same shared 409 text.
      // Record the pairing before it is swallowed (review #14522).
      await this.annotateWriterRefusal(error);
      throw error;
    });
    this.renewPromise = noted.finally(() => {
      this.renewPromise = undefined;
    });
    return this.renewPromise;
  }

  // Review #14522 discriminator: when the store refuses a writer operation
  // with the shared writer-conflict text, record which grant this writer
  // presented and the store-head generation/revision/state verdict at the
  // same instant, sanitized (writer id is the boot id; never a token). The
  // pair separates a grant the wake never re-acquired from a grant the
  // store already judges superseded or unleased.
  private async annotateWriterRefusal(error: unknown): Promise<void> {
    if (
      !(error instanceof ManagedSessionStoreHttpError) ||
      error.status !== 409
    )
      return;
    const grant = this.grant;
    const grantView =
      grant === undefined
        ? 'grant=absent'
        : `grantGeneration=${grant.writerGeneration} grantRevision=${grant.journalRevision} grantCommitted=${grant.committedSequence}`;
    let headView: string;
    try {
      const head = parseRestoreHead(
        await this.json(
          `/restore?workspaceId=${encodeURIComponent(this.sessionKey.workspaceId)}`,
          'GET',
        ),
      );
      headView = `headGeneration=${head.writerGeneration} headRevision=${head.journalRevision} headCommitted=${head.committedSequence} state=${head.state}`;
    } catch (probe) {
      headView = `headProbeFailed(${
        probe instanceof Error ? probe.message : String(probe)
      })`;
    }
    const detail = `writerId=${this.writerId} ${grantView} ${headView}`;
    error.writerRefusalContext = detail;
    debugLogger.debug(
      `Managed Session Store writer refused: session=${this.sessionKey.sessionId} ${detail}`,
    );
  }

  private scheduleRenewal(retrying = false): void {
    this.stopRenewal();
    if (
      this.renewalStopped ||
      this.sealed ||
      this.locallyStopped ||
      this.retirementJoin ||
      this.grant === undefined ||
      this.grant.leaseUntil <= Date.now()
    )
      return;
    const delay = Math.max(
      250,
      Math.min(
        retrying ? 1000 : Math.floor(this.leaseDurationMs / 2),
        this.grant.leaseUntil - Date.now() - 500,
      ),
    );
    this.renewTimer = setTimeout(() => {
      void this.renewWriter().catch((error: unknown) => {
        if (
          error instanceof ManagedSessionStoreTransportError ||
          (error instanceof ManagedSessionStoreHttpError &&
            [500, 502, 503, 504].includes(error.status))
        ) {
          this.scheduleRenewal(true);
        }
      });
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
      ![1, 2].includes(head.storageVersion) ||
      head.writerGeneration !== grant.writerGeneration ||
      head.recoveryStatus !== 'READY' ||
      head.compactedThroughRevision !== 0
    ) {
      throw corrupt('restore head is not readable by this writer.');
    }
    // A head below this writer's committed position is a server-side
    // regression; re-baselining onto it would silently forget our own
    // commits, so only an equal-or-ahead head may replace the grant.
    if (
      head.journalRevision < grant.journalRevision ||
      head.committedSequence < grant.committedSequence
    ) {
      throw corrupt(
        `restore head regressed below this writer's committed position (head ${head.journalRevision}/${head.committedSequence} < grant ${grant.journalRevision}/${grant.committedSequence}).`,
      );
    }
  }

  private requireGrant(): WriterGrant {
    if (this.grant === undefined || this.sealed || this.locallyStopped) {
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
    contentionDeadline?: number,
  ): Promise<unknown> {
    return this.withRetry(
      method === 'GET' || path === '/writers:renew',
      method,
      path,
      async (timeoutMs) => {
        const response = await this.request(path, method, body, timeoutMs);
        try {
          return (await response.json()) as unknown;
        } catch (error) {
          if (
            error instanceof TypeError ||
            (error instanceof DOMException &&
              ['AbortError', 'TimeoutError'].includes(error.name))
          ) {
            throw new ManagedSessionStoreTransportError(
              `Managed Session Store response failed: ${error.message}.`,
            );
          }
          throw corrupt(
            `Managed Session Store returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
          );
        }
      },
      contentionDeadline,
    );
  }

  /**
   * Reads are idempotent and the lease renewal is fenced by generation, so
   * a dropped connection or a transient 5xx there — at any point of the
   * exchange, body streaming included — must not masquerade as missing
   * history on a cold restore. Those calls retry the whole exchange twice
   * with a short jittered backoff, all inside one `requestTimeoutMs`
   * budget, so a wedged endpoint blocks no longer than before. Commits are
   * not retried here for transport failures; their callers handle that
   * outcome themselves. A bounded `tenant_guard_contended` refusal is the
   * exception: the store rolled the transaction back before writing
   * anything, so it is a definite non-commit and is retried on any route,
   * commits included, until the call's budget (or the caller's shared
   * contention deadline) is spent. A terminal failure names the endpoint
   * and, once a retry actually ran, the attempt count.
   */
  private async withRetry<T>(
    retryable: boolean,
    method: 'GET' | 'POST',
    path: string,
    run: (timeoutMs: number) => Promise<T>,
    contentionDeadline?: number,
  ): Promise<T> {
    const deadline = Date.now() + this.requestTimeoutMs;
    // A caller that retries this helper itself passes one contention
    // deadline for all of its calls, so their guard retries share a single
    // budget instead of each restarting a fresh requestTimeoutMs (#13800).
    const guardDeadline = Math.min(deadline, contentionDeadline ?? deadline);
    let attempt = 0;
    // Guard retries are counted apart so they never spend the transient
    // path's three-attempt allowance.
    let guardRetries = 0;
    // The latest contention refusal seen: when the shared deadline
    // aborts a later attempt instead of the store answering again, the
    // terminal throw keeps the guard's own name instead of renaming it
    // a transport failure (#13800 R1-7).
    let contendedRefusal: ManagedSessionStoreHttpError | undefined;
    for (;;) {
      attempt++;
      try {
        // Guard retries run inside the caller's shared contention deadline:
        // a slower guard answer aborts there rather than each retry
        // restarting the full requestTimeoutMs (#13800 P2). A call's first
        // attempt keeps its own budget, so a restart the caller earned after
        // a non-contention failure is not issued already expired (#13800
        // R2-2).
        const attemptDeadline = guardRetries > 0 ? guardDeadline : deadline;
        return await run(Math.max(1, attemptDeadline - Date.now()));
      } catch (error) {
        // A bounded tenant-guard wait is a definite non-commit: the store
        // rolled the transaction back before writing anything. Keep retrying
        // it — on any route — for the rest of this request budget instead of
        // spending the three-attempt cap in ~15 s and latching the Session's
        // writes behind a contention window it could have outlasted (#13800).
        const contended =
          error instanceof ManagedSessionStoreHttpError &&
          error.status === 503 &&
          error.remoteCode === 'tenant_guard_contended';
        if (contended) contendedRefusal = error;
        if (contended && guardDeadline - Date.now() > 250) {
          debugLogger.debug(
            `Managed Session Store ${method} ${path} attempt ${attempt} found the tenant guard contended; retrying.`,
          );
          guardRetries++;
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        const transient =
          error instanceof ManagedSessionStoreTransportError ||
          (error instanceof ManagedSessionStoreHttpError &&
            [500, 502, 503, 504].includes(error.status));
        // Past its window a contended guard is terminal: a transient retry
        // there would only time out and rename it a transport failure.
        if (
          !retryable ||
          !transient ||
          contended ||
          attempt - guardRetries >= 3 ||
          Date.now() >= deadline
        ) {
          if (
            contendedRefusal !== undefined &&
            guardDeadline - Date.now() <= 250
          ) {
            throw new ManagedSessionStoreHttpError(
              contendedRefusal.status,
              contendedRefusal.remoteCode,
              attempt > 1
                ? `Managed Session Store ${method} ${path} failed after ${attempt} attempts: ${contendedRefusal.message}`
                : `Managed Session Store ${method} ${path} failed: ${contendedRefusal.message}`,
              // Report upward whether guard retries actually consumed
              // the shared budget (#13800 R2-2): a first attempt that
              // only collided with the near-deadline instant did not
              // spend it, and the caller's restart stays allowed.
              guardRetries > 0 || undefined,
              contendedRefusal.details,
              contendedRefusal.route,
            );
          }
          if (transient) {
            const detail =
              attempt > 1
                ? `Managed Session Store ${method} ${path} failed after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}`
                : `Managed Session Store ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`;
            if (error instanceof ManagedSessionStoreHttpError)
              throw new ManagedSessionStoreHttpError(
                error.status,
                error.remoteCode,
                detail,
                undefined,
                error.details,
                error.route,
              );
            if (error instanceof ManagedSessionStoreTransportError)
              throw new ManagedSessionStoreTransportError(detail);
          }
          throw error;
        }
        debugLogger.debug(
          `Managed Session Store ${method} ${path} attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}); retrying.`,
        );
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            200 * (attempt - guardRetries) + Math.floor(Math.random() * 100),
          ),
        );
      }
    }
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Readonly<Record<string, unknown>>,
    timeoutMs = this.requestTimeoutMs,
    accept = 'application/json',
  ): Promise<Response> {
    if (this.locallyStopped) {
      throw new ManagedSessionRecordError(
        'the HTTP Managed Session writer is locally stopped.',
      );
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${this.sessionUrl()}${path}`, {
        method,
        redirect: 'error',
        headers: {
          Accept: accept,
          'X-Qwen-Managed-Max-Readable-Storage-Version': '2',
          [HTTP_MANAGED_SESSION_STORE_CONTRACT.tenantHeader]:
            this.sessionKey.tenantId,
          [HTTP_MANAGED_SESSION_STORE_CONTRACT.writerTokenHeader]:
            this.writerToken,
          ...(this.lifecycleAuthority
            ? {
                'X-Qwen-Lifecycle-Operation-Id':
                  this.lifecycleAuthority.operationId,
                'X-Qwen-Lifecycle-Claim-Generation': String(
                  this.lifecycleAuthority.claimGeneration,
                ),
              }
            : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ManagedSessionStoreTransportError(
        `Managed Session Store request failed: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    if (!response.ok) {
      const error = await readHttpError(response);
      // Record the refusing route alongside the code (review #14522): the
      // public message is shared across server predicates, so the route
      // must travel in its own field, not the printable text.
      throw new ManagedSessionStoreHttpError(
        response.status,
        error.code,
        error.message,
        undefined,
        error.details,
        `${method} ${path}`,
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

export function describeTransaction(
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
      refs: dedupeRefs([
        header.definitionRef,
        header.rootSnapshotRef,
        ...(header.baseTranscriptProof === undefined
          ? []
          : [header.baseTranscriptProof]),
      ]),
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
    refs: dedupeRefs(
      eventRecords.flatMap((event) => managedSessionEventRefs(event)),
    ),
  };
}

function dedupeRefs(
  found: Iterable<ManagedSessionDurableRef>,
): ManagedSessionDurableRef[] {
  const refs = new Map<string, ManagedSessionDurableRef>();
  for (const ref of found) {
    const existing = refs.get(ref.resourceId);
    if (existing !== undefined) requireSameRef(existing, ref);
    else refs.set(ref.resourceId, ref);
  }
  return [...refs.values()];
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

export interface StoredTransaction {
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

export function parseStoredTransaction(value: unknown): StoredTransaction {
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

export function requireStoredTransactionMatches(
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
    supportedStorageVersion:
      record['supportedStorageVersion'] === undefined
        ? 1
        : safeCounter(
            record['supportedStorageVersion'],
            'supportedStorageVersion',
          ),
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

/**
 * Every ref a committed resource closes over transitively. Exported so the
 * envelope-closure invariant (a `managed-input` carrying attachment refs)
 * has a directly testable seam.
 */
export function collectNestedResourceRefs(
  ref: ManagedSessionDurableRef,
  bytes: Buffer,
): ManagedSessionDurableRef[] {
  if (ref.kind === MANAGED_MESSAGE_CHUNKS_KIND) {
    return managedMessageChunkParts(ref.kind, bytes);
  }
  if (ref.kind === 'managed-tool-outcome-chunks') {
    const manifest = asRecord(
      JSON.parse(bytes.toString('utf8')),
      'outcome chunks',
    );
    if (Object.keys(manifest).length !== 1 || !('parts' in manifest)) {
      throw corrupt('outcome chunk manifest fields conflict.');
    }
    const parts = asArray(manifest['parts'], 'outcome parts');
    if (parts.length < 2 || parts.length > 69) {
      throw corrupt('outcome chunk count exceeds its bounds.');
    }
    return parts.map((part) => {
      const checked = assertManagedSessionDurableRef(
        part as ManagedSessionJsonValue,
        'outcome chunk part',
      );
      if (checked.kind !== 'managed-tool-outcome-part') {
        throw corrupt('outcome chunks must reference outcome parts.');
      }
      return checked;
    });
  }
  if (ref.kind === 'managed-checkpoint') {
    const parsed = tryParseHarnessCheckpointV1(bytes);
    return parsed.ok ? collectRefs([parsed.checkpoint]) : [];
  }
  if (ref.kind === 'managed-file_history') {
    const record = asRecord(
      parseManagedSessionRecordJson(
        bytes.toString('utf8'),
        MANAGED_SESSION_LIMITS.maxEventBytes,
      ),
      'file history',
    );
    // Only `preparation` is walked: a bind/result record's previousRecordRef
    // belongs to its original journal transaction, while a prepared record
    // re-admits its predecessor through preparation.intentRef, which SQL's
    // activation proof reads from this transaction.
    return record['schemaVersion'] === 2 &&
      record['profile'] === 'csi-files-retirement/1'
      ? collectRefs([record['preparation']])
      : [];
  }
  if (HOSTED_RECOVERY_RESOURCE_KINDS.has(ref.kind)) {
    return hostedRecoveryReferences(
      parseHostedRecoveryResource(bytes, undefined, ref.kind),
    );
  }
  if (
    EXTENSION_RECORD_KINDS.has(ref.kind) ||
    ref.kind === 'managed-definition' ||
    ref.kind === 'managed-action-options' ||
    ref.kind === 'managed-hook-plan' ||
    ref.kind === 'managed-hook-message-chunks'
  ) {
    const record = parseManagedSessionRecordJson(
      bytes.toString('utf8'),
      MANAGED_SESSION_LIMITS.maxEventBytes,
    );
    if (ref.kind === 'managed-hook-plan')
      return collectRefs([(record as { messagesRef?: unknown }).messagesRef]);
    if (ref.kind === 'managed-hook-message-chunks')
      return collectRefs((record as { parts: unknown[] }).parts);
    return collectRefs([record]);
  }
  // A result manifest names its page envelopes: they are Session resources
  // too, staged exactly like the manifest, and a commit that closes over
  // the manifest but not its pages would leave the Artifact's read chain
  // 404ing on the page hop (#13856). A body this parse cannot represent
  // has no pages to close over, exactly like the input branch below.
  if (ref.kind === MANAGED_TOOL_RESULT_KINDS.manifest) {
    try {
      return collectRefs([parseToolResultManifestBytes(bytes)]);
    } catch {
      return [];
    }
  }
  // An input's envelope embeds what it admits — a channel attachment's ref
  // among them. The commit closes over those bytes exactly like an
  // explicit ref, or a reopened reader finds the envelope but 404s on its
  // attachments (R8 P1). A body this parse cannot represent has no refs
  // to close over by definition.
  if (ref.kind === 'managed-input') {
    try {
      return collectRefs([
        parseManagedSessionRecordJson(
          bytes.toString('utf8'),
          MANAGED_SESSION_LIMITS.maxEventBytes,
        ),
      ]);
    } catch {
      return [];
    }
  }
  return [];
}

function isReferenceContainer(kind: string): boolean {
  return (
    EXTENSION_RECORD_KINDS.has(kind) ||
    HOSTED_RECOVERY_RESOURCE_KINDS.has(kind) ||
    [
      'managed-definition',
      'managed-checkpoint',
      'managed-file_history',
      'managed-action-options',
      'managed-hook-plan',
      'managed-hook-message-chunks',
      MANAGED_MESSAGE_CHUNKS_KIND,
      'managed-tool-outcome-chunks',
    ].includes(kind)
  );
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

async function readHttpError(response: Response): Promise<{
  code: string;
  message: string;
  details?: Record<string, string | number | boolean>;
}> {
  try {
    const body = asRecord((await response.json()) as unknown, 'error response');
    const error = asRecord(body['error'], 'error');
    const details: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(error))
      if (
        key !== 'code' &&
        key !== 'message' &&
        (typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean')
      )
        details[key] = value;
    return {
      code: string(error['code'], 'error.code'),
      message: string(error['message'], 'error.message'),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
  } catch {
    return {
      code: 'managed_session_store_http_error',
      message: `Managed Session Store returned HTTP ${response.status}.`,
    };
  }
}

async function readBoundedPublicationJson(
  response: Response,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw corrupt('Publication response has no body.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 4 * 1024 * 1024)
        throw corrupt('Publication response exceeds its byte limit.');
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
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
