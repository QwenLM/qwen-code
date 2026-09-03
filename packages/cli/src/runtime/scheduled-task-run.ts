/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripTerminalControlSequences } from '@qwen-code/qwen-code-core/utils/terminalSafe.js';
import { SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX } from '@qwen-code/acp-bridge';

export { SCHEDULED_TASK_RUN_SOURCE_TYPE } from '@qwen-code/acp-bridge';

export function scheduledTaskRunSourceId(taskId: string): string {
  return `${SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX}${taskId}`;
}

/** Model-facing control sentence. The web-shell client matches it literally
 * to render the run context as a card, so change both together. */
export const SCHEDULED_TASK_RUN_INSTRUCTION =
  'This is a scheduled task run. Execute the instructions below now. Do not create or modify a schedule unless the instructions explicitly ask you to.';

function cleanMetadataLine(value: string): string {
  return stripTerminalControlSequences(value)
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Same ceiling the scheduled-task route and the sub-session launcher apply
 * to a session title, so the label survives their re-cleaning untruncated. */
const MAX_RUN_SESSION_NAME_LENGTH = 60;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Titles the fresh child session of one per-run fire: the task's label plus
 * the local trigger time (`MM-DD HH:mm`), so consecutive runs of the same task
 * are distinguishable in the session list. The label is cleaned like every
 * other scheduled-task session name and cut on a code-point boundary so the
 * time suffix always fits within the shared title ceiling.
 */
export function scheduledTaskRunSessionName(
  label: string,
  triggeredAt: number,
): string {
  const at = new Date(triggeredAt);
  const suffix = ` · ${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(
    at.getHours(),
  )}:${pad2(at.getMinutes())}`;
  const cleaned = cleanMetadataLine(label);
  const budget = MAX_RUN_SESSION_NAME_LENGTH - suffix.length;
  let short = cleaned;
  if (cleaned.length > budget) {
    let cut = budget - 1;
    const boundary = cleaned.charCodeAt(cut - 1);
    if (boundary >= 0xd800 && boundary <= 0xdbff) cut -= 1;
    short = `${cleaned.slice(0, cut)}…`;
  }
  return `${short}${suffix}`;
}

export function buildScheduledTaskRunPrompt(input: {
  id: string;
  name?: string;
  cron: string;
  prompt: string;
  triggeredAt: number;
  trigger: 'scheduled' | 'manual';
}): string {
  const name = cleanMetadataLine(input.name ?? input.id) || input.id;
  const cron = cleanMetadataLine(input.cron);
  return [
    `Scheduled task: ${name}`,
    `Task ID: ${input.id}`,
    `Schedule: ${cron}`,
    `Triggered at: ${new Date(input.triggeredAt).toISOString()}`,
    `Trigger: ${input.trigger}`,
    'Session: new chat for this run',
    '',
    SCHEDULED_TASK_RUN_INSTRUCTION,
    '',
    input.prompt,
  ].join('\n');
}
