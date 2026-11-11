/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end guard for the reported defect: running
 * `qwen skills install --scope project <source>` must accept the short
 * `-s` flag and the `project` alias, and it must print its result to stdout
 * instead of only writing to the run diagnostic log.
 *
 * Unlike the other skills tests this file keeps the real `coreEvents` and the
 * real `initializeOutputListenersAndFlush` drain, and only intercepts the
 * final `writeToStdout` / `writeToStderr` sinks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import stripAnsi from 'strip-ansi';

const { stdoutWrites, stderrWrites, writeToStdout, writeToStderr } = vi.hoisted(
  () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdoutWrites: stdout,
      stderrWrites: stderr,
      writeToStdout: vi.fn((chunk: unknown) => {
        if (typeof chunk === 'string') stdout.push(chunk);
        return true;
      }),
      writeToStderr: vi.fn((chunk: unknown) => {
        if (typeof chunk === 'string') stderr.push(chunk);
        return true;
      }),
    };
  },
);

const mockInstallSkill = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    writeToStdout,
    writeToStderr,
  };
});

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: vi.fn(),
}));

vi.mock('../../utils/skillUtils.js', () => ({
  installSkill: mockInstallSkill,
}));

vi.mock('../../utils/skillConsent.js', () => ({
  requestConsentNonInteractive: vi.fn(async () => true),
  skillsConsentString: vi.fn(async () => 'Mock Consent String'),
}));

import { createSkillsCommand } from './index.js';

function capturedStdout(): string {
  return stripAnsi(stdoutWrites.join(''));
}

describe('skills install stdout visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stdoutWrites.length = 0;
    stderrWrites.length = 0;
    mockInstallSkill.mockResolvedValue([
      { name: 'demo-skill', location: '/workspace/.qwen/skills/demo-skill' },
    ]);
  });

  it('prints the success message on stdout and treats project as workspace', async () => {
    await createSkillsCommand().parseAsync(
      ['install', '-s', 'project', '/tmp/demo-skill', '--consent'],
      { from: 'user' },
    );

    expect(mockInstallSkill).toHaveBeenCalledWith(
      '/tmp/demo-skill',
      'workspace',
      undefined,
      expect.any(Function),
      expect.any(Function),
    );
    expect(capturedStdout()).toContain(
      'Successfully installed skill: demo-skill',
    );
    expect(capturedStdout()).toContain('scope: workspace');
  });

  it('still accepts the long --scope workspace form', async () => {
    await createSkillsCommand().parseAsync(
      ['install', '--scope', 'workspace', '/tmp/demo-skill', '--consent'],
      { from: 'user' },
    );

    expect(mockInstallSkill).toHaveBeenCalledWith(
      '/tmp/demo-skill',
      'workspace',
      undefined,
      expect.any(Function),
      expect.any(Function),
    );
    expect(capturedStdout()).toContain(
      'Successfully installed skill: demo-skill',
    );
  });

  it('reports install failures on stderr', async () => {
    mockInstallSkill.mockRejectedValue(new Error('Install failed'));

    await createSkillsCommand().parseAsync(
      ['install', '/tmp/demo-skill', '--consent'],
      { from: 'user' },
    );

    expect(stripAnsi(stderrWrites.join(''))).toContain('Install failed');
  });
});
