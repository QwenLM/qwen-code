/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Label used for API calls that do not originate from a subagent
 * (i.e. calls made by the main conversation).
 */
export const MAIN_SOURCE = 'main';

/**
 * AsyncLocalStorage carrying the name of the subagent that owns the current
 * execution context. When set, `LoggingContentGenerator` annotates emitted
 * telemetry events with this name so the `/stats` panel can attribute API
 * calls to the originating subagent. When unset, API calls are attributed
 * to `MAIN_SOURCE` ("main").
 *
 * AgentCore wraps its reasoning loop in `subagentNameContext.run(this.name,
 * ...)`; the content generator reads the store inside its per-call logging
 * helpers.
 */
export const subagentNameContext = new AsyncLocalStorage<string>();
