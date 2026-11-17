/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { FunctionDeclaration } from '@google/genai';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ManagedSessionAction } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type { HostedActionOptions } from './hosted-tool-approval.js';

export const HOSTED_QUESTION_POLICY = 'hosted-user-question/1';
export const HOSTED_QUESTION_INPUT_BYTES = 16 * 1024;
export const HOSTED_QUESTION_ANSWER_BYTES = 32 * 1024;

export interface HostedActionQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly required: true;
  readonly multiple: boolean;
  readonly allowText: true;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly description: string;
  }>;
}

export interface HostedQuestionAnswer {
  readonly questionId: string;
  readonly optionIds?: readonly string[];
  readonly text?: string;
}

export const HOSTED_USER_QUESTION_TOOL: FunctionDeclaration = {
  name: 'ask_user_question',
  description:
    'Ask the user to clarify requirements or choose an approach. Use this tool as the only call in its batch and wait for the answer. Users can always enter custom text. Put a recommended choice first with "(Recommended)" in its label. In Plan mode, use exit_plan_mode for approval of the finished plan.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', minLength: 1, maxLength: 2048 },
            header: { type: 'string', minLength: 1 },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', minLength: 1, maxLength: 256 },
                  description: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 1024,
                  },
                },
                required: ['label', 'description'],
                additionalProperties: false,
              },
            },
            multiSelect: { type: 'boolean' },
          },
          required: ['question', 'header', 'options'],
          additionalProperties: false,
        },
      },
      metadata: {
        type: 'object',
        properties: { source: { type: 'string' } },
        additionalProperties: false,
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
};

export class HostedQuestionInputError extends Error {}

function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new HostedQuestionInputError('Invalid question or answer fields.');
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, nonblank = true): string {
  if (
    typeof value !== 'string' ||
    (nonblank && !value.trim()) ||
    value.length > max ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    throw new HostedQuestionInputError(
      `Question text must be valid Unicode, nonblank when required, and at most ${max} characters.`,
    );
  return value;
}

export function hostedQuestions(input: unknown): HostedActionQuestion[] {
  const args = object(input, ['questions'], ['metadata']);
  if (Buffer.byteLength(JSON.stringify(args)) > HOSTED_QUESTION_INPUT_BYTES)
    throw new HostedQuestionInputError('Question input exceeds 16 KiB.');
  if (Object.hasOwn(args, 'metadata')) {
    const metadata = object(args['metadata'], [], ['source']);
    if (Object.hasOwn(metadata, 'source'))
      text(metadata['source'], HOSTED_QUESTION_INPUT_BYTES, false);
  }
  const questions = args['questions'];
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4)
    throw new HostedQuestionInputError('Ask between one and four questions.');
  return questions.map((value, index) => {
    const question = object(
      value,
      ['question', 'header', 'options'],
      ['multiSelect'],
    );
    text(question['header'], HOSTED_QUESTION_INPUT_BYTES);
    if (
      Object.hasOwn(question, 'multiSelect') &&
      typeof question['multiSelect'] !== 'boolean'
    )
      throw new HostedQuestionInputError('multiSelect must be a boolean.');
    const options = question['options'];
    if (!Array.isArray(options) || options.length < 2 || options.length > 4)
      throw new HostedQuestionInputError(
        'Provide between two and four options.',
      );
    return {
      id: `q${index + 1}`,
      prompt: text(question['question'], 2048),
      required: true,
      multiple: question['multiSelect'] === true,
      allowText: true,
      options: options.map((value, optionIndex) => {
        const option = object(value, ['label', 'description']);
        return {
          id: `q${index + 1}o${optionIndex + 1}`,
          label: text(option['label'], 256),
          description: text(option['description'], 1024),
        };
      }),
    };
  });
}

export function assertHostedQuestions(
  value: unknown,
): asserts value is HostedActionQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    throw new HostedQuestionInputError('Invalid saved questions.');
  for (const [index, item] of value.entries()) {
    const question = object(item, [
      'id',
      'prompt',
      'required',
      'multiple',
      'allowText',
      'options',
    ]);
    text(question['prompt'], 2048);
    const options = question['options'];
    if (
      question['id'] !== `q${index + 1}` ||
      question['required'] !== true ||
      question['allowText'] !== true ||
      typeof question['multiple'] !== 'boolean' ||
      !Array.isArray(options) ||
      options.length < 2 ||
      options.length > 4
    )
      throw new HostedQuestionInputError('Invalid saved question shape.');
    for (const [optionIndex, value] of options.entries()) {
      const option = object(value, ['id', 'label', 'description']);
      if (option['id'] !== `q${index + 1}o${optionIndex + 1}`)
        throw new HostedQuestionInputError('Invalid saved option ID.');
      text(option['label'], 256);
      text(option['description'], 1024);
    }
  }
}

