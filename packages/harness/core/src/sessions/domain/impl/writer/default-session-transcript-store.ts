/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nodePath from 'node:path';
import type { Session } from '../../interface/session/session.js';
import type { SessionTranscriptWriter } from '../../interface/writer/session-transcript-writer.js';
import type { SessionTranscriptStore } from '../../interface/writer/session-transcript-store.js';
import type { SessionWriterOptions } from '../../interface/writer/session-writer-options.js';
import { WriterCoordinator } from '../../../infra/writer/writer-coordinator.js';
import type { WriterCoordinatorOptions } from '../../../infra/writer/writer-coordinator-options.js';
import type { SessionWriterStateReader } from '../../../infra/reader/session-writer-state-reader.js';
import { FileSystemSessionWriterStateReader } from '../../../infra/reader/file-system-state-reader.js';
import { resolveBucketDir } from '../../../utils/session-utils.js';
import { SessionTranscriptWriterImpl } from './session-transcript-writer-impl.js';
import { LeasedSessionTranscriptWriter } from './leased-session-transcript-writer.js';
import {
  SessionWriterState,
  type ManagedSessionWriterState,
} from './session-writer-state.js';

export interface DefaultSessionTranscriptStoreOptions {
  readonly coordinator?: WriterCoordinator;
  readonly coordinatorOptions?: WriterCoordinatorOptions;
  readonly stateReader?: SessionWriterStateReader;
}

/**
 * Process-scoped composition root for transcript writers.
 *
 * Mirrors the legacy `TranscriptStore`: it maintains a map of active writer
 * states keyed by session id and canonical file path, hands out reference-
 * counted handles, and coordinates process-wide flush/close.
 */
export class DefaultSessionTranscriptStore
  implements SessionTranscriptStore
{
  private readonly coordinator: WriterCoordinator;
  private readonly stateReader: SessionWriterStateReader;
  private readonly states = new Map<
    string,
    Promise<ManagedSessionWriterState>
  >();
  private closed = false;

  constructor(options: DefaultSessionTranscriptStoreOptions = {}) {
    this.coordinator =
      options.coordinator ?? new WriterCoordinator(options.coordinatorOptions);
    this.stateReader =
      options.stateReader ?? new FileSystemSessionWriterStateReader();
  }

  async acquireWriter(
    session: Session,
    options?: SessionWriterOptions,
  ): Promise<SessionTranscriptWriter> {
    this.assertOpen();

    const sessionId = session.getSessionId();
    const projectDir = session.getProjectDir();
    const bucketDir = resolveBucketDir(
      projectDir,
      options?.bucketDir ?? session.getTranscriptBucketDir(),
    );
    const filePath = nodePath.join(bucketDir, `${sessionId}.jsonl`);

    const channel = await this.coordinator.acquire(filePath);
    const key = makeWriterStateKey(sessionId, channel.filePath);

    let statePromise = this.states.get(key);
    if (statePromise) {
      await channel.release();
    } else {
      statePromise = this.createState(key, channel.filePath, channel, session, options);
      this.states.set(key, statePromise);
      void statePromise.catch(() => {
        if (this.states.get(key) === statePromise) {
          this.states.delete(key);
        }
      });
    }

    const state = await statePromise;
    if (!state.retain()) {
      await state.forceClose();
      if (this.states.get(key) === statePromise) {
        this.states.delete(key);
      }
      return this.acquireWriter(session, options);
    }

    return new LeasedSessionTranscriptWriter(state.writer, () =>
      this.releaseWriter(state),
    );
  }

  async flushAll(): Promise<void> {
    this.assertOpen();
    return this.coordinator.flushAll();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const states = await Promise.allSettled([...this.states.values()]);
    const initializedStates = states.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const writerResults = await Promise.allSettled(
      initializedStates.map((state) => state.forceClose()),
    );
    this.states.clear();
    const coordinatorResult = await Promise.allSettled([
      this.coordinator.close(),
    ]);
    const rejected = [...writerResults, ...coordinatorResult].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) {
      throw rejected.reason;
    }
  }

  private async releaseWriter(state: ManagedSessionWriterState): Promise<void> {
    let closed = true;
    try {
      closed = await state.release();
    } finally {
      if (closed) {
        await this.deleteStateIfCurrent(state);
      }
    }
  }

  private async deleteStateIfCurrent(
    state: ManagedSessionWriterState,
  ): Promise<void> {
    const current = this.states.get(state.key);
    if (current && (await current.catch(() => undefined)) === state) {
      this.states.delete(state.key);
    }
  }

  private async createState(
    key: string,
    canonicalPath: string,
    channel: Awaited<ReturnType<WriterCoordinator['acquire']>>,
    session: Session,
    options?: SessionWriterOptions,
  ): Promise<SessionWriterState> {
    try {
      const snapshot = await this.stateReader.load(canonicalPath, session.getSessionId());
      const writer = new SessionTranscriptWriterImpl({
        channel,
        sessionId: session.getSessionId(),
        cwd: options?.cwd ?? session.getCwd(),
        entrypoint: options?.entrypoint ?? 'unknown',
        ...(options?.userType ? { userType: options.userType } : {}),
        ...(options?.version ? { version: options.version } : {}),
        ...(options?.gitBranch
          ? { gitBranch: options.gitBranch }
          : session.getGitBranch()
            ? { gitBranch: session.getGitBranch() }
            : {}),
      });
      if (snapshot.fileExisted) {
        writer.initializeExistingTranscript(
          snapshot.messageUuids,
          snapshot.mainParentUuid,
          snapshot.activeLeafUuid,
        );
      }
      writer.hydrateSessionMetadata(snapshot);
      if (session.getWorkspaceDirectories().length > 0) {
        writer.primeWorkspaceDirectories(session.getWorkspaceDirectories());
      }
      return new SessionWriterState(key, canonicalPath, writer);
    } catch (error) {
      await channel.release();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('SessionTranscriptStore is closed');
    }
  }
}

function makeWriterStateKey(sessionId: string, canonicalPath: string): string {
  return `${sessionId}\0${canonicalPath}`;
}
