/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  AUTO_MEMORY_SNAPSHOT_METADATA,
  findLatestAutoMemorySnapshot,
} from '../memory/request-context.js';
import { isLocalCommandTranscriptPair } from '../services/session-api-history.js';
import {
  aggregateTranscriptRecordFragments,
  isTranscriptConversationRecord,
  isInternalCodeModeToolResult,
} from '../utils/transcript-records.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
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
import type { ManagedHistoryMap } from './managed-session-history.js';

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
  ) {}

  /**
   * Commits one record as a `message.committed` event. The caller supplies the
   * actor: the current Harness for model-facing records, or a trusted entry for
   * the projected form of an accepted input, which has no activation to name.
   */
  async commit(
    command: ManagedSessionCommand,
    input: { record: ChatRecord; modelAttemptId?: string | null },
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
      command,
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
    const records: ChatRecord[] = [];
    for await (const record of this.iterateMessageRecords(throughSequence))
      records.push(record);
    return records;
  }

  async projectModelRecords(throughSequence?: number): Promise<ChatRecord[]> {
    return this.contextRecords(throughSequence, true);
  }

  async projectContextRecords(throughSequence?: number): Promise<ChatRecord[]> {
    return this.contextRecords(throughSequence, false);
  }

  async *iterateRecords(
    throughSequence = this.authority.committedSequence,
  ): AsyncGenerator<ChatRecord> {
    for await (const { record } of this.projectedEvents(1, throughSequence))
      yield record;
  }

  async *iterateActiveRecords(
    throughSequence = this.authority.committedSequence,
  ): AsyncGenerator<ChatRecord> {
    const scratch = this.authority.createQueryHistory();
    try {
      const identities = scratch.map<{
        parentUuid: string | null;
        first: number;
        last: number;
      }>('resource');
      const fragments = scratch.map<number>('resource-pending');
      const order = scratch.map<number>('command');
      let leaf: string | undefined;
      for await (const { event, record } of this.projectedEvents(
        1,
        throughSequence,
      )) {
        if (!isTranscriptConversationRecord(record)) continue;
        const previous = await identities.get(record.uuid);
        if (previous && previous.parentUuid !== record.parentUuid)
          throw new ManagedSessionRecordError(
            'Transcript fragments disagree on their parent.',
          );
        if (previous) await fragments.set(previous.last, event.sequence);
        await fragments.set(event.sequence, 0);
        await identities.set(record.uuid, {
          parentUuid: record.parentUuid,
          first: previous?.first ?? event.sequence,
          last: event.sequence,
        });
        leaf = record.uuid;
      }
      let length = 0;
      let id: string | null | undefined = leaf;
      while (id) {
        const identity = await identities.get(id);
        if (!identity) break;
        if (length >= identities.size)
          throw new ManagedSessionRecordError(
            'Active transcript contains a parent cycle.',
          );
        await order.set(length++, identity.first);
        id = identity.parentUuid;
      }
      for (let position = length - 1; position >= 0; position--)
        yield await this.aggregateFragments(
          (await order.get(position))!,
          fragments,
        );
    } finally {
      await scratch.close();
    }
  }

  private async aggregateFragments(
    first: number,
    fragments: ManagedHistoryMap<number>,
  ): Promise<ChatRecord> {
    let result: ChatRecord | undefined;
    for (let sequence = first; sequence; ) {
      const event = await this.authority
        .iterateEvents(sequence, sequence)
        .at(0);
      const record = event && (await this.recordAt(event));
      if (!record)
        throw new ManagedSessionRecordError(
          'Transcript fragment has no canonical record.',
        );
      result = result
        ? (aggregateTranscriptRecordFragments([result, record]) as ChatRecord)
        : record;
      const next = await fragments.get(sequence);
      if (next === undefined || (next !== 0 && next <= sequence))
        throw new ManagedSessionRecordError(
          'Transcript fragment chain is incomplete.',
        );
      sequence = next;
    }
    return result!;
  }

  private async *projectedEvents(
    from: number,
    through: number,
  ): AsyncGenerator<{
    event: ManagedSessionEvent;
    record: ChatRecord;
  }> {
    for await (const event of this.authority.iterateEvents(from, through)) {
      const record = await this.recordAt(event);
      if (record) yield { event, record };
    }
  }

  async recordAt(event: ManagedSessionEvent): Promise<ChatRecord | undefined> {
    const branch = await readManagedBranchCheckpoint(
      event,
      this.resources,
      (id) => this.authority.checkpointSequence(id, event.sequence - 1),
      event.sequence - 1,
    );
    if (branch) return branch;
    const carried = managedSessionReaderFacingBody(event);
    if (!carried) return undefined;
    const body = await readRecordBody(
      this.resources,
      carried.ref,
      `${event.kind} ${event.eventId}`,
    );
    return requireProjectedRecord(
      carried.inDomainEnvelope
        ? (body as unknown as { record?: unknown }).record
        : body,
      event.sessionKey.sessionId,
      `${event.kind} ${event.eventId}`,
    );
  }

  async *iterateMessageRecords(
    throughSequence = this.authority.committedSequence,
  ): AsyncGenerator<ChatRecord> {
    for await (const { event, record } of this.projectedEvents(
      1,
      throughSequence,
    )) {
      if (this.isProjectionEvent(event) && event.kind !== 'context.compacted')
        yield record;
    }
  }

  private isProjectionEvent(event: ManagedSessionEvent): boolean {
    return (
      event.kind === 'message.committed' ||
      event.kind === 'context.compacted' ||
      (event.kind === 'checkpoint.committed' &&
        assertManagedSessionDurableRef(
          event.payload['stateRef'],
          'checkpoint state',
        ).kind === 'managed-branch-checkpoint')
    );
  }

  private isContextCandidate(record: ChatRecord, modelOnly: boolean): boolean {
    if (isInternalCodeModeToolResult(record)) return false;
    if (record.type !== 'system')
      return (
        record.subtype !== 'realtime_message' && record.message !== undefined
      );
    return (
      [
        'memory_catalog_snapshot',
        'slash_command',
        'goal_turn_end',
        'chat_compression',
      ].includes(record.subtype ?? '') ||
      (!modelOnly && record.subtype === 'branch_checkpoint')
    );
  }

  private contextAccumulator(modelOnly: boolean) {
    const records: ChatRecord[] = [];
    let lastMaterial: number | undefined;
    let lastMemory: string | undefined;
    let markedGoal = false;
    const memoryIn = (record: ChatRecord): string | undefined =>
      record.subtype === 'chat_compression'
        ? findLatestAutoMemorySnapshot(
            (record.systemPayload as { compressedHistory?: Content[] })
              ?.compressedHistory ?? [],
          )?.text
        : record.subtype === 'memory_catalog_snapshot'
          ? record.message?.parts?.[0]?.text
          : undefined;
    return {
      add: (record: ChatRecord) => {
        if (!this.isContextCandidate(record, modelOnly)) return;
        const previous =
          lastMaterial === undefined ? undefined : records[lastMaterial];
        if (record.subtype === 'slash_command') {
          if (isLocalCommandTranscriptPair(record, previous)) {
            const removed = records.splice(lastMaterial!);
            if (!modelOnly)
              records.push(
                ...removed.filter(
                  (entry) => entry.subtype === 'branch_checkpoint',
                ),
              );
            lastMemory = undefined;
            for (const entry of records)
              lastMemory = memoryIn(entry) ?? lastMemory;
          }
          if (previous?.type === 'user') lastMaterial = undefined;
          return;
        }
        if (record.subtype === 'memory_catalog_snapshot') {
          const part = record.message?.parts?.[0];
          if (
            part?.partMetadata?.[AUTO_MEMORY_SNAPSHOT_METADATA] !== true ||
            typeof part.text !== 'string' ||
            part.text === lastMemory
          )
            return;
          lastMemory = part.text;
        } else if (record.subtype === 'goal_turn_end') {
          const callId = (record.systemPayload as { toolCallId?: string })
            ?.toolCallId;
          const permit = record.goalContext;
          if (
            markedGoal ||
            previous?.type !== 'tool_result' ||
            typeof permit?.goalId !== 'string' ||
            !permit.goalId ||
            typeof permit.turnId !== 'string' ||
            !permit.turnId ||
            !Number.isInteger(permit.revision) ||
            previous.goalContext?.goalId !== permit.goalId ||
            previous.goalContext.revision !== permit.revision ||
            previous.goalContext.turnId !== permit.turnId ||
            !previous.message?.parts?.some(
              (part) => part.functionResponse?.id === callId,
            )
          )
            return;
          markedGoal = true;
        } else if (record.subtype === 'chat_compression') {
          lastMaterial = undefined;
          lastMemory = memoryIn(record);
        } else if (record.type !== 'system') {
          lastMaterial = records.length;
          markedGoal = false;
        }
        records.push(record);
      },
      finish: (): ChatRecord[] => {
        if (modelOnly) return records;
        const included = new Set<string>();
        let previous: string | null = null;
        return records.map((record) => {
          const result =
            record.parentUuid !== null && !included.has(record.parentUuid)
              ? { ...record, parentUuid: previous }
              : record;
          included.add(record.uuid);
          previous = record.uuid;
          return result;
        });
      },
    };
  }

  private async contextRecords(
    throughSequence: number | undefined,
    modelOnly: boolean,
  ): Promise<ChatRecord[]> {
    const through = throughSequence ?? this.authority.committedSequence;
    const compaction = await this.authority.findEvent(
      'context.compacted',
      'kind',
      'context.compacted',
      { last: true, throughSequence: through },
    );
    const branch = await this.authority.branchCheckpointAt(through);
    const projection = this.contextAccumulator(modelOnly);
    if (!branch || (compaction && compaction.sequence > branch.sequence)) {
      for await (const { record } of this.projectedEvents(
        compaction?.sequence ?? 1,
        through,
      ))
        projection.add(record);
      return projection.finish();
    }
    const scratch = this.authority.createQueryHistory();
    try {
      const identities = scratch.map<{
        parentUuid: string | null;
        first: number;
        last: number;
        included: boolean;
        compression: boolean;
      }>('resource');
      const fragments = scratch.map<number>('resource-pending');
      const order = scratch.map<number>('command');
      let length = 0;
      for await (const { event, record } of this.projectedEvents(
        1,
        branch.sequence,
      )) {
        if (!isTranscriptConversationRecord(record)) continue;
        const previous = await identities.get(record.uuid);
        if (previous) await fragments.set(previous.last, event.sequence);
        await fragments.set(event.sequence, 0);
        await identities.set(record.uuid, {
          parentUuid: previous?.parentUuid ?? record.parentUuid,
          first: previous?.first ?? event.sequence,
          last: event.sequence,
          included:
            previous?.included ?? this.isContextCandidate(record, modelOnly),
          compression: record.subtype === 'chat_compression',
        });
      }
      const branchRecord = await this.recordAt(branch);
      if (!branchRecord)
        throw new ManagedSessionRecordError(
          'Branch checkpoint has no reader-facing record.',
        );
      let id: string | null = branchRecord.uuid;
      let visited = 0;
      while (id) {
        if (++visited > identities.size)
          throw new ManagedSessionRecordError(
            'Active transcript contains a parent cycle.',
          );
        const identity = await identities.get(id);
        if (!identity)
          throw new ManagedSessionRecordError(
            'Active transcript is missing a parent record.',
          );
        if (identity.included) await order.set(length++, identity.first);
        if (identity.compression) break;
        id = identity.parentUuid;
      }
      for (let position = length - 1; position >= 0; position--) {
        projection.add(
          await this.aggregateFragments(
            (await order.get(position))!,
            fragments,
          ),
        );
      }
      for await (const { record } of this.projectedEvents(
        branch.sequence + 1,
        through,
      ))
        projection.add(record);
      return projection.finish();
    } finally {
      await scratch.close();
    }
  }
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
  return value as ChatRecord;
}
