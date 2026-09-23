/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import {
  authorizeParsedHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  HARNESS_MODEL_START_PHASES,
  tryParseHarnessCheckpointV1,
  type HarnessCheckpointV1,
  type HarnessRunAuthorization,
} from './managed-harness-checkpoint.js';
import {
  MANAGED_SESSION_COMMIT_SUBTYPE,
  MANAGED_SESSION_EVENT_SUBTYPE,
  MANAGED_SESSION_FORMAT_VERSION,
  MANAGED_SESSION_HEADER_SUBTYPE,
  MANAGED_SESSION_LIMITS,
  MANAGED_SESSION_MINIMUM_READER,
  ManagedSessionRecordError,
  assertManagedSessionDomainEnabled,
  assertManagedSessionEventActor,
  assertManagedSessionTransaction,
  managedSessionEventsDigest,
  managedSessionKeysEqual,
  parseManagedSessionCommitMarker,
  parseManagedSessionEvent,
  parseManagedSessionHeader,
  type ManagedSessionActorClass,
  type ManagedSessionDomain,
  type ManagedSessionCommitMarker,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
  type ManagedSessionEventKind,
  type ManagedSessionHeader,
  type ManagedSessionKey,
} from './managed-session-records.js';
import { readManagedBranchCheckpoint } from './managed-session-resources.js';
import {
  managedSessionActivationStateFrom,
  managedSessionCommandKey,
  type ManagedSessionActivationState,
  type ManagedSessionCommitReceipt,
  type ManagedSessionCommittedTransaction,
  type ManagedSessionJournalHandle,
  type ManagedSessionJournalScan,
  type ManagedSessionResourceStore,
} from './managed-session-storage.js';

export type {
  ManagedSessionActivationState,
  ManagedSessionCommitReceipt,
} from './managed-session-storage.js';

export type ManagedSessionRecordBody =
  | ManagedSessionHeader
  | ManagedSessionEvent
  | ManagedSessionCommitMarker;

export interface ManagedSessionCommand {
  readonly operation: string;
  readonly commandId: string;
  readonly sessionKey: ManagedSessionKey;
  readonly contentDigest: string;
  /** Required for execution commands; the caller's view of the log tail. */
  readonly expectedSequence?: number;
}

export interface ManagedSessionActor {
  readonly class: ManagedSessionActorClass;
  /** The activation the Harness holds; rejected once a later epoch exists. */
  readonly activation?: {
    readonly activationId: string;
    readonly epoch: number;
  };
}

/**
 * Storage-spec restore basis. `checkpoint` means a checkpoint resource exists,
 * not that a Harness may run; use `harnessRunAuthorization()` for that gate.
 * `blocked` is a real outcome, not an error path: execution continuation
 * depends on a checkpoint, so a session that has model or tool history but no
 * checkpoint must not silently restart from an older state or an empty history.
 */
export type ManagedSessionRestoreBasis = 'checkpoint' | 'initial' | 'blocked';

/**
 * Storage §2.2 closed set. `blocked` is a recovery status, not a basis;
 * a continuation without a checkpoint uses `restoreBasis=null`.
 */
export type ManagedSessionRestoreBundleBasis =
  | 'checkpoint'
  | 'initial'
  | 'history_rewind'
  | 'history_copy'
  | 'format_upgrade';

export type ManagedSessionRestoreRecoveryStatus = 'ok' | 'blocked';

export interface ManagedSessionRestoreBundle {
  readonly formatVersion: typeof MANAGED_SESSION_FORMAT_VERSION;
  readonly sessionKey: ManagedSessionKey;
  readonly engine: 'managed';
  readonly throughSequence: number;
  readonly checkpointRef: ManagedSessionDurableRef | null;
  readonly restoreBasis: ManagedSessionRestoreBundleBasis | null;
  readonly restoreProofRef: ManagedSessionDurableRef | null;
  readonly recoveryStatus: ManagedSessionRestoreRecoveryStatus;
}

export function assertManagedSessionRestoreBundle(
  bundle: ManagedSessionRestoreBundle,
): void {
  const hasCheckpoint = bundle.checkpointRef !== null;
  const hasProof = bundle.restoreProofRef !== null;
  const { restoreBasis, recoveryStatus } = bundle;

  if (restoreBasis === null) {
    if (recoveryStatus !== 'blocked' || hasCheckpoint || hasProof) {
      throw new ManagedSessionRecordError(
        'a restore bundle without restoreBasis must be blocked with both refs null.',
      );
    }
    return;
  }

  if (restoreBasis === 'checkpoint') {
    if (!hasCheckpoint || hasProof) {
      throw new ManagedSessionRecordError(
        'checkpoint restore requires checkpointRef and a null restoreProofRef.',
      );
    }
    return;
  }

  if (restoreBasis === 'initial') {
    if (hasCheckpoint || hasProof || recoveryStatus !== 'ok') {
      throw new ManagedSessionRecordError(
        'initial restore requires both refs null and is not a blocked downgrade.',
      );
    }
    return;
  }

  if (
    restoreBasis === 'history_rewind' ||
    restoreBasis === 'history_copy' ||
    restoreBasis === 'format_upgrade'
  ) {
    if (hasCheckpoint || !hasProof) {
      throw new ManagedSessionRecordError(
        `${restoreBasis} restore requires restoreProofRef and a null checkpointRef.`,
      );
    }
    return;
  }

  const _exhaustive: never = restoreBasis;
  throw new ManagedSessionRecordError(
    `unknown restoreBasis ${String(_exhaustive)}.`,
  );
}

export interface ManagedSessionCheckpoint {
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly previousCheckpointId: string | null;
  readonly stateRef: ManagedSessionDurableRef;
  readonly boundary: string | null;
}

export type ManagedSessionActionState =
  | 'requested'
  | 'decided'
  | 'cancelled'
  | 'expired';

export interface ManagedSessionAction {
  readonly requestId: string;
  readonly kind: string;
  readonly source: string;
  readonly inputRevision: number;
  readonly optionsRef: ManagedSessionDurableRef | null;
  readonly state: ManagedSessionActionState;
  readonly decisionRef: ManagedSessionDurableRef | null;
}

export interface ManagedSessionCheckpointReceipt {
  readonly receipt: ManagedSessionCommitReceipt;
  readonly checkpoint: ManagedSessionCheckpoint;
}

export interface ManagedSessionDomainReceipt {
  readonly receipt: ManagedSessionCommitReceipt;
  readonly recordRef: ManagedSessionDurableRef;
  readonly revision: number;
}

export interface ManagedSessionInputRequest {
  readonly inputId: string;
  readonly turnId: string;
  readonly source: string;
  readonly contentRef: ManagedSessionDurableRef;
  readonly deadline: number | null;
  readonly admissionRef: ManagedSessionDurableRef;
  readonly wakeReason: string;
}

