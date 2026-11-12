/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ChatRecord } from '../services/chatRecordingService.js';
import {
  getManagedExecutionDiagnostics,
  executionDiagnosticDigest,
  type ManagedInvocationObservation,
} from './managed-execution-diagnostics.js';
import {
  assertManagedSessionDurableRef,
  MANAGED_SESSION_FORMAT_VERSION,
  ManagedSessionRecordError,
  managedSessionReaderFacingBody,
  safeErrorValue,
  validateManagedReaderFacingRecord,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
  type ManagedSessionKey,
} from './managed-session-records.js';
import {
  readManagedSessionLog,
  type LocalManagedSessionAuthority,
  type ManagedSessionActor,
  type ManagedSessionCommand,
  type ManagedSessionCommitReceipt,
} from './managed-session-authority.js';
import {
  MANAGED_MESSAGE_KIND,
  publishManagedMessageBody,
  readManagedMessageBody,
} from './managed-message-chunks.js';
import {
  LocalManagedSessionResourceStore,
  readManagedBranchCheckpoint,
} from './managed-session-resources.js';
import type {
  ManagedSessionJournalScan,
  ManagedSessionResourceStore,
} from './managed-session-storage.js';

/**
 * Charged bytes (bodies plus a fixed per-entry overhead) of the verified
 * message bodies that the projections of one process keep.
 * A Harness rebuilds a Session's history from its message bodies several times
 * per Turn; without a cache every rebuild read every body of the Session again.
 * The bound keeps resident Sessions from each holding their whole history:
 * active Sessions stay warm and idle ones fall out first, except that a Session
 * found to exceed the bound on its own only uses free room (see
 * `ManagedMessageBodyCache`).
 */
export const MANAGED_MESSAGE_BODY_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * What the cache charges each entry on top of its body: the key, the map entry,
 * the buffer objects and the buffer's own allocation, measured at 520 to 740
 * bytes on Node 22 and rounded up, so that many small bodies cannot hold
 * several times the bound.
 */
export const MANAGED_MESSAGE_BODY_ENTRY_BYTES = 768;

/** The cached bodies of one resource store, least recently read first. */
interface StoreBodies {
  readonly entries: Map<string, Buffer>;
  /** Charged bytes of the entries. */
  bytes: number;
  /**
   * Keeping another of the store's own bodies, one that fits the bound alone,
   * once would have taken them past the bound.
   */
  oversized: boolean;
}

function bodyKey(ref: ManagedSessionDurableRef): string {
  return [
    ref.resourceId,
    ref.kind,
    ref.schemaVersion,
    ref.byteLength,
    ref.digest,
  ].join('\u0000');
}

/**
 * Message bodies already read through a projection, or handed over by a caller
 * that read them through the same store (`remember`). A body is immutable and
 * its ref names its kind, length and digest, so an entry is exactly the body
 * the store's verified read returned for that ref, assembled whole for a
 * chunked one. A cached body is not read through the store again, so a store
 * check that runs on every read, such as a writer fence, no longer runs for
 * it. Entries are kept per resource store, so Sessions never share them, and a
 * store's entries are released when the store itself is collected. Only reads
 * fill the cache, a projection's own or one the caller made through the same
 * store and hands over (`remember`): a body nobody has read through the store
 * is still read from it, and fails the projection if the store no longer has
 * it.
 *
 * The resource store's own read contract does not change. Readers that open
 * their own store, such as `readManagedSessionRecords`, read it on every call,
 * so if a store loses a body that a committed event references, they fail,
 * while a projection whose cache kept that body keeps serving it until the
 * entry is evicted or its store object is collected. Losing such a body is
 * damage: while the Session can still be read, nothing removes it.
 *
 * A projection reads every body of its Session in commit order, so plain LRU
 * would let a Session whose bodies exceed the bound evict each body just
 * before its next projection reached it, and never hit. Instead a store never
 * evicts its own bodies to keep a new one: such a Session keeps the bodies it
 * kept first and reads the rest from the store. Room for a new body comes from
 * the other stores, the store least recently hit or kept first and, within
 * it, its least recently read bodies first. A body whose charge alone exceeds
 * the bound is returned but never kept, and does not cap its store. Once
 * keeping another of a store's own bodies would take them past the bound, the
 * store only uses free room from then on (room no store holds, such as what a
 * collected store or an eviction leaves) and never takes room from another
 * store, idle or not. Such a Session reads part
 * of its history from the store on every projection anyway; letting it take
 * room back would make the Sessions it took the room from re-read their whole
 * history instead, every time they and it alternate. The flag only sees what
 * a store holds, so two such Sessions projecting at the same time can keep
 * displacing each other before either holds the bound alone. At worst a
 * Session reads as it did without the cache.
 *
 * Every entry is charged its body's length plus a fixed overhead, and the
 * body is kept in a buffer of its own, so a slice of a pooled buffer does not
 * pin the whole pool. The returned buffer is shared with the cache and must
 * not be modified.
 */
