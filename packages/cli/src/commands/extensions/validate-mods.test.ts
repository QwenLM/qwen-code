/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModValidationReport } from '@qwen-code/qwen-code-core/mods/mod-types.js';
import { formatModReport, handleValidateMods } from './validate-mods.js';

const mocks = vi.hoisted(() => ({ validateMods: vi.fn(), output: vi.fn() }));
vi.mock('@qwen-code/qwen-code-core/mods/mod-validation.js', () => ({
  validateMods: mocks.validateMods,
}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.output,
}));

function report(
  status: ModValidationReport['static']['status'],
): ModValidationReport {
  return {
    schemaVersion: 1,
    target: 'claude-code@2.1.295',
    discovery: 'declared',
    static: { status, complete: status !== 'incomplete' },
    runtime: 'unavailable',
    entry: 'hooks/register.mjs',
    files: ['hooks/register.mjs'],
    requirements: [],
    diagnostics: [],
  };
}
afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
});

describe('validate-mods command', () => {
  it.each([
    ['valid', 0],
    ['invalid', 1],
    ['incomplete', 1],
  ] as const)(
    'writes one JSON document with %s status and exit %s',
    async (status, exitCode) => {
      mocks.validateMods.mockResolvedValue(report(status));
      await handleValidateMods({ path: './uninstalled', json: true });
      expect(mocks.validateMods).toHaveBeenCalledWith('./uninstalled');
      expect(mocks.output).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mocks.output.mock.calls[0][0])).toEqual(report(status));
      expect(process.exitCode).toBe(exitCode);
    },
  );
  it('sanitizes terminal controls in text and states runtime availability', () => {
    const value = report('valid');
    value.entry = 'hooks/\u001b\u0007bad.mjs';
    const output = formatModReport(value);
    expect(output).toContain('Runtime: unavailable');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
  });
});