export class ManagedSessionConflictError extends ManagedSessionRecordError {
  override readonly code = 'managed_session_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'ManagedSessionConflictError';
  }
}

/**
 * A crash between the last event and its commit marker. The remedy is to
 * truncate the tail under an exclusive writer, which needs a lease capability
 * that does not exist yet, so the authority stays blocked instead of reusing
 * the sequences the tail already consumed.
 */
export class ManagedSessionUncommittedTailError extends ManagedSessionRecordError {
  override readonly code = 'managed_session_uncommitted_tail';

  constructor(
    message: string,
    readonly uncommittedRecords: number,
  ) {
    super(message);
    this.name = 'ManagedSessionUncommittedTailError';
  }
}

export class ManagedSessionAlreadyExistsError extends ManagedSessionRecordError {
  override readonly code = 'managed_session_already_exists';

  constructor(readonly sessionId: string) {
    super(`Managed Session ${sessionId} already exists.`);
    this.name = 'ManagedSessionAlreadyExistsError';
  }
}

export class ManagedSessionNotFoundError extends ManagedSessionRecordError {
  override readonly code = 'managed_session_not_found';

  constructor(readonly sessionId: string) {
    super(`Managed Session ${sessionId} was not found.`);
    this.name = 'ManagedSessionNotFoundError';
  }
}

export interface OpenManagedSessionAuthorityOptions {
  readonly journal?: ManagedSessionJournalHandle;
  /** Compatibility entry point for callers that already own the local writer. */
  readonly lease?: SessionWriterLease;
  readonly sessionKey: ManagedSessionKey;
  readonly cwd: string;
  readonly version: string;
  /** Supplied when creating a session; ignored once a header exists. */
  readonly create?: {
    readonly definitionRef: ManagedSessionDurableRef;
    readonly rootSnapshotRef: ManagedSessionDurableRef;
    readonly createdBy: string;
  };
  /** Reject an existing header instead of reopening it through a create path. */
  readonly requireNew?: boolean;
  readonly now?: () => number;
  /** Required only for domain records, whose bodies live in resources. */
  readonly resources?: ManagedSessionResourceStore;
}

/**
 * The semantic authority for one Managed Session. It validates complete
 * transactions, then gives them to one journal handle; the selected store owns
 * physical serialization, fencing and durability.
 */
export class LocalManagedSessionAuthority {
  private constructor(
    private readonly journal: ManagedSessionJournalHandle,
    private readonly sessionKey: ManagedSessionKey,
    private readonly cwd: string,
    private readonly version: string,
    private readonly now: () => number,
    private readonly header: ManagedSessionHeader,
    private readonly events: ManagedSessionEvent[],
    private readonly transactions: Map<
      string,
      ManagedSessionCommittedTransaction
    >,
    private committed: number,
    private lastMarkerDigest: string | null,
    private lastRecordUuid: string | null,
    private activation: ManagedSessionActivationState | undefined,
    private readonly resources: ManagedSessionResourceStore | undefined,
  ) {}

  private writeFailure: Error | undefined;
  private recoveryBlocked = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly eventIds = new Set<string>();
  private readonly checkpointSequences = new Map<string, number>();
  private checkpoint: ManagedSessionCheckpoint | undefined;
  private hasContinuation = false;
  private compactedThrough = 0;
  private readonly domainRecords = new Map<
    string,
    { revision: number; recordRef: ManagedSessionDurableRef }
  >();
  private readonly actions = new Map<string, ManagedSessionAction>();

  get committedSequence(): number {
    return this.committed;
  }

  /**
   * The highest sequence a compaction already claims to have replaced, so the
   * next one states a range that does not overlap an earlier claim.
   */
  get compactedThroughSequence(): number {
    return this.compactedThrough;
  }

  get sessionHeader(): ManagedSessionHeader {
    return this.header;
  }

  /** The highest activation epoch committed so far; 0 when none exists. */
  /** The activation the log currently records, if any. */
  get currentActivation(): ManagedSessionActivationState | undefined {
    return this.activation;
  }

  blockRecovery(request: {
    readonly status:
      | 'BLOCKED_RESOURCE'
      | 'BLOCKED_WORKSPACE'
      | 'BLOCKED_EXECUTION';
    readonly detailCode: string;
  }): Promise<void> {
    return this.runSerial(async () => {
      if (this.journal.blockRecovery === undefined) {
        throw new ManagedSessionRecordError(
          'the Managed Session journal cannot persist a recovery block.',
        );
      }
      await this.journal.blockRecovery(request);
      this.recoveryBlocked = true;
    });
  }

  static async open(
    options: OpenManagedSessionAuthorityOptions,
  ): Promise<LocalManagedSessionAuthority> {
    const now = options.now ?? (() => Date.now());
    if (options.journal !== undefined && options.lease !== undefined) {
      throw new ManagedSessionRecordError(
        'journal and a compatibility local lease cannot be supplied together.',
      );
    }
    const journal =
      options.journal ??
      (options.lease === undefined
        ? undefined
        : LocalJsonlManagedSessionJournalStore.fromLease(
            options.lease,
            options.sessionKey,
          ));
    if (journal === undefined) {
      throw new ManagedSessionRecordError(
        'a Managed Session journal handle is required.',
      );
    }
    const scan = await journal.read();
    if (scan.uncommitted > 0) {
      throw new ManagedSessionUncommittedTailError(
        `session log ends with ${scan.uncommitted} uncommitted record(s); truncation under an exclusive writer is required before appending.`,
        scan.uncommitted,
      );
    }
    if (options.requireNew === true && scan.header !== undefined) {
      throw new ManagedSessionAlreadyExistsError(options.sessionKey.sessionId);
    }
    let header = scan.header;
    let lastRecordUuid = scan.lastRecordUuid;
    if (header === undefined) {
      if (scan.foreignRecords > scan.engineRecords) {
        throw new ManagedSessionRecordError(
          'session log has existing records but no Managed header; history import is not supported yet.',
        );
      }
      if (options.create === undefined) {
        throw new ManagedSessionNotFoundError(options.sessionKey.sessionId);
      }
      header = parseManagedSessionHeader({
        formatVersion: MANAGED_SESSION_FORMAT_VERSION,
        minimumReader: MANAGED_SESSION_MINIMUM_READER,
        sessionKey: options.sessionKey,
        engine: 'managed',
        definitionRef: options.create.definitionRef,
        rootSnapshotRef: options.create.rootSnapshotRef,
        createdBy: options.create.createdBy,
      });
      // Recorded before the header, in the container's own metadata shape, so
      // every existing execution-engine guard sees a Managed session instead of
      // defaulting to legacy and letting a legacy-only operation run on it.
      const records: unknown[] = [];
      if (scan.engineRecords === 0) {
        const engineUuid = randomUUID();
        records.push({
          uuid: engineUuid,
          parentUuid: lastRecordUuid,
          sessionId: options.sessionKey.sessionId,
          timestamp: new Date(now()).toISOString(),
          type: 'system',
          subtype: 'session_execution_engine',
          cwd: options.cwd,
          version: options.version,
          systemPayload: { version: 1, engine: 'managed' },
        });
        lastRecordUuid = engineUuid;
      }
      const uuid = randomUUID();
      records.push({
        uuid,
        parentUuid: lastRecordUuid,
        sessionId: options.sessionKey.sessionId,
        timestamp: new Date(now()).toISOString(),
        type: 'system',
        subtype: MANAGED_SESSION_HEADER_SUBTYPE,
        cwd: options.cwd,
        version: options.version,
        managedSession: header,
      });
      await journal.appendTransaction(records);
      lastRecordUuid = uuid;
    }
    const authority = new LocalManagedSessionAuthority(
      journal,
      options.sessionKey,
      options.cwd,
      options.version,
      now,
      header,
      scan.events,
      scan.transactions,
      scan.committed,
      scan.lastMarkerDigest,
      lastRecordUuid,
      scan.activation,
      options.resources,
    );
    const branches = await authority.validateRecoveryFacts(scan.events);
    for (const event of scan.events) {
      authority.eventIds.add(event.eventId);
      if (event.kind === 'domain.committed') {
        authority.recordDomainEvent(event);
      }
      authority.recordRecoveryFacts(event, branches.has(event.eventId));
    }
    return authority;
  }

