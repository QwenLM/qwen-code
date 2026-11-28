/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomClient } from '../../../client/customClient.js';
import type { QoderApi } from './api/qoder.js';

/**
 * The client-facing Qoder facade: server capabilities plus lifecycle.
 *
 * Extends the generic `CustomClient` shape so the shared `ResponsesTransport`
 * can consume it without a Qoder-specific transport.
 */
export interface QoderClient extends CustomClient {
  readonly api: QoderApi;

  /** Starts client-owned resources once. Idempotent. */
  start(): Promise<void>;

  /** Stops client-owned resources; repeated calls share the result. */
  stop(): Promise<void>;

  /** Signals that login state changed (sign-in, sign-out, token rotation). */
  notifyLoginStateChanged(): Promise<void>;
}
