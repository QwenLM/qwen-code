/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_EXTERNAL_RECORD_ID_LENGTH,
  MAX_EXTERNAL_RECORD_MENTION_IDS,
  MAX_EXTERNAL_RECORD_STEP_TITLE_LENGTH,
  MAX_EXTERNAL_RECORD_STEPS,
  parseSessionExternalRecordParams,
} from './session-external-record-params.js';

const mention = (payload: Record<string, unknown>) => ({
  kind: 'agent_mention',
  recordKey: 'mention:client-1',
  modelText: '<agent_mention>hi</agent_mention>',
  payload: { displayText: '@claude hi', mentionedAgentIds: ['a1'], ...payload },
});

const message = (payload: Record<string, unknown>) => ({
  kind: 'agent_message',
  recordKey: 'run-1:result',
  modelText: '<agent_message from="claude">done</agent_message>',
  payload: {
    displayText: 'done',
    author: { agentId: 'a1', name: 'claude' },
    runId: 'run-1',
    status: 'completed',
    ...payload,
  },
});

const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => `id-${index}`);
const steps = (count: number, title = 'Read file') =>
  Array.from({ length: count }, (_, index) => ({
    id: `step-${index}`,
    title,
    status: 'completed',
  }));

describe('parseSessionExternalRecordParams size bounds', () => {
  it('accepts lists at their caps', () => {
    for (const params of [
      mention({
        mentionedAgentIds: ids(MAX_EXTERNAL_RECORD_MENTION_IDS),
        mentionedSquadIds: ids(MAX_EXTERNAL_RECORD_MENTION_IDS),
      }),
      message({
        steps: steps(
          MAX_EXTERNAL_RECORD_STEPS,
          'x'.repeat(MAX_EXTERNAL_RECORD_STEP_TITLE_LENGTH),
        ),
      }),
    ]) {
      expect(parseSessionExternalRecordParams(params)).toMatchObject({
        kind: params.kind,
      });
    }
  });

  it.each([
    [
      'too many agent ids',
      mention({ mentionedAgentIds: ids(MAX_EXTERNAL_RECORD_MENTION_IDS + 1) }),
      /payload\.mentionedAgentIds/,
    ],
    [
      'an overlong agent id',
      mention({
        mentionedAgentIds: ['x'.repeat(MAX_EXTERNAL_RECORD_ID_LENGTH + 1)],
      }),
      /payload\.mentionedAgentIds/,
    ],
    [
      'too many squad ids',
      mention({ mentionedSquadIds: ids(MAX_EXTERNAL_RECORD_MENTION_IDS + 1) }),
      /payload\.mentionedSquadIds/,
    ],
    [
      'a non-string squad id',
      mention({ mentionedSquadIds: [42] }),
      /payload\.mentionedSquadIds/,
    ],
    [
      'too many steps',
      message({ steps: steps(MAX_EXTERNAL_RECORD_STEPS + 1) }),
      /payload\.steps/,
    ],
    [
      'an overlong step title',
      message({
        steps: steps(1, 'x'.repeat(MAX_EXTERNAL_RECORD_STEP_TITLE_LENGTH + 1)),
      }),
      /payload\.steps/,
    ],
    [
      'an overlong step id',
      message({
        steps: [
          {
            id: 'x'.repeat(MAX_EXTERNAL_RECORD_ID_LENGTH + 1),
            title: 'Read file',
            status: 'running',
          },
        ],
      }),
      /payload\.steps/,
    ],
    [
      'a malformed step',
      message({ steps: [{ id: 's1', title: 'Read file', status: 'queued' }] }),
      /payload\.steps/,
    ],
  ])('rejects %s', (_name, params, reason) => {
    expect(parseSessionExternalRecordParams(params)).toMatch(reason);
  });
});