  /**
   * Discards a tail that was appended without a commit marker, after proving
   * the retained prefix reads cleanly. Repair is explicit: opening a session
   * reports the tail and refuses to write, because a read-only owner or a
   * compatibility probe must never rewrite a transcript.
   */
  /**
   * Acquires the writer for a Managed session.
   *
   * Managed sessions leave a sealed lock behind on close rather than removing
   * it, so reacquiring one means taking over that seal. The certified takeover
   * verifies the sealed transcript proof against the live file, which is what
   * makes the barrier meaningful: a writer that never sealed cannot silently
   * adopt the log.
   */
  static acquireWriter(options: {
    runtimeBaseDir: string;
    sessionId: string;
    transcriptPath: string;
  }): Promise<SessionWriterLease> {
    return SessionWriterLease.acquire({
      runtimeBaseDir: options.runtimeBaseDir,
      sessionId: options.sessionId,
      transcriptPath: options.transcriptPath,
      takeoverPolicy: 'certified',
    });
  }

  /**
   * Seals the writer instead of releasing it.
   *
   * `release()` deletes the lock, which leaves a Managed transcript with no
   * barrier at all: any writer can then acquire it and append legacy records,
   * and the authority afterwards refuses to reopen the log at all. Sealing
   * keeps a lock that a default acquire declines, so the authoritative log
   * stays closed to writers that do not know how to take it over.
   */
  async close(): Promise<void> {
    await this.journal.seal();
  }

  static async recoverUncommittedTail(options: {
    lease: SessionWriterLease;
    sessionKey: ManagedSessionKey;
  }): Promise<{ discardedBytes: number; diagnosticPath: string }> {
    return LocalJsonlManagedSessionJournalStore.fromLease(
      options.lease,
      options.sessionKey,
    ).recoverUncommittedTail();
  }

  /**
   * The newest committed event of a kind.
   *
   * Separate from the paged read on purpose: that one starts at the beginning
   * and caps at `maxReadEvents`, so a caller looking for the latest of
   * something would silently find nothing once the log outgrows a page.
   */
  lastEventOfKind(
    kind: ManagedSessionEventKind,
  ): ManagedSessionEvent | undefined {
    for (let index = this.events.length - 1; index >= 0; index--) {
      if (this.events[index].kind === kind) return this.events[index];
    }
    return undefined;
  }

  /**
   * Every committed event in an inclusive sequence range.
   *
   * Same reason as {@link lastEventOfKind} for not going through the paged
   * read: a caller describing a range has to see all of it, and a page would
   * silently truncate the description.
   */
  eventsInSequenceRange(
    fromSequence: number,
    toSequence: number,
  ): readonly ManagedSessionEvent[] {
    return this.events.filter(
      (event) => event.sequence >= fromSequence && event.sequence <= toSequence,
    );
  }

  /**
   * Bounded read of the committed prefix. It never needs a live Harness.
   */
  readEvents(
    options: { afterSequence?: number; limit?: number } = {},
  ): readonly ManagedSessionEvent[] {
    const after = options.afterSequence ?? 0;
    const limit = Math.min(
      options.limit ?? MANAGED_SESSION_LIMITS.defaultReadEvents,
      MANAGED_SESSION_LIMITS.maxReadEvents,
    );
    if (limit < 1) {
      throw new ManagedSessionRecordError('readEvents limit must be positive.');
    }
    const out: ManagedSessionEvent[] = [];
    for (const event of this.events) {
      if (event.sequence <= after) continue;
      out.push(event);
      if (out.length === limit) break;
    }
    return out;
  }

  /**
   * Persists the accepted input and the wake intent in one transaction. The
   * wake fact is generated here because an entry may request a wake but must
   * not author it.
   */
  submitInput(
    command: ManagedSessionCommand,
    input: ManagedSessionInputRequest,
  ): Promise<ManagedSessionCommitReceipt> {
    return this.runSerial(() => {
      // Read inside the lock: the committed sequence moves as other
      // transactions commit.
      const first = this.committed + 1;
      const occurredAt = this.now();
      const accepted = {
        v: MANAGED_SESSION_FORMAT_VERSION,
        sequence: first,
        eventId: `${input.inputId}:accepted`,
        sessionKey: command.sessionKey,
        kind: 'input.accepted',
        occurredAt,
        payload: {
          inputId: input.inputId,
          turnId: input.turnId,
          source: input.source,
          contentRef: input.contentRef,
          deadline: input.deadline,
          admissionRef: input.admissionRef,
        },
      };
      const wake = {
        v: MANAGED_SESSION_FORMAT_VERSION,
        sequence: first + 1,
        eventId: `${input.inputId}:wake`,
        sessionKey: command.sessionKey,
        kind: 'wake.requested',
        occurredAt,
        payload: {
          wakeId: `${input.inputId}:wake`,
          reason: input.wakeReason,
          subject: { type: 'turn', turnId: input.turnId },
          sourceEventId: `${input.inputId}:accepted`,
          requiredSequence: first,
        },
      };
      return this.commit(
        command,
        [accepted, wake],
        [{ class: 'trusted_entry' }, { class: 'authority' }],
      );
    });
  }

  /**
   * Conditional append for one actor. The events must continue the committed
   * sequence exactly.
   */
  appendExecution(
    command: ManagedSessionCommand,
    events: readonly unknown[],
    actor: ManagedSessionActor,
  ): Promise<ManagedSessionCommitReceipt> {
    return this.runSerial(() =>
      this.commit(
        command,
        events,
        events.map(() => actor),
      ),
    );
  }

