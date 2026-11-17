/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  LocalManagedSessionAuthority,
  activationAlreadyInstalledError,
} from './managed-session-authority.js';
import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import { ManagedSessionRecordSink } from './managed-session-record-sink.js';
import type { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import {
  ManagedSessionCommitRejectedError,
  type ManagedSessionCommitProof,
  type ManagedSessionJournalStore,
  type ManagedSessionResourceStore,
} from './managed-session-storage.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
  ManagedSessionSubject,
} from './managed-session-records.js';
import {
  ManagedSessionAppendUnsettledError,
  ManagedSessionRecordError,
} from './managed-session-records.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MANAGED_SESSION_ASSEMBLY');

/**
 * Keeps the installed activation's horizon ahead of a reader while the worker
 * is alive. The install stamps a fixed expiry, so without renewal a session
 * that outlives its lease reads as abandoned behind a live writer lock.
 * Renewal failures are retried on the next tick; a durable write failure
 * already fences new appends. A renewal that is still in flight owns the next
 * attempt: queueing another one behind a stalled Store call would grow the
 * backlog for the whole outage.
 *
 * A stopped writer cannot renew again, and a persistent non-recoverable
 * failure repeats the same rejection every interval for the rest of the
 * process's life, so both end the loop. Two refusals are recoverable and keep
 * retrying instead: an unsettled append (the store may settle it later) and a
 * rejected commit (the store rolled the attempt back and the authority does
 * not latch a write failure behind it). Both clear the count, so the cap
 * measures consecutive refusals; three of them span one full lease
 * (`leaseDurationMs / 3` per attempt), past which the activation cannot be
 * kept ahead of a reader anyway.
 */
const MAX_RENEWAL_FAILURES = 3;

function startActivationRenewal(
  authority: LocalManagedSessionAuthority,
  leaseDurationMs: number,
): { stop: () => Promise<void> } {
  const intervalMs = Math.max(Math.floor(leaseDurationMs / 3), 1);
  let inFlight: Promise<void> | undefined;
  let failures = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (inFlight || stopped) return;
    inFlight = authority
      .renewActivation({ leaseDurationMs })
      .then(() => {
        if (!stopped) failures = 0;
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (
          error instanceof ManagedSessionAppendUnsettledError ||
          error instanceof ManagedSessionCommitRejectedError
        ) {
          // Both are recoverable: the store may still settle the append, and a
          // rollbackable commit rejection leaves the writer writable (the
          // authority rethrows it before latching a write failure). A later
          // tick can renew once the store recovers, so neither may count
          // toward the permanent stop. Clearing the count keeps the cap
          // measuring consecutive refusals rather than a process lifetime.
          failures = 0;
          debugLogger.debug(
            'Managed Session activation renewal deferred',
            describeRenewalError(error),
          );
          return;
        }
        debugLogger.debug(
          'Managed Session activation renewal failed',
          describeRenewalError(error),
        );
        failures += 1;
        if (authority.writesStopped || failures >= MAX_RENEWAL_FAILURES) {
          debugLogger.warn(
            'Managed Session activation renewal stopped',
            authority.writesStopped
              ? 'the writer stopped accepting appends'
              : `${failures} consecutive failures`,
          );
          stopped = true;
          clearInterval(timer);
        }
      })
      .finally(() => {
        inFlight = undefined;
      });
  }, intervalMs);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      return inFlight ?? Promise.resolve();
    },
  };
}

function describeRenewalError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rejects a close whose activation release and writer seal both failed.
 *
 * `errors` keeps both failures. The seal failure is the one that says what
 * state the writer was left in, so a caller that classifies a close failure
 * (a writer conflict, a lost writer) reads `sealError` rather than this
 * wrapper, whose own class names neither.
 */
export class ManagedSessionCloseError extends AggregateError {
  constructor(
    readonly sealError: unknown,
    readonly releaseError: unknown,
  ) {
    super(
      [sealError, releaseError],
      `Managed Session close failed to seal the writer (${describeRenewalError(sealError)}) after releasing the activation failed (${describeRenewalError(releaseError)})`,
    );
    this.name = 'ManagedSessionCloseError';
  }
}

