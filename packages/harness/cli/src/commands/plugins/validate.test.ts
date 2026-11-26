/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';

const coreMocks = vi.hoisted(() => ({
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  sessionLogger: { setExitContext: vi.fn() },
}));

vi.mock('@qwen-code/core', () => coreMocks);

const validReport = {
  schemaVersion: 1 as const,
  validator: { name: 'fixture-cli', version: '1.2.3' },
  valid: true,
  target: { inputPath: './plugin', resolvedPath: '/tmp/plugin' },
  plugin: { name: 'plugin', version: '1.0.0' },
  diagnostics: [],
  summary: { errorCount: 0, warningCount: 0, componentCount: 1 },
};

const sharedMocks = vi.hoisted(() => ({
  formatPluginValidationReport: vi.fn(() => 'Plugin is valid.'),
  validatePluginReportForCommand: vi.fn(),
}));

vi.mock('@qwen-code/core/plugin-management', () => sharedMocks);
vi.mock('../../utils/exitCli.js', () => ({ exitCli: vi.fn(async () => {}) }));

import { createValidateCommand, handleValidate } from './validate.js';

describe('plugins validate command', () => {
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;
  let stderrWriteSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    vi.clearAllMocks();
    sharedMocks.validatePluginReportForCommand.mockResolvedValue(validReport);
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrWriteSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
  });

  it('declares json and strict options', () => {
    const help = createValidateCommand().helpInformation();
    expect(help).toContain('--json');
    expect(help).toContain('--strict');
  });

  it('emits a report envelope and exits zero for valid JSON output', async () => {
    const exitCode = await handleValidate({ path: './plugin', json: true });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(String(stdoutWriteSpy.mock.calls[0]?.[0]));
    expect(parsed).toEqual({ schemaVersion: 1, ok: true, report: validReport });
  });

  it('returns an invalid report with exit code one', async () => {
    sharedMocks.validatePluginReportForCommand.mockResolvedValueOnce({
      ...validReport,
      valid: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'plugin.manifest.invalid_json',
          message: 'Invalid JSON',
          phase: 'manifest',
        },
      ],
      summary: { errorCount: 1, warningCount: 0, componentCount: 0 },
    });

    const exitCode = await handleValidate({ path: './broken', json: true });

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(String(stdoutWriteSpy.mock.calls[0]?.[0]));
    expect(parsed.ok).toBe(true);
    expect(parsed.report.valid).toBe(false);
  });

  it('strict changes only the exit policy, not the report', async () => {
    const warningReport = {
      ...validReport,
      diagnostics: [
        {
          severity: 'warning',
          code: 'plugin.manifest.version_missing',
          message: 'No version specified.',
          phase: 'manifest',
        },
      ],
      summary: { errorCount: 0, warningCount: 1, componentCount: 1 },
    };
    sharedMocks.validatePluginReportForCommand.mockResolvedValue(warningReport);

    expect(
      await handleValidate({ path: './plugin', json: true, strict: false }),
    ).toBe(0);
    expect(
      await handleValidate({ path: './plugin', json: true, strict: true }),
    ).toBe(1);
    const reports = stdoutWriteSpy.mock.calls.map((call) =>
      JSON.parse(String(call[0])),
    );
    expect(reports[0].report).toEqual(reports[1].report);
  });

  it('uses an operational error envelope and exit code two on exceptions', async () => {
    sharedMocks.validatePluginReportForCommand.mockRejectedValueOnce(
      new Error('validator crashed'),
    );

    const exitCode = await handleValidate({ path: './plugin', json: true });

    expect(exitCode).toBe(2);
    const parsed = JSON.parse(String(stdoutWriteSpy.mock.calls[0]?.[0]));
    expect(parsed).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'plugin_validation_failed',
        message: 'validator crashed',
      },
    });
  });
});
