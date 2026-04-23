/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CronJob } from '@qwen-code/qwen-code-core';
import type {
  CommandCompletionItem,
  MessageActionReturn,
  SlashCommand,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import {
  SelfEvolveService,
  type SelfEvolveProgressEvent,
} from '../../services/SelfEvolveService.js';

type SelfEvolveParsedArgs =
  | {
      mode: 'run';
      direction?: string;
    }
  | {
      mode: 'schedule';
      direction?: string;
      interval: string;
      cron: string;
      cadence: string;
      roundedFrom?: string;
    }
  | {
      mode: 'list';
    }
  | {
      mode: 'clear';
    }
  | {
      mode: 'error';
      message: string;
    };

interface IntervalParseResult {
  value: number;
  unit: 's' | 'm' | 'h' | 'd';
  canonical: string;
}

interface RecurringSchedule {
  cron: string;
  cadence: string;
  roundedFrom?: string;
}

const LEADING_INTERVAL_PATTERN = /^\d+[smhd]$/i;
const TRAILING_EVERY_PATTERN =
  /^(?<prompt>.+?)\s+every\s+(?<value>\d+)(?:\s*(?<short>[smhd])|(?:\s+)(?<word>seconds?|minutes?|hours?|days?))\s*$/i;
const CLEAN_MINUTE_INTERVALS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const CLEAN_HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12];
const SELF_EVOLVE_COMPLETIONS: CommandCompletionItem[] = [
  {
    value: '--once',
    description:
      'Run once now. This is the default if you omit schedule flags.',
  },
  {
    value: '--every',
    description:
      'Run now and then repeat on a schedule, for example `--every 2h`.',
  },
  {
    value: 'list',
    description: 'Show scheduled recurring self-evolve jobs for this session.',
  },
  {
    value: 'clear',
    description:
      'Delete all scheduled recurring self-evolve jobs for this session.',
  },
];

function quoteDirection(direction: string): string {
  return direction.split(/\s+/).filter(Boolean).join(' ');
}

function formatRounds(rounds: number): string {
  return `${rounds} round${rounds === 1 ? '' : 's'}`;
}

function formatCandidateSource(source?: string): string | undefined {
  switch (source) {
    case 'failed-test':
      return 'recorded failing test artifact';
    case 'lint-error':
      return 'existing lint failure in the repo';
    case 'type-error':
      return 'existing type failure in the repo';
    case 'todo-comment':
      return 'existing TODO in the repo';
    case 'backlog-file':
      return 'existing backlog item';
    case 'user-direction':
      return 'your direction brief';
    default:
      return source;
  }
}

function pushLine(lines: string[], label: string, value?: string): void {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }
  lines.push(`${label}: ${trimmed}`);
}

function pushList(lines: string[], label: string, items?: string[]): void {
  if (!items || items.length === 0) {
    return;
  }
  lines.push(`${label}:`);
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed) {
      lines.push(`- ${trimmed}`);
    }
  }
}

interface SelfEvolveLiveSummary {
  status: string;
  selectedTask?: string;
  selectedTaskReason?: string;
  currentRound?: number;
  latestValidation?: string;
  latestActivity?: string;
}

function normalizeProgressText(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed : undefined;
}

function parseSelectedTaskProgress(message: string | undefined): {
  task?: string;
  reason?: string;
} {
  const normalized = normalizeProgressText(message);
  if (!normalized) {
    return {};
  }

  const reasonMatch = normalized.match(
    /^(?<task>.*?)(?:[.。]\s*)?(?:Reason|Why this task|Why):\s*(?<reason>.+)$/i,
  );
  const taskPortion =
    reasonMatch?.groups?.['task']?.trim() ??
    normalized.replace(/^(?:selected|chosen|picked)\s+/i, '').trim();
  const reason = normalizeProgressText(reasonMatch?.groups?.['reason']);

  return {
    task: taskPortion.replace(/[.。]\s*$/u, '').trim() || undefined,
    reason,
  };
}

function formatValidationProgress(
  command: string | undefined,
  message: string | undefined,
): string | undefined {
  const normalizedMessage = normalizeProgressText(message);
  if (!normalizedMessage) {
    return undefined;
  }

  const trimmedCommand = command?.trim();
  if (!trimmedCommand || normalizedMessage.includes(trimmedCommand)) {
    return normalizedMessage;
  }

  return `${trimmedCommand}: ${normalizedMessage}`;
}

