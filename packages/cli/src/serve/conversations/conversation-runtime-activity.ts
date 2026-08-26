/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export class ConversationRuntimeActivityGate {
  private sealed = false;
  private active = 0;
  private drain?: { promise: Promise<void>; resolve: () => void };

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.sealed) {
      throw Object.assign(
        new Error('The daemon is draining and no longer accepts work.'),
        { code: 'daemon_draining' },
      );
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      if (this.active === 0) {
        this.drain?.resolve();
        this.drain = undefined;
      }
    }
  }

  sealAndWait(): Promise<void> {
    this.sealed = true;
    if (this.active === 0) return Promise.resolve();
    if (!this.drain) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.drain = { promise, resolve };
    }
    return this.drain.promise;
  }
}
