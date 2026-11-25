/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptCommitObserver } from './commit-observer.js';
import type { TranscriptEntry } from '../entry/transcript-entry.js';
import { AppendChannel } from './append-channel.js';
import type { AppendChannelOptions } from './append-channel-options.js';
import type { AppendChannelLease } from './append-channel-lease.js';
import { ManagedAppendChannelLease } from './managed-append-channel-lease.js';
import type { WriterCoordinatorOptions } from './writer-coordinator-options.js';
import { canonicalizeTranscriptPath } from '../path/transcript-path-canonicalizer.js';

interface ChannelState {
  readonly channel: AppendChannel;
  leases: number;
}

/**
 * Process-scoped coordinator that owns one append order domain per path.
 *
 * It keeps exactly one
 * {@link AppendChannel} per canonical transcript path and hands out reference-
 * counted leases. When a lease releases with a failure the channel is evicted
 * so the next acquire builds a fresh ordering domain.
 */
export class WriterCoordinator {
  private readonly options: WriterCoordinatorOptions;
  private readonly channels = new Map<string, ChannelState>();
  private readonly commitObservers = new Set<TranscriptCommitObserver>();
  private closed = false;

  constructor(options: WriterCoordinatorOptions = {}) {
    this.options = options;
    if (options.commitObserver) {
      this.commitObservers.add(options.commitObserver);
    }
  }

  addCommitObserver(observer: TranscriptCommitObserver): () => void {
    this.assertOpen();
    this.commitObservers.add(observer);
    return () => {
      this.commitObservers.delete(observer);
    };
  }

  async acquire(filePath: string): Promise<AppendChannelLease> {
    this.assertOpen();
    const canonicalPath = await this.canonicalizePath(filePath);
    this.assertOpen();
    const state = this.ensureChannelState(canonicalPath);
    state.leases++;
    return new ManagedAppendChannelLease(this, canonicalPath, state.channel);
  }

  async barrier(filePath: string): Promise<void> {
    const canonicalPath = await this.canonicalizePath(filePath);
    await this.channels.get(canonicalPath)?.channel.barrier();
  }

  async publishCommittedEntries(
    filePath: string,
    entries: readonly TranscriptEntry[],
  ): Promise<void> {
    this.assertOpen();
    const canonicalPath = await this.canonicalizePath(filePath);
    await this.notifyCommitted(canonicalPath, entries);
  }

  async deleteFile(filePath: string): Promise<void> {
    this.assertOpen();
    const canonicalPath = await this.canonicalizePath(filePath);
    const state = this.ensureChannelState(canonicalPath);
    await state.channel.deleteFile();
    this.channels.delete(canonicalPath);
  }

  async createFileExclusive(
    filePath: string,
    entries: readonly TranscriptEntry[],
  ): Promise<void> {
    this.assertOpen();
    const canonicalPath = await this.canonicalizePath(filePath);
    const state = this.ensureChannelState(canonicalPath);
    await state.channel.createExclusive(entries);
  }

  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.channels.values()].map((state) => state.channel.flush()),
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const states = [...this.channels.values()];
    const results = await Promise.allSettled(
      states.map((state) => state.channel.close()),
    );
    this.channels.clear();
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) {
      throw rejected.reason;
    }
  }

  /**
   * Drops one lease. `discard` evicts the channel so the next `acquire()` builds
   * a fresh one — used when the channel failed and is permanently poisoned.
   */
  release(
    canonicalPath: string,
    channel: AppendChannel,
    discard: boolean,
  ): void {
    const state = this.channels.get(canonicalPath);
    if (!state || state.channel !== channel) {
      return;
    }
    if (state.leases > 0) {
      state.leases--;
    }
    if (discard && state.leases === 0) {
      this.channels.delete(canonicalPath);
    }
  }

  private ensureChannelState(canonicalPath: string): ChannelState {
    let state = this.channels.get(canonicalPath);
    if (!state) {
      state = {
        channel: new AppendChannel(this.channelOptions(canonicalPath)),
        leases: 0,
      };
      this.channels.set(canonicalPath, state);
    }
    return state;
  }

  private channelOptions(filePath: string): AppendChannelOptions {
    return {
      filePath,
      ...(this.options.flushIntervalMs !== undefined
        ? { flushIntervalMs: this.options.flushIntervalMs }
        : {}),
      ...(this.options.maxBatchBytes !== undefined
        ? { maxBatchBytes: this.options.maxBatchBytes }
        : {}),
      ...(this.options.fileSystem
        ? { fileSystem: this.options.fileSystem }
        : {}),
      commitObserver: this.notifyCommitted,
    };
  }

  private readonly notifyCommitted: TranscriptCommitObserver = async (
    filePath,
    entries,
  ) => {
    if (this.commitObservers.size === 0) {
      return;
    }
    const results = await Promise.allSettled(
      [...this.commitObservers].map((observer) => observer(filePath, entries)),
    );
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(result.reason as unknown);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Transcript commit observer failed');
    }
  };

  /** Resolves a transcript path without acquiring or creating a write channel. */
  canonicalizePath(filePath: string): Promise<string> {
    this.assertOpen();
    return canonicalizeTranscriptPath(filePath, this.options.fileSystem);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('WriterCoordinator is closed');
    }
  }
}
