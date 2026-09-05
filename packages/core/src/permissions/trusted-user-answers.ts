/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MAX_TRUSTED_USER_ANSWER_CALLS = 8;
export const MAX_TRUSTED_USER_ANSWER_RECORD_CHARS = 8_000;
export const MAX_TRUSTED_USER_ANSWERS_TOTAL_CHARS = 32_000;

export interface TrustedUserAnswerQuestion {
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
  }>;
  readonly multiSelect?: boolean;
}

export interface TrustedUserAnswer {
  readonly question: string;
  readonly selectedOptions: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
  }>;
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
    const question = questions[questionIndex]!;
    const matchingOptions =
      question.multiSelect === true
        ? []
        : question.options.filter((option) => option.label === value);
    const selectedOptions =
      matchingOptions.length === 1
        ? [
            {
              label: matchingOptions[0]!.label,
              description: matchingOptions[0]!.description,
            },
          ]
        : [];
    answers.push({
      question: question.question,
      selectedOptions,
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

    let record: TrustedUserAnswerRecord = {
      callId,
      answers,
      omitted: false,
    };
    let chars = JSON.stringify(record).length;
    if (chars > MAX_TRUSTED_USER_ANSWER_RECORD_CHARS) {
      record = { callId, answers: [], omitted: true };
      chars = JSON.stringify(record).length;
      if (chars > MAX_TRUSTED_USER_ANSWER_RECORD_CHARS) return false;
    }

    this.records.set(callId, { record, chars });
    this.totalChars += chars;
    this.enforceLimits();
    return this.records.has(callId);
  }

  snapshot(): TrustedUserAnswerSnapshot {
    return Object.freeze(
      [...this.records.values()].map(({ record }) =>
        Object.freeze({
          callId: record.callId,
          omitted: record.omitted,
          answers: Object.freeze(
            record.answers.map((answer) =>
              Object.freeze({
                question: answer.question,
                answer: answer.answer,
                selectedOptions: Object.freeze(
                  answer.selectedOptions.map((option) =>
                    Object.freeze({ ...option }),
                  ),
                ),
              }),
            ),
          ),
        }),
      ),
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
      const oldest = this.records.entries().next().value as
        | [string, { record: TrustedUserAnswerRecord; chars: number }]
        | undefined;
      if (!oldest) return;
      this.records.delete(oldest[0]);
      this.totalChars -= oldest[1].chars;
    }
  }
}
