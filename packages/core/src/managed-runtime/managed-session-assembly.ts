/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import { ManagedSessionRecordSink } from './managed-session-record-sink.js';
import type { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type {
  ManagedSessionJournalStore,
  ManagedSessionResourceStore,
} from './managed-session-storage.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from './managed-session-records.js';
import { ManagedSessionRecordError } from './managed-session-records.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MANAGED_SESSION_ASSEMBLY');

/**
 * Keeps the installed activation's horizon ahead of a reader while the worker
 * is alive. The install stamps a fixed expiry, so without renewal a session
 * that outlives its lease reads as abandoned behind a live writer lock.
 * Renewal failures are retried on the next tick: a durable write failure
 * already fences new appends, so the timer only logs.
 */
function startActivationRenewal(
  authority: LocalManagedSessionAuthority,
  leaseDurationMs: number,
): { stop: () => void } {
  const intervalMs = Math.max(Math.floor(leaseDurationMs / 3), 1);
  const timer = setInterval(() => {
    authority.renewActivation({ leaseDurationMs }).catch((error: unknown) => {
      debugLogger.debug(
        'Managed Session activation renewal failed',
        describeRenewalError(error),
      );
    });
  }, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}

function describeRenewalError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  /**
   * Releases the current activation and installs a successor. The next Harness
   * handle must present the returned identity; the sink names it automatically.
   */
  replaceActivation(): Promise<{
    readonly activationId: string;
    readonly epoch: number;
  }>;
  /** Seals the writer, leaving the at-rest barrier in place. */
  close(): Promise<void>;
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
    async replaceActivation() {
      await authority.releaseActivation();
      activation = await authority.installActivation({
        activationId: randomUUID(),
        workerId: options.workerId,
        leaseDurationMs: options.activationLeaseDurationMs,
      });
      return activation;
    },
    // Sealing is the at-rest barrier, but only the lease's owner may end it.
    // A call that owns the whole lifecycle also records the boundary, or the
    // activation would read as abandoned. An adopted lease still stops the
    // renewal it started; only the lease itself stays with its owner.
    close: async () => {
      renewal.stop();
      if (adopted) return;
      await authority.releaseActivation();
      await authority.close();
    },
  };
}
