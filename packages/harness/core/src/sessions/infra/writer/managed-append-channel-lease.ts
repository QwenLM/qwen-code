/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptEntry } from '../entry/transcript-entry.js';
import type { AppendChannel } from './append-channel.js';
import type { AppendChannelLease } from './append-channel-lease.js';
import type { WriterCoordinator } from './writer-coordinator.js';

export class ManagedAppendChannelLease implements AppendChannelLease {
  readonly filePath: string;
  private released = false;

  constructor(
    private readonly coordinator: WriterCoordinator,
    filePath: string,
    private readonly channel: AppendChannel,
  ) {
    this.filePath = filePath;
  }

  append(entries: readonly TranscriptEntry[]): Promise<void> {
    this.assertActive();
    return this.channel.append(entries);
  }

  barrier(): Promise<void> {
    this.assertActive();
    return this.channel.barrier();
  }

  flush(): Promise<void> {
    return this.barrier();
  }

  readTail(maxBytes?: number): Promise<Buffer> {
    this.assertActive();
    return this.channel.readTail(maxBytes);
  }

  readAll(): Promise<Buffer> {
    this.assertActive();
    return this.channel.readAll();
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    let failed = true;
    try {
      await this.channel.barrier();
      failed = false;
    } finally {
      this.coordinator.release(this.filePath, this.channel, failed);
    }
  }

  private assertActive(): void {
    if (this.released) {
      throw new Error('AppendChannelLease is released');
    }
  }
}
