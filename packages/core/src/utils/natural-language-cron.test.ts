import { describe, it, expect } from 'vitest';
import {
  parseNaturalLanguageSchedule,
  TASK_TEMPLATES,
} from './natural-language-cron.js';

describe('parseNaturalLanguageSchedule', () => {
  describe('every N minutes', () => {
    it('parses "every 5 minutes"', () => {
      const result = parseNaturalLanguageSchedule('every 5 minutes');
      expect(result.cron).toBe('*/5 * * * *');
      expect(result.description).toBe('Every 5 minutes');
    });

    it('parses "every 15 minutes"', () => {
      const result = parseNaturalLanguageSchedule('every 15 minutes');
      expect(result.cron).toBe('*/15 * * * *');
    });
  });

  describe('every hour', () => {
    it('parses "every hour"', () => {
      const result = parseNaturalLanguageSchedule('every hour');
      expect(result.cron).toBe('0 * * * *');
      expect(result.description).toBe('Every hour');
    });
  });

  describe('every day at time', () => {
    it('parses "every day at 9am"', () => {
      const result = parseNaturalLanguageSchedule('every day at 9am');
      expect(result.cron).toBe('0 9 * * *');
      expect(result.description).toBe('Every day at 9:00');
    });

    it('parses "every day at 3pm"', () => {
      const result = parseNaturalLanguageSchedule('every day at 3pm');
      expect(result.cron).toBe('0 15 * * *');
    });

    it('parses "every day at 9:30am"', () => {
      const result = parseNaturalLanguageSchedule('every day at 9:30am');
      expect(result.cron).toBe('30 9 * * *');
    });
  });

  describe('weekday schedules', () => {
    it('parses "every weekday morning"', () => {
      const result = parseNaturalLanguageSchedule('every weekday morning');
      expect(result.cron).toBe('0 9 * * 1-5');
      expect(result.description).toBe('Every weekday at 9:00 AM');
    });

    it('parses "every weekday at 10am"', () => {
      const result = parseNaturalLanguageSchedule('every weekday at 10am');
      expect(result.cron).toBe('0 10 * * 1-5');
    });
  });

  describe('weekend schedules', () => {
    it('parses "every weekend at 10am"', () => {
      const result = parseNaturalLanguageSchedule('every weekend at 10am');
      expect(result.cron).toBe('0 10 * * 0,6');
    });
  });

  describe('day of week', () => {
    it('parses "mondays at 3pm"', () => {
      const result = parseNaturalLanguageSchedule('mondays at 3pm');
      expect(result.cron).toBe('0 15 * * 1');
      expect(result.description).toBe('Every Monday at 15:00');
    });

    it('parses "friday at 5pm"', () => {
      const result = parseNaturalLanguageSchedule('friday at 5pm');
      expect(result.cron).toBe('0 17 * * 5');
    });
  });

  describe('time of day keywords', () => {
    it('parses "morning"', () => {
      const result = parseNaturalLanguageSchedule('morning');
      expect(result.cron).toBe('0 9 * * *');
    });

    it('parses "afternoon"', () => {
      const result = parseNaturalLanguageSchedule('afternoon');
      expect(result.cron).toBe('0 14 * * *');
    });

    it('parses "evening"', () => {
      const result = parseNaturalLanguageSchedule('evening');
      expect(result.cron).toBe('0 18 * * *');
    });

    it('parses "night"', () => {
      const result = parseNaturalLanguageSchedule('night');
      expect(result.cron).toBe('0 22 * * *');
    });

    it('parses "midnight"', () => {
      const result = parseNaturalLanguageSchedule('midnight');
      expect(result.cron).toBe('0 0 * * *');
    });

    it('parses "noon"', () => {
      const result = parseNaturalLanguageSchedule('noon');
      expect(result.cron).toBe('0 12 * * *');
    });
  });

  describe('default fallback', () => {
    it('returns default for unrecognized input', () => {
      const result = parseNaturalLanguageSchedule('something random');
      expect(result.cron).toBe('0 9 * * *');
      expect(result.description).toContain('default');
    });
  });
});

describe('TASK_TEMPLATES', () => {
  it('has daily-pr-review template', () => {
    expect(TASK_TEMPLATES['daily-pr-review']).toBeDefined();
    expect(TASK_TEMPLATES['daily-pr-review'].cron).toBe('0 9 * * 1-5');
  });

  it('has hourly-build-check template', () => {
    expect(TASK_TEMPLATES['hourly-build-check']).toBeDefined();
    expect(TASK_TEMPLATES['hourly-build-check'].cron).toBe('0 * * * *');
  });

  it('has weekly-cleanup template', () => {
    expect(TASK_TEMPLATES['weekly-cleanup']).toBeDefined();
    expect(TASK_TEMPLATES['weekly-cleanup'].cron).toBe('0 0 * * 0');
  });

  it('has daily-standup template', () => {
    expect(TASK_TEMPLATES['daily-standup']).toBeDefined();
    expect(TASK_TEMPLATES['daily-standup'].cron).toBe('0 9 * * *');
  });

  it('has security-scan template', () => {
    expect(TASK_TEMPLATES['security-scan']).toBeDefined();
    expect(TASK_TEMPLATES['security-scan'].cron).toBe('0 2 * * *');
  });

  it('all templates have required fields', () => {
    for (const template of Object.values(TASK_TEMPLATES)) {
      expect(template.name).toBeTruthy();
      expect(template.description).toBeTruthy();
      expect(template.cron).toBeTruthy();
      expect(template.prompt).toBeTruthy();
      expect(template.approvalMode).toBeTruthy();
    }
  });
});
