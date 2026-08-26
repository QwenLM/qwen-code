/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripTerminalControlSequences } from '@qwen-code/qwen-code-core';

export const SCHEDULED_TASK_RUN_SOURCE_TYPE = 'default';
export const SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX = 'scheduled_task_run:';

export function scheduledTaskRunSourceId(taskId: string): string {
  return `${SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX}${taskId}`;
}

function cleanMetadataLine(value: string): string {
  return stripTerminalControlSequences(value)
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
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
    'This is a scheduled task run. Execute the instructions below now. Do not create or modify a schedule unless the instructions explicitly ask you to.',
    '',
    input.prompt,
  ].join('\n');
}
