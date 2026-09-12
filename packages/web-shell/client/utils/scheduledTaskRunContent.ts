export interface ScheduledTaskRunContent {
  name: string;
  id: string;
  cron: string;
  triggeredAt: string;
  trigger: 'scheduled' | 'manual';
  sessionMode: 'persistent' | 'per_run';
  prompt: string;
}

// Mirrors `SCHEDULED_TASK_RUN_INSTRUCTION` and
// `buildScheduledTaskRunPrompt` in cli/src/runtime/scheduled-task-run.ts. The
// Web Shell cannot import the CLI package, but it needs the same envelope both
// to render daemon-produced runs and to submit a manual persistent run.
const SCHEDULED_TASK_RUN_INSTRUCTION =
  'This is a scheduled task run. Execute the instructions below now. Do not create or modify a schedule unless the instructions explicitly ask you to.';

/* eslint-disable no-control-regex -- mirrors the CLI metadata sanitizer */
const TERMINAL_OSC_REGEX = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const TERMINAL_CSI_REGEX = /\u001b\[[\d;?]*[a-zA-Z]/g;
const TERMINAL_SHIFT_DCS_REGEX = /\u001b[NOP]/g;

function cleanMetadataLine(value: string): string {
  return value
    .replace(TERMINAL_OSC_REGEX, ' ')
    .replace(TERMINAL_CSI_REGEX, ' ')
    .replace(TERMINAL_SHIFT_DCS_REGEX, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}
/* eslint-enable no-control-regex */

const SESSION_LINE_BY_MODE = {
  persistent: 'Session: reuse the task conversation',
  per_run: 'Session: new chat for this run',
} as const;

export function buildScheduledTaskRunContent(input: {
  id: string;
  name: string | null;
  cron: string;
  triggeredAt: number;
  trigger: 'scheduled' | 'manual';
  sessionMode: 'persistent' | 'per_run';
  prompt: string;
}): string {
  const name = cleanMetadataLine(input.name ?? input.id) || input.id;
  const cron = cleanMetadataLine(input.cron);
  return [
    `Scheduled task: ${name}`,
    `Task ID: ${input.id}`,
    `Schedule: ${cron}`,
    `Triggered at: ${new Date(input.triggeredAt).toISOString()}`,
    `Trigger: ${input.trigger}`,
    SESSION_LINE_BY_MODE[input.sessionMode],
    '',
    SCHEDULED_TASK_RUN_INSTRUCTION,
    '',
    input.prompt,
  ].join('\n');
}

export function parseScheduledTaskRunContent(
  content: string,
): ScheduledTaskRunContent | null {
  const separator = `\n\n${SCHEDULED_TASK_RUN_INSTRUCTION}\n\n`;
  const separatorIndex = content.indexOf(separator);
  if (separatorIndex < 0) return null;
  const lines = content.slice(0, separatorIndex).split('\n');
  if (lines.length !== 6) return null;
  const sessionMode = (
    Object.entries(SESSION_LINE_BY_MODE) as Array<
      ['persistent' | 'per_run', string]
    >
  ).find(([, line]) => line === lines[5])?.[0];
  if (!sessionMode) return null;
  const values = [
    ['Scheduled task: ', lines[0]],
    ['Task ID: ', lines[1]],
    ['Schedule: ', lines[2]],
    ['Triggered at: ', lines[3]],
    ['Trigger: ', lines[4]],
  ] as const;
  if (values.some(([prefix, line]) => !line?.startsWith(prefix))) return null;
  const trigger = lines[4]!.slice('Trigger: '.length);
  if (trigger !== 'scheduled' && trigger !== 'manual') return null;
  return {
    name: lines[0]!.slice('Scheduled task: '.length),
    id: lines[1]!.slice('Task ID: '.length),
    cron: lines[2]!.slice('Schedule: '.length),
    triggeredAt: lines[3]!.slice('Triggered at: '.length),
    trigger,
    sessionMode,
    prompt: content.slice(separatorIndex + separator.length),
  };
}
