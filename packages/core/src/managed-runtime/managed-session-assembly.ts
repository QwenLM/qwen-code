/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { ManagedSessionRecordSink } from './managed-session-record-sink.js';
import type { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from './managed-session-records.js';

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
  readonly resources: LocalManagedSessionResourceStore;
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
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: options.runtimeBaseDir,
    sessionKey: options.sessionKey,
  });
  const adopted = options.lease !== undefined;
  const lease =
    options.lease ??
    (await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: options.runtimeBaseDir,
      sessionId: options.sessionId,
      transcriptPath: options.transcriptPath,
    }));
  let authority: LocalManagedSessionAuthority;
  try {
    authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: options.sessionKey,
      cwd: options.cwd,
      version: options.version,
      resources,
      ...(options.create === undefined ? {} : { create: options.create }),
    });
  } catch (cause) {
    // An adopted writer is not ours to end: releasing it would pull the lease
    // out from under its owner. One we acquired must be released, since sealing
    // an unopened session leaves a barrier with nothing behind it and leaving it
    // held blocks every later attempt.
    if (!adopted) {
      await lease.release().catch(() => undefined);
    }
    throw cause;
  }

  let activation = await authority.installActivation({
    activationId: randomUUID(),
    workerId: options.workerId,
    leaseDurationMs: options.activationLeaseDurationMs,
  });

  // Installed before the sink exists, so there is no window in which a record
  // has no activation to name. The callback reads the live binding so a
  // replacement handle's records name the successor, not the drained one.
  const sink = new ManagedSessionRecordSink(authority, resources, () => ({
    class: 'harness',
    activation,
  }));

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
    // activation would read as abandoned.
    close: adopted
      ? async () => undefined
      : async () => {
          await authority.releaseActivation();
          await authority.close();
        },
  };
}
