/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Judge } from '../../../judgment/types.js';
import { JevAutoJudge } from './auto-judge.js';
import {
  createClassifierSnapshot,
  createEmptyToolLookup,
  type ClassifierMessage,
} from './classifier.js';

const runtime = {
  invokeFn: null,
  userConfig: undefined,
  userInstructions: undefined,
};

describe.each(['primary', 'shadow'] as const)(
  'Bash risk in %s approval',
  (executionMode) => {
    it.each([true, false, undefined])(
      'omits risk=%s without changing original inputs',
      async (risk) => {
        const input = {
          command: 'echo risk',
          description: 'Print risk',
          dir_path: '/repo',
          ...(risk === undefined ? {} : { risk }),
        };
        const messages: ClassifierMessage[] = [
          { role: 'user', content: 'Print risk' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'bash-1', text: 'risk' },
            ],
          },
        ];
        const original = structuredClone({ input, messages });
        // An absent projector exercises the raw-input fallback as well as history.
        const snapshot = createClassifierSnapshot(
          runtime,
          messages,
          'Bash',
          input,
          createEmptyToolLookup(),
        );
        const judge = vi
          .fn()
          .mockResolvedValue({
            answers: { permission: { type: 'choice', choice: 'allow' } },
          });
        const adapter = new JevAutoJudge({
          createJudge: async () => ({ label: 'test/model', judge }) as Judge,
          getSessionId: () => 'session-1',
          getWorkspace: () => '/repo',
          executionMode,
        });

        expect(
          (await adapter.judge(snapshot, new AbortController().signal))
            .shouldBlock,
        ).toBe(false);
        expect(judge).toHaveBeenCalledOnce();
        const state = judge.mock.calls[0][0].state;
        const expectedInput = {
          command: 'echo risk',
          description: 'Print risk',
          dir_path: '/repo',
        };
        expect(state.history).toEqual([
          { role: 'user', content: [{ type: 'text', text: 'Print risk' }] },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'bash-1',
                name: 'Bash',
                input: expectedInput,
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'outcome',
                id: 'bash-1',
                name: 'Bash',
                input: expectedInput,
                resultInfo: { outcome: 'ok' },
              },
            ],
          },
        ]);
        expect(state.action).toBe(`Bash ${JSON.stringify(expectedInput)}\n`);
        expect(snapshot.input).toEqual(expectedInput);
        expect(snapshot.llmAction).not.toContain('"risk":');
        expect(snapshot.llmTranscript).not.toContain('"risk":');
        expect({ input, messages }).toEqual(original);
      },
    );
  },
);

it('preserves another tool’s risk argument and Bash command text', () => {
  const input = { risk: true, command: 'echo risk' };
  const messages: ClassifierMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'custom-1', name: 'CustomTool', input },
      ],
    },
  ];
  const snapshot = createClassifierSnapshot(
    runtime,
    messages,
    'CustomTool',
    input,
    createEmptyToolLookup(),
  );
  expect(snapshot.input).toEqual(input);
  expect(snapshot.transcript[0].content).toEqual(messages[0].content);
  expect(snapshot.action).toBe(`CustomTool ${JSON.stringify(input)}\n`);
});
