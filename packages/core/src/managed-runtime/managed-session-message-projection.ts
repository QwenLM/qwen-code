/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '../services/chatRecordingService.js';
import {
  MANAGED_SESSION_FORMAT_VERSION,
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
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
  LocalManagedSessionResourceStore,
  readManagedBranchCheckpoint,
} from './managed-session-resources.js';

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
    private readonly resources: LocalManagedSessionResourceStore,
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
    const contentRef = await this.resources.publish('managed-message', body);
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
   */
  async project(): Promise<ChatRecord[]> {
    const records: ChatRecord[] = [];
    const checkpoints = new Map<string, number>();
    let after = 0;
    for (;;) {
      const page = this.authority.readEvents({
        afterSequence: after,
        limit: MANAGED_SESSION_LIMITS.maxReadEvents,
      });
      if (page.length === 0) break;
      for (const event of page) {
        after = event.sequence;
        const branch = await readManagedBranchCheckpoint(
          event,
          this.resources,
          (id) => checkpoints.get(id),
          this.authority.committedSequence,
        );
        if (event.kind === 'checkpoint.committed') {
          checkpoints.set(
            event.payload['checkpointId'] as string,
            event.sequence,
          );
        }
        if (branch !== undefined) {
          records.push(branch);
        } else if (event.kind === 'message.committed') {
          records.push(
            await readRecordBody(this.resources, event.payload['contentRef']),
          );
        }
      }
    }
    return records;
  }
}

async function readRecordBody(
  resources: LocalManagedSessionResourceStore,
  ref: ManagedSessionEvent['payload'][string],
): Promise<ChatRecord> {
  const body = await resources.read(
    ref as unknown as Parameters<LocalManagedSessionResourceStore['read']>[0],
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
  const scan = await readManagedSessionLog(
    options.transcriptPath,
    options.sessionKey,
    options.maxBytes,
  );
  if (scan.header === undefined) {
    throw new ManagedSessionRecordError(
      'session log has no Managed header, so it cannot be projected.',
    );
  }
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: options.runtimeBaseDir,
    sessionKey: options.sessionKey,
  });
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
      records.push(branch);
      continue;
    }
    const carried = readerFacingBody(event);
    if (carried === undefined) continue;
    const body = await readRecordBody(resources, carried.ref);
    records.push(
      carried.inDomainEnvelope
        ? (body as unknown as { record: ChatRecord }).record
        : body,
    );
  }
  return records;
}

/**
 * Domains whose body is a whole reader-facing record. The rest carry their own
 * shape and are not something a reader replays.
 */
const RECORD_CARRYING_DOMAINS: ReadonlySet<unknown> = new Set([
  'goal_state',
  'file_history',
  'session_source',
]);

/**
 * Where a whole reader-facing record lives, for the channels that carry one.
 *
 * A domain body is the authority's envelope wrapping the content, so the record
 * sits under its own key there, unlike the event channels whose body is the
 * record itself.
 */
function readerFacingBody(event: ManagedSessionEvent):
  | {
      ref: ManagedSessionEvent['payload'][string];
      inDomainEnvelope: boolean;
    }
  | undefined {
  switch (event.kind) {
    case 'message.committed':
      return { ref: event.payload['contentRef'], inDomainEnvelope: false };
    case 'turn.settled':
      return { ref: event.payload['resultRef'], inDomainEnvelope: false };
    case 'context.compacted':
      return { ref: event.payload['summaryRef'], inDomainEnvelope: false };
    case 'domain.committed':
      return RECORD_CARRYING_DOMAINS.has(event.payload['domain'])
        ? { ref: event.payload['recordRef'], inDomainEnvelope: true }
        : undefined;
    default:
      return undefined;
  }
}
