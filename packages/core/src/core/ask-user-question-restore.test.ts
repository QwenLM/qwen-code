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
import {
  content,
  fnCall,
  fnResponse,
  modelText,
} from '../test-utils/model-fixtures.js';

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
      content('model', fnCall('ask_user_question', AUQ_ARGS, 'call-auq')),
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
      content(
        'model',
        fnCall('run_shell_command', { command: 'ls' }, 'call-bash'),
        fnCall('ask_user_question', AUQ_ARGS, 'call-auq'),
      ),
    ];
    expect(findRestorableAskUserQuestion(history.at(-1))).toBeUndefined();
  });

  it('does not hit when there is no dangling model turn', () => {
    expect(findRestorableAskUserQuestion(modelText('done'))).toBeUndefined();
    expect(
      findRestorableAskUserQuestion(
        content(
          'user',
          fnResponse('ask_user_question', { output: 'answered' }, 'call-auq'),
        ),
      ),
    ).toBeUndefined();
    expect(findRestorableAskUserQuestion(undefined)).toBeUndefined();
  });

  it('does not hit a trailing ask_user_question with invalid params', () => {
    const last: Content = content(
      'model',
      fnCall(
        'ask_user_question',
        {
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
        'call-auq',
      ),
    );
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
        message: content(
          'model',
          fnCall('ask_user_question', AUQ_ARGS, 'call-auq'),
        ),
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
