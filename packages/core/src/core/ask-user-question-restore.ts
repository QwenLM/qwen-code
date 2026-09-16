/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, FunctionCall } from '@google/genai';
import { ToolNames } from '../tools/tool-names.js';
import type { AskUserQuestionParams } from '../tools/askUserQuestion.js';

export interface RestorableAskUserQuestion {
  readonly functionCalls: FunctionCall[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Structural check matching `AskUserQuestionTool.validateToolParams`.
 * Used without constructing the tool (eligibility is a pure history scan).
 */
export function parseAskUserQuestionParams(
  args: unknown,
): AskUserQuestionParams | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  const questions = (args as { questions?: unknown }).questions;
  if (
    !Array.isArray(questions) ||
    questions.length < 1 ||
    questions.length > 4
  ) {
    return undefined;
  }
  for (const question of questions) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      return undefined;
    }
    const q = question as {
      question?: unknown;
      header?: unknown;
      options?: unknown;
      multiSelect?: unknown;
    };
    if (!isNonEmptyString(q.question) || !isNonEmptyString(q.header)) {
      return undefined;
    }
    if (
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      q.options.length > 4
    ) {
      return undefined;
    }
    for (const option of q.options) {
      if (!option || typeof option !== 'object' || Array.isArray(option)) {
        return undefined;
      }
      const o = option as { label?: unknown; description?: unknown };
      if (!isNonEmptyString(o.label) || !isNonEmptyString(o.description)) {
        return undefined;
      }
    }
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') {
      return undefined;
    }
  }
  return args as AskUserQuestionParams;
}

/**
 * Trailing unanswered `ask_user_question` that load/resume may re-hang.
 * Mixed dangling tools in the last model turn are not restorable.
 *
 * Takes only the last history entry (e.g. `chat.peekLastHistoryEntry()`) so
 * callers never pay for a full-history `structuredClone` — which also drops
 * the Symbol-keyed provider tool-call id attached by `normalizeModelToolCallIds`.
 */
export function findRestorableAskUserQuestion(
  last: Content | undefined,
): RestorableAskUserQuestion | undefined {
  if (last?.role !== 'model') return undefined;

  const functionCalls: FunctionCall[] = [];
  for (const part of last.parts ?? []) {
    const fc = part.functionCall;
    if (!fc?.id) continue;
    if (fc.name !== ToolNames.ASK_USER_QUESTION) return undefined;
    if (!parseAskUserQuestionParams(fc.args)) return undefined;
    functionCalls.push(fc);
  }
  if (functionCalls.length === 0) return undefined;
  return { functionCalls };
}

export function restorableAskUserQuestionCallIds(
  last: Content | undefined,
): Set<string> | undefined {
  const restorable = findRestorableAskUserQuestion(last);
  if (!restorable) return undefined;
  return new Set(
    restorable.functionCalls
      .map((call) => call.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
}

/**
 * Last API-facing content in a transcript replay, skipping system/bookkeeping
 * records. Used when chat is not initialized yet (cold bulk load replay).
 */
export function lastHistoryContentFromRecords(
  records: ReadonlyArray<{ type?: string; message?: Content }>,
): Content | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record?.type === 'system' || !record?.message) continue;
    return record.message;
  }
  return undefined;
}