function formatLiveProgressSummary(
  summary: SelfEvolveLiveSummary,
  direction?: string,
): string {
  const lines = ['Self-evolve is running...'];
  pushLine(lines, 'Status', summary.status);
  pushLine(lines, 'Requested direction', direction);
  lines.push(
    `Selected task: ${summary.selectedTask?.trim() || 'Waiting for child selection...'}`,
  );
  pushLine(lines, 'Why this task', summary.selectedTaskReason);
  pushLine(
    lines,
    'Current round',
    summary.currentRound != null ? `Round ${summary.currentRound}` : undefined,
  );
  pushLine(lines, 'Latest validation', summary.latestValidation);
  pushLine(lines, 'Latest activity', summary.latestActivity);
  return lines.join('\n');
}

function applyProgressToLiveSummary(
  summary: SelfEvolveLiveSummary,
  event: SelfEvolveProgressEvent,
): SelfEvolveLiveSummary {
  const nextSummary: SelfEvolveLiveSummary = {
    ...summary,
    status: formatProgress(event),
  };

  if (event.round != null) {
    nextSummary.currentRound = event.round;
  }

  if (event.stage !== 'child_activity') {
    return nextSummary;
  }

  const childMessage = normalizeProgressText(
    event.childMessage ?? event.message,
  );
  if (!childMessage) {
    return nextSummary;
  }

  switch (event.childKind) {
    case 'selected_task': {
      const parsed = parseSelectedTaskProgress(childMessage);
      nextSummary.selectedTask = parsed.task ?? childMessage;
      nextSummary.selectedTaskReason =
        parsed.reason ?? nextSummary.selectedTaskReason;
      nextSummary.latestActivity = childMessage;
      return nextSummary;
    }
    case 'command_result':
      nextSummary.latestValidation =
        formatValidationProgress(event.command, childMessage) ??
        nextSummary.latestValidation;
      nextSummary.latestActivity = childMessage;
      return nextSummary;
    case 'command':
    case 'round_start':
    case 'final':
    default:
      nextSummary.latestActivity = childMessage;
      return nextSummary;
  }
}

function formatOutcome(
  result: Awaited<ReturnType<SelfEvolveService['run']>>,
): string {
  if (result.ok) {
    return `Outcome: Kept a reviewable change after ${formatRounds(result.roundsAttempted)}.`;
  }

  if (result.status === 'no_safe_task') {
    return result.roundsAttempted > 0
      ? `Outcome: Skipped this run after ${formatRounds(result.roundsAttempted)} because no safe task was selected.`
      : 'Outcome: Skipped this run because no safe task was selected.';
  }

  if (
    result.status === 'validation_failed' ||
    result.status === 'max_retries_exhausted'
  ) {
    return `Outcome: Rolled the trial change back after ${formatRounds(result.roundsAttempted)}.`;
  }

  return result.roundsAttempted > 0
    ? `Outcome: Stopped after ${formatRounds(result.roundsAttempted)} without keeping a change.`
    : 'Outcome: Stopped before a safe change was ready.';
}

function formatFailureNotesLabel(
  result: Awaited<ReturnType<SelfEvolveService['run']>>,
): string {
  if (result.ok) {
    return 'Notes';
  }

  switch (result.status) {
    case 'no_safe_task':
      return 'Why it skipped';
    case 'validation_failed':
    case 'max_retries_exhausted':
      return 'Why it rolled back';
    default:
      return 'What blocked it';
  }
}

