/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MAX_TRUSTED_USER_ANSWER_CALLS = 8;
export const MAX_TRUSTED_USER_ANSWERS_TOTAL_CHARS = 32_000;
/**
 * Cap on the projected question text. The question is model-authored, so it
 * is bounded like a classifier user hint (`MAX_USER_HINT_LENGTH`) rather than
 * like the user's own answer.
 */
export const MAX_TRUSTED_USER_ANSWER_QUESTION_CHARS = 200;
const MAX_TRUSTED_USER_ANSWER_RECORD_CHARS = 8_000;

export interface TrustedUserAnswerQuestion {
  readonly question: string;
}

export interface TrustedUserAnswer {
  readonly question: string;
  readonly answer: string;
}

export interface TrustedUserAnswerRecord {
  readonly callId: string;
  readonly answers: readonly TrustedUserAnswer[];
  readonly omitted: boolean;
}

export type TrustedUserAnswerSnapshot = readonly TrustedUserAnswerRecord[];

export function parseAnswerQuestionIndex(
  key: string,
  questionCount: number,
): number | undefined {
  const index = Number(key);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= questionCount ||
    String(index) !== key
  ) {
    return undefined;
  }
  return index;
}

export function normalizeTrustedUserAnswers(
  questions: readonly TrustedUserAnswerQuestion[],
  rawAnswers: unknown,
): readonly TrustedUserAnswer[] {
  if (
    !rawAnswers ||
    typeof rawAnswers !== 'object' ||
    Array.isArray(rawAnswers)
  ) {
    return [];
  }

  const answers: TrustedUserAnswer[] = [];
  for (const [key, value] of Object.entries(rawAnswers)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const questionIndex = parseAnswerQuestionIndex(key, questions.length);
    if (questionIndex === undefined) continue;
    const question = questions[questionIndex]!.question;
    answers.push({
      question:
        question.length > MAX_TRUSTED_USER_ANSWER_QUESTION_CHARS
          ? question.slice(0, MAX_TRUSTED_USER_ANSWER_QUESTION_CHARS) + '…'
          : question,
      answer: value,
    });
  }
  return answers;
}

export class TrustedUserAnswers {
  private readonly records = new Map<
    string,
    { record: TrustedUserAnswerRecord; chars: number }
  >();
  private totalChars = 0;

  record(
    callId: string,
    questions: readonly TrustedUserAnswerQuestion[],
    rawAnswers: unknown,
  ): boolean {
    if (callId.length === 0) return false;
    if (this.records.has(callId)) return false;

    const answers = normalizeTrustedUserAnswers(questions, rawAnswers);
    if (answers.length === 0) return false;

    let record: TrustedUserAnswerRecord = { callId, answers, omitted: false };
    let chars = JSON.stringify(record).length;
    if (chars > MAX_TRUSTED_USER_ANSWER_RECORD_CHARS) {
      record = { callId, answers: [], omitted: true };
      chars = JSON.stringify(record).length;
      if (chars > MAX_TRUSTED_USER_ANSWER_RECORD_CHARS) return false;
    }

    this.records.set(callId, {
      chars,
      record: Object.freeze({
        ...record,
        answers: Object.freeze(
          record.answers.map((answer) => Object.freeze(answer)),
        ),
      }),
    });
    this.totalChars += chars;
    this.enforceLimits();
    return this.records.has(callId);
  }

  snapshot(): TrustedUserAnswerSnapshot {
    return Object.freeze(
      [...this.records.values()].map(({ record }) => record),
    );
  }

  clear(): void {
    this.records.clear();
    this.totalChars = 0;
  }

  private enforceLimits(): void {
    while (
      this.records.size > MAX_TRUSTED_USER_ANSWER_CALLS ||
      this.totalChars > MAX_TRUSTED_USER_ANSWERS_TOTAL_CHARS
    ) {
      const oldest = this.records.keys().next().value!;
      this.totalChars -= this.records.get(oldest)!.chars;
      this.records.delete(oldest);
    }
  }
}
