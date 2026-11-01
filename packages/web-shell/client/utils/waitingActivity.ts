/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Summaries for the waiting card: the task's daily Q&A calendar and token usage.

export const WAITING_ACTIVITY_WEEKS = 44;
export const WAITING_ACTIVITY_DAYS = 7;
export const WAITING_ACTIVITY_CELLS =
  WAITING_ACTIVITY_WEEKS * WAITING_ACTIVITY_DAYS;

export interface WaitingActivityDay {
  /** Local midnight at the start of the day. */
  startAt: number;
  /** Local midnight at the start of the next day. */
  endAt: number;
  count: number;
  /** First message that day, preferring the user question. */
  messageId?: string;
  /** Calendar placeholders after today, rendered without interaction. */
  future?: boolean;
}

export interface WaitingActivityMessage {
  id?: string;
  role?: string;
  timestamp?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  };
}

export interface WaitingActivityOptions {
  weeks?: number;
  /** Test seam for the local "today" anchor. */
  now?: number;
}

export interface WaitingTokenUsage {
  input: number;
  output: number;
  cached: number;
  context?: number;
  contextLimit?: number;
}

export interface WaitingTokenUsageFallback {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function startOfLocalDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addLocalDays(value: number, days: number): number {
  // setDate keeps local midnight stable across daylight-saving changes.
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function mondayOffset(value: number): number {
  return (new Date(value).getDay() + 6) % 7;
}

/**
 * Groups user and assistant messages into a fixed 44-week calendar. Each cell
 * is one local day and columns are Monday-to-Sunday weeks.
 */
export function buildWaitingActivity(
  messages: readonly WaitingActivityMessage[],
  options: WaitingActivityOptions = {},
): WaitingActivityDay[] {
  const weeks = Math.max(
    1,
    Math.floor(options.weeks ?? WAITING_ACTIVITY_WEEKS),
  );
  const cellCount = weeks * WAITING_ACTIVITY_DAYS;
  const today = startOfLocalDay(options.now ?? Date.now());
  const gridStart = addLocalDays(
    today,
    -(mondayOffset(today) + (weeks - 1) * WAITING_ACTIVITY_DAYS),
  );
  const cells: WaitingActivityDay[] = [];
  const indexByDay = new Map<number, number>();
  for (let index = 0; index < cellCount; index++) {
    const dayStart = addLocalDays(gridStart, index);
    indexByDay.set(dayStart, index);
    cells.push({
      startAt: dayStart,
      endAt: addLocalDays(dayStart, 1),
      count: 0,
      ...(dayStart > today ? { future: true } : {}),
    });
  }

  const anchors: Array<{ id: string; role: string } | undefined> = [];
  for (const message of messages) {
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      !isTimestamp(message.timestamp)
    ) {
      continue;
    }
    const index = indexByDay.get(startOfLocalDay(message.timestamp));
    if (index === undefined || cells[index]!.future) continue;
    cells[index]!.count += 1;
    const anchor = anchors[index];
    if (
      message.id &&
      (!anchor || (message.role === 'user' && anchor.role !== 'user'))
    ) {
      anchors[index] = { id: message.id, role: message.role };
    }
  }
  anchors.forEach((anchor, index) => {
    if (anchor) cells[index]!.messageId = anchor.id;
  });
  return cells;
}

/** Sums assistant usage across the task; falls back to the latest usage event. */
export function buildWaitingTokenUsage(
  messages: readonly WaitingActivityMessage[],
  fallback: WaitingTokenUsageFallback = {},
  context?: number,
  contextLimit?: number,
): WaitingTokenUsage {
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.usage) continue;
    input += Math.max(0, message.usage.inputTokens ?? 0);
    output += Math.max(0, message.usage.outputTokens ?? 0);
    cached += Math.max(0, message.usage.cachedTokens ?? 0);
  }
  if (input === 0 && output === 0) {
    input = Math.max(0, fallback.inputTokens ?? 0);
    output = Math.max(0, fallback.outputTokens ?? 0);
    cached = Math.max(0, fallback.cachedTokens ?? 0);
  }
  return {
    input,
    output,
    cached,
    ...(context !== undefined ? { context: Math.max(0, context) } : {}),
    ...(contextLimit !== undefined
      ? { contextLimit: Math.max(0, contextLimit) }
      : {}),
  };
}
