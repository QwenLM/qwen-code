/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionContext } from '../types.js';
import type * as acp from '../../acp.js';

/**
 * Abstract base class for all session event emitters.
 * Provides common functionality and access to session context.
 */
export abstract class BaseEmitter {
  constructor(protected readonly ctx: SessionContext) {}

  /**
   * Converts an ISO timestamp string or epoch ms to epoch ms number.
   * Returns undefined if the input is not a valid timestamp.
   */
  protected static toEpochMs(ts?: string | number): number | undefined {
    if (typeof ts === 'number') {
      return Number.isFinite(ts) ? ts : undefined;
    }
    if (typeof ts === 'string') {
      const ms = new Date(ts).getTime();
      return Number.isFinite(ms) ? ms : undefined;
    }
    return undefined;
  }

  /**
   * Sends a session update to the ACP client.
   */
  protected async sendUpdate(update: acp.SessionUpdate): Promise<void> {
    return this.ctx.sendUpdate(update);
  }

  /**
   * Gets the session configuration.
   */
  protected get config() {
    return this.ctx.config;
  }

  /**
   * Gets the session ID.
   */
  protected get sessionId() {
    return this.ctx.sessionId;
  }
}