export class ManagedMessageBodyCache {
  private readonly stores = new WeakMap<
    ManagedSessionResourceStore,
    StoreBodies
  >();
  /** Stores holding bodies, least recently hit or kept first. */
  private readonly order = new Set<StoreBodies>();
  private readonly collected = new FinalizationRegistry<StoreBodies>((bodies) =>
    this.release(bodies),
  );
  private size = 0;

  constructor(
    private readonly limitBytes: number,
    private readonly entryBytes: number = MANAGED_MESSAGE_BODY_ENTRY_BYTES,
  ) {}

  /** Charged bytes of every entry. */
  get bytes(): number {
    return this.size;
  }

  async read(
    resources: ManagedSessionResourceStore,
    ref: ManagedSessionDurableRef,
  ): Promise<Buffer> {
    const bodies = this.bodiesOf(resources);
    const key = bodyKey(ref);
    const cached = bodies.entries.get(key);
    if (cached !== undefined) {
      bodies.entries.delete(key);
      bodies.entries.set(key, cached);
      this.touch(bodies);
      return cached;
    }
    const body = await readManagedMessageBody(
      (bodyRef) => resources.read(bodyRef),
      ref,
    );
    return this.keep(bodies, key, body);
  }

  /**
   * Keeps a body as if a projection had read it, so the next projection of
   * that store does not read it again. The caller must have read `body`
   * through `resources.read` itself, the store's verified read, for example
   * while verifying the resources a journal references before projecting it.
   *
   * Only a `managed-message` body qualifies. The entry of a chunked one
   * (`managed-message-chunks`) is the body assembled from its parts, not the
   * manifest its ref names. Bytes that do not match the ref's length and
   * digest are not kept. The cache may keep `body` itself, so the caller must
   * not modify it afterwards; a slice of a larger buffer is kept as a copy.
   */
  remember(
    resources: ManagedSessionResourceStore,
    ref: ManagedSessionDurableRef,
    body: Buffer,
  ): void {
    if (
      ref.kind !== MANAGED_MESSAGE_KIND ||
      body.byteLength !== ref.byteLength ||
      createHash('sha256').update(body).digest('hex') !== ref.digest
    )
      return;
    this.keep(this.bodiesOf(resources), bodyKey(ref), body);
  }

  private bodiesOf(resources: ManagedSessionResourceStore): StoreBodies {
    let bodies = this.stores.get(resources);
    if (bodies === undefined) {
      bodies = { entries: new Map(), bytes: 0, oversized: false };
      this.stores.set(resources, bodies);
      this.collected.register(resources, bodies);
    }
    return bodies;
  }

  /** Keeps `body` under `key` if the bound allows, and returns what to serve. */
  private keep(bodies: StoreBodies, key: string, body: Buffer): Buffer {
    const cost = body.byteLength + this.entryBytes;
    // An entry may exist already: a concurrent read of the same ref, or a
    // handed-over body, kept it.
    if (cost > this.limitBytes || bodies.entries.has(key)) return body;
    if (bodies.bytes + cost > this.limitBytes) {
      bodies.oversized = true;
      return body;
    }
    if (bodies.oversized && this.size + cost > this.limitBytes) return body;
    let kept = body;
    if (body.buffer.byteLength !== body.byteLength) {
      // Buffer.from would copy into the shared pool again.
      kept = Buffer.allocUnsafeSlow(body.byteLength);
      body.copy(kept);
    }
    bodies.entries.set(key, kept);
    bodies.bytes += cost;
    this.size += cost;
    this.touch(bodies);
    this.evict();
    return kept;
  }

  private touch(bodies: StoreBodies): void {
    this.order.delete(bodies);
    this.order.add(bodies);
  }

