/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { parseBranchCheckpointPayload } from '../services/branch-points.js';
import type {
  LocalManagedSessionAuthority,
  ManagedSessionActor,
} from './managed-session-authority.js';
import {
  createNextTurnReadyHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  HARNESS_MODEL_START_PHASES,
  HARNESS_TURN_COMPLETE_BOUNDARY,
} from './managed-harness-checkpoint.js';
import { ManagedSessionMessageProjection } from './managed-session-message-projection.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';

/**
 * The record shapes the message projection can carry today.
 *
 * A Managed log keeps domain content once and projects reader-facing records
 * back out of it, so a record may only be routed here if the projection can
 * reproduce it. Shapes with their own home in the event union or the domain
 * registry are routed there instead; anything still unmapped is refused rather
 * than falling back to a direct append.
 */
const CARRIED_SYSTEM_SUBTYPES = new Set([
  'slash_command',
  'at_command',
  'ui_telemetry',
  'attribution_snapshot',
]);

/**
 * Message subtypes the projection restores as they were. A subtype on a user
 * record marks where the message came from rather than making it another kind
 * of content, so it belongs on the message channel.
 */
const CARRIED_MESSAGE_SUBTYPES = new Set([
  'goal_runtime',
  'mid_turn_user_message',
]);

export class ManagedSessionUnmappedRecordError extends Error {
  readonly code = 'managed_session_unmapped_record';

  constructor(record: ChatRecord) {
    super(
      `Managed sessions have no mapping yet for a ${record.type} record` +
        `${record.subtype ? ` with subtype ${record.subtype}` : ''}.`,
    );
    this.name = 'ManagedSessionUnmappedRecordError';
  }
}

/**
 * The controlled sink a Managed-bound recorder writes through.
 *
 * Routing the recorder here is what stops a Managed session from keeping a
 * second, legacy copy of its history beside the authoritative log.
 */
export class ManagedSessionRecordSink {
  private readonly projection: ManagedSessionMessageProjection;

  constructor(
    private readonly authority: LocalManagedSessionAuthority,
    private readonly resources: ManagedSessionResourceStore,
    /** Supplied by the binder, which is the only party that knows the activation. */
    private readonly actor: () => ManagedSessionActor,
  ) {
    this.projection = new ManagedSessionMessageProjection(authority, resources);
  }

  canCarry(record: ChatRecord): boolean {
    if (record.type === 'system') {
      if (record.subtype === 'custom_title') return true;
      if (record.subtype === 'turn_result') return true;
      if (record.subtype === 'chat_compression') return true;
      if (record.subtype === 'branch_checkpoint') return true;
      if (record.subtype === 'goal_state') return true;
      if (record.subtype === 'file_history_snapshot') return true;
      if (record.subtype === 'session_source') return true;
      return (
        record.subtype !== undefined &&
        CARRIED_SYSTEM_SUBTYPES.has(record.subtype)
      );
    }
    if (
      record.type === 'user' ||
      record.type === 'assistant' ||
      record.type === 'tool_result'
    ) {
      return (
        record.subtype === undefined ||
        CARRIED_MESSAGE_SUBTYPES.has(record.subtype)
      );
    }
    return false;
  }

  /**
   * Refuses rather than falling back. A silent fallback to a direct append
   * would put content in the transcript that the authoritative log does not
   * account for, which is the divergence this layer exists to prevent.
   */
  async write(record: ChatRecord): Promise<void> {
    if (!this.canCarry(record)) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    if (record.subtype === 'custom_title') {
      await this.commitTitle(record);
      return;
    }
    if (record.subtype === 'goal_state') {
      await this.commitGoalState(record);
      return;
    }
    if (record.subtype === 'file_history_snapshot') {
      await this.commitFileHistory(record);
      return;
    }
    if (record.subtype === 'session_source') {
      await this.commitSessionSource(record);
      return;
    }
    if (record.subtype === 'turn_result') {
      await this.commitTurnSettled(record);
      return;
    }
    if (record.subtype === 'chat_compression') {
      await this.commitContextCompacted(record);
      return;
    }
    if (record.subtype === 'branch_checkpoint') {
      await this.commitBranchCheckpoint(record);
      return;
    }
    await this.projection.commit(
      {
        operation: 'commitMessage',
        commandId: `recorder:${record.uuid}`,
        sessionKey: this.authority.sessionHeader.sessionKey,
        contentDigest: this.authority.sessionHeader.definitionRef.digest,
      },
      { record },
      this.actor(),
    );
  }

