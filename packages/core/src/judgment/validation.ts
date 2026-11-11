/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { JudgmentRequest, Questions } from './types.js';

const questionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    instructions: z.string(),
    criteria: z
      .record(z.string().nullable())
      .refine((value) => Object.keys(value).length > 0, 'must contain choices'),
  }),
  z.object({
    type: z.literal('noul'),
    instructions: z.string(),
    criteria: z
      .object({ true: z.string().optional(), false: z.string().optional() })
      .optional(),
  }),
  z.object({
    type: z.literal('score'),
    instructions: z.string(),
    criteria: z.array(z.string()).min(2),
  }),
]);
const questionsSchema = z.record(questionSchema);

export function validateJudgmentRequest(request: JudgmentRequest): void {
  questionsSchema.parse(request.questions);
  for (const [id, question] of Object.entries(request.questions)) {
    if (!id.trim() || /[\r\n]/.test(id))
      throw new Error(
        'Judgment question IDs must be non-empty single-line strings',
      );
    if (
      question.type === 'choice' &&
      Object.keys(question.criteria).some(
        (label) => !label.trim() || /[\r\n]/.test(label),
      )
    ) {
      throw new Error('Judgment choices must be non-empty single-line strings');
    }
  }
  if (Object.keys(request.questions).length === 0)
    throw new Error('Judgment requires at least one question');
  if (
    typeof request.state !== 'string' &&
    (request.state === null || typeof request.state !== 'object')
  ) {
    throw new Error('Judgment state must be a string, object or array');
  }
  // Reject circular/non-JSON inputs before either backend issues a request.
  JSON.stringify(request.state);
}

const probability = z.number().finite().min(0).max(1);
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('choice'),
        choice: z.string(),
        probabilities: z.record(probability).optional(),
        confidence: probability.optional(),
      }),
      z.object({ type: z.literal('noul'), noul: probability }),
      z.object({
        type: z.literal('score'),
        score: z.number().finite(),
        probabilities: z.record(probability).optional(),
        confidence: probability.optional(),
      }),
    ]),
  ),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
/** Native SystemOne response contract. Optional metadata is never invented. */
export function parseNativeJudgmentResponse(
  value: unknown,
  questions: Questions,
  source: string,
) {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`${source} returned an invalid judgment response`);
  const result = parsed.data;
  for (const [id, question] of Object.entries(questions)) {
    const answer = result.answers[id];
    if (!answer || answer.type !== question.type)
      throw new Error(`${source} returned no matching answer for "${id}"`);
    if (
      answer.type === 'choice' &&
      question.type === 'choice' &&
      !Object.hasOwn(question.criteria, answer.choice)
    ) {
      throw new Error(`${source} returned an unknown choice for "${id}"`);
    }
    if (
      answer.type === 'score' &&
      question.type === 'score' &&
      (answer.score < 0 || answer.score > question.criteria.length - 1)
    ) {
      throw new Error(`${source} returned an invalid score for "${id}"`);
    }
  }
  return result;
}
