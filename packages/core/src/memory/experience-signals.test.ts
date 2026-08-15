/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import {
  accumulateExperienceSignals,
  isSubstantiveToolCall,
} from './experience-signals.js';
import { ORPHAN_TOOL_USE_REPAIR_REASON } from '../core/geminiChat.js';
import { PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE } from '../core/plan-mode-entry-policy.js';
import {
  DUPLICATE_PROVIDER_TOOL_CALL_PREFIX,
  HOOK_STOP_PREFIX,
  operationCancelledErrorMessage,
  PERMISSION_DECLINED_MESSAGE_PREFIX,
  SUPPRESSED_SIBLING_SKIP_PREFIX,
} from '../core/tool-result-markers.js';
import { ToolNames } from '../tools/tool-names.js';

function toolResult(name: string, response: Record<string, unknown>): Content {
  return {
    role: 'user',
    parts: [{ functionResponse: { id: 'c', name, response } }],
  };
}

function toolOk(name: string, output = 'done'): Content {
  return toolResult(name, { output });
}

function toolError(name: string, error = 'boom'): Content {
  return toolResult(name, { error });
}

function shellOutput(command: string, exitCode: number): string {
  return [
    `Command: ${command}`,
    'Directory: (root)',
    'Output: ...',
    'Error: ',
    `Exit Code: ${exitCode}`,
    'Signal: (none)',
  ].join('\n');
}

function detect(history: Content[]) {
  const { failedToolNames: _, ...signals } =
    accumulateExperienceSignals(history);
  return signals;
}

const NEUTRAL_ERRORS = [
  ['cancelled', operationCancelledErrorMessage('user abort')],
  ['orphan repair', ORPHAN_TOOL_USE_REPAIR_REASON],
  ['plan sibling', PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE],
  ['hook stop (arbitrary reason)', `${HOOK_STOP_PREFIX}DLP policy violation`],
  ['hook stop (default text)', `${HOOK_STOP_PREFIX}Execution stopped by hook`],
  [
    'permission declined',
    `${PERMISSION_DECLINED_MESSAGE_PREFIX} "write_file", but that permission was declined.`,
  ],
  [
    'duplicate provider call',
    `${DUPLICATE_PROVIDER_TOOL_CALL_PREFIX}call-1" was already handled.`,
  ],
  ['suppressed structured-output sibling', SUPPRESSED_SIBLING_SKIP_PREFIX],
] as const;

// Verbatim wordings from coreToolScheduler's never-executed denial sites
// (hook deny, background-agent auto-deny, hard deny, plan-mode block). The
// dynamic producers (auto-mode block, plan-required teammate pre-approval)
// share the same createErrorResponse builder, so the structural
// `executionStatus: 'not_started'` field — not the wording — must classify
// every denial as never-executed.
const DENIED_ERRORS = [
  ['hook deny', 'Permission denied by hook for "write_file"'],
  [
    'background-agent auto-deny',
    'Tool "write_file" requires permission, but background agents cannot prompt for confirmation. The tool call was denied.',
  ],
  ['hard deny', 'Tool "write_file" is denied.'],
  [
    'plan-mode block',
    'Tool blocked by plan mode: "edit" is not a read-only tool. Only read-only tools (read_file, grep_search, glob, list_directory, web_fetch, etc.) are allowed in plan mode. Do NOT retry this tool. Pivot to read-only alternatives to gather the information you need, then call exit_plan_mode with a plan that covers this tool\'s purpose.',
  ],
] as const;

describe('accumulateExperienceSignals', () => {
  it('starts empty', () => {
    expect(accumulateExperienceSignals([])).toEqual({
      retryArc: false,
      hasSubstantiveWork: false,
      failedToolNames: new Set(),
    });
  });

  it('detects only an ordered same-tool failure and recovery', () => {
    expect(detect([toolError('read_file'), toolOk('read_file')]).retryArc).toBe(
      true,
    );
    expect(detect([toolError('glob'), toolOk('read_file')]).retryArc).toBe(
      false,
    );
    expect(detect([toolOk('read_file'), toolError('read_file')]).retryArc).toBe(
      false,
    );
    expect(detect([toolError('read_file')]).retryArc).toBe(false);
  });

  it('keeps a pending failure across unrelated work', () => {
    expect(
      detect([
        toolError('write_file'),
        toolOk('read_file'),
        toolOk('write_file'),
      ]).retryArc,
    ).toBe(true);
  });

  it('uses the shell response error key rather than parsing output text', () => {
    expect(
      detect([
        toolError('run_shell_command', shellOutput('npm test', 2)),
        toolOk('run_shell_command', shellOutput('npm test', 0)),
      ]).retryArc,
    ).toBe(true);
    expect(
      detect([
        toolOk('run_shell_command', shellOutput('grep foo', 1)),
        toolOk('run_shell_command', shellOutput('grep bar', 0)),
      ]).retryArc,
    ).toBe(false);

    const embeddedStatus = [
      'Command: cat transcript.log',
      'Output: Exit Code: 1',
      'Exit Code: 0',
    ].join('\n');
    expect(
      detect([
        toolError('run_shell_command', shellOutput('npm test', 2)),
        toolOk('run_shell_command', embeddedStatus),
      ]).retryArc,
    ).toBe(true);
  });

  it.each(NEUTRAL_ERRORS)(
    'treats %s as unknown without losing a pending failure',
    (_label, error) => {
      expect(
        accumulateExperienceSignals([toolError('write_file', error)])
          .failedToolNames,
      ).toEqual(new Set());

      const pending = accumulateExperienceSignals([
        toolError('write_file'),
        toolError('write_file', error),
      ]);
      expect(pending.retryArc).toBe(false);
      expect(pending.failedToolNames).toEqual(new Set(['write_file']));

      expect(
        accumulateExperienceSignals([toolOk('write_file')], pending).retryArc,
      ).toBe(true);
    },
  );

  it.each(DENIED_ERRORS)(
    'classifies never-executed denials as neutral via executionStatus (%s)',
    (_label, error) => {
      const denied = toolResult('edit', {
        error,
        executionStatus: 'not_started',
      });
      expect(accumulateExperienceSignals([denied]).failedToolNames).toEqual(
        new Set(),
      );

      // Control: the same wording without the structured field is a
      // genuine failure — the field is what neutralizes it, so a producer
      // that stops carrying it is detectable.
      expect(
        accumulateExperienceSignals([toolError('edit', error)]).failedToolNames,
      ).toEqual(new Set(['edit']));
    },
  );

  it('carries pending failures across separately scanned fragments', () => {
    const pending = accumulateExperienceSignals([toolError('read_file')]);
    expect(
      accumulateExperienceSignals([toolOk('read_file')], pending).retryArc,
    ).toBe(true);
  });

  it('canonicalizes tool names in retry arcs', () => {
    expect(detect([toolError('replace'), toolOk('edit')]).retryArc).toBe(true);
  });

  it('never derives substantive work from response history', () => {
    expect(
      detect([
        toolError('write_file'),
        toolOk('write_file'),
        toolError('edit', NEUTRAL_ERRORS[3][1]),
        toolError('run_shell_command', NEUTRAL_ERRORS[0][1]),
      ]).hasSubstantiveWork,
    ).toBe(false);
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
    'search_file_content',
    'mcp__github__create_issue',
    'agent',
    'unknown_tool',
  ])('does not count %s', (name) => {
    expect(isSubstantiveToolCall(name)).toBe(false);
  });
});
