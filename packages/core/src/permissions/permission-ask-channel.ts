/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createAskMetricsStore,
  type AskMetricsStore,
} from './ask-handler/ask-facts.js';

/**
 * Per-session permission side-channel state.
 *
 * The ask facts used to be a module-level map keyed by the bare tool call id
 * with no session in the key at all, so two sessions using the same id shared
 * one entry and whichever consumed it first emptied it for the other. Holding
 * one store per `Config` puts the cap at session scope, and a session can no
 * longer read facts recorded for another session's ask.
 *
 * Created eagerly with the config so the whole permission chain can take it as
 * a plain field rather than threading it through optional accessors.
 */
export class PermissionTelemetry {
  /** Ask-settlement facts the presenter records and the execution gate reads. */
  readonly askMetrics: AskMetricsStore = createAskMetricsStore();
}
