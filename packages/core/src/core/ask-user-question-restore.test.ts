/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import {
  findRestorableAskUserQuestion,
  lastHistoryContentFromRecords,
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
    const restorable = findRestorableAskUserQuestion(history.at(-1));
    expect(restorable?.functionCalls).toEqual([
      { id: 'call-auq', name: 'ask_user_question', args: AUQ_ARGS },
    ]);
    expect(restorableAskUserQuestionCallIds(history.at(-1))).toEqual(
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
    expect(findRestorableAskUserQuestion(history.at(-1))).toBeUndefined();
  });

  it('does not hit when there is no dangling model turn', () => {
    expect(
      findRestorableAskUserQuestion({
        role: 'model',
        parts: [{ text: 'done' }],
      }),
    ).toBeUndefined();
    expect(
      findRestorableAskUserQuestion({
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
      }),
    ).toBeUndefined();
    expect(findRestorableAskUserQuestion(undefined)).toBeUndefined();
  });

  it('does not hit a trailing ask_user_question with invalid params', () => {
    const last: Content = {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call-auq',
            name: 'ask_user_question',
            args: {
              questions: [
                {
                  question: 'Pick?',
                  header: 'H',
                  // fail-closed: a single-option question is invalid and
                  // must degrade to the failed-tool-result fallback.
                  options: [{ label: 'Only', description: 'one option' }],
                },
              ],
            },
          },
        },
      ],
    };
    expect(findRestorableAskUserQuestion(last)).toBeUndefined();
    expect(restorableAskUserQuestionCallIds(last)).toBeUndefined();
  });
});

describe('lastHistoryContentFromRecords', () => {
  it('returns the last non-system message', () => {
    const last = lastHistoryContentFromRecords([
      { type: 'user', message: { role: 'user', parts: [{ text: 'pick' }] } },
      {
        type: 'assistant',
        message: {
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
      },
      { type: 'system', message: { role: 'user', parts: [{ text: 'noise' }] } },
    ]);
    expect(last?.role).toBe('model');
    expect(restorableAskUserQuestionCallIds(last)).toEqual(
      new Set(['call-auq']),
    );
  });

  it('returns undefined when there is no API-facing message', () => {
    expect(
      lastHistoryContentFromRecords([{ type: 'system' }, { type: 'user' }]),
    ).toBeUndefined();
  });
});
