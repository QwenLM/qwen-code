/**
 * Cron Matching Utilities for Automations
 *
 * Determines if a cron expression matches the current time.
 * Used by SchedulerTick automations to trigger at specific intervals.
 */

import { Cron } from 'croner';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('cron-matcher');

/**
 * Check if a cron expression matches the current time.
 * Uses croner's nextRun to determine if the current minute matches the cron pattern.
 *
 * @param cronExpr - Cron expression in 5-field format (minute hour day-of-month month day-of-week)
 * @param timezone - Optional IANA timezone (e.g., "Europe/Budapest", "America/New_York")
 * @returns true if the cron expression matches the current minute
 *
 * @example
 * matchesCron('* * * * *')                    // Matches every minute
 * matchesCron('0 9 * * *', 'Europe/Budapest') // Matches 9:00 AM Budapest time
 */
export function matchesCron(cronExpr: string, timezone?: string): boolean {
  try {
    const options = timezone ? { timezone } : {};
    const job = new Cron(cronExpr, options);
    const now = new Date();

    // Get start of current minute (floored to :00 seconds)
    const startOfMinute = new Date(now);
    startOfMinute.setSeconds(0, 0);

    // Check from 1 second before the start of this minute
    const checkFrom = new Date(startOfMinute.getTime() - 1000);
    const nextRun = job.nextRun(checkFrom);

    log.debug(`[matchesCron] cron=${cronExpr}, tz=${timezone || 'default'}`);
    log.debug(`[matchesCron] now=${now.toISOString()}, startOfMinute=${startOfMinute.toISOString()}`);
    log.debug(`[matchesCron] checkFrom=${checkFrom.toISOString()}, nextRun=${nextRun?.toISOString() || 'null'}`);

    // If nextRun falls within the current minute, we have a match
    if (!nextRun) {
      log.debug(`[matchesCron] No nextRun, returning false`);
      return false;
    }

    const matches = nextRun.getTime() >= startOfMinute.getTime() &&
           nextRun.getTime() < startOfMinute.getTime() + 60_000;
    log.debug(`[matchesCron] matches=${matches} (nextRun ${nextRun.getTime()} vs startOfMinute ${startOfMinute.getTime()} to ${startOfMinute.getTime() + 60_000})`);
    return matches;
  } catch (e) {
    console.error(`[matchesCron] Error:`, e);
    return false;
  }
}