function formatResult(
  result: Awaited<ReturnType<SelfEvolveService['run']>>,
): string {
  const lines: string[] = [`Summary: ${result.summary}`, formatOutcome(result)];
  pushLine(lines, 'Requested direction', result.direction);
  pushLine(lines, 'Selected task', result.selectedTask);
  pushLine(
    lines,
    result.selectedTaskSource === 'user-direction'
      ? 'Narrowed direction'
      : 'Why this task',
    result.selectedTaskRationale,
  );
  pushLine(lines, 'Source', formatCandidateSource(result.selectedTaskSource));
  pushLine(lines, 'Location', result.selectedTaskLocation);
  if (result.validation && result.validation.length > 0) {
    pushList(lines, 'Validation', result.validation);
  } else if (result.status !== 'no_safe_task' && result.selectedTask) {
    lines.push('Validation: None reported by the child run.');
  }
  if (result.ok) {
    pushLine(lines, 'Review branch', result.branch);
    pushLine(lines, 'Review commit', result.commitSha);
  } else {
    pushList(lines, formatFailureNotesLabel(result), result.learnings);
  }
  pushLine(lines, 'Record', result.recordPath);
  return lines.join('\n');
}

function usage(): string {
  return [
    'Usage: /self-evolve [direction]                  # run once now (default)',
    '       /self-evolve --every <interval> [direction]  # run now, then repeat on a schedule',
    '       /self-evolve [direction] every <interval>    # same as --every, with trailing syntax',
    '       /self-evolve --once [direction]',
    '       /self-evolve list',
    '       /self-evolve clear',
  ].join('\n');
}

function parseInterval(raw: string): IntervalParseResult | null {
  const trimmed = raw.trim();
  const shortMatch = trimmed.match(/^(?<value>\d+)(?<unit>[smhd])$/i);
  if (shortMatch?.groups) {
    return {
      value: Number(shortMatch.groups['value']),
      unit: shortMatch.groups['unit']!.toLowerCase() as 's' | 'm' | 'h' | 'd',
      canonical: `${Number(shortMatch.groups['value'])}${shortMatch.groups['unit']!.toLowerCase()}`,
    };
  }

  const longMatch = trimmed.match(
    /^(?<value>\d+)\s+(?<unit>seconds?|minutes?|hours?|days?)$/i,
  );
  if (!longMatch?.groups) {
    return null;
  }

  const unitWord = longMatch.groups['unit']!.toLowerCase();
  const unit = unitWord.startsWith('second')
    ? 's'
    : unitWord.startsWith('minute')
      ? 'm'
      : unitWord.startsWith('hour')
        ? 'h'
        : 'd';

  return {
    value: Number(longMatch.groups['value']),
    unit,
    canonical: `${Number(longMatch.groups['value'])}${unit}`,
  };
}

function pickNearestCleanInterval(target: number, options: number[]): number {
  return options.reduce((best, current) => {
    const currentDistance = Math.abs(current - target);
    const bestDistance = Math.abs(best - target);
    if (currentDistance < bestDistance) {
      return current;
    }
    if (currentDistance === bestDistance && current > best) {
      return current;
    }
    return best;
  });
}

function describeInterval(value: number, unit: 'minute' | 'hour' | 'day') {
  return `Every ${value} ${unit}${value === 1 ? '' : 's'}`;
}

function buildRecurringSchedule(
  interval: IntervalParseResult,
): RecurringSchedule {
  if (interval.unit === 's') {
    const requestedMinutes = Math.max(1, Math.ceil(interval.value / 60));
    const cleanMinutes = pickNearestCleanInterval(
      requestedMinutes,
      CLEAN_MINUTE_INTERVALS,
    );
    return {
      cron: `*/${cleanMinutes} * * * *`,
      cadence: describeInterval(cleanMinutes, 'minute'),
      roundedFrom:
        cleanMinutes === requestedMinutes ? undefined : interval.canonical,
    };
  }

  if (interval.unit === 'm') {
    if (interval.value < 60) {
      const cleanMinutes = pickNearestCleanInterval(
        interval.value,
        CLEAN_MINUTE_INTERVALS,
      );
      return {
        cron: `*/${cleanMinutes} * * * *`,
        cadence: describeInterval(cleanMinutes, 'minute'),
        roundedFrom:
          cleanMinutes === interval.value ? undefined : interval.canonical,
      };
    }

    const requestedHours = interval.value / 60;
    const cleanHours = pickNearestCleanInterval(
      requestedHours,
      CLEAN_HOUR_INTERVALS,
    );
    return {
      cron: `0 */${cleanHours} * * *`,
      cadence: describeInterval(cleanHours, 'hour'),
      roundedFrom:
        cleanHours * 60 === interval.value ? undefined : interval.canonical,
    };
  }

  if (interval.unit === 'h') {
    if (interval.value < 24) {
      const cleanHours = pickNearestCleanInterval(
        interval.value,
        CLEAN_HOUR_INTERVALS,
      );
      return {
        cron: `0 */${cleanHours} * * *`,
        cadence: describeInterval(cleanHours, 'hour'),
        roundedFrom:
          cleanHours === interval.value ? undefined : interval.canonical,
      };
    }

    const cleanDays = Math.max(1, Math.round(interval.value / 24));
    return {
      cron: `0 0 */${cleanDays} * *`,
      cadence: describeInterval(cleanDays, 'day'),
      roundedFrom:
        cleanDays * 24 === interval.value ? undefined : interval.canonical,
    };
  }

  return {
    cron: `0 0 */${interval.value} * *`,
    cadence: describeInterval(interval.value, 'day'),
  };
}

