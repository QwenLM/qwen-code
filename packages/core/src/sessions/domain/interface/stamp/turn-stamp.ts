/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageStamp } from './message-stamp.js';

/**
 * Stamp for constructing a {@link Turn} aggregate from external data.
 *
 * All fields are optional so that callers with partial data can still
 * construct a Session projection. When {@link messages} are supplied they
 * are grouped using the same rules as transcript projection.
 */
export interface TurnStamp {
  readonly promptId?: string;
  readonly sessionId?: string;
  readonly requestSetId?: string;
  readonly promptText?: string;
  readonly inputMode?: 'prompt' | 'bash';
  readonly agentId?: string;
  readonly messages?: readonly MessageStamp[];
}