  appendExecutionEvent(
    command: ManagedSessionCommand,
    event: (sequence: number) => unknown,
    actor: ManagedSessionActor,
  ): Promise<ManagedSessionCommitReceipt> {
    return this.runSerial(() =>
      this.commit(command, [event(this.committed + 1)], [actor]),
    );
  }

  /** The latest committed action for this request, if any. */
  action(requestId: string): ManagedSessionAction | undefined {
    return this.actions.get(requestId);
  }

  /**
   * Harness-only: a tool_call permission ticket. Final decisions go through
   * {@link resolveAction} as the trusted arbiter, not this method.
   */
  requestToolAction(
    command: ManagedSessionCommand,
    request: {
      readonly requestId: string;
      readonly kind: string;
      readonly inputRevision: number;
      readonly optionsRef: ManagedSessionDurableRef | null;
    },
    actor: ManagedSessionActor,
  ): Promise<ManagedSessionAction> {
    return this.runSerial(async () => {
      const held = actor.activation;
      if (actor.class !== 'harness' || held === undefined) {
        throw new ManagedSessionConflictError(
          'only the current harness may request a tool_call action.',
        );
      }
      const existing = this.actions.get(request.requestId);
      if (existing !== undefined) {
        if (existing.state !== 'requested') {
          throw new ManagedSessionConflictError(
            `action ${request.requestId} is already ${existing.state}.`,
          );
        }
        return existing;
      }
      await this.commit(
        command,
        [
          {
            v: MANAGED_SESSION_FORMAT_VERSION,
            sequence: this.committed + 1,
            eventId: `action:${request.requestId}:requested`,
            sessionKey: command.sessionKey,
            kind: 'action.changed',
            occurredAt: this.now(),
            subject: {
              type: 'activation',
              scopeId: held.activationId,
              activationId: held.activationId,
              epoch: held.epoch,
            },
            payload: {
              requestId: request.requestId,
              kind: request.kind,
              source: 'tool_call',
              inputRevision: request.inputRevision,
              optionsRef: request.optionsRef,
              state: 'requested',
              decisionRef: null,
            },
          },
        ],
        [actor],
      );
      const committed = this.actions.get(request.requestId);
      if (committed === undefined) {
        throw new ManagedSessionRecordError(
          `action ${request.requestId} was requested but not recorded.`,
        );
      }
      return committed;
    });
  }

  /**
   * Arbiter-only final decision. A later conflicting outcome is rejected; the
   * same outcome is idempotent so a duplicate client response is safe.
   */
  resolveAction(
    command: ManagedSessionCommand,
    request: {
      readonly requestId: string;
      readonly state: Exclude<ManagedSessionActionState, 'requested'>;
      readonly decisionRef: ManagedSessionDurableRef | null;
    },
  ): Promise<ManagedSessionAction> {
    return this.runSerial(async () => {
      const existing = this.actions.get(request.requestId);
      if (existing === undefined) {
        throw new ManagedSessionConflictError(
          `action ${request.requestId} has not been requested.`,
        );
      }
      if (existing.state !== 'requested') {
        if (actionDecisionsMatch(existing, request)) {
          return existing;
        }
        throw new ManagedSessionConflictError(
          `action ${request.requestId} already ${existing.state}.`,
        );
      }
      await this.commit(
        command,
        [
          {
            v: MANAGED_SESSION_FORMAT_VERSION,
            sequence: this.committed + 1,
            eventId: `action:${request.requestId}:${request.state}`,
            sessionKey: command.sessionKey,
            kind: 'action.changed',
            occurredAt: this.now(),
            payload: {
              requestId: existing.requestId,
              kind: existing.kind,
              source: existing.source,
              inputRevision: existing.inputRevision,
              optionsRef: existing.optionsRef,
              state: request.state,
              decisionRef: request.decisionRef,
            },
          },
        ],
        [{ class: 'trusted_entry' }],
      );
      const committed = this.actions.get(request.requestId);
      if (committed === undefined) {
        throw new ManagedSessionRecordError(
          `action ${request.requestId} was resolved but not recorded.`,
        );
      }
      return committed;
    });
  }

  /** The newest committed checkpoint, if the session has one. */
  get latestCheckpoint(): ManagedSessionCheckpoint | undefined {
    return this.checkpoint;
  }

  /**
   * Storage-spec restore basis. The authority decides this; a Harness must not
   * pick a weaker basis for itself. Runnable authorization is a separate gate.
   */
  restoreBasis(): ManagedSessionRestoreBasis {
    if (this.checkpoint !== undefined) return 'checkpoint';
    return this.hasContinuation ? 'blocked' : 'initial';
  }

  /**
   * Storage §2.2 package. `restoreBasis()` still reports `blocked` when
   * continuation exists without a checkpoint; this bundle keeps that case as
   * `restoreBasis=null` plus `recoveryStatus=blocked` so it cannot be renamed
   * to `initial`. A stored checkpoint that fails authorization stays
   * `restoreBasis=checkpoint` with its original ref.
   */
  async restoreBundle(): Promise<ManagedSessionRestoreBundle> {
    const checkpoint = this.checkpoint;
    const identity: Pick<
      ManagedSessionRestoreBundle,
      'formatVersion' | 'sessionKey' | 'engine' | 'throughSequence'
    > = {
      formatVersion: MANAGED_SESSION_FORMAT_VERSION,
      sessionKey: this.sessionKey,
      engine: 'managed',
      throughSequence: this.committed,
    };
    if (checkpoint !== undefined) {
      const authorization = await this.harnessRunAuthorization();
      const bundle: ManagedSessionRestoreBundle = {
        ...identity,
        checkpointRef: checkpoint.stateRef,
        restoreBasis: 'checkpoint',
        restoreProofRef: null,
        recoveryStatus: authorization.status === 'runnable' ? 'ok' : 'blocked',
      };
      assertManagedSessionRestoreBundle(bundle);
      return bundle;
    }
    if (this.hasContinuation) {
      const bundle: ManagedSessionRestoreBundle = {
        ...identity,
        checkpointRef: null,
        restoreBasis: null,
        restoreProofRef: null,
        recoveryStatus: 'blocked',
      };
      assertManagedSessionRestoreBundle(bundle);
      return bundle;
    }
    const bundle: ManagedSessionRestoreBundle = {
      ...identity,
      checkpointRef: null,
      restoreBasis: 'initial',
      restoreProofRef: null,
      recoveryStatus: 'ok',
    };
    assertManagedSessionRestoreBundle(bundle);
    return bundle;
  }

