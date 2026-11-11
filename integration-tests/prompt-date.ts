/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The date a prompt tells the model: the startup context renders it, and a
 * date reminder repeats or updates it. The agent loop parity suites compare
 * two runs of one scenario, which can straddle midnight, so they mask the
 * rendered date and set the reminder parts aside.
 */

import { formatDateForContext } from '@qwen-code/qwen-code-core/core/environmentContext.js';

type JsonObject = Record<string, unknown>;

/**
 * A date rendered by `formatDateForContext`: the weekday and the month in
 * en-US long form, the day not zero-padded.
 */
export const CONTEXT_DATE =
  /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/g;

/**
 * The date the app renders for `day` of June 2026. Call it with consecutive
 * single-digit days: `formatDateForContext` does not zero-pad the day, so a
 * pattern that requires two digits must fail such a pair.
 */
export function contextDate(day: number): string {
  return formatDateForContext(new Date(2026, 5, day));
}

/** The part that starts a conversation on `today`. */
export function startupContextPart(today: string): { text: string } {
  return {
    text: `<system-reminder>\nThis is the Qwen Code. We are setting up the context for our chat.\nToday's date is ${today}.\n</system-reminder>`,
  };
}

/** A model request whose startup context starts the conversation on `today`. */
export function startupContext(today: string): JsonObject {
  return {
    messages: [{ role: 'user', content: [startupContextPart(today)] }],
  };
}

/** A part that only tells the model the date, as the client adds it. */
const DATE_REMINDER =
  /^<system-reminder>\n(?:Today's date is |The date has changed since earlier in this conversation\. )/;

/** Whether `part` is a date reminder rather than prompt text. */
export function isDateReminder(part: unknown): boolean {
  return (
    typeof (part as JsonObject)?.['text'] === 'string' &&
    DATE_REMINDER.test((part as JsonObject)['text'] as string)
  );
}

/** `content` without the date reminders the client adds. */
export function withoutDateReminder(content: unknown): unknown {
  return Array.isArray(content)
    ? content.filter((part) => !isDateReminder(part))
    : content;
}

/**
 * The user turns among `messages`. The startup context is not a turn, but a
 * prompt that carries a date reminder is: count the parts the user wrote.
 */
export function userTurns(messages: JsonObject[]): number {
  return messages.filter(
    (message) =>
      message['role'] === 'user' &&
      !JSON.stringify(withoutDateReminder(message['content'])).includes(
        '<system-reminder>',
      ),
  ).length;
}