  /**
   * The store that just kept a body is the most recently read and holds at
   * most the bound, so the other stores make room before the loop reaches it.
   */
  private evict(): void {
    for (const bodies of this.order) {
      if (this.size <= this.limitBytes) return;
      for (const [key, body] of bodies.entries) {
        if (this.size <= this.limitBytes) break;
        bodies.entries.delete(key);
        bodies.bytes -= body.byteLength + this.entryBytes;
        this.size -= body.byteLength + this.entryBytes;
      }
      if (bodies.entries.size === 0) this.order.delete(bodies);
    }
  }

  private release(bodies: StoreBodies): void {
    this.order.delete(bodies);
    this.size -= bodies.bytes;
    bodies.entries.clear();
    bodies.bytes = 0;
  }
}

const sharedMessageBodies = new ManagedMessageBodyCache(
  MANAGED_MESSAGE_BODY_CACHE_BYTES,
);

/**
 * Carries the existing transcript history inside the authoritative log.
 *
 * A Managed session must not append an equivalent legacy record beside each
 * committed event, so the domain content is the only copy and every reader-facing
 * record is projected back out of it. Storing the whole original record as the
 * content body is what makes that projection lossless: subtype, message parts,
 * usage metadata and tool-call details all survive, while the event carries the
 * identity and ordering facts a reader indexes on.
 */
export class ManagedSessionMessageProjection {
  constructor(
    private readonly authority: LocalManagedSessionAuthority,
    private readonly resources: ManagedSessionResourceStore,
    private readonly bodies: ManagedMessageBodyCache = sharedMessageBodies,
  ) {}

  /**
   * Commits one record as a `message.committed` event. The caller supplies the
   * actor: the current Harness for model-facing records, or a trusted entry for
   * the projected form of an accepted input, which has no activation to name.
   */
  async commit(
    command: ManagedSessionCommand,
    input: {
      record: ChatRecord;
      modelAttemptId?: string | null;
      diagnostics?: readonly ManagedInvocationObservation[];
    },
    actor: ManagedSessionActor,
  ): Promise<{ receipt: ManagedSessionCommitReceipt; messageId: string }> {
    const record = input.record;
    if (typeof record.uuid !== 'string' || record.uuid.length === 0) {
      throw new ManagedSessionRecordError(
        'a projected record must carry its own uuid.',
      );
    }
    const body = Buffer.from(JSON.stringify(record), 'utf8');
    const contentRef = await publishManagedMessageBody(this.resources, body);
    const diagnosticsRef = await getManagedExecutionDiagnostics(
      this.authority,
    )?.message(record, input.diagnostics);
    const subject =
      actor.class === 'harness' && actor.activation !== undefined
        ? {
            type: 'activation',
            scopeId: actor.activation.activationId,
            activationId: actor.activation.activationId,
            epoch: actor.activation.epoch,
          }
        : undefined;
    const receipt = await this.authority.appendExecutionEvent(
      diagnosticsRef
        ? {
            ...command,
            contentDigest: executionDiagnosticDigest(
              contentRef.digest,
              diagnosticsRef,
            ),
          }
        : command,
      (sequence) => ({
        v: MANAGED_SESSION_FORMAT_VERSION,
        sequence,
        eventId: `message:${record.uuid}`,
        sessionKey: command.sessionKey,
        kind: 'message.committed',
        occurredAt: Date.parse(record.timestamp) || Date.now(),
        ...(subject === undefined ? {} : { subject }),
        payload: {
          messageId: record.uuid,
          role: record.type,
          contentRef,
          ...(diagnosticsRef ? { diagnosticsRef } : {}),
          parentMessageId: record.parentUuid,
          ...(input.modelAttemptId === undefined
            ? {}
            : { modelAttemptId: input.modelAttemptId }),
        },
      }),
      actor,
    );
    return { receipt, messageId: record.uuid };
  }

  /**
   * Rebuilds the reader-facing records from the committed prefix, in commit
   * order. A content body that cannot be resolved fails the projection rather
   * than silently dropping a record, which would present a short history as a
   * complete one.
   *
   * Deliberately narrower than the reader-facing list: this projection
   * carries branch checkpoints and committed messages only. Turn results,
   * compaction summaries and record-carrying domains are projected by
   * `projectManagedSessionRecords` — the reader-facing list used both to
   * rebuild a session for a reader and by the live recorder's chain view
   * (`ChatRecordingService.readActiveTranscriptChain`).
   */
  async project(throughSequence?: number): Promise<ChatRecord[]> {
    return this.projectRecords(throughSequence, false);
  }

