/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModValidationReport } from '@qwen-code/qwen-code-core/mods/mod-types.js';
import { formatModReport, handleValidateMods } from './validate-mods.js';

const mocks = vi.hoisted(() => ({
  validateMods: vi.fn(),
  output: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/mods/mod-validation.js', () => ({
  validateMods: mocks.validateMods,
}));
vi.mock('../../utils/stdioHelpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/stdioHelpers.js')>();
  return {
    ...actual,
    writeStdoutLine: mocks.output,
  };
});

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
const initialStdoutListeners = new Set(process.stdout.listeners('error'));
const initialStderrListeners = new Set(process.stderr.listeners('error'));
afterEach(() => {
  for (const listener of process.stdout.listeners('error')) {
    if (!initialStdoutListeners.has(listener))
      process.stdout.removeListener(
        'error',
        listener as (error: Error) => void,
      );
  }
  for (const listener of process.stderr.listeners('error')) {
    if (!initialStderrListeners.has(listener))
      process.stderr.removeListener(
        'error',
        listener as (error: Error) => void,
      );
  }
  vi.clearAllMocks();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('validate-mods command', () => {
  it('renders the default text handler result with requirements and diagnostics', async () => {
    const value = report('incomplete');
    value.requirements = [
      {
        kind: 'event',
        name: 'tool.call',
        stage: 'M4',
        file: 'hooks/register.mjs',
        line: 3,
        column: 5,
        matcher: '{"tool":"Bash"}',
        hasCatch: true,
      },
      {
        kind: 'api',
        name: 'fs.read',
        stage: 'M5',
        file: 'hooks/helper.mjs',
        line: 2,
        column: 9,
      },
    ];
    value.diagnostics = [
      {
        code: 'MOD_ANALYSIS_INCOMPLETE',
        severity: 'error',
        message: 'The registration cannot be classified.',
        file: 'hooks/register.mjs',
        line: 7,
        column: 3,
      },
    ];
    mocks.validateMods.mockResolvedValue(value);
    await handleValidateMods({ path: './uninstalled' });
    expect(mocks.output).toHaveBeenCalledOnce();
    expect(mocks.output.mock.calls[0][0]).toBe(
      [
        'Mod: declared',
        'Static: incomplete',
        'Runtime: unavailable',
        'Target: claude-code@2.1.295',
        'Entry: hooks/register.mjs',
        'event: tool.call (M4) hooks/register.mjs:3:5 matcher={"tool":"Bash"} catch',
        'api: fs.read (M5) hooks/helper.mjs:2:9',
        'error MOD_ANALYSIS_INCOMPLETE hooks/register.mjs:7:3: The registration cannot be classified.',
      ].join('\n'),
    );
    expect(process.exitCode).toBe(1);
  });
  it('sanitizes requirement provenance and matcher and omits absent fields', () => {
    const value = report('valid');
    value.requirements = [
      {
        kind: 'event',
        name: 'tool.\u0007call',
        stage: 'M4',
        file: 'hooks/\u001b[31mregister.mjs',
        line: 3,
        matcher: 'Bash\u0007',
        hasCatch: true,
      },
      { kind: 'event', name: 'session.start', stage: 'M4', hasCatch: false },
    ];
    const output = formatModReport(value);
    expect(output).toContain(
      'event: tool.call (M4) hooks/register.mjs:3:1 matcher=Bash catch',
    );
    expect(output.split('\n').at(-1)).toBe('event: session.start (M4)');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
  });
  it.each(['synchronous', 'asynchronous'] as const)(
    'keeps a valid report exit when stdout has a %s broken pipe',
    async (mode) => {
      const actual = await vi.importActual<
        typeof import('../../utils/stdioHelpers.js')
      >('../../utils/stdioHelpers.js');
      const destroy = vi
        .spyOn(process.stdout, 'destroy')
        .mockReturnValue(process.stdout);
      const error = Object.assign(new Error('reader closed'), {
        code: 'EPIPE',
      });
      vi.spyOn(process.stdout, 'write').mockImplementation(() => {
        if (mode === 'synchronous') throw error;
        process.stdout.emit('error', error);
        return false;
      });
      mocks.output.mockImplementationOnce(actual.writeStdoutLine);
      mocks.validateMods.mockResolvedValue(report('valid'));
      await expect(
        handleValidateMods({ path: './uninstalled', json: true }),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(0);
      if (mode === 'asynchronous') expect(destroy).toHaveBeenCalledOnce();
    },
  );
  it('propagates output errors other than a broken pipe', async () => {
    const error = Object.assign(new Error('output failed'), { code: 'ENOSPC' });
    mocks.output.mockImplementationOnce(() => {
      throw error;
    });
    mocks.validateMods.mockResolvedValue(report('valid'));
    await expect(
      handleValidateMods({ path: './uninstalled', json: true }),
    ).rejects.toBe(error);
  });
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