function parseSelfEvolveArgs(args: string): SelfEvolveParsedArgs {
  const trimmed = args.trim();
  if (!trimmed) {
    return { mode: 'run' };
  }

  if (trimmed === 'list') {
    return { mode: 'list' };
  }

  if (trimmed === 'clear') {
    return { mode: 'clear' };
  }

  if (trimmed.startsWith('--direction')) {
    const direction = trimmed.slice('--direction'.length).trim();
    return direction
      ? { mode: 'run', direction }
      : { mode: 'error', message: usage() };
  }

  const oncePrefix = '--once';
  const everyPrefix = '--every';
  let rest = trimmed;
  let forceOnce = false;
  let explicitInterval: string | undefined;

  if (rest === oncePrefix || rest.startsWith(`${oncePrefix} `)) {
    forceOnce = true;
    rest = rest.slice(oncePrefix.length).trim();
  }

  if (rest === everyPrefix || rest.startsWith(`${everyPrefix} `)) {
    if (forceOnce) {
      return { mode: 'error', message: usage() };
    }
    const afterEvery = rest.slice(everyPrefix.length).trim();
    const intervalMatch = afterEvery.match(
      /^(?<interval>\d+(?:\s+(?:seconds?|minutes?|hours?|days?)|[smhd]))(?:\s+(?<direction>.*))?$/i,
    );
    if (!intervalMatch?.groups?.['interval']) {
      return { mode: 'error', message: usage() };
    }
    explicitInterval = intervalMatch.groups['interval'];
    rest = intervalMatch.groups['direction']?.trim() ?? '';
  }

  if (rest.startsWith('--direction ')) {
    rest = rest.slice('--direction'.length).trim();
  }

  if (forceOnce) {
    return {
      mode: 'run',
      direction: rest || undefined,
    };
  }

  let intervalSpec = explicitInterval;
  let direction = rest || undefined;

  const leadingToken = rest.split(/\s+/, 1)[0];
  if (
    !intervalSpec &&
    leadingToken &&
    LEADING_INTERVAL_PATTERN.test(leadingToken)
  ) {
    intervalSpec = leadingToken;
    direction = rest.slice(leadingToken.length).trim() || undefined;
  }

  if (!intervalSpec) {
    const trailingMatch = rest.match(TRAILING_EVERY_PATTERN);
    if (trailingMatch?.groups?.['prompt']) {
      intervalSpec =
        trailingMatch.groups['short'] != null
          ? `${trailingMatch.groups['value']}${trailingMatch.groups['short']!.toLowerCase()}`
          : `${trailingMatch.groups['value']} ${trailingMatch.groups['word']}`;
      direction = trailingMatch.groups['prompt'].trim() || undefined;
    }
  }

  if (!intervalSpec) {
    return { mode: 'run', direction };
  }

  const parsedInterval = parseInterval(intervalSpec);
  if (!parsedInterval || parsedInterval.value < 1) {
    return { mode: 'error', message: usage() };
  }

  const schedule = buildRecurringSchedule(parsedInterval);
  return {
    mode: 'schedule',
    direction,
    interval: parsedInterval.canonical,
    cron: schedule.cron,
    cadence: schedule.cadence,
    roundedFrom: schedule.roundedFrom,
  };
}