  /**
   * A title is not message content: it belongs to the `session_metadata` domain
   * record the session directory reads, so it is committed there rather than
   * projected as a message.
   */
  private async commitTitle(record: ChatRecord): Promise<void> {
    const payload = record.systemPayload as
      | { customTitle?: unknown; titleSource?: unknown }
      | undefined;
    const title = payload?.customTitle;
    if (typeof title !== 'string' || title.length === 0) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    await this.authority.commitDomainRecord(
      {
        operation: 'renameSession',
        commandId: `recorder:${record.uuid}`,
        sessionKey: this.authority.sessionHeader.sessionKey,
        contentDigest: this.authority.sessionHeader.definitionRef.digest,
      },
      {
        domain: 'session_metadata',
        content: {
          title,
          ...(payload?.titleSource === 'auto' ||
          payload?.titleSource === 'manual'
            ? { titleSource: payload.titleSource }
            : {}),
        },
      },
      { class: 'trusted_entry' },
    );
  }

  /**
   * A goal snapshot is the goal domain's state, so it is committed there rather
   * than projected as a message. The body carries the whole record, because goal
   * recovery reads the original record and the domain holds the complete goal
   * state.
   */
  private async commitGoalState(record: ChatRecord): Promise<void> {
    if (record.systemPayload === undefined) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    await this.authority.commitDomainRecord(
      {
        operation: 'commitGoalState',
        commandId: `recorder:${record.uuid}`,
        sessionKey: this.authority.sessionHeader.sessionKey,
        contentDigest: this.authority.sessionHeader.definitionRef.digest,
      },
      {
        domain: 'goal_state',
        // Nested rather than spread: the authority composes its envelope
        // (operationId, revision, previousRecordRef) around the content, and a
        // spread record would sit beside those fields and could collide.
        content: { record: record as unknown as Record<string, unknown> },
      },
      // A domain record admits only a trusted entry: the update reaches the log
      // through the authorised entry, and the activation is an eligibility
      // condition rather than the author.
      { class: 'trusted_entry' },
    );
  }

  /**
   * A file history batch records which backups a prompt took, so it is
   * committed to the file history domain rather than projected as a message.
   *
   * Each batch is its own record instead of one folded latest-wins state: a
   * folded body would force this writer to re-read the accumulated snapshots
   * after every cold reopen, and a body written from partial knowledge would
   * silently drop earlier prompts' backups. The reader folds the records with
   * the same bounded accumulator it uses on a legacy transcript, so the
   * restored snapshot set is identical.
   */
  private async commitFileHistory(record: ChatRecord): Promise<void> {
    if (record.systemPayload === undefined) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    await this.authority.commitDomainRecord(
      {
        operation: 'commitFileHistory',
        commandId: `recorder:${record.uuid}`,
        sessionKey: this.authority.sessionHeader.sessionKey,
        contentDigest: this.authority.sessionHeader.definitionRef.digest,
      },
      {
        domain: 'file_history',
        content: { record: record as unknown as Record<string, unknown> },
      },
      { class: 'trusted_entry' },
    );
  }

  /**
   * The source a session was created from is session identity, not message
   * content, so it is committed to its own domain. The recorder re-anchors the
   * same record periodically so a truncated legacy transcript still carries the
   * source near its tail; those repeats commit again here, and the reader keeps
   * the latest, so the anchoring stays a legacy concern rather than a fault.
   */
  private async commitSessionSource(record: ChatRecord): Promise<void> {
    if (record.systemPayload === undefined) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    await this.authority.commitDomainRecord(
      {
        operation: 'commitSessionSource',
        commandId: `recorder:${record.uuid}`,
        sessionKey: this.authority.sessionHeader.sessionKey,
        contentDigest: this.authority.sessionHeader.definitionRef.digest,
      },
      {
        domain: 'session_source',
        content: { record: record as unknown as Record<string, unknown> },
      },
      { class: 'trusted_entry' },
    );
  }