  /**
   * Publishes the Harness state and commits the checkpoint that covers the log
   * up to this point. `boundary` is null for the first checkpoint a legitimate
   * initialisation establishes before any model request.
   */
  async commitCheckpoint(
    command: ManagedSessionCommand,
    request: { state: Buffer; boundary: string | null },
    actor: ManagedSessionActor,
  ): Promise<ManagedSessionCheckpointReceipt> {
    const store = this.resources;
    if (store === undefined) {
      throw new ManagedSessionRecordError(
        'a resource store is required to commit checkpoints.',
      );
    }
    const held = actor.activation;
    if (actor.class !== 'harness' || held === undefined) {
      throw new ManagedSessionConflictError(
        'only the current harness may commit a checkpoint.',
      );
    }
    return this.runSerial(async () => {
      const previous = this.checkpoint;
      const checkpointId = `ckpt-${this.committed + 1}`;
      const covered = this.committed;
      const previousCheckpointId = previous?.checkpointId ?? null;
      const parsed = tryParseHarnessCheckpointV1(request.state);
      const state =
        parsed.ok &&
        (parsed.checkpoint.identity.checkpointId !== checkpointId ||
          parsed.checkpoint.identity.coveredSequence !== covered ||
          parsed.checkpoint.identity.previousCheckpointId !==
            previousCheckpointId)
          ? encodeHarnessCheckpointV1({
              ...parsed.checkpoint,
              identity: {
                ...parsed.checkpoint.identity,
                checkpointId,
                coveredSequence: covered,
                previousCheckpointId,
              },
              resume: {
                ...parsed.checkpoint.resume,
                throughSequence: covered,
              },
            })
          : request.state;
      const stateRef = await store.publish('managed-checkpoint', state);
      const receipt = await this.commit(
        command,
        [
          {
            v: MANAGED_SESSION_FORMAT_VERSION,
            sequence: this.committed + 1,
            eventId: checkpointId,
            sessionKey: command.sessionKey,
            kind: 'checkpoint.committed',
            occurredAt: this.now(),
            subject: {
              type: 'activation',
              scopeId: held.activationId,
              activationId: held.activationId,
              epoch: held.epoch,
            },
            payload: {
              checkpointId,
              coveredSequence: covered,
              previousCheckpointId,
              stateRef,
              boundary: request.boundary,
            },
          },
        ],
        [actor],
      );
      const checkpoint = this.checkpoint;
      if (checkpoint === undefined) {
        throw new ManagedSessionRecordError(
          'checkpoint was committed but not recorded.',
        );
      }
      return { receipt, checkpoint };
    });
  }

  /**
   * Safety point A/D: a finished turn with no pending Harness work. The
   * terminal `turn.settled` event and the next-turn-ready checkpoint land in
   * one transaction. Storage forbids covering events from this transaction, so
   * `coveredSequence` is the prefix already committed before this call; the
   * settle event is the atomic companion, not part of coverage.
   */
  async commitTurnComplete(
    command: ManagedSessionCommand,
    request: {
      readonly turn: {
        readonly turnId: string;
        readonly outcome: string;
        readonly stopReason: string | null;
        readonly resultRef: ManagedSessionDurableRef;
        readonly occurredAt: number;
        readonly eventId: string;
      };
      readonly boundary: string;
      readonly state: (
        identity: {
          readonly checkpointId: string;
          readonly coveredSequence: number;
          readonly previousCheckpointId: string | null;
        },
        previous: HarnessCheckpointV1,
      ) => Buffer;
    },
    actor: ManagedSessionActor,
  ): Promise<ManagedSessionCheckpointReceipt> {
    const store = this.resources;
    if (store === undefined) {
      throw new ManagedSessionRecordError(
        'a resource store is required to commit checkpoints.',
      );
    }
    const held = actor.activation;
    if (actor.class !== 'harness' || held === undefined) {
      throw new ManagedSessionConflictError(
        'only the current harness may commit a checkpoint.',
      );
    }
    return this.runSerial(async () => {
      const authorization = await this.harnessRunAuthorization();
      if (authorization.status !== 'runnable') {
        throw new ManagedSessionConflictError(
          'turn-complete checkpoint requires a runnable Harness checkpoint.',
        );
      }
      const previous = authorization.checkpoint;
      if (!HARNESS_MODEL_START_PHASES.has(previous.continuation.phase)) {
        throw new ManagedSessionConflictError(
          'turn-complete checkpoint requires no pending Harness work.',
        );
      }
      const covered = this.committed;
      const checkpointId = `ckpt-${covered + 2}`;
      const previousCheckpointId = this.checkpoint?.checkpointId ?? null;
      const state = request.state(
        {
          checkpointId,
          coveredSequence: covered,
          previousCheckpointId,
        },
        previous,
      );
      const parsed = tryParseHarnessCheckpointV1(state);
      if (!parsed.ok) {
        throw new ManagedSessionRecordError(
          parsed.message ?? 'turn-complete checkpoint state is not Harness v1.',
        );
      }
      if (
        parsed.checkpoint.identity.checkpointId !== checkpointId ||
        parsed.checkpoint.identity.coveredSequence !== covered ||
        parsed.checkpoint.identity.previousCheckpointId !==
          previousCheckpointId ||
        !managedSessionKeysEqual(
          parsed.checkpoint.identity.sessionKey,
          this.sessionKey,
        )
      ) {
        throw new ManagedSessionConflictError(
          'turn-complete checkpoint identity does not match the assigned coverage.',
        );
      }
      if (
        !HARNESS_MODEL_START_PHASES.has(parsed.checkpoint.continuation.phase)
      ) {
        throw new ManagedSessionConflictError(
          'turn-complete checkpoint requires no pending Harness work.',
        );
      }
      const stateRef = await store.publish('managed-checkpoint', state);
      const subject = {
        type: 'activation' as const,
        scopeId: held.activationId,
        activationId: held.activationId,
        epoch: held.epoch,
      };
      const receipt = await this.commit(
        command,
        [
          {
            v: MANAGED_SESSION_FORMAT_VERSION,
            sequence: covered + 1,
            eventId: request.turn.eventId,
            sessionKey: command.sessionKey,
            kind: 'turn.settled',
            occurredAt: request.turn.occurredAt,
            subject,
            payload: {
              turnId: request.turn.turnId,
              outcome: request.turn.outcome,
              stopReason: request.turn.stopReason,
              resultRef: request.turn.resultRef,
              usageRef: null,
              pendingOwnersRef: null,
            },
          },
          {
            v: MANAGED_SESSION_FORMAT_VERSION,
            sequence: covered + 2,
            eventId: checkpointId,
            sessionKey: command.sessionKey,
            kind: 'checkpoint.committed',
            occurredAt: this.now(),
            subject,
            payload: {
              checkpointId,
              coveredSequence: covered,
              previousCheckpointId,
              stateRef,
              boundary: request.boundary,
            },
          },
        ],
        [actor, actor],
      );
      const checkpoint = this.checkpoint;
      if (checkpoint === undefined) {
        throw new ManagedSessionRecordError(
          'checkpoint was committed but not recorded.',
        );
      }
      return { receipt, checkpoint };
    });
  }

