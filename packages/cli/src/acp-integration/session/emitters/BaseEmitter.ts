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
