/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  accumulateExperienceSignals,
  hasExperienceSignal,
  isSubstantiveToolCall,
  type ExperienceSignals,
} from './experience-signals.js';
import { ORPHAN_TOOL_USE_REPAIR_REASON } from '../core/geminiChat.js';

function modelCall(name: string): Content {
  return { role: 'model', parts: [{ functionCall: { name, args: {} } }] };
}

function toolOk(name: string, output = 'done'): Content {
  return {
    role: 'user',
    parts: [{ functionResponse: { id: 'c', name, response: { output } } }],
  };
}

function toolError(name: string, message = 'boom'): Content {
  return {
    role: 'user',
    parts: [
      { functionResponse: { id: 'c', name, response: { error: message } } },
    ],
  };
}

function shellOutputBlock(command: string, exitCode: number): string {
  return [
    `Command: ${command}`,
    'Directory: (root)',
    'Output: ...',
    'Error: ',
    `Exit Code: ${exitCode}`,
    'Signal: (none)',
  ].join('\n');
}

// Real shell.ts failure shape: the `error` key is present (populated only
// when isShellExitError holds) alongside the output block.
function shellError(command: string, exitCode: number): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: 'c',
          name: 'run_shell_command',
          response: {
            error: `Command failed with exit code ${exitCode}`,
            output: shellOutputBlock(command, exitCode),
          },
        },
      },
    ],
  };
}

// Whitelisted exit-1 commands (grep/rg/diff/test) carry no `error` key —
// shell.ts deliberately classifies them as success-shaped.
function shellOk(command: string, exitCode = 0): Content {
  return toolOk('run_shell_command', shellOutputBlock(command, exitCode));
}

function cancelledResult(name: string): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: 'c',
          name,
          response: { error: '[Operation Cancelled] Reason: user abort' },
        },
      },
    ],
  };
}

function orphanRepairResult(name: string): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: 'c',
          name,
          response: { error: ORPHAN_TOOL_USE_REPAIR_REASON },
        },
      },
    ],
  };
}

/** Whole-window convenience wrapper over the production entry point. */
function detect(history: Content[]) {
  const { failedToolNames: _failedToolNames, ...signals } =
    accumulateExperienceSignals(history);
  return signals;
}

