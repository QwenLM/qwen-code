/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type JudgmentJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JudgmentJsonValue[]
  | { readonly [key: string]: JudgmentJsonValue };
export type JudgmentState =
  | string
  | readonly JudgmentJsonValue[]
  | { readonly [key: string]: JudgmentJsonValue };

export interface ChoiceQuestion<L extends string = string> {
  type: 'choice';
  instructions: string;
  criteria: Record<L, string | null>;
}
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: readonly [string, string, ...string[]];
}
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface ChoiceAnswer<L extends string = string> {
  type: 'choice';
  choice: L;
  probabilities?: Record<L, number>;
  confidence?: number;
}
export interface NoulAnswer {
  type: 'noul';
  noul: number;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}
export type AnswerFor<Q extends Question> =
  Q extends ChoiceQuestion<infer L>
    ? ChoiceAnswer<L>
    : Q extends NoulQuestion
      ? NoulAnswer
      : ScoreAnswer;
export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;
export interface JudgmentRequest<Q extends Questions = Questions> {
  state: JudgmentState;
  questions: Q;
}
export interface JudgmentUsage {
  inputTokens?: number;
  outputTokens?: number;
}
export interface JudgmentResult<Q extends Questions = Questions> {
  api: string;
  provider: string;
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  /** Omitted when the completion interface does not expose token counts. */
  usage?: JudgmentUsage;
  requestId?: string;
  serverRequestId?: string;
  serverTraceId?: string;
}
export interface JudgeOptions {
  /** Permission decisions must not use silently truncated local inputs. */
  requireCompleteInput?: boolean;
  /** Observational calls must not refresh auth, retry, or switch endpoints. */
  sideEffectFree?: boolean;
  signal?: AbortSignal;
}
export interface Judge {
  readonly label: string;
  judge<Q extends Questions>(
    request: JudgmentRequest<Q>,
    options?: JudgeOptions,
  ): Promise<JudgmentResult<Q>>;
}
export class JudgmentParseError extends Error {
  constructor(
    readonly questionId: string,
    detail: string,
  ) {
    // Do not include state or model output in the exception: it can reach logs.
    super(`Judgment answer for "${questionId}" is invalid: ${detail}`);
    this.name = 'JudgmentParseError';
  }
}

/** A provider rejected the complete input because it exceeds its context limit. */
export class JudgmentInputTooLongError extends Error {
  constructor() {
    super('Judgment input exceeds the context window');
    this.name = 'JudgmentInputTooLongError';
  }
}
