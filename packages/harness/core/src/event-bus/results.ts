/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HandlerName } from './events.js';
import type { TaskStartedFacts } from './task-start.js';

export interface ConversationResult {
  readonly taskStarted?: TaskStartedFacts;
}

export interface HandlerResultMap {
  conversation: ConversationResult | void;
  llm: void;
  tool: void;
  query: void;
}

export interface HandlerResult<H extends HandlerName = HandlerName> {
  /** Which handler produced it; attribution only. */
  source: H;
  result: HandlerResultMap[H];
}

export type AnyHandleResult = {
  [H in HandlerName]: HandlerResult<H>;
}[HandlerName];
