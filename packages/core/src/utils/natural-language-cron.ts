/**
 * Natural language to cron expression converter.
 *
 * Converts common phrases like "every day at 9am" to cron expressions.
 */

export interface ParsedSchedule {
  cron: string;
  description: string;
}

/**
 * Parse natural language schedule description to cron expression.
 *
 * Examples:
 * - "every day at 9am" → "0 9 * * *"
 * - "every weekday morning" → "0 9 * * 1-5"
 * - "every hour" → "0 * * * *"
 * - "every 5 minutes" → "*&#47;5 * * * *"
 * - "mondays at 3pm" → "0 15 * * 1"
 */
export function parseNaturalLanguageSchedule(input: string): ParsedSchedule {
  const normalized = input.toLowerCase().trim();

  // Every N minutes
  const everyMinutesMatch = normalized.match(/every\s+(\d+)\s+minutes?/);
  if (everyMinutesMatch) {
    const minutes = everyMinutesMatch[1];
    return {
      cron: `*/${minutes} * * * *`,
      description: `Every ${minutes} minutes`,
    };
  }

  // Every hour
  if (/every\s+hour/.test(normalized)) {
    return {
      cron: '0 * * * *',
      description: 'Every hour',
    };
  }

  // Every day at TIME
  const everyDayAtMatch = normalized.match(
    /every\s+day\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/,
  );
  if (everyDayAtMatch) {
    let hour = parseInt(everyDayAtMatch[1], 10);
    const minute = everyDayAtMatch[2] ? parseInt(everyDayAtMatch[2], 10) : 0;
    const ampm = everyDayAtMatch[3];

    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    return {
      cron: `${minute} ${hour} * * *`,
      description: `Every day at ${hour}:${minute.toString().padStart(2, '0')}`,
    };
  }

  // Every weekday morning (9am)
  if (/every\s+weekday\s+morning/.test(normalized)) {
    return {
      cron: '0 9 * * 1-5',
      description: 'Every weekday at 9:00 AM',
    };
  }

  // Every weekday at TIME
  const everyWeekdayAtMatch = normalized.match(
    /every\s+weekday\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/,
  );
  if (everyWeekdayAtMatch) {
    let hour = parseInt(everyWeekdayAtMatch[1], 10);
    const minute = everyWeekdayAtMatch[2]
      ? parseInt(everyWeekdayAtMatch[2], 10)
      : 0;
    const ampm = everyWeekdayAtMatch[3];

    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    return {
      cron: `${minute} ${hour} * * 1-5`,
      description: `Every weekday at ${hour}:${minute.toString().padStart(2, '0')}`,
    };
  }

  // Every weekend at TIME
  const everyWeekendAtMatch = normalized.match(
    /every\s+weekend\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/,
  );
  if (everyWeekendAtMatch) {
    let hour = parseInt(everyWeekendAtMatch[1], 10);
    const minute = everyWeekendAtMatch[2]
      ? parseInt(everyWeekendAtMatch[2], 10)
      : 0;
    const ampm = everyWeekendAtMatch[3];

    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    return {
      cron: `${minute} ${hour} * * 0,6`,
      description: `Every weekend at ${hour}:${minute.toString().padStart(2, '0')}`,
    };
  }

  // Day of week at TIME (e.g., "mondays at 3pm")
  const dayOfWeekMatch = normalized.match(
    /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)s?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/,
  );
  if (dayOfWeekMatch) {
    const dayMap: Record<string, number> = {
      sunday: 0,
      sun: 0,
      monday: 1,
      mon: 1,
      tuesday: 2,
      tue: 2,
      wednesday: 3,
      wed: 3,
      thursday: 4,
      thu: 4,
      friday: 5,
      fri: 5,
      saturday: 6,
      sat: 6,
    };

    const day = dayMap[dayOfWeekMatch[1]] ?? 1;
    let hour = parseInt(dayOfWeekMatch[2], 10);
    const minute = dayOfWeekMatch[3] ? parseInt(dayOfWeekMatch[3], 10) : 0;
    const ampm = dayOfWeekMatch[4];

    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const dayNames = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    return {
      cron: `${minute} ${hour} * * ${day}`,
      description: `Every ${dayNames[day]} at ${hour}:${minute.toString().padStart(2, '0')}`,
    };
  }

  // Morning (9am)
  if (/morning/.test(normalized)) {
    return {
      cron: '0 9 * * *',
      description: 'Every day at 9:00 AM',
    };
  }

  // Afternoon (2pm)
  if (/afternoon/.test(normalized)) {
    return {
      cron: '0 14 * * *',
      description: 'Every day at 2:00 PM',
    };
  }

  // Evening (6pm)
  if (/evening/.test(normalized)) {
    return {
      cron: '0 18 * * *',
      description: 'Every day at 6:00 PM',
    };
  }

  // Midnight
  if (/midnight/.test(normalized)) {
    return {
      cron: '0 0 * * *',
      description: 'Every day at midnight',
    };
  }

  // Noon
  if (/noon/.test(normalized)) {
    return {
      cron: '0 12 * * *',
      description: 'Every day at noon',
    };
  }

  // Night (10pm)
  if (/night/.test(normalized)) {
    return {
      cron: '0 22 * * *',
      description: 'Every day at 10:00 PM',
    };
  }

  // Default: every day at 9am
  return {
    cron: '0 9 * * *',
    description: 'Every day at 9:00 AM (default)',
  };
}

/**
 * Task templates for common use cases.
 */
export interface TaskTemplate {
  name: string;
  description: string;
  cron: string;
  prompt: string;
  approvalMode: 'plan' | 'default' | 'auto-edit' | 'auto' | 'yolo';
}

export const TASK_TEMPLATES: Record<string, TaskTemplate> = {
  'daily-pr-review': {
    name: 'Daily PR Review',
    description: "Review today's pull requests each weekday morning",
    cron: '0 9 * * 1-5',
    prompt:
      "Review today's pull requests and summarize the changes. Focus on security issues and performance regressions.",
    approvalMode: 'auto',
  },
  'hourly-build-check': {
    name: 'Hourly Build Check',
    description: 'Check if the build passes every hour',
    cron: '0 * * * *',
    prompt: 'Run the build and tests. Report any failures.',
    approvalMode: 'auto',
  },
  'weekly-cleanup': {
    name: 'Weekly Cleanup',
    description: 'Clean up old files and logs every Sunday at midnight',
    cron: '0 0 * * 0',
    prompt:
      'Clean up temporary files, old logs, and unused dependencies. Report what was cleaned.',
    approvalMode: 'auto',
  },
  'daily-standup': {
    name: 'Daily Standup Summary',
    description: 'Generate a daily standup summary at 9am',
    cron: '0 9 * * *',
    prompt:
      "Summarize yesterday's commits, open PRs, and any blockers. Format as a standup update.",
    approvalMode: 'auto',
  },
  'security-scan': {
    name: 'Security Scan',
    description: 'Run security audit every day at 2am',
    cron: '0 2 * * *',
    prompt:
      'Run a security audit on dependencies and report any vulnerabilities.',
    approvalMode: 'auto',
  },
};
