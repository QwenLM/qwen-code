/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripTerminalControlSequences } from '@qwen-code/qwen-code-core';
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
