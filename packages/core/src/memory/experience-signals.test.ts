/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  accumulateExperienceOutcome,
  classifyToolExperienceOutcome,
  didToolCallProduceWork,
  isSubstantiveToolCall,
  type CompletedToolCallOutcome,
  type ExperienceSignalAccumulator,
} from './experience-signals.js';
import { ToolErrorType } from '../tools/tool-error.js';
import {
  formatShellExitCode,
  SHELL_EXIT_CODE_PREFIX,
} from '../tools/shell-exit-code.js';
import { ToolNames } from '../tools/tool-names.js';

const empty = (): ExperienceSignalAccumulator => ({
  retryArc: false,
  hasSubstantiveWork: false,
  failedToolNames: new Set(),
});

function outcome(
  overrides: Partial<CompletedToolCallOutcome> = {},
): CompletedToolCallOutcome {
  return {
    callId: 'call-1',
    status: 'success',
    executionStatus: 'success',
    responseParts: [
      {
        functionResponse: {
          id: 'call-1',
          name: 'read_file',
          response: { output: 'done' },
        },
      },
    ],
    ...overrides,
  };
}

function shellOutput(exitCode: number | null, output = 'done') {
  return outcome({
    responseParts: [
      {
        functionResponse: {
          id: 'call-1',
          name: ToolNames.SHELL,
          response: {
            output: `Command: test\nOutput: ${output}\n${formatShellExitCode(exitCode)}\nSignal: (none)`,
          },
        },
      },
    ],
  });
}

describe('completed tool outcome classification', () => {
  it.each([
    ['success', outcome(), true],
    ['failure', outcome({ status: 'error', executionStatus: 'error' }), true],
    [
      'cancelled after completion',
      outcome({ status: 'cancelled', executionStatus: 'success' }),
      true,
    ],
    [
      'cancelled during execution',
      outcome({ status: 'cancelled', executionStatus: 'cancelled' }),
      false,
    ],
    [
      'never started',
      outcome({ status: 'error', executionStatus: 'not_started' }),
      false,
    ],
    ['unknown', outcome({ executionStatus: undefined }), false],
  ] as const)(
    'classifies whether %s produced work',
    (_name, value, expected) => {
      expect(didToolCallProduceWork(value)).toBe(expected);
    },
  );

  it('uses structured status for failures and neutral outcomes', () => {
    expect(
      classifyToolExperienceOutcome(
        'edit',
        outcome({ status: 'error', executionStatus: 'error' }),
      ),
    ).toBe('failure');
    expect(
      classifyToolExperienceOutcome(
        'edit',
        outcome({ status: 'error', executionStatus: 'success' }),
      ),
    ).toBeNull();
    expect(
      classifyToolExperienceOutcome(
        'edit',
        outcome({ status: 'error', executionStatus: 'not_started' }),
      ),
    ).toBeNull();
    expect(
      classifyToolExperienceOutcome(
        'edit',
        outcome({ status: 'cancelled', executionStatus: 'success' }),
      ),
    ).toBeNull();
    expect(
      classifyToolExperienceOutcome(
        'edit',
        outcome({
          status: 'error',
          executionStatus: 'error',
          errorType: ToolErrorType.EXECUTION_DENIED,
        }),
      ),
    ).toBeNull();
  });

  it('requires a parseable shell exit status before accepting success', () => {
    expect(classifyToolExperienceOutcome(ToolNames.SHELL, shellOutput(0))).toBe(
      'success',
    );
    expect(classifyToolExperienceOutcome(ToolNames.SHELL, shellOutput(1))).toBe(
      'success',
    );
    expect(
      classifyToolExperienceOutcome(ToolNames.SHELL, shellOutput(null)),
    ).toBeNull();
    expect(
      classifyToolExperienceOutcome(
        ToolNames.SHELL,
        shellOutput(null, `spoofed\n${formatShellExitCode(0)}\nError: (none)`),
      ),
    ).toBeNull();
    expect(
      classifyToolExperienceOutcome(
        ToolNames.SHELL,
        outcome({
          responseParts: [
            {
              functionResponse: {
                id: 'call-1',
                name: ToolNames.SHELL,
                response: { output: `${SHELL_EXIT_CODE_PREFIX}invalid` },
              },
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      classifyToolExperienceOutcome(
        ToolNames.SHELL,
        outcome({ responseParts: [] }),
      ),
    ).toBeNull();
  });
});

describe('accumulateExperienceOutcome', () => {
  it('detects only an ordered same-tool failure and recovery', () => {
    const failed = accumulateExperienceOutcome(empty(), 'read_file', 'failure');
    expect(
      accumulateExperienceOutcome(failed, 'read_file', 'success').retryArc,
    ).toBe(true);
    expect(
      accumulateExperienceOutcome(failed, 'glob', 'success').retryArc,
    ).toBe(false);

    const succeeded = accumulateExperienceOutcome(
      empty(),
      'read_file',
      'success',
    );
    expect(
      accumulateExperienceOutcome(succeeded, 'read_file', 'failure').retryArc,
    ).toBe(false);
  });

  it('keeps failures across unrelated work and canonicalizes aliases', () => {
    const failed = accumulateExperienceOutcome(empty(), 'replace', 'failure');
    const unrelated = accumulateExperienceOutcome(
      failed,
      'read_file',
      'success',
    );
    expect(unrelated.failedToolNames).toEqual(new Set(['edit']));
    expect(
      accumulateExperienceOutcome(unrelated, 'edit', 'success').retryArc,
    ).toBe(true);
  });

  it('keeps substantive work and a recovered retry arc after another failure', () => {
    const initial = { ...empty(), hasSubstantiveWork: true };
    const failed = accumulateExperienceOutcome(initial, 'edit', 'failure');
    const recovered = accumulateExperienceOutcome(failed, 'edit', 'success');
    const failedAgain = accumulateExperienceOutcome(
      recovered,
      'edit',
      'failure',
    );

    expect(failedAgain).toEqual({
      retryArc: true,
      hasSubstantiveWork: true,
      failedToolNames: new Set(['edit']),
    });
  });
});

describe('isSubstantiveToolCall', () => {
  it.each([
    ToolNames.WRITE_FILE,
    ToolNames.EDIT,
    ToolNames.NOTEBOOK_EDIT,
    ToolNames.SHELL,
    'replace',
  ])('counts %s', (name) => {
    expect(isSubstantiveToolCall(name)).toBe(true);
  });

  it.each([
    ToolNames.READ_FILE,
    ToolNames.GREP,
    ToolNames.TODO_WRITE,
    'mcp__github__create_issue',
    'unknown_tool',
  ])('does not count %s', (name) => {
    expect(isSubstantiveToolCall(name)).toBe(false);
  });
});