export interface OpenManagedSessionOptions {
  readonly runtimeBaseDir: string;
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly sessionKey: ManagedSessionKey;
  readonly cwd: string;
  readonly version: string;
  /** Supplied when creating a session; omitted when reopening one. */
  readonly create?: {
    readonly definitionRef: ManagedSessionDurableRef;
    readonly rootSnapshotRef: ManagedSessionDurableRef;
    readonly createdBy: string;
  };
  /** Create requests fail when the durable authority already exists. */
  readonly requireNew?: boolean;
  /**
   * Keeps the Stage H resources that opening verified for the caller to take;
   * see `LocalManagedSessionAuthority.takeVerifiedExtensionResources`.
   */
  readonly retainVerifiedResources?: boolean;
  /**
   * Identifies the worker advancing the session. Opening installs an activation
   * under this identity, because a writer that opens the log is by definition
   * the party advancing it, and only an activation lets a Harness append.
   */
  readonly workerId: string;
  /**
   * How long the installed activation claims to stay live. Required because the
   * format records a horizon and the policy belongs to the caller: nothing here
   * knows how long that worker is supervised for.
   */
  readonly activationLeaseDurationMs: number;
  /** Overrides local JSONL persistence for hosted deployments. */
  readonly journalStore?: ManagedSessionJournalStore;
  /** Overrides local resource files for hosted deployments. */
  readonly resourceStore?: ManagedSessionResourceStore;
  /**
   * An already-held writer to adopt instead of acquiring one.
   *
   * Two writers for one session cannot coexist, so a caller that already owns
   * the session's writer hands it in. Its owner keeps the lifecycle: `close()`
   * then leaves the lease alone rather than sealing it.
   */
  readonly lease?: SessionWriterLease;
}

export interface ManagedSession {
  readonly authority: LocalManagedSessionAuthority;
  readonly resources: ManagedSessionResourceStore;
  readonly sink: ManagedSessionRecordSink;
  /** The activation currently advancing this session. */
  readonly activation: {
    readonly activationId: string;
    readonly epoch: number;
  };
  /**
   * Records that this activation stopped advancing the session.
   *
   * Separate from `close()` because it must land after the last record and
   * before the writer is sealed: a record naming a released activation is
   * refused by the fence.
   */
  releaseActivation(): Promise<void>;
  prepareOwnershipRelease(): Promise<ManagedSessionCommitProof>;
  /**
   * Releases the current activation and installs a successor. The next Harness
   * handle must present the returned identity; the sink names it automatically.
   * The successor's ID is random unless `activationId` names it. Hosted Hook
   * release reads a random successor as a load that may own a Hook Runtime,
   * so a successor that never acquires one carries a `hook_operation` subject
   * or the ID `managedHookRestoreActivationId` derives. A named ID must be new
   * to the log; a repeat is refused before the current activation is released.
   */
  replaceActivation(
    subject?: ManagedSessionSubject,
    activationId?: string,
  ): Promise<{
    readonly activationId: string;
    readonly epoch: number;
  }>;
  /**
   * Seals the writer, leaving the at-rest barrier in place. Omit activation
   * release only when an external permanent lifecycle fence forbids appends.
   * When both the release and the seal fail, the close rejects with a
   * `ManagedSessionCloseError`; otherwise with the failure itself.
   */
  close(options?: { readonly releaseActivation?: boolean }): Promise<void>;
}

/**
 * Opens a Managed session as one unit: the writer, the resource store that
 * holds event bodies, and the sink a recorder writes through.
 *
 * The pieces were built separately and each verified on its own, but a caller
 * assembling them by hand could easily get the lifecycle wrong -- releasing the
 * writer instead of sealing it, or pointing the store at a different root than
 * the reader. Composing them here keeps those decisions in one place.
 */
