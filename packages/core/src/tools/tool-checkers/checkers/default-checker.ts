/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for the session-local tools: writing a todo, managing the
 * task list, goals and topic, scheduling a wakeup, listing cron entries or
 * agents, the codebase investigator, and StructuredOutput — the result-return
 * channel injected into workflow and hook agents.
 *
 * No effect outside the session that a user needs to approve — rules still
 * apply, so a user can deny one; absent a rule it runs. They share one check,
 * so they share one entry.
 */

import { alwaysAllowChecker, type HostToolChecker } from '../rule-precedence.js';
import {
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  CODEBASE_INVESTIGATOR_TOOL_NAME,
  COMPLETE_TASK_TOOL_NAME,
  CREATE_GOAL_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  SCHEDULE_WAKEUP_TOOL_NAME,
  STRUCTURED_OUTPUT_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
} from '../../tool-names.js';

/** The session-local tools this entry covers. */
export const SESSION_LOCAL_TOOL_NAMES: readonly string[] = [
  // Only the isolated VM is authorized here. Every nested operation is checked
  // independently through the same permission pipeline as a direct tool call.
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  COMPLETE_TASK_TOOL_NAME,
  CREATE_GOAL_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  SCHEDULE_WAKEUP_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  CODEBASE_INVESTIGATOR_TOOL_NAME,
  STRUCTURED_OUTPUT_TOOL_NAME,
];

export function createDefaultToolChecker(toolName: string): HostToolChecker {
  return alwaysAllowChecker(toolName);
}