  /**
   * A turn result is the turn's terminal state, so it is committed as
   * `turn.settled` rather than projected as a message. The whole record becomes
   * the result body, which keeps the error detail and timings the payload
   * carries beyond the fields the event indexes.
   */
  private async commitTurnSettled(record: ChatRecord): Promise<void> {
    const payload = record.systemPayload as
      | { promptId?: unknown; state?: unknown; stopReason?: unknown }
      | undefined;
    const turnId = payload?.promptId;
    const outcome = payload?.state;
    if (
      typeof turnId !== 'string' ||
      turnId.length === 0 ||
      typeof outcome !== 'string' ||
      outcome.length === 0
    ) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    const resultRef = await this.resources.publish(
      'managed-turn-result',
      Buffer.from(JSON.stringify(record), 'utf8'),
    );
    const actor = this.actor();
    const held = actor.activation;
    const command = {
      operation: 'settleTurn',
      commandId: `recorder:${record.uuid}`,
      sessionKey: this.authority.sessionHeader.sessionKey,
      contentDigest: resultRef.digest,
    };
    const turn = {
      turnId,
      outcome,
      stopReason:
        typeof payload?.stopReason === 'string' ? payload.stopReason : null,
      resultRef,
      occurredAt: Date.parse(record.timestamp) || Date.now(),
      eventId: `turn:${turnId}`,
    };
    if (actor.class === 'harness' && held !== undefined) {
      const authorization = await this.authority.harnessRunAuthorization();
      if (
        authorization.status === 'runnable' &&
        HARNESS_MODEL_START_PHASES.has(
          authorization.checkpoint.continuation.phase,
        )
      ) {
        await this.authority.commitTurnComplete(
          command,
          {
            turn,
            boundary: HARNESS_TURN_COMPLETE_BOUNDARY,
            state: (identity, previous) =>
              encodeHarnessCheckpointV1(
                createNextTurnReadyHarnessCheckpoint({
                  previous,
                  ...identity,
                  activationId: held.activationId,
                  turnId,
                  promptId: turnId,
                }),
              ),
          },
          actor,
        );
        return;
      }
    }
    await this.authority.appendExecutionEvent(
      command,
      (sequence) => ({
        v: 1,
        sequence,
        eventId: turn.eventId,
        sessionKey: this.authority.sessionHeader.sessionKey,
        kind: 'turn.settled',
        occurredAt: turn.occurredAt,
        ...(actor.class === 'harness' && held !== undefined
          ? {
              subject: {
                type: 'activation',
                scopeId: held.activationId,
                activationId: held.activationId,
                epoch: held.epoch,
              },
            }
          : {}),
        payload: {
          turnId: turn.turnId,
          outcome: turn.outcome,
          stopReason: turn.stopReason,
          resultRef,
          usageRef: null,
          pendingOwnersRef: null,
        },
      }),
      actor,
    );
  }

  /**
   * A compaction replaces a range of history rather than adding to it, so it is
   * committed as `context.compacted` naming that range and the messages inside
   * it. The whole record becomes the summary body: a reader rebuilds the model
   * history from the snapshot it carries, so a record without one is refused.
   */
  private async commitContextCompacted(record: ChatRecord): Promise<void> {
    const payload = record.systemPayload as
      | { compressedHistory?: unknown }
      | undefined;
    if (!payload?.compressedHistory) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    const fromSequence = this.authority.compactedThroughSequence + 1;
    const toSequence = this.authority.committedSequence;
    const replacedMessageIds = this.authority
      .eventsInSequenceRange(fromSequence, toSequence)
      .filter((event) => event.kind === 'message.committed')
      .map((event) => event.payload['messageId'] as string);
    const summaryRef = await this.resources.publish(
      'managed-compaction-summary',
      Buffer.from(JSON.stringify(record), 'utf8'),
    );
    const actor = this.actor();
    const held = actor.activation;
    await this.authority.appendExecution(
      {
        operation: 'compactContext',
        commandId: `recorder:${record.uuid}`,
        sessionKey: this.authority.sessionHeader.sessionKey,
        contentDigest: summaryRef.digest,
      },
      [
        {
          v: 1,
          sequence: toSequence + 1,
          eventId: `compaction:${record.uuid}`,
          sessionKey: this.authority.sessionHeader.sessionKey,
          kind: 'context.compacted',
          occurredAt: Date.parse(record.timestamp) || Date.now(),
          ...(held === undefined
            ? {}
            : {
                subject: {
                  type: 'activation',
                  scopeId: held.activationId,
                  activationId: held.activationId,
                  epoch: held.epoch,
                },
              }),
          payload: {
            compactionId: record.uuid,
            fromSequence,
            toSequence,
            summaryRef,
            replacedMessageIds,
            tokenCountsRef: null,
          },
        },
      ],
      actor,
    );
  }

  private async commitBranchCheckpoint(record: ChatRecord): Promise<void> {
    if (parseBranchCheckpointPayload(record.systemPayload) === undefined) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    // Preserve the old operation and byte digest for retries across cold reopen.
    await this.projection.commit(
      {
        operation: 'commitBranchCheckpoint',
        commandId: `recorder:${record.uuid}`,
        sessionKey: this.authority.sessionHeader.sessionKey,
        contentDigest: createHash('sha256')
          .update(JSON.stringify(record), 'utf8')
          .digest('hex'),
      },
      { record },
      this.actor(),
    );
  }

  /** Reader-facing records rebuilt from the authoritative log. */
  project(): Promise<ChatRecord[]> {
    return this.projection.project();
  }
}