export async function openManagedSession(
  options: OpenManagedSessionOptions,
): Promise<ManagedSession> {
  if (options.journalStore !== undefined && options.lease !== undefined) {
    throw new ManagedSessionRecordError(
      'journalStore and an adopted local lease cannot be supplied together.',
    );
  }
  const resources =
    options.resourceStore ??
    LocalManagedSessionResourceStore.create({
      runtimeBaseDir: options.runtimeBaseDir,
      sessionKey: options.sessionKey,
    });
  const adopted = options.lease !== undefined;
  const journalStore =
    options.journalStore ??
    new LocalJsonlManagedSessionJournalStore({
      runtimeBaseDir: options.runtimeBaseDir,
      sessionId: options.sessionId,
      transcriptPath: options.transcriptPath,
      requireNew: options.requireNew,
      ...(options.lease === undefined ? {} : { lease: options.lease }),
    });
  const journal = await journalStore.open({ sessionKey: options.sessionKey });
  let authority: LocalManagedSessionAuthority;
  try {
    authority = await LocalManagedSessionAuthority.open({
      journal,
      sessionKey: options.sessionKey,
      cwd: options.cwd,
      version: options.version,
      resources,
      ...(options.create === undefined ? {} : { create: options.create }),
      ...(options.requireNew === true ? { requireNew: true } : {}),
      ...(options.retainVerifiedResources === true
        ? { retainVerifiedResources: true }
        : {}),
      // A takeover proves the sealed writer's commit position before this
      // authority may advance the log.
      ...(journal.takeoverCommitProof === undefined
        ? {}
        : { expectedCommitProof: journal.takeoverCommitProof }),
    });
  } catch (cause) {
    // An adopted writer is not ours to end: releasing it would pull the lease
    // out from under its owner. One we acquired must be released, since sealing
    // an unopened session leaves a barrier with nothing behind it and leaving it
    // held blocks every later attempt.
    await journal.abort().catch(() => undefined);
    throw cause;
  }

  let activation: { activationId: string; epoch: number };
  try {
    activation = await authority.installActivation({
      activationId: randomUUID(),
      workerId: options.workerId,
      leaseDurationMs: options.activationLeaseDurationMs,
    });
  } catch (cause) {
    await journal.abort().catch(() => undefined);
    throw cause;
  }

  // Installed before the sink exists, so there is no window in which a record
  // has no activation to name. The callback reads the live binding so a
  // replacement handle's records name the successor, not the drained one.
  const sink = new ManagedSessionRecordSink(authority, resources, () => ({
    class: 'harness',
    activation,
  }));

  const renewal = startActivationRenewal(
    authority,
    options.activationLeaseDurationMs,
  );

  return {
    authority,
    resources,
    sink,
    get activation() {
      return activation;
    },
    releaseActivation: () => authority.releaseActivation(),
    prepareOwnershipRelease: async () => {
      if (adopted)
        throw new ManagedSessionRecordError(
          'An adopted writer cannot release ownership.',
        );
      await renewal.stop();
      await authority.releaseActivation();
      if (authority.currentActivation?.phase !== 'released')
        throw new ManagedSessionRecordError(
          'Ownership release requires a released activation.',
        );
      return authority.commitProof;
    },
    async replaceActivation(subject, activationId) {
      // Refuse before the release, or the current activation would be left
      // released with no successor.
      if (
        activationId !== undefined &&
        authority.hasInstalledActivation(activationId)
      ) {
        throw activationAlreadyInstalledError(activationId);
      }
      await authority.releaseActivation();
      activation = await authority.installActivation({
        activationId: activationId ?? randomUUID(),
        workerId: options.workerId,
        leaseDurationMs: options.activationLeaseDurationMs,
        subject,
      });
      return activation;
    },
    // Sealing is the at-rest barrier, but only the lease's owner may end it.
    // A call that owns the whole lifecycle also records the boundary, or the
    // activation would read as abandoned. An external permanent fence may
    // forbid that append. An adopted lease still stops the
    // renewal it started; only the lease itself stays with its owner.
    // The seal runs even when releasing the activation failed: a writer left
    // unsealed can neither resume cleanly nor be taken over. A release
    // failure rejects the close; when the seal fails too, the close rejects
    // with both, so neither is lost to a debug line that is off by default
    // (review round 1, R1-4). The seal error itself is left untouched: the
    // lease hands the same memoized rejection to every later seal, and the
    // seal often carries a cause of its own (review round 1, R1-3 and R1-4).
    // The wrapper exposes the seal error for callers that classify it.
    close: async (options) => {
      renewal.stop();
      if (adopted) return;
      let released = true;
      let releaseError: unknown;
      try {
        if (options?.releaseActivation !== false)
          await authority.releaseActivation();
      } catch (error) {
        released = false;
        releaseError = error;
        debugLogger.debug(
          'Managed Session activation release failed before seal',
          describeRenewalError(error),
        );
      }
      try {
        await authority.close();
      } catch (sealError) {
        if (released) throw sealError;
        throw new ManagedSessionCloseError(sealError, releaseError);
      }
      if (!released) throw releaseError;
    },
  };
}
