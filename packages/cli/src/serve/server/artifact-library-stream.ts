/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import {
  formatGenerationSse,
  GENERATION_HEARTBEAT_MS,
  writeGenerationSseChunk,
} from '../generation-sse.js';

export class ArtifactLibraryStream {
  private chain = Promise.resolve();
  private pending = 0;
  private stopped = false;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly onClose = () => {
    this.stopped = true;
    clearInterval(this.heartbeat);
  };

  constructor(private readonly res: Response) {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    this.heartbeat = setInterval(() => {
      if (!this.closed && this.pending === 0)
        void this.write(': heartbeat\n\n').catch(() => undefined);
    }, GENERATION_HEARTBEAT_MS);
    this.heartbeat.unref();
    res.once('close', this.onClose);
  }

  get closed(): boolean {
    return this.stopped || this.res.destroyed;
  }

  send(event: string, data: Record<string, unknown>): Promise<void> {
    return this.write(formatGenerationSse(event, data));
  }

  private write(chunk: string): Promise<void> {
    this.pending++;
    this.chain = this.chain
      .then(() => writeGenerationSseChunk(this.res, chunk))
      .catch((error: unknown) => {
        this.onClose();
        throw error;
      })
      .finally(() => this.pending--);
    return this.chain;
  }

  end(): void {
    this.onClose();
    this.res.off('close', this.onClose);
    if (!this.res.destroyed) this.res.end();
  }
}