function buildScheduledPrompt(direction?: string): string {
  const trimmedDirection = direction?.trim();
  if (!trimmedDirection) {
    return '/self-evolve --once';
  }

  return `/self-evolve --once --direction ${quoteDirection(trimmedDirection)}`;
}

function isSelfEvolveJob(job: CronJob): boolean {
  return /^\/self-evolve(?:\s|$)/.test(job.prompt.trim());
}

function formatJob(job: CronJob): string {
  return [`${job.id}  \`${job.cronExpr}\``, `Prompt: ${job.prompt}`].join('\n');
}

function toMessage(
  messageType: 'info' | 'error',
  content: string,
): MessageActionReturn {
  return {
    type: 'message',
    messageType,
    content,
  };
}

function formatProgress(event: SelfEvolveProgressEvent): string {
  switch (event.stage) {
    case 'discovering_candidates':
      return 'Inspecting the repo for small safe tasks...';
    case 'creating_worktree':
      return 'Creating an isolated self-evolve worktree...';
    case 'starting_session':
      return 'Starting the isolated self-evolve session...';
    case 'child_activity':
      return event.message;
    case 'committing':
      return 'Preparing a review commit...';
    case 'finalizing':
      return 'Cleaning the isolated worktree for review...';
    case 'cleaning_up':
      return 'Removing temporary self-evolve files...';
    default:
      return event.message;
  }
}

function formatBackgroundFailure(error: unknown): string {
  return [
    'The background self-evolve attempt failed unexpectedly.',
    error instanceof Error ? error.message : String(error),
  ].join('\n');
}

function formatBackgroundResultHeading(
  result: Awaited<ReturnType<SelfEvolveService['run']>>,
): string {
  if (result.ok) {
    return 'Background self-evolve attempt prepared a reviewable change.';
  }

  if (result.status === 'no_safe_task') {
    return 'Background self-evolve attempt skipped this round.';
  }

  if (
    result.status === 'validation_failed' ||
    result.status === 'max_retries_exhausted'
  ) {
    return 'Background self-evolve attempt rolled back its trial change.';
  }

  return 'Background self-evolve attempt stopped before a safe change was ready.';
}

function completeSelfEvolveArgs(partialArg: string): CommandCompletionItem[] {
  const normalized = partialArg.replace(/^\s+/, '');
  if (!normalized) {
    return SELF_EVOLVE_COMPLETIONS;
  }

  if (/\s/.test(normalized)) {
    return [];
  }

  return SELF_EVOLVE_COMPLETIONS.filter((candidate) =>
    candidate.value.startsWith(normalized),
  );
}