export function normalizeHostedQuestionAnswers(
  questions: readonly HostedActionQuestion[],
  value: unknown,
): HostedQuestionAnswer[] {
  if (!Array.isArray(value) || value.length !== questions.length)
    throw new HostedQuestionInputError('Answer every question exactly once.');
  const answers = new Map<string, Record<string, unknown>>();
  for (const valueItem of value) {
    const answer = object(valueItem, ['questionId'], ['optionIds', 'text']);
    const id = answer['questionId'];
    if (
      typeof id !== 'string' ||
      !questions.some((q) => q.id === id) ||
      answers.has(id)
    )
      throw new HostedQuestionInputError('Unknown or duplicate question ID.');
    answers.set(id, answer);
  }
  const normalized = questions.map((question) => {
    const answer = answers.get(question.id)!;
    const rawIds = Object.hasOwn(answer, 'optionIds')
      ? answer['optionIds']
      : undefined;
    if (
      rawIds !== undefined &&
      (!Array.isArray(rawIds) ||
        rawIds.length === 0 ||
        rawIds.length > question.options.length ||
        new Set(rawIds).size !== rawIds.length ||
        rawIds.some(
          (id) => !question.options.some((option) => option.id === id),
        ))
    )
      throw new HostedQuestionInputError(
        'Unknown, empty or duplicate option IDs.',
      );
    const optionIds = question.options
      .filter((option) =>
        (rawIds as unknown[] | undefined)?.includes(option.id),
      )
      .map((option) => option.id);
    const answerText = Object.hasOwn(answer, 'text')
      ? text(answer['text'], 8192)
      : undefined;
    if (
      (optionIds.length === 0 && answerText === undefined) ||
      (!question.multiple &&
        optionIds.length + Number(answerText !== undefined) !== 1)
    )
      throw new HostedQuestionInputError(
        'Choose one answer for a single-choice question, or provide a nonempty multiple-choice answer.',
      );
    return {
      questionId: question.id,
      ...(optionIds.length ? { optionIds } : {}),
      ...(answerText !== undefined ? { text: answerText } : {}),
    };
  });
  if (
    Buffer.byteLength(JSON.stringify(normalized)) > HOSTED_QUESTION_ANSWER_BYTES
  )
    throw new HostedQuestionInputError('Question answers exceed 32 KiB.');
  return normalized;
}

export function hostedQuestionDecisionBytes(
  answers: readonly HostedQuestionAnswer[],
  inputRevision: number,
  policyRevision: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({ v: 2, answers, inputRevision, policyRevision }),
  );
}

export async function readHostedQuestionDecision(
  session: ManagedSession,
  action: ManagedSessionAction,
  options: Extract<HostedActionOptions, { v: 4 }>,
): Promise<HostedQuestionAnswer[]> {
  if (
    action.state !== 'decided' ||
    action.decisionRef?.kind !== 'managed-action-decision'
  )
    throw new Error('Question has no durable answer.');
  const bytes = await session.resources.read(action.decisionRef);
  const decision = object(JSON.parse(bytes.toString('utf8')), [
    'v',
    'answers',
    'inputRevision',
    'policyRevision',
  ]);
  const answers = normalizeHostedQuestionAnswers(
    options.questions,
    decision['answers'],
  );
  const canonical = hostedQuestionDecisionBytes(
    answers,
    options.inputRevision,
    options.policyRevision,
  );
  if (
    decision['v'] !== 2 ||
    decision['inputRevision'] !== action.inputRevision ||
    decision['policyRevision'] !== HOSTED_QUESTION_POLICY ||
    !bytes.equals(canonical) ||
    createHash('sha256').update(canonical).digest('hex') !==
      action.decisionRef.digest
  )
    throw new Error('Question answer conflicts with its original Action.');
  return answers;
}