  /**
   * Hands a message body the caller read through this projection's own
   * store to the body cache, so that projecting does not read it again (see
   * `ManagedMessageBodyCache.remember`).
   */
  rememberBody(ref: ManagedSessionDurableRef, body: Buffer): void {
    this.bodies.remember(this.resources, ref, body);
  }

  async projectModelRecords(throughSequence?: number): Promise<ChatRecord[]> {
    return this.projectRecords(throughSequence, true);
  }

  private async projectRecords(
    throughSequence: number | undefined,
    includeCompactions: boolean,
  ): Promise<ChatRecord[]> {
    return projectManagedModelRecords(
      this.authority.eventsInSequenceRange(
        1,
        throughSequence ?? this.authority.committedSequence,
      ),
      this.resources,
      throughSequence ?? this.authority.committedSequence,
      {
        includeCompactions,
        readBody: (ref) => this.bodies.read(this.resources, ref),
      },
    );
  }
}

/** Pure journal projection shared by live Sessions and frozen side queries. */
export async function projectManagedModelRecords(
  events: Iterable<ManagedSessionEvent>,
  resources: ManagedSessionResourceStore,
  throughSequence: number,
  options: {
    includeCompactions?: boolean;
    readBody?: (ref: ManagedSessionDurableRef) => Promise<Buffer>;
  } = {},
): Promise<ChatRecord[]> {
  const records: ChatRecord[] = [];
  const checkpoints = new Map<string, number>();
  const readBody =
    options.readBody ??
    ((ref) => readManagedMessageBody((part) => resources.read(part), ref));
  for (const event of events) {
    if (event.sequence > throughSequence) break;
    const branch = await readManagedBranchCheckpoint(
      event,
      resources,
      (id) => checkpoints.get(id),
      throughSequence,
    );
    if (event.kind === 'checkpoint.committed')
      checkpoints.set(event.payload['checkpointId'] as string, event.sequence);
    if (branch !== undefined) records.push(branch);
    else if (
      event.kind === 'message.committed' ||
      (options.includeCompactions && event.kind === 'context.compacted')
    ) {
      const ref = assertManagedSessionDurableRef(
        event.payload[
          event.kind === 'context.compacted' ? 'summaryRef' : 'contentRef'
        ],
        `${event.kind} event ${event.eventId} body`,
      );
      records.push(
        JSON.parse((await readBody(ref)).toString('utf8')) as ChatRecord,
      );
    }
  }
  return records;
}

async function readRecordBody(
  resources: ManagedSessionResourceStore,
  ref: ManagedSessionEvent['payload'][string],
  at: string,
): Promise<ChatRecord> {
  const body = await readManagedMessageBody(
    (bodyRef) => resources.read(bodyRef),
    assertManagedSessionDurableRef(ref, at),
  );
  return JSON.parse(body.toString('utf8')) as ChatRecord;
}

/**
 * Projects a Managed session's reader-facing records without taking the writer.
 *
 * Session loading runs on paths that never write, so it cannot go through the
 * authority: acquiring a lease there would fight the live writer and fail for a
 * session that is merely being read. The committed prefix is the whole history,
 * so a torn or uncommitted tail left by a crashed writer is simply not part of
 * what a reader sees.
 *
 * Every channel that carries a whole original record is projected, in commit
 * order; `readerFacingBody` is the list of them.
 */
export async function readManagedSessionRecords(options: {
  readonly transcriptPath: string;
  readonly runtimeBaseDir: string;
  readonly sessionKey: ManagedSessionKey;
  /** Bounds the projection to a frozen snapshot's byte length. */
  readonly maxBytes?: number;
}): Promise<ChatRecord[]> {
  const scan = await readManagedSessionLog(options);
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: options.runtimeBaseDir,
    sessionKey: options.sessionKey,
  });
  return projectManagedSessionRecords({ scan, resources });
}

/**
 * The records a reader replays together with the session's title, from one
 * read of the log. The title is the last one committed anywhere in the log,
 * not only in the windows at each end that the session list scans. A title
 * whose body cannot be read is reported as none, as the session list reports
 * it: a damaged title costs the title, not the session.
 */
