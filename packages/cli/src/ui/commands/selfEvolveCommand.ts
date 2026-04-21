/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CronJob } from '@qwen-code/qwen-code-core';
import type { MessageActionReturn, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { SelfEvolveService } from '../../services/SelfEvolveService.js';

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

function quoteDirection(direction: string): string {
  return direction.split(/\s+/).filter(Boolean).join(' ');
}

function formatResult(
  result: Awaited<ReturnType<SelfEvolveService['run']>>,
): string {
  const lines: string[] = [result.summary];
  if (result.direction) {
    lines.push(`Direction: ${result.direction}`);
  }
  if (result.selectedTask) {
    lines.push(`Task: ${result.selectedTask}`);
  }
  if (result.ok) {
    lines.push(`Branch: ${result.branch}`);
    lines.push(`Commit: ${result.commitSha}`);
  }
  if (result.validation && result.validation.length > 0) {
    lines.push(`Validation: ${result.validation.join(' | ')}`);
  }
  if (!result.ok && result.learnings.length > 0) {
    lines.push(`Learnings: ${result.learnings.join(' | ')}`);
  }
  lines.push(`Record: ${result.recordPath}`);
  return lines.join('\n');
}

function usage(): string {
  return [
    'Usage: /self-evolve [direction]',
    '       /self-evolve --every <interval> [direction]',
    '       /self-evolve [direction] every <interval>',
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
  return [`${job.id}  ${job.cronExpr}`, `Prompt: ${job.prompt}`].join('\n');
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

export const selfEvolveCommand: SlashCommand = {
  name: 'self-evolve',
  description:
    'Run a small safe repo improvement once or on a recurring schedule',
  kind: CommandKind.BUILT_IN,
  commandType: 'local',
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
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
    if (executionMode === 'interactive') {
      context.ui.setPendingItem({
        type: 'info',
        text:
          parsed.mode === 'schedule'
            ? t('Scheduling self-evolve and running the first attempt...')
            : t('Running self-evolve in an isolated worktree...'),
      });
    }

    try {
      let scheduledSummary: string | undefined;
      if (parsed.mode === 'schedule') {
        const job = config
          .getCronScheduler()
          .create(parsed.cron, buildScheduledPrompt(parsed.direction), true);
        const roundedLine = parsed.roundedFrom
          ? `Rounded from ${parsed.roundedFrom} to ${parsed.cadence.toLowerCase()}.`
          : undefined;
        scheduledSummary = [
          `Scheduled recurring self-evolve job ${job.id}.`,
          `Cadence: ${parsed.cadence} (${parsed.cron})`,
          roundedLine,
          'Recurring self-evolve jobs are session-only and auto-expire after 3 days.',
          'Running the first self-evolve attempt now.',
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n');
      }

      const service = new SelfEvolveService();
      const result = await service.run(config, {
        direction: parsed.direction,
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
      if (executionMode === 'interactive') {
        context.ui.setPendingItem(null);
      }
    }
  },
};