  /**
   * Reads the state the newest checkpoint references. A checkpoint whose body
   * cannot be resolved is a blocked recovery, not an empty one, so the failure
   * from the resource store is allowed to propagate.
   */
  async readCheckpointState(): Promise<Buffer | undefined> {
    const current = this.checkpoint;
    if (current === undefined) return undefined;
    const store = this.resources;
    if (store === undefined) {
      throw new ManagedSessionRecordError(
        'a resource store is required to read checkpoints.',
      );
    }
    return store.read(current.stateRef);
  }

  /**
   * Whether a Harness may run from the current restore basis. A stored
   * checkpoint is not runnable until its nine-group v1 state parses and
   * matches this session; opaque historical blobs stay `restoreBasis=
   * checkpoint` but authorize as blocked.
   */
  async harnessRunAuthorization(): Promise<HarnessRunAuthorization> {
    const basis = this.restoreBasis();
    if (basis === 'initial') return { status: 'initial' };
    if (basis === 'blocked') {
      return { status: 'blocked', reason: 'missing_checkpoint' };
    }
    const expected = this.checkpoint;
    if (expected === undefined) {
      return { status: 'blocked', reason: 'missing_checkpoint' };
    }
    let bytes: Buffer;
    try {
      const state = await this.readCheckpointState();
      if (state === undefined) {
        return { status: 'blocked', reason: 'missing_state' };
      }
      bytes = state;
    } catch (error) {
      if (error instanceof ManagedSessionRecordError) {
        return {
          status: 'blocked',
          reason: 'missing_state',
          message: error.message,
        };
      }
      throw error;
    }
    const parsed = tryParseHarnessCheckpointV1(bytes);
    if (!parsed.ok) {
      return {
        status: 'blocked',
        reason: parsed.reason === 'opaque' ? 'opaque_state' : 'invalid_state',
        message: parsed.message,
      };
    }
    return authorizeParsedHarnessCheckpoint(parsed.checkpoint, {
      sessionKey: this.sessionKey,
      checkpointId: expected.checkpointId,
      coveredSequence: expected.coveredSequence,
    });
  }

  /**
   * Commits one registered domain record. The body is published as a resource
   * first, because the event carries only a reference to it; the authority
   * composes the envelope so a caller cannot choose its own revision or break
   * the per-domain chain.
   */
  async commitDomainRecord(
    command: ManagedSessionCommand,
    request: {
      domain: ManagedSessionDomain;
      content: Readonly<Record<string, unknown>>;
    },
    actor: ManagedSessionActor,
  ): Promise<ManagedSessionDomainReceipt> {
    assertManagedSessionDomainEnabled(request.domain);
    const store = this.resources;
    if (store === undefined) {
      throw new ManagedSessionRecordError(
        'a resource store is required to commit domain records.',
      );
    }
    return this.runSerial(async () => {
      const previous = this.domainRecords.get(request.domain);
      const revision = (previous?.revision ?? 0) + 1;
      const recordRef = await store.publish(
        `managed-${request.domain}`,
        Buffer.from(
          JSON.stringify({
            operationId: command.commandId,
            revision,
            previousRecordRef: previous?.recordRef ?? null,
            ...request.content,
          }),
          'utf8',
        ),
      );
      const receipt = await this.commit(
        command,
        [
          {
            v: MANAGED_SESSION_FORMAT_VERSION,
            sequence: this.committed + 1,
            eventId: `${request.domain}:${revision}`,
            sessionKey: command.sessionKey,
            kind: 'domain.committed',
            occurredAt: this.now(),
            payload: {
              domain: request.domain,
              version: MANAGED_SESSION_FORMAT_VERSION,
              operationId: command.commandId,
              recordRef,
            },
          },
        ],
        [actor],
      );
      return { receipt, recordRef, revision };
    });
  }

  /**
   * One transaction at a time. The writer lease serialises individual lines,
   * which is not enough: concurrent transactions would interleave their event
   * records around each other's commit markers.
   */
  private runSerial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async commit(
    command: ManagedSessionCommand,
    values: readonly unknown[],
    actors: readonly ManagedSessionActor[],
  ): Promise<ManagedSessionCommitReceipt> {
    if (this.writeFailure !== undefined) {
      throw new ManagedSessionRecordError(
        `session log writes stopped after an earlier failure: ${this.writeFailure.message}`,
      );
    }
    if (!managedSessionKeysEqual(command.sessionKey, this.sessionKey)) {
      throw new ManagedSessionConflictError(
        'command session key does not match this session.',
      );
    }
    const key = managedSessionCommandKey(command.operation, command.commandId);
    const previous = this.transactions.get(key);
    if (previous !== undefined) {
      if (previous.contentDigest !== command.contentDigest) {
        throw new ManagedSessionConflictError(
          `command ${command.commandId} was already committed with different content.`,
        );
      }
      return {
        ...previous.receipt,
        committedSequence: this.committed,
        replayed: true,
      };
    }
    if (
      command.expectedSequence !== undefined &&
      command.expectedSequence !== this.committed
    ) {
      throw new ManagedSessionConflictError(
        `expectedSequence ${command.expectedSequence} does not match the committed sequence ${this.committed}; re-read before retrying.`,
      );
    }

    const events = values.map((value, index) => {
      const event = parseManagedSessionEvent(value);
      const actor = actors[index];
      assertManagedSessionEventActor(event, actor.class);
      if (!managedSessionKeysEqual(event.sessionKey, this.sessionKey)) {
        throw new ManagedSessionConflictError(
          'event session key does not match this session.',
        );
      }
      this.assertActorFence(event, actor);
      if (event.kind === 'activation.changed') {
        this.assertActivationEpoch(event);
      }
      if (this.eventIds.has(event.eventId)) {
        throw new ManagedSessionConflictError(
          `event id ${event.eventId} is already committed.`,
        );
      }
      return event;
    });
    if (events.length === 0) {
      throw new ManagedSessionRecordError(
        'a transaction must contain at least one event.',
      );
    }
    if (new Set(events.map((event) => event.eventId)).size !== events.length) {
      throw new ManagedSessionConflictError(
        'a transaction must not repeat an event id.',
      );
    }
    if (events[0].sequence !== this.committed + 1) {
      throw new ManagedSessionConflictError(
        `transaction starts at sequence ${events[0].sequence} but the committed sequence is ${this.committed}.`,
      );
    }
    const encoded = events.map((event) => JSON.stringify(event));
    encoded.forEach((line, index) => {
      if (
        Buffer.byteLength(line, 'utf8') > MANAGED_SESSION_LIMITS.maxEventBytes
      ) {
        throw new ManagedSessionRecordError(
          `event ${events[index].eventId} exceeds ${MANAGED_SESSION_LIMITS.maxEventBytes} bytes.`,
        );
      }
    });
    assertManagedSessionTransaction(
      events,
      encoded.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0),
    );

