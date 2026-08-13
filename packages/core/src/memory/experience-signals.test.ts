/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  accumulateExperienceSignals,
  detectExperienceSignals,
  hasExperienceSignal,
  type ExperienceSignals,
} from './experience-signals.js';

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

function shellResult(command: string, exitCode: number): Content {
  return toolOk(
    'run_shell_command',
    [
      `Command: ${command}`,
      'Directory: (root)',
      'Output: ...',
      'Error: ',
      `Exit Code: ${exitCode}`,
      'Signal: (none)',
    ].join('\n'),
  );
}

describe('detectExperienceSignals', () => {
  it('returns no signals for empty history', () => {
    expect(detectExperienceSignals([])).toEqual({
      retryArc: false,
      hasSubstantiveWork: false,
    });
  });

  it('detects a retry arc from a tool error followed by a success', () => {
    const signals = detectExperienceSignals([
      modelCall('read_file'),
      toolError('read_file'),
      modelCall('read_file'),
      toolOk('read_file'),
    ]);
    expect(signals.retryArc).toBe(true);
  });

  it('does not close a retry arc with a different tool', () => {
    const signals = detectExperienceSignals([
      toolError('glob'),
      toolOk('read_file'),
    ]);

    expect(signals.retryArc).toBe(false);
  });

  it('detects a retry arc from a non-zero shell exit followed by a success', () => {
    const signals = detectExperienceSignals([
      modelCall('run_shell_command'),
      shellResult('npm run test', 2),
      modelCall('run_shell_command'),
      shellResult('npm run test', 0),
    ]);
    expect(signals.retryArc).toBe(true);
  });

  it('does not flag failure without a later success', () => {
    const signals = detectExperienceSignals([
      modelCall('run_shell_command'),
      shellResult('npm run build', 2),
    ]);
    expect(signals.retryArc).toBe(false);
  });

  it('does not flag success-then-failure (order matters)', () => {
    const signals = detectExperienceSignals([
      modelCall('run_shell_command'),
      shellResult('npm run build', 0),
      modelCall('run_shell_command'),
      shellResult('npm run build', 1),
    ]);
    expect(signals.retryArc).toBe(false);
  });

  it('treats a non-zero exit without a tool error (e.g. grep) as failure', () => {
    const signals = detectExperienceSignals([
      modelCall('run_shell_command'),
      shellResult('grep -r foo src', 1),
      modelCall('run_shell_command'),
      shellResult('grep -r bar src', 0),
    ]);
    expect(signals.retryArc).toBe(true);
  });

  it('marks write/edit/shell calls as substantive work', () => {
    expect(
      detectExperienceSignals([modelCall('write_file')]).hasSubstantiveWork,
    ).toBe(true);
    expect(
      detectExperienceSignals([modelCall('run_shell_command')])
        .hasSubstantiveWork,
    ).toBe(true);
  });

  it('does not mark read-only sessions as substantive work', () => {
    const signals = detectExperienceSignals([
      modelCall('read_file'),
      toolOk('read_file'),
      modelCall('list_directory'),
      toolOk('list_directory'),
      modelCall('grep_search'),
      toolOk('grep_search'),
    ]);
    expect(signals).toEqual({ retryArc: false, hasSubstantiveWork: false });
  });

  it('does not treat an unparseable shell response as success', () => {
    const signals = detectExperienceSignals([
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