export async function readManagedSessionRecordsAndTitle(options: {
  readonly transcriptPath: string;
  readonly runtimeBaseDir: string;
  readonly sessionKey: ManagedSessionKey;
  /** Bounds the projection to a frozen snapshot's byte length. */
  readonly maxBytes?: number;
}): Promise<{
  records: ChatRecord[];
  titleInfo: { title?: string; source?: 'auto' | 'manual' };
}> {
  const scan = await readManagedSessionLog(options);
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: options.runtimeBaseDir,
    sessionKey: options.sessionKey,
  });
  const records = await projectManagedSessionRecords({ scan, resources });
  let titleInfo: { title?: string; source?: 'auto' | 'manual' } = {};
  try {
    titleInfo = await projectManagedSessionTitleInfo({ scan, resources });
  } catch {
    // Reported as no title.
  }
  return { records, titleInfo };
}

/** Projects an already-verified durable journal through its resource store. */
export async function projectManagedSessionRecords(options: {
  readonly scan: ManagedSessionJournalScan;
  readonly resources: ManagedSessionResourceStore;
}): Promise<ChatRecord[]> {
  const { scan, resources } = options;
  if (scan.header === undefined) {
    throw new ManagedSessionRecordError(
      'session log has no Managed header, so it cannot be projected.',
    );
  }
  const records: ChatRecord[] = [];
  const checkpoints = new Map<string, number>();
  for (const event of scan.events) {
    const branch = await readManagedBranchCheckpoint(
      event,
      resources,
      (id) => checkpoints.get(id),
      scan.committed,
    );
    if (event.kind === 'checkpoint.committed') {
      checkpoints.set(event.payload['checkpointId'] as string, event.sequence);
    }
    if (branch !== undefined) {
      records.push(
        requireProjectedRecord(
          branch,
          scan.header.sessionKey.sessionId,
          `${event.kind} event ${event.eventId} ref`,
        ),
      );
      continue;
    }
    const carried = managedSessionReaderFacingBody(event);
    if (carried === undefined) continue;
    const body: unknown = await readRecordBody(
      resources,
      carried.ref,
      `${event.kind} event ${event.eventId} ref`,
    );
    records.push(
      requireProjectedRecord(
        carried.inDomainEnvelope
          ? body !== null && typeof body === 'object'
            ? (body as { readonly record?: unknown }).record
            : undefined
          : body,
        scan.header.sessionKey.sessionId,
        `${event.kind} event ${event.eventId} ref`,
      ),
    );
  }
  return records;
}

/** Restores the latest committed title metadata from a durable journal. */
export async function projectManagedSessionTitleInfo(options: {
  readonly scan: ManagedSessionJournalScan;
  readonly resources: ManagedSessionResourceStore;
}): Promise<{ title?: string; source?: 'auto' | 'manual' }> {
  const { scan, resources } = options;
  if (scan.header === undefined) {
    throw new ManagedSessionRecordError(
      'session log has no Managed header, so it cannot be projected.',
    );
  }
  const event = scan.events.findLast(
    (candidate) =>
      candidate.kind === 'domain.committed' &&
      candidate.payload['domain'] === 'session_metadata',
  );
  if (event === undefined) return {};
  const body = JSON.parse(
    (
      await resources.read(
        event.payload['recordRef'] as unknown as ManagedSessionDurableRef,
      )
    ).toString('utf8'),
  ) as { title?: unknown; titleSource?: unknown };
  if (typeof body.title !== 'string' || body.title.length === 0) return {};
  return {
    title: body.title,
    ...(body.titleSource === 'auto' || body.titleSource === 'manual'
      ? { source: body.titleSource }
      : {}),
  };
}

function requireProjectedRecord(
  value: unknown,
  sessionId: string,
  at: string,
): ChatRecord {
  const validated = validateManagedReaderFacingRecord(value, sessionId);
  if ('error' in validated) {
    // The reason is bounded the way the writer fence's own message is: the
    // predicate interpolates values decoded from the stored body.
    throw new ManagedSessionRecordError(
      `Managed Session resource contains an invalid reader-facing record: ${safeErrorValue(validated.error)} (${at}).`,
    );
  }
  return validated.record;
}
