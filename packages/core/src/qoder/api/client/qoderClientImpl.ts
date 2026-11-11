/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QoderApi } from './api/qoder.js';
import type { QoderClient } from './qoderClient.js';
import type { QoderTokenProvider } from './pipeline/valve/authValve.js';

/**
 * Concrete {@link QoderClient}. The outbound pipeline owns all HTTP concerns;
 * this class only exposes the API facade and translates login-state changes
 * into token-cache invalidation.
 */
export class QoderClientImpl implements QoderClient {
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;

  constructor(
    readonly api: QoderApi,
    private readonly tokenProvider: QoderTokenProvider,
  ) {}

  start(): Promise<void> {
    if (!this.startPromise) {
      this.stopPromise = undefined;
      this.startPromise = Promise.resolve();
    }
    return this.startPromise;
  }

  stop(): Promise<void> {
    this.stopPromise ??= Promise.resolve().then(() => {
      this.tokenProvider.invalidate?.();
    });
    return this.stopPromise;
  }

  async notifyLoginStateChanged(): Promise<void> {
    this.tokenProvider.invalidate?.();
  }
}
