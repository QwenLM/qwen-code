/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What started a turn. Carried through the turn hooks and the event-bus state so
 * a consumer can tell a typed prompt from a scheduled fire or a subagent run.
 */
export type TaskTrigger =
  | 'user_prompt'
  | 'continuation'
  | 'scheduled'
  | 'subagent'
  | 'workflow'
  | 'unknown';
