/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Maps session state onto OSC 7501 program status records.
 *
 * Privacy: `msg` only ever carries fixed phrases, the first line of an error,
 * or a session title the user set explicitly. Prompt text and model output
 * never leave the TUI through this channel.
 */

import {
  ASK_USER_TOOL_NAME,
  CoreToolCallStatus,
  isActiveStatus,
  type UnifiedTask,
} from '@qwen-code/core';
import {
  formatProgramStatus,
  sanitizeProgramStatusId,
  type BlockedKind,
  type ProgramStatus,
} from '../../ink/termio/programStatus.js';
import type { TurnEnd } from '../hooks/localSession.shared.js';
import { StreamingState, type HistoryItemWithoutId } from '../types.js';

export interface ProgramStatusBlocker {
  kind?: BlockedKind;
  msg: string;
}

/** Everything that can hold the session waiting for the user. */
export interface ProgramStatusBlockerInput {
  /** The session gate is waiting for the user. */
  signInRequired: boolean;
  /** An MCP / provider authentication consent prompt is open. */
  authConsentPending: boolean;
  pendingHistoryItems: HistoryItemWithoutId[];
  /** Tool names of prompts in the permission queue. */
  permissionQueueToolNames: readonly string[];
  commandConfirmationPending: boolean;
  /** Folder trust, MCP approval, extension update, peer inbound, ... */
  otherApprovalPending: boolean;
}

export const PROGRAM_STATUS_MESSAGES = {
  signIn: 'Sign-in required',
  authConsent: 'Authentication confirmation required',
  question: 'Answer requested by agent',
  toolConfirmation: 'Tool confirmation required',
  commandConfirmation: 'Confirmation required',
  approval: 'Approval required',
} as const;

/** Highest-priority reason the session is waiting for the user, if any. */
export function getProgramStatusBlocker(
  input: ProgramStatusBlockerInput,
): ProgramStatusBlocker | undefined {
  if (input.signInRequired) {
    return { kind: 'auth', msg: PROGRAM_STATUS_MESSAGES.signIn };
  }
  if (input.authConsentPending) {
    return { kind: 'auth', msg: PROGRAM_STATUS_MESSAGES.authConsent };
  }

  let toolAwaiting = false;
  for (const item of input.pendingHistoryItems) {
    if (item.type !== 'tool_group') continue;
    for (const tool of item.tools) {
      if (tool.status !== CoreToolCallStatus.AwaitingApproval) continue;
      if (tool.confirmationDetails?.type === ASK_USER_TOOL_NAME) {
        return { kind: 'question', msg: PROGRAM_STATUS_MESSAGES.question };
      }
      toolAwaiting = true;
    }
  }
  if (input.permissionQueueToolNames.includes(ASK_USER_TOOL_NAME)) {
    return { kind: 'question', msg: PROGRAM_STATUS_MESSAGES.question };
  }
  if (toolAwaiting || input.permissionQueueToolNames.length > 0) {
    return {
      kind: 'permission',
      msg: PROGRAM_STATUS_MESSAGES.toolConfirmation,
    };
  }
  if (input.commandConfirmationPending) {
    return {
      kind: 'permission',
      msg: PROGRAM_STATUS_MESSAGES.commandConfirmation,
    };
  }
  if (input.otherApprovalPending) {
    return { kind: 'permission', msg: PROGRAM_STATUS_MESSAGES.approval };
  }
  return undefined;
}

export interface MainProgramStatusInput {
  streamingState: StreamingState;
  /** Prompts waiting in the input queue. */
  queued: boolean;
  blocker: ProgramStatusBlocker | undefined;
  lastTurnEnd: TurnEnd;
  /** A title the user set explicitly (`/rename`, resumed custom title). */
  customSessionTitle?: string;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? text;
}

/** The root record. Blocked outranks working, which outranks the last turn. */
export function toMainProgramStatus(
  input: MainProgramStatusInput,
): ProgramStatus {
  if (input.blocker) {
    return { state: 'blocked', kind: input.blocker.kind, msg: input.blocker.msg };
  }
  if (input.streamingState !== StreamingState.Idle || input.queued) {
    return { state: 'working', msg: input.customSessionTitle };
  }
  const end = input.lastTurnEnd;
  if (end === 'completed') {
    return { state: 'done', msg: input.customSessionTitle };
  }
  if (!end || end === 'cancelled') return { state: 'idle' };
  return { state: 'error', msg: firstLine(end.error) };
}

const SUBAGENT_TASK_TYPES = new Set<UnifiedTask['type']>([
  'local_agent',
  'in_process_teammate',
  'local_workflow',
]);
export const MAX_SUBAGENT_RECORDS = 32;

/** Child records for background agents, teammates and workflows. */
export function toSubagentProgramStatuses(
  tasks: readonly UnifiedTask[],
): Array<ProgramStatus & { id: string }> {
  const records: Array<ProgramStatus & { id: string }> = [];
  for (const task of tasks) {
    if (!SUBAGENT_TASK_TYPES.has(task.type)) continue;
    if (!isActiveStatus(task.status) && task.status !== 'paused') continue;
    if (task.type === 'in_process_teammate' && task.isIdle) continue;
    const id = sanitizeProgramStatusId(task.id);
    if (id === undefined) continue;
    const title =
      task.type === 'local_workflow'
        ? (task.title ?? task.workflowName)
        : task.description;
    records.push({
      id,
      state: task.status === 'paused' ? 'idle' : 'working',
      title,
    });
  }
  return records
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_SUBAGENT_RECORDS);
}

/** Root key in the sent-record map. The root report itself carries no id. */
export const ROOT_RECORD_KEY = '';

/** Encodes the wanted records as key → full escape sequence. */
export function encodeProgramStatusRecords(
  main: ProgramStatus,
  subagents: ReadonlyArray<ProgramStatus & { id: string }>,
): Map<string, string> {
  const records = new Map<string, string>([
    [ROOT_RECORD_KEY, formatProgramStatus(main)],
  ]);
  for (const record of subagents) {
    records.set(record.id, formatProgramStatus(record));
  }
  return records;
}
