/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import {
  findRestorableAskUserQuestion,
  parseAskUserQuestionParams,
  restorableAskUserQuestionCallIds,
} from './ask-user-question-restore.js';

const AUQ_ARGS = {
  questions: [
    {
      question: 'Which approach?',
      header: 'Approach',
      options: [
        { label: 'Polling', description: 'Poll the API' },
        { label: 'Webhook', description: 'Use a webhook' },
      ],
    },
  ],
};

describe('parseAskUserQuestionParams', () => {
  it('accepts a valid questions payload', () => {
    expect(parseAskUserQuestionParams(AUQ_ARGS)).toEqual(AUQ_ARGS);
  });

  it('rejects empty or mixed invalid payloads', () => {
    expect(parseAskUserQuestionParams(undefined)).toBeUndefined();
    expect(parseAskUserQuestionParams({ questions: [] })).toBeUndefined();
    expect(
      parseAskUserQuestionParams({
        questions: [{ question: 'x', header: 'H', options: [] }],
      }),
    ).toBeUndefined();
  });
});

describe('findRestorableAskUserQuestion', () => {
  it('hits a trailing unanswered ask_user_question', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'pick one' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-auq',
              name: 'ask_user_question',
              args: AUQ_ARGS,
            },
          },
        ],
      },
    ];
    const restorable = findRestorableAskUserQuestion(history);
    expect(restorable?.functionCalls).toEqual([
      { id: 'call-auq', name: 'ask_user_question', args: AUQ_ARGS },
    ]);
    expect(restorableAskUserQuestionCallIds(history)).toEqual(
      new Set(['call-auq']),
    );
  });

  it('does not hit mixed dangling tools in the last model turn', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'do both' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-bash',
              name: 'run_shell_command',
              args: { command: 'ls' },
            },
          },
          {
            functionCall: {
              id: 'call-auq',
              name: 'ask_user_question',
              args: AUQ_ARGS,
            },
          },
        ],
      },
    ];
    expect(findRestorableAskUserQuestion(history)).toBeUndefined();
  });

  it('does not hit when there is no dangling model turn', () => {
    expect(
      findRestorableAskUserQuestion([
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'done' }] },
      ]),
    ).toBeUndefined();
    expect(
      findRestorableAskUserQuestion([
        { role: 'user', parts: [{ text: 'hi' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-auq',
                name: 'ask_user_question',
                args: AUQ_ARGS,
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-auq',
                name: 'ask_user_question',
                response: { output: 'answered' },
              },
            },
          ],
        },
      ]),
    ).toBeUndefined();
  });
});