    const marker = parseManagedSessionCommitMarker({
      transactionId: randomUUID(),
      commandId: command.commandId,
      operation: command.operation,
      contentDigest: command.contentDigest,
      firstSequence: events[0].sequence,
      lastSequence: events[events.length - 1].sequence,
      eventCount: events.length,
      eventsDigest: managedSessionEventsDigest(events),
      previousCommitDigest: this.lastMarkerDigest,
    });
    const markerLine = JSON.stringify(marker);
    if (
      Buffer.byteLength(markerLine, 'utf8') >
      MANAGED_SESSION_LIMITS.maxCommitMarkerBytes
    ) {
      throw new ManagedSessionRecordError(
        `commit marker exceeds ${MANAGED_SESSION_LIMITS.maxCommitMarkerBytes} bytes.`,
      );
    }

    const branches = await this.validateRecoveryFacts(events);

    // Events first, marker last: a crash before the marker leaves the
    // transaction invisible rather than half applied.
    const records: unknown[] = [];
    let lastRecordUuid = this.lastRecordUuid;
    for (const event of events) {
      const next = this.createRecord(
        MANAGED_SESSION_EVENT_SUBTYPE,
        event,
        lastRecordUuid,
      );
      records.push(next.record);
      lastRecordUuid = next.uuid;
    }
    const final = this.createRecord(
      MANAGED_SESSION_COMMIT_SUBTYPE,
      marker,
      lastRecordUuid,
    );
    records.push(final.record);
    try {
      await this.journal.appendTransaction(records);
      this.lastRecordUuid = final.uuid;
    } catch (cause) {
      // Records may already be on disk, so the sequences this transaction
      // claimed are spent whether or not the marker landed.
      this.writeFailure =
        cause instanceof Error ? cause : new Error(String(cause));
      throw cause;
    }