export const selfEvolveCommand: SlashCommand = {
  name: 'self-evolve',
  description:
    'Run a small safe repo improvement once by default, or repeat it on a schedule with every/--every',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  argumentHint: '[direction] | --every <interval> [direction] | list | clear',
  examples: [
    '/self-evolve',
    '/self-evolve focus on small CLI lint follow-ups',
    '/self-evolve --every 2h focus lint cleanup',
    '/self-evolve focus TODO cleanup every 4h',
  ],
  completion: async (_context, partialArg) =>
    completeSelfEvolveArgs(partialArg),
  action: async (context, args): Promise<void | MessageActionReturn> => {
    const parsed = parseSelfEvolveArgs(args);
    if (parsed.mode === 'error') {
      return toMessage('error', parsed.message);
    }

    const config = context.services.config;
    if (!config) {
      return toMessage('error', t('Configuration is not available.'));
    }

    if (
      (parsed.mode === 'schedule' ||
        parsed.mode === 'list' ||
        parsed.mode === 'clear') &&
      !config.isCronEnabled()
    ) {
      return toMessage(
        'error',
        'Recurring /self-evolve requires cron support. Enable `experimental.cron: true` or set `QWEN_CODE_ENABLE_CRON=1`.',
      );
    }

    if (parsed.mode === 'list') {
      const jobs = config.getCronScheduler().list().filter(isSelfEvolveJob);
      if (jobs.length === 0) {
        return toMessage('info', 'No scheduled self-evolve jobs.');
      }
      return toMessage(
        'info',
        ['Scheduled self-evolve jobs:', ...jobs.map(formatJob)].join('\n\n'),
      );
    }

    if (parsed.mode === 'clear') {
      const scheduler = config.getCronScheduler();
      const jobs = scheduler.list().filter(isSelfEvolveJob);
      for (const job of jobs) {
        scheduler.delete(job.id);
      }
      return toMessage(
        'info',
        jobs.length === 0
          ? 'No scheduled self-evolve jobs to clear.'
          : `Cleared ${jobs.length} scheduled self-evolve job${jobs.length === 1 ? '' : 's'}.`,
      );
    }

    const executionMode = context.executionMode ?? 'interactive';
    const requestedDirection =
      'direction' in parsed ? parsed.direction : undefined;
    const handleProgress = (event: SelfEvolveProgressEvent) => {
      if (executionMode !== 'interactive') {
        return;
      }
      if (useInteractivePending) {
        Object.assign(
          liveSummary,
          applyProgressToLiveSummary(liveSummary, event),
        );
        renderInteractivePending();
      }
      if (event.stage === 'child_activity') {
        context.ui.addItem(
          {
            type: 'info',
            text: formatProgress(event),
          },
          Date.now(),
        );
        return;
      }
    };
    const useInteractivePending =
      executionMode === 'interactive' && parsed.mode !== 'schedule';
    const liveSummary: SelfEvolveLiveSummary = {
      status: t('Running self-evolve in an isolated worktree...'),
    };
    const renderInteractivePending = () => {
      if (!useInteractivePending) {
        return;
      }
      context.ui.setPendingItem({
        type: 'info',
        text: formatLiveProgressSummary(liveSummary, requestedDirection),
      });
    };

    if (useInteractivePending) {
      renderInteractivePending();
    }

    try {
      let scheduledSummary: string | undefined;
      const service = new SelfEvolveService();
      if (parsed.mode === 'schedule') {
        const job = config
          .getCronScheduler()
          .create(parsed.cron, buildScheduledPrompt(parsed.direction), true);
        const roundedLine = parsed.roundedFrom
          ? `Rounded from ${parsed.roundedFrom} to ${parsed.cadence.toLowerCase()}.`
          : undefined;
        scheduledSummary = [
          `Scheduled recurring self-evolve job ${job.id}.`,
          `Cadence: ${parsed.cadence} (\`${parsed.cron}\`)`,
          roundedLine,
          parsed.direction
            ? `Requested direction: ${parsed.direction}`
            : undefined,
          parsed.direction
            ? 'Each run will narrow that brief into one small safe, verifiable change before editing.'
            : undefined,
          'Recurring self-evolve jobs are session-only and auto-expire after 3 days.',
          executionMode === 'interactive'
            ? 'Running the first self-evolve attempt in the background. You can keep using Qwen Code.'
            : 'Running the first self-evolve attempt now.',
          executionMode === 'interactive'
            ? 'The child session will stream its selected task, rounds, and validation activity here while it works.'
            : undefined,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n');
      }

      if (parsed.mode === 'schedule' && executionMode === 'interactive') {
        context.ui.addItem(
          {
            type: 'info',
            text: scheduledSummary!,
          },
          Date.now(),
        );
        void service
          .run(config, {
            direction: parsed.direction,
            onProgress: handleProgress,
          })
          .then((result) => {
            context.ui.addItem(
              {
                type: 'info',
                text: `${formatBackgroundResultHeading(result)}\n${formatResult(result)}`,
              },
              Date.now(),
            );
          })
          .catch((error) => {
            context.ui.addItem(
              {
                type: 'error',
                text: formatBackgroundFailure(error),
              },
              Date.now(),
            );
          });
        return;
      }

      const result = await service.run(config, {
        direction: parsed.direction,
        onProgress: useInteractivePending ? handleProgress : undefined,
      });
      const resultContent = formatResult(result);
      const content = scheduledSummary
        ? `${scheduledSummary}\n\n${resultContent}`
        : resultContent;

      if (executionMode === 'interactive') {
        context.ui.addItem(
          {
            type: result.ok ? 'info' : 'error',
            text: content,
          },
          Date.now(),
        );
        return;
      }

      return toMessage(result.ok ? 'info' : 'error', content);
    } finally {
      if (useInteractivePending) {
        context.ui.setPendingItem(null);
      }
    }
  },
};
