/**
 * Automation Condition Evaluator
 *
 * Pure synchronous evaluation engine for automation conditions.
 * Inspired by Home Assistant's condition system.
 *
 * Supports:
 * - time: Time-of-day and day-of-week checks
 * - state: Event payload field checks with HA-style from/to for transitions
 * - and/or/not: Logical composition with short-circuit evaluation
 */

import type { AutomationCondition, TimeCondition, StateCondition, LogicalCondition } from './types.ts';
import { MAX_CONDITION_DEPTH_EXCLUSIVE } from './conditions-constants.ts';

// ============================================================================
// Constants
// ============================================================================

/**
 * Maps user-facing field names to internal payload field pairs for transition events.
 * When a user writes `field: "permissionMode"` with `from`/`to`, we resolve to the
 * actual payload keys (e.g. `oldMode`/`newMode`).
 */
const TRANSITION_FIELDS: Record<string, { to: string; from: string }> = {
  permissionMode: { to: 'newMode', from: 'oldMode' },
  sessionStatus: { to: 'newState', from: 'oldState' },
};

/** Map 3-letter weekday names to JS Date.getDay() / Intl weekday numbers (1=Mon..7=Sun) */
const WEEKDAY_MAP: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};

// ============================================================================
// Context
// ============================================================================

/** Context passed to condition evaluators */
export interface ConditionContext {
  /** Event payload fields */
  payload: Record<string, unknown>;
  /** Injectable current time (for testing) */
  now?: Date;
  /** Fallback timezone from the matcher */
  matcherTimezone?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Evaluate an array of conditions (top-level AND).
 * Returns true if all conditions pass, or if the array is empty/undefined.
 */
export function evaluateConditions(conditions: AutomationCondition[], context: ConditionContext): boolean {
  if (conditions.length === 0) return true;
  for (const condition of conditions) {
    if (!evaluateCondition(condition, context, 0)) return false;
  }
  return true;
}

// ============================================================================
// Internal Dispatch
// ============================================================================

function evaluateCondition(condition: AutomationCondition, context: ConditionContext, depth: number): boolean {
  // Depth starts at 0 at top-level; allowed depth indexes are 0..MAX_CONDITION_DEPTH_EXCLUSIVE-1.
  if (depth >= MAX_CONDITION_DEPTH_EXCLUSIVE) return false;

  switch (condition.condition) {
    case 'time':
      return evaluateTimeCondition(condition, context);
    case 'state':
      return evaluateStateCondition(condition, context);
    case 'and':
    case 'or':
    case 'not':
      return evaluateLogicalCondition(condition, context, depth);
    default:
      // Unknown condition type — fail closed
      return false;
  }
}

// ============================================================================
// Time Condition
// ============================================================================

function evaluateTimeCondition(condition: TimeCondition, context: ConditionContext): boolean {
  const now = context.now ?? new Date();
  const tz = condition.timezone ?? context.matcherTimezone;

  // Get current time in the target timezone
  const { hours, minutes, weekdayNum } = getTimeInTimezone(now, tz);

  // Check weekday filter
  if (condition.weekday && condition.weekday.length > 0) {
    const allowed = new Set(condition.weekday.map(d => WEEKDAY_MAP[d]));
    if (!allowed.has(weekdayNum)) return false;
  }

  // Check time range
  const hasAfter = condition.after !== undefined;
  const hasBefore = condition.before !== undefined;

  if (!hasAfter && !hasBefore) return true;

  const currentMinutes = hours * 60 + minutes;
  const afterMinutes = hasAfter ? parseTimeToMinutes(condition.after!) : 0;
  const beforeMinutes = hasBefore ? parseTimeToMinutes(condition.before!) : 0;

  if (hasAfter && hasBefore) {
    if (afterMinutes <= beforeMinutes) {
      // Normal range: after <= current < before
      return currentMinutes >= afterMinutes && currentMinutes < beforeMinutes;
    } else {
      // Overnight wrap: current >= after OR current < before
      return currentMinutes >= afterMinutes || currentMinutes < beforeMinutes;
    }
  }

  if (hasAfter) return currentMinutes >= afterMinutes;
  // hasBefore only
  return currentMinutes < beforeMinutes;
}

/** Parse "HH:MM" to total minutes since midnight */
function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Get hours, minutes, and weekday number in a timezone */
function getTimeInTimezone(date: Date, timezone?: string): { hours: number; minutes: number; weekdayNum: number } {
  if (timezone) {
    try {
      // Use Intl to convert to target timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
        hour12: false,
      });
      const parts = formatter.formatToParts(date);
      const hours = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
      const minutes = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
      const weekdayStr = parts.find(p => p.type === 'weekday')?.value?.toLowerCase().slice(0, 3) ?? '';
      const weekdayNum = WEEKDAY_MAP[weekdayStr] ?? 0;
      return { hours, minutes, weekdayNum };
    } catch {
      // Invalid timezone — fall through to local
    }
  }

  // Local time fallback
  const hours = date.getHours();
  const minutes = date.getMinutes();
  // JS getDay(): 0=Sun, 1=Mon... → convert to our 1=Mon..7=Sun
  const jsDay = date.getDay();
  const weekdayNum = jsDay === 0 ? 7 : jsDay;
  return { hours, minutes, weekdayNum };
}

// ============================================================================
// State Condition
// ============================================================================

function evaluateStateCondition(condition: StateCondition, context: ConditionContext): boolean {
  const { field } = condition;
  const { payload } = context;

  // Handle from/to (transition fields)
  const hasFrom = condition.from !== undefined;
  const hasTo = condition.to !== undefined;

  if (hasFrom || hasTo) {
    const mapping = TRANSITION_FIELDS[field];
    const toKey = mapping?.to ?? field;
    const fromKey = mapping?.from ?? field;

    if (hasTo && payload[toKey] !== condition.to) return false;
    if (hasFrom && payload[fromKey] !== condition.from) return false;
    return true;
  }

  // Handle contains (array membership)
  if (condition.contains !== undefined) {
    const arr = payload[field];
    if (!Array.isArray(arr)) return false;
    return arr.includes(condition.contains);
  }

  // Handle not_value (negation)
  if (condition.not_value !== undefined) {
    const fieldValue = payload[field];
    if (fieldValue === undefined) return false;
    return fieldValue !== condition.not_value;
  }

  // Handle value (exact match)
  if (condition.value !== undefined) {
    return payload[field] === condition.value;
  }

  // No operator specified — fail closed
  return false;
}

// ============================================================================
// Logical Conditions
// ============================================================================

function evaluateLogicalCondition(condition: LogicalCondition, context: ConditionContext, depth: number): boolean {
  const { conditions } = condition;

  switch (condition.condition) {
    case 'and':
      for (const sub of conditions) {
        if (!evaluateCondition(sub, context, depth + 1)) return false;
      }
      return true;

    case 'or':
      for (const sub of conditions) {
        if (evaluateCondition(sub, context, depth + 1)) return true;
      }
      return false;

    case 'not':
      for (const sub of conditions) {
        if (evaluateCondition(sub, context, depth + 1)) return false;
      }
      return true;

    default:
      return false;
  }
}