    for (const event of events) {
      this.events.push(event);
      this.eventIds.add(event.eventId);
      if (event.kind === 'activation.changed') {
        this.activation = managedSessionActivationStateFrom(event);
      }
      if (event.kind === 'domain.committed') {
        this.recordDomainEvent(event);
      }
      this.recordRecoveryFacts(event, branches.has(event.eventId));
    }
    this.committed = marker.lastSequence;
    this.lastMarkerDigest = managedToolDigest(
      marker,
      MANAGED_SESSION_LIMITS.maxCommitMarkerBytes,
    );
    const receipt: ManagedSessionCommitReceipt = {
      transactionId: marker.transactionId,
      commandId: marker.commandId,
      operation: marker.operation,
      firstSequence: marker.firstSequence,
      lastSequence: marker.lastSequence,
      committedSequence: this.committed,
      replayed: false,
    };
    this.transactions.set(key, {
      receipt,
      contentDigest: command.contentDigest,
    });
    return receipt;
  }

  /**
   * Installs a new activation, which is what allows a Harness to append at all.
   *
   * The epoch is the authority's to assign, so the caller supplies an identity
   * and gets back the activation to present on every later append. Only a
   * coordinator may record the transition, so the actor is not a parameter.
   */
  async installActivation(input: {
    readonly activationId: string;
    readonly workerId: string;
    /**
     * How long the install claims the activation stays live. The format
     * requires a horizon; a reader compares it against the writer lock to judge
     * whether the holder is still there.
     */
    readonly leaseDurationMs: number;
  }): Promise<{ activationId: string; epoch: number }> {
    const epoch = (this.activation?.epoch ?? 0) + 1;
    const installRef = await this.publishActivationBody(
      'managed-activation-install',
      {
        version: 1,
        activationId: input.activationId,
        epoch,
        workerId: input.workerId,
        leaseDurationMs: input.leaseDurationMs,
      },
    );
    await this.commitActivation({
      activationId: input.activationId,
      epoch,
      workerId: input.workerId,
      phase: 'active',
      leaseDurationMs: input.leaseDurationMs,
      expiresAt: this.now() + input.leaseDurationMs,
      installRef,
      boundaryRef: null,
      operation: 'installActivation',
    });
    return { activationId: input.activationId, epoch };
  }

  /**
   * Records that the current activation stopped advancing the session.
   *
   * Without it a reader cannot tell a holder that finished from one that
   * vanished, so the boundary is what recovery reads. Releasing an activation
   * that is already gone is not an error: there is nothing left to fence.
   */
  async releaseActivation(): Promise<void> {
    if (this.recoveryBlocked) return;
    const current = this.activation;
    if (
      current === undefined ||
      current.phase === 'released' ||
      current.phase === 'revoked'
    ) {
      return;
    }
    const boundaryRef = await this.publishActivationBody(
      'managed-activation-boundary',
      {
        version: 1,
        activationId: current.activationId,
        epoch: current.epoch,
        committedSequence: this.committed,
        lastRecordUuid: this.lastRecordUuid,
      },
    );
    await this.commitActivation({
      activationId: current.activationId,
      epoch: current.epoch,
      workerId: current.workerId,
      phase: 'released',
      leaseDurationMs: null,
      expiresAt: current.expiresAt,
      installRef: null,
      boundaryRef,
      operation: 'releaseActivation',
    });
  }

  private async publishActivationBody(
    kind: string,
    body: Record<string, unknown>,
  ): Promise<ManagedSessionDurableRef> {
    const store = this.resources;
    if (store === undefined) {
      throw new ManagedSessionRecordError(
        'a resource store is required to change the activation.',
      );
    }
    return store.publish(kind, Buffer.from(JSON.stringify(body), 'utf8'));
  }

  private async commitActivation(input: {
    readonly activationId: string;
    readonly epoch: number;
    readonly workerId: string;
    readonly phase: string;
    readonly leaseDurationMs: number | null;
    readonly expiresAt: number | null;
    readonly installRef: ManagedSessionDurableRef | null;
    readonly boundaryRef: ManagedSessionDurableRef | null;
    readonly operation: string;
  }): Promise<void> {
    await this.appendExecutionEvent(
      {
        operation: input.operation,
        commandId: `${input.activationId}:${input.phase}`,
        sessionKey: this.sessionKey,
        contentDigest: this.header.definitionRef.digest,
      },
      (sequence) => ({
        v: MANAGED_SESSION_FORMAT_VERSION,
        sequence,
        eventId: `activation:${input.activationId}:${input.phase}`,
        sessionKey: this.sessionKey,
        kind: 'activation.changed',
        occurredAt: this.now(),
        payload: {
          activationId: input.activationId,
          epoch: input.epoch,
          workerId: input.workerId,
          subject: {
            type: 'activation',
            scopeId: input.activationId,
            activationId: input.activationId,
            epoch: input.epoch,
          },
          phase: input.phase,
          leaseDurationMs: input.leaseDurationMs,
          expiresAt: input.expiresAt,
          installRef: input.installRef,
          boundaryRef: input.boundaryRef,
        },
      }),
      { class: 'coordinator' },
    );
  }

  /**
   * Classifies the checkpoints a transaction or a cold log carries. It runs
   * before the first physical append, so a checkpoint whose state cannot be
   * verified never reaches the log or the recovery facts.
   */
  private async validateRecoveryFacts(
    events: readonly ManagedSessionEvent[],
  ): Promise<Set<string>> {
    const branches = new Set<string>();
    const pendingCheckpoints = new Map<string, number>();
    for (const event of events) {
      const branch = await readManagedBranchCheckpoint(
        event,
        this.resources,
        (id) => pendingCheckpoints.get(id) ?? this.checkpointSequences.get(id),
        this.committed,
      );
      if (branch !== undefined) branches.add(event.eventId);
      if (event.kind === 'checkpoint.committed') {
        pendingCheckpoints.set(
          event.payload['checkpointId'] as string,
          event.sequence,
        );
      }
    }
    return branches;
  }

  private recordRecoveryFacts(
    event: ManagedSessionEvent,
    branch: boolean,
  ): void {
    if (event.kind === 'checkpoint.committed') {
      this.checkpointSequences.set(
        event.payload['checkpointId'] as string,
        event.sequence,
      );
    }
    if (branch) {
      this.hasContinuation = true;
      return;
    }
    if (event.kind === 'context.compacted') {
      this.compactedThrough = event.payload['toSequence'] as number;
      this.hasContinuation = true;
      return;
    }
    if (event.kind === 'checkpoint.committed') {
      this.checkpoint = {
        checkpointId: event.payload['checkpointId'] as string,
        coveredSequence: event.payload['coveredSequence'] as number,
        previousCheckpointId: event.payload['previousCheckpointId'] as
          | string
          | null,
        stateRef: event.payload[
          'stateRef'
        ] as unknown as ManagedSessionDurableRef,
        boundary: event.payload['boundary'] as string | null,
      };
      return;
    }
    if (event.kind === 'action.changed') {
      this.actions.set(event.payload['requestId'] as string, {
        requestId: event.payload['requestId'] as string,
        kind: event.payload['kind'] as string,
        source: event.payload['source'] as string,
        inputRevision: event.payload['inputRevision'] as number,
        optionsRef: event.payload[
          'optionsRef'
        ] as ManagedSessionDurableRef | null,
        state: event.payload['state'] as ManagedSessionActionState,
        decisionRef: event.payload[
          'decisionRef'
        ] as ManagedSessionDurableRef | null,
      });
      return;
    }
    if (
      event.kind === 'model.attempt' ||
      event.kind === 'tool.intent' ||
      event.kind === 'tool.receipt' ||
      event.kind === 'turn.settled' ||
      (event.kind === 'message.committed' &&
        (event.payload['role'] === 'assistant' ||
          event.payload['role'] === 'tool_result'))
    ) {
      this.hasContinuation = true;
    }
  }

  private recordDomainEvent(event: ManagedSessionEvent): void {
    const domain = event.payload['domain'] as string;
    const previous = this.domainRecords.get(domain);
    this.domainRecords.set(domain, {
      revision: (previous?.revision ?? 0) + 1,
      recordRef: event.payload[
        'recordRef'
      ] as unknown as ManagedSessionDurableRef,
    });
  }

  /** The latest committed record for a registered domain, if any. */
  domainRecord(
    domain: ManagedSessionDomain,
  ): { revision: number; recordRef: ManagedSessionDurableRef } | undefined {
    return this.domainRecords.get(domain);
  }

  private assertActivationEpoch(event: ManagedSessionEvent): void {
    const next = managedSessionActivationStateFrom(event);
    const current = this.activation;
    if (current === undefined || next.activationId !== current.activationId) {
      const expected = (current?.epoch ?? 0) + 1;
      if (next.epoch !== expected) {
        throw new ManagedSessionConflictError(
          `activation ${next.activationId} must use epoch ${expected}, not ${next.epoch}.`,
        );
      }
      return;
    }
    if (next.epoch !== current.epoch) {
      throw new ManagedSessionConflictError(
        `activation ${next.activationId} is at epoch ${current.epoch} and cannot change to ${next.epoch}.`,
      );
    }
  }

  private assertActorFence(
    event: ManagedSessionEvent,
    actor: ManagedSessionActor,
  ): void {
    if (actor.class !== 'harness') return;
    const held = actor.activation;
    if (held === undefined) {
      throw new ManagedSessionConflictError(
        'a harness append must present the activation it holds.',
      );
    }
    const current = this.activation;
    if (current === undefined) {
      throw new ManagedSessionConflictError(
        'no activation is committed for this session, so no harness may append.',
      );
    }
    if (
      held.activationId !== current.activationId ||
      held.epoch !== current.epoch
    ) {
      throw new ManagedSessionConflictError(
        `activation ${held.activationId}/${held.epoch} is not the committed activation ${current.activationId}/${current.epoch}.`,
      );
    }
    if (current.phase !== 'installing' && current.phase !== 'active') {
      throw new ManagedSessionConflictError(
        `activation ${current.activationId} is ${current.phase} and may not append.`,
      );
    }
    const subject = event.subject;
    if (
      subject?.type !== 'activation' ||
      subject.activationId !== held.activationId ||
      subject.epoch !== held.epoch
    ) {
      throw new ManagedSessionConflictError(
        'event subject does not match the activation the harness holds.',
      );
    }
  }

  private createRecord(
    subtype:
      | typeof MANAGED_SESSION_EVENT_SUBTYPE
      | typeof MANAGED_SESSION_COMMIT_SUBTYPE,
    body: ManagedSessionRecordBody,
    parentUuid: string | null,
  ): { readonly uuid: string; readonly record: unknown } {
    const uuid = randomUUID();
    return {
      uuid,
      record: {
        uuid,
        parentUuid,
        sessionId: this.sessionKey.sessionId,
        timestamp: new Date(this.now()).toISOString(),
        type: 'system',
        subtype,
        cwd: this.cwd,
        version: this.version,
        managedSession: body,
      },
    };
  }
}

function actionDecisionsMatch(
  existing: ManagedSessionAction,
  request: {
    readonly state: ManagedSessionActionState;
    readonly decisionRef: ManagedSessionDurableRef | null;
  },
): boolean {
  if (existing.state !== request.state) return false;
  const left = existing.decisionRef;
  const right = request.decisionRef;
  if (left === null || right === null) return left === right;
  return left.digest === right.digest && left.byteLength === right.byteLength;
}

/**
 * Reads the complete committed prefix. A corrupt line inside the prefix fails
 * the scan rather than being skipped, because skipping it would resume
 * execution from an incomplete state.
 *
 * `maxBytes` bounds the scan to a frozen snapshot: a reader that already froze
 * a byte length has to keep answering from it, or a page it serves would mix in
 * records appended after the cursor was issued.
 */
export async function readManagedSessionLog(
  path: string,
  sessionKey: ManagedSessionKey,
  maxBytes?: number,
): Promise<ManagedSessionJournalScan> {
  return LocalJsonlManagedSessionJournalStore.read(path, sessionKey, maxBytes);
}