describe('accumulateExperienceSignals', () => {
  it('returns no signals for empty history', () => {
    expect(detect([])).toEqual({
      retryArc: false,
      hasSubstantiveWork: false,
    });
  });

  it('detects a retry arc from a tool error followed by a success', () => {
    const signals = detect([
      modelCall('read_file'),
      toolError('read_file'),
      modelCall('read_file'),
      toolOk('read_file'),
    ]);
    expect(signals.retryArc).toBe(true);
  });

  it('does not close a retry arc with a different tool', () => {
    const signals = detect([toolError('glob'), toolOk('read_file')]);

    expect(signals.retryArc).toBe(false);
  });

  it('detects a retry arc from a failed shell call followed by a success', () => {
    const signals = detect([
      modelCall('run_shell_command'),
      shellError('npm run test', 2),
      modelCall('run_shell_command'),
      shellOk('npm run test'),
    ]);
    expect(signals.retryArc).toBe(true);
  });

  it('does not flag failure without a later success', () => {
    const signals = detect([
      modelCall('run_shell_command'),
      shellError('npm run build', 2),
    ]);
    expect(signals.retryArc).toBe(false);
  });

  it('does not flag success-then-failure (order matters)', () => {
    const signals = detect([
      modelCall('run_shell_command'),
      shellOk('npm run build'),
      modelCall('run_shell_command'),
      shellError('npm run build', 1),
    ]);
    expect(signals.retryArc).toBe(false);
  });

  it('treats a whitelisted exit-1 without an error key (e.g. grep) as success', () => {
    // shell.ts deliberately reports grep/rg/diff/test exit-1 without an
    // `error` key; the classifier must follow that semantics, so a no-match
    // grep followed by any successful shell call opens no retry arc.
    const signals = detect([
      modelCall('run_shell_command'),
      shellOk('grep -r foo src', 1),
      modelCall('run_shell_command'),
      shellOk('grep -r bar src'),
    ]);
    expect(signals.retryArc).toBe(false);
  });

  it('ignores a status-shaped block embedded in successful command output', () => {
    // A successful command (no `error` key) whose stdout embeds a shell
    // transcript with `Exit Code: 1` is still a success — and closes a
    // pending genuine failure arc.
    const embedded = [
      'Command: cat transcript.log',
      'Output: Exit Code: 1',
      'Signal: (none)',
      'Exit Code: 0',
      'Signal: (none)',
    ].join('\n');
    const signals = detect([
      modelCall('run_shell_command'),
      shellError('npm run test', 2),
      modelCall('run_shell_command'),
      toolOk('run_shell_command', embedded),
    ]);
    expect(signals.retryArc).toBe(true);

    const noArc = detect([
      modelCall('run_shell_command'),
      toolOk('run_shell_command', embedded),
    ]);
    expect(noArc.retryArc).toBe(false);
  });

  it('marks write/edit/notebook/shell calls as substantive work', () => {
    for (const name of [
      'write_file',
      'edit',
      'notebook_edit',
      'run_shell_command',
    ]) {
      expect(detect([modelCall(name)]).hasSubstantiveWork).toBe(true);
    }
  });

  it('marks MCP and other dynamically named tools as substantive work', () => {
    expect(isSubstantiveToolCall('mcp__github__create_issue')).toBe(true);
    expect(isSubstantiveToolCall('agent')).toBe(true);
    expect(
      detect([modelCall('mcp__github__create_issue')]).hasSubstantiveWork,
    ).toBe(true);
  });

  it('does not mark read-only sessions as substantive work', () => {
    const signals = detect([
      modelCall('read_file'),
      toolOk('read_file'),
      modelCall('list_directory'),
      toolOk('list_directory'),
      modelCall('grep_search'),
      toolOk('grep_search'),
    ]);
    expect(signals).toEqual({ retryArc: false, hasSubstantiveWork: false });
  });

  it('resolves legacy aliases via canonicalToolName', () => {
    // `replace` is the legacy alias of `edit`.
    expect(isSubstantiveToolCall('replace')).toBe(true);
    // An arc opened under the alias is closed by a success under the
    // canonical name.
    const signals = detect([
      toolError('replace'),
      modelCall('edit'),
      toolOk('edit'),
    ]);
    expect(signals.retryArc).toBe(true);
  });

  it('ignores cancelled-tool responses instead of seeding a failure', () => {
    const signals = detect([
      modelCall('run_shell_command'),
      cancelledResult('run_shell_command'),
      modelCall('run_shell_command'),
      shellOk('npm run build'),
    ]);
    expect(signals.retryArc).toBe(false);
  });

  it('ignores interrupted-turn orphan repair responses', () => {
    const signals = detect([
      modelCall('write_file'),
      orphanRepairResult('write_file'),
      modelCall('write_file'),
      toolOk('write_file'),
    ]);
    expect(signals.retryArc).toBe(false);
  });

  it('does not let a synthesized marker close a pending genuine failure arc', () => {
    // A cancelled/repair response is unknown, not success: the pending arc
    // stays open until a real success closes it.
    for (const marker of [cancelledResult, orphanRepairResult]) {
      const signals = detect([
        modelCall('run_shell_command'),
        shellError('npm run test', 2),
        marker('run_shell_command'),
        modelCall('run_shell_command'),
        shellOk('npm run test'),
      ]);
      expect(signals.retryArc).toBe(true);
    }
  });

  it('does not treat an unparseable shell response as failure', () => {
    const signals = detect([
      toolError('read_file'),
      modelCall('run_shell_command'),
      toolOk('run_shell_command', 'Exit Code: (none)'),
    ]);
    expect(signals.retryArc).toBe(false);
  });

  it('keeps a pending failure across separately scanned fragments', () => {
    const failed = accumulateExperienceSignals([toolError('read_file')]);
    const recovered = accumulateExperienceSignals(
      [toolOk('read_file')],
      failed,
    );

    expect(recovered.retryArc).toBe(true);
  });
});

describe('hasExperienceSignal', () => {
  it('is false when neither signal is set', () => {
    const signals: ExperienceSignals = {
      retryArc: false,
      userSteer: false,
      hasSubstantiveWork: true,
    };
    expect(hasExperienceSignal(signals)).toBe(false);
  });

  it.each(['retryArc', 'userSteer'] as const)('is true with %s', (key) => {
    const signals: ExperienceSignals = {
      retryArc: false,
      userSteer: false,
      hasSubstantiveWork: false,
      [key]: true,
    };
    expect(hasExperienceSignal(signals)).toBe(true);
  });
});
