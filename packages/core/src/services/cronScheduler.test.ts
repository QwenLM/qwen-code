import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CronScheduler, type CronJob } from './cronScheduler.js';

const TEST_CREATED_AT = new Date(2025, 0, 15, 0, 0, 0).getTime();

describe('CronScheduler', () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.destroy();
  });

  describe('create', () => {
    it('creates a job with valid fields', () => {
      const job = scheduler.create('*/5 * * * *', 'test prompt', true);
      expect(job.id).toHaveLength(8);
      expect(job.cronExpr).toBe('*/5 * * * *');
      expect(job.prompt).toBe('test prompt');
      expect(job.recurring).toBe(true);
      expect(job.createdAt).toBeGreaterThan(0);
      expect(job.expiresAt).toBeGreaterThan(job.createdAt);
    });

    it('creates one-shot jobs with zero jitter', () => {
      const job = scheduler.create('*/1 * * * *', 'once', false);
      expect(job.jitterMs).toBe(0);
    });

    it('enforces max 50 jobs', () => {
      for (let i = 0; i < 50; i++) {
        scheduler.create('*/1 * * * *', `job-${i}`, true);
      }
      expect(() => scheduler.create('*/1 * * * *', 'job-51', true)).toThrow(
        'Maximum number of cron jobs (50) reached',
      );
    });

    it('generates unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const job = scheduler.create('*/1 * * * *', `job-${i}`, true);
        ids.add(job.id);
      }
      expect(ids.size).toBe(20);
    });
  });

  describe('delete', () => {
    it('removes an existing job', () => {
      const job = scheduler.create('*/1 * * * *', 'test', true);
      expect(scheduler.delete(job.id)).toBe(true);
      expect(scheduler.list()).toHaveLength(0);
    });

    it('returns false for non-existent job', () => {
      expect(scheduler.delete('nonexistent')).toBe(false);
    });
  });

  describe('list', () => {
    it('returns empty array when no jobs', () => {
      expect(scheduler.list()).toEqual([]);
    });

    it('returns all jobs', () => {
      scheduler.create('*/1 * * * *', 'a', true);
      scheduler.create('*/2 * * * *', 'b', false);
      const jobs = scheduler.list();
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.prompt).sort()).toEqual(['a', 'b']);
    });
  });

  describe('size', () => {
    it('tracks job count', () => {
      expect(scheduler.size).toBe(0);
      const job = scheduler.create('*/1 * * * *', 'a', true);
      expect(scheduler.size).toBe(1);
      scheduler.delete(job.id);
      expect(scheduler.size).toBe(0);
    });
  });

  describe('tick', () => {
    it('fires callback when a job matches', () => {
      const fired: CronJob[] = [];
      scheduler.start((job) => fired.push(job));

      // Use every-minute cron so jitter is tiny (max ~6s for 1-min period)
      const job = scheduler.create('*/1 * * * *', 'match', true);
      job.createdAt = TEST_CREATED_AT;

      // Tick at 10:30:59 — past any jitter for a 1-min period job
      const date = new Date(2025, 0, 15, 10, 30, 59);
      scheduler.tick(date);

      expect(fired).toHaveLength(1);
      expect(fired[0]!.prompt).toBe('match');
    });

    it('does not fire when no match', () => {
      const fired: CronJob[] = [];
      scheduler.start((job) => fired.push(job));

      const job = scheduler.create('30 10 * * *', 'no match', true);
      job.createdAt = TEST_CREATED_AT;
      job.jitterMs = 0; // pin jitter so the test is deterministic

      // Tick at 10:31 — should not fire
      scheduler.tick(new Date(2025, 0, 15, 10, 31, 0));
      expect(fired).toHaveLength(0);
    });

    it('does not double-fire in same minute', () => {
      const fired: CronJob[] = [];
      scheduler.start((job) => fired.push(job));

      const job = scheduler.create('*/1 * * * *', 'once per minute', true);
      job.createdAt = TEST_CREATED_AT;

      // Both ticks in second 59 — past jitter for a 1-min period job
      const date1 = new Date(2025, 0, 15, 10, 30, 59);
      const date2 = new Date(2025, 0, 15, 10, 30, 59, 500);
      scheduler.tick(date1);
      scheduler.tick(date2);

      expect(fired).toHaveLength(1);
    });

    it('removes one-shot jobs after firing', () => {
      const fired: CronJob[] = [];
      scheduler.start((job) => fired.push(job));

      // One-shot: jitter is 0, so second 1 is fine
      scheduler.create('30 10 * * *', 'one-shot', false);

      scheduler.tick(new Date(2025, 0, 15, 10, 30, 1));
      expect(fired).toHaveLength(1);
      expect(scheduler.list()).toHaveLength(0);
    });

    it('keeps recurring jobs after firing', () => {
      const fired: CronJob[] = [];
      scheduler.start((job) => fired.push(job));

      const job = scheduler.create('*/1 * * * *', 'recurring', true);
      job.createdAt = TEST_CREATED_AT;

      // Tick at second 59 — past any jitter for a 1-min period job
      scheduler.tick(new Date(2025, 0, 15, 10, 30, 59));
      expect(fired).toHaveLength(1);
      expect(scheduler.list()).toHaveLength(1);
    });

    it('removes expired jobs', () => {
      scheduler.start(() => {});

      const job = scheduler.create('*/1 * * * *', 'expire me', true);
      // Tick far in the future (past expiry)
      const farFuture = new Date(job.expiresAt + 1000);
      scheduler.tick(farFuture);

      expect(scheduler.list()).toHaveLength(0);
    });

    it('fires in next minute after first fire', () => {
      const fired: CronJob[] = [];
      scheduler.start((job) => fired.push(job));

      // Every minute
      const job = scheduler.create('* * * * *', 'every minute', true);
      job.createdAt = TEST_CREATED_AT;

      scheduler.tick(new Date(2025, 0, 15, 10, 30, 59));
      expect(fired).toHaveLength(1);

      // Next minute
      scheduler.tick(new Date(2025, 0, 15, 10, 31, 59));
      expect(fired).toHaveLength(2);
    });

    it('fires recurring jobs after the matching minute when positive jitter delays them', () => {
      const fired: CronJob[] = [];
      scheduler.start((job) => fired.push(job));

      const job = scheduler.create('0 * * * *', 'hourly delayed', true);
      job.createdAt = TEST_CREATED_AT;
      job.jitterMs = 6 * 60 * 1000;

      scheduler.tick(new Date(2025, 0, 15, 10, 5, 59));
      expect(fired).toHaveLength(0);

      scheduler.tick(new Date(2025, 0, 15, 10, 6, 0));
      expect(fired).toHaveLength(1);
      expect(fired[0]!.prompt).toBe('hourly delayed');
    });

    it('fires one-shot jobs before the matching minute when negative jitter advances them', () => {
      const fired: CronJob[] = [];
      scheduler.start((job) => fired.push(job));

      const job = scheduler.create('30 10 * * *', 'oneshot early', false);
      job.jitterMs = -30 * 1000;

      scheduler.tick(new Date(2025, 0, 15, 10, 29, 29));
      expect(fired).toHaveLength(0);

      scheduler.tick(new Date(2025, 0, 15, 10, 29, 30));
      expect(fired).toHaveLength(1);
      expect(fired[0]!.prompt).toBe('oneshot early');
    });

    it('does not replay a recurring slot that started before the job was created', () => {
      const fired: CronJob[] = [];
      scheduler.start((job) => fired.push(job));

      const job = scheduler.create('0 */2 * * *', 'every two hours', true);
      job.createdAt = new Date(2025, 0, 15, 0, 6, 3).getTime();
      job.jitterMs = 5 * 60 * 1000;

      scheduler.tick(new Date(2025, 0, 15, 0, 6, 10));
      expect(fired).toHaveLength(0);

      scheduler.tick(new Date(2025, 0, 15, 2, 5, 0));
      expect(fired).toHaveLength(1);
      expect(fired[0]!.prompt).toBe('every two hours');
    });
  });

  describe('start/stop', () => {
    it('starts and stops without error', () => {
      scheduler.start(() => {});
      expect(scheduler.running).toBe(true);
      scheduler.stop();
      expect(scheduler.running).toBe(false);
    });

    it('does not fire after stop', () => {
      const fired: CronJob[] = [];
      scheduler.start((job) => fired.push(job));
      scheduler.stop();

      scheduler.create('30 10 * * *', 'no fire', true);
      scheduler.tick(new Date(2025, 0, 15, 10, 30, 1));

      // tick still works manually, but onFire is cleared
      expect(fired).toHaveLength(0);
    });

    it('start is idempotent', () => {
      scheduler.start(() => {});
      scheduler.start(() => {}); // should not throw or create duplicate timers
      expect(scheduler.running).toBe(true);
    });
  });

  describe('getExitSummary', () => {
    it('returns null when no jobs', () => {
      expect(scheduler.getExitSummary()).toBeNull();
    });

    it('returns summary with single job', () => {
      scheduler.create('*/5 * * * *', 'check the build', true);
      const summary = scheduler.getExitSummary()!;
      expect(summary).toContain('1 active loop cancelled:');
      expect(summary).toContain('Every 5 minutes');
      expect(summary).toContain('check the build');
    });

    it('returns summary with multiple jobs', () => {
      scheduler.create('*/5 * * * *', 'check the build', true);
      scheduler.create('*/30 * * * *', 'check PR reviews', true);
      const summary = scheduler.getExitSummary()!;
      expect(summary).toContain('2 active loops cancelled:');
      expect(summary).toContain('check the build');
      expect(summary).toContain('check PR reviews');
    });

    it('truncates long prompts', () => {
      const longPrompt = 'a'.repeat(100);
      scheduler.create('*/1 * * * *', longPrompt, true);
      const summary = scheduler.getExitSummary()!;
      expect(summary).toContain('...');
      // Should not contain the full 100-char prompt
      expect(summary).not.toContain(longPrompt);
    });

    it('returns null after all jobs are deleted', () => {
      const job = scheduler.create('*/1 * * * *', 'temp', true);
      scheduler.delete(job.id);
      expect(scheduler.getExitSummary()).toBeNull();
    });
  });

  describe('destroy', () => {
    it('stops and clears all jobs', () => {
      scheduler.create('*/1 * * * *', 'a', true);
      scheduler.create('*/2 * * * *', 'b', true);
      scheduler.start(() => {});

      scheduler.destroy();

      expect(scheduler.running).toBe(false);
      expect(scheduler.list()).toHaveLength(0);
    });
  });
});
