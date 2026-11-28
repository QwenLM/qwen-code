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
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  sessionLogger: { setExitContext: vi.fn() },
}));

vi.mock('@qwen-code/core', () => ({
  getErrorMessage: coreMocks.getErrorMessage,
  sessionLogger: coreMocks.sessionLogger,
}));

const sharedMocks = vi.hoisted(() => ({
  uninstallPluginForCommand: vi.fn(async () => ({
    message: 'Plugin uninstalled successfully.',
    runtimeReloadRequired: true as const,
    pluginId: 'test-plugin',
    fullyRemoved: true,
    reverseDependents: [] as string[],
  })),
  inferPluginErrorCode: vi.fn(() => 'plugin_operation_failed'),
  normalizePluginScope: vi.fn((s: string) => s),
}));

vi.mock('@qwen-code/core/plugin-management', () => ({
  uninstallPluginForCommand: sharedMocks.uninstallPluginForCommand,
  inferPluginErrorCode: sharedMocks.inferPluginErrorCode,
  normalizePluginScope: sharedMocks.normalizePluginScope,
}));

vi.mock('../../config/createCliSettingsService.js', () => ({
  resolveCommandSettings: vi.fn(() => ({ merged: {} })),
}));

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: vi.fn(async () => {}),
}));

import { handleUninstall, createUninstallCommand } from './uninstall.js';

describe('plugins uninstall command', () => {
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;
  let stderrWriteSpy: MockInstance<typeof process.stderr.write>;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    sharedMocks.uninstallPluginForCommand.mockResolvedValue({
      message: 'Plugin uninstalled successfully.',
      runtimeReloadRequired: true,
      pluginId: 'test-plugin',
      fullyRemoved: true,
      reverseDependents: [],
    });
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrWriteSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('has the expected command definition', () => {
    const cmd = createUninstallCommand();
    expect(cmd.name()).toBe('uninstall');
  });

  describe('--json flag', () => {
    it('outputs structured JSON on success', async () => {
      await handleUninstall({ plugin: 'test-plugin', scope: 'user', json: true });

      const jsonOutput = stdoutWriteSpy.mock.calls
        .map((c) => c[0])
        .find((s) => typeof s === 'string' && s.includes('"ok"'));
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput as string);
      expect(parsed).toEqual({
        ok: true,
        pluginId: 'test-plugin',
        fullyRemoved: true,
        reverseDependents: [],
      });
    });

    it('suppresses progress message', async () => {
      await handleUninstall({ plugin: 'test-plugin', scope: 'user', json: true });

      const allWrites = stdoutWriteSpy.mock.calls.map((c) => String(c[0]));
      expect(allWrites.some((w) => w.includes('Uninstalling plugin'))).toBe(
        false,
      );
    });

    it('passes keepData to shared function', async () => {
      await handleUninstall({
        plugin: 'test-plugin',
        scope: 'user',
        keepData: true,
        json: true,
      });

      expect(sharedMocks.uninstallPluginForCommand).toHaveBeenCalledWith(
        expect.objectContaining({ keepData: true }),
      );
    });

    it('outputs structured JSON error on failure', async () => {
      sharedMocks.uninstallPluginForCommand.mockRejectedValueOnce(
        new Error('Plugin is not installed'),
      );
      sharedMocks.inferPluginErrorCode.mockReturnValueOnce(
        'plugin_not_installed',
      );

      await handleUninstall({ plugin: 'unknown', scope: 'user', json: true });

      const jsonOutput = stdoutWriteSpy.mock.calls
        .map((c) => c[0])
        .find((s) => typeof s === 'string' && s.includes('"error"'));
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput as string);
      expect(parsed).toEqual({
        error: true,
        code: 'plugin_not_installed',
        message: 'Plugin is not installed',
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('includes reverse dependents when present', async () => {
      sharedMocks.uninstallPluginForCommand.mockResolvedValueOnce({
        message: 'Uninstalled.',
        runtimeReloadRequired: true,
        pluginId: 'dep-plugin',
        fullyRemoved: false,
        reverseDependents: ['plugin-a', 'plugin-b'],
      });

      await handleUninstall({ plugin: 'dep-plugin', scope: 'user', json: true });

      const jsonOutput = stdoutWriteSpy.mock.calls
        .map((c) => c[0])
        .find((s) => typeof s === 'string' && s.includes('"ok"'));
      const parsed = JSON.parse(jsonOutput as string);
      expect(parsed.reverseDependents).toEqual(['plugin-a', 'plugin-b']);
      expect(parsed.fullyRemoved).toBe(false);
    });

    it('sets exit context on error', async () => {
      sharedMocks.uninstallPluginForCommand.mockRejectedValueOnce(
        new Error('fail'),
      );

      await handleUninstall({ plugin: 'bad', scope: 'user', json: true });

      expect(coreMocks.sessionLogger.setExitContext).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'fatal_error',
          exit_code: 1,
          source: 'plugins.uninstall',
        }),
      );
    });
  });

  it('accepts non-user scope', async () => {
    await handleUninstall({ plugin: 'test-plugin', scope: 'local', json: true });

    expect(sharedMocks.uninstallPluginForCommand).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'local' }),
    );
  });

  describe('non-json mode (default)', () => {
    it('shows progress message', async () => {
      await handleUninstall({ plugin: 'test-plugin', scope: 'user' });

      const allWrites = stdoutWriteSpy.mock.calls.map((c) => String(c[0]));
      expect(
        allWrites.some(
          (w) =>
            w.includes('Uninstalling plugin "test-plugin"') &&
            w.includes('scope "user"'),
        ),
      ).toBe(true);
    });

    it('writes success message to stdout', async () => {
      await handleUninstall({ plugin: 'test-plugin', scope: 'user' });

      expect(sharedMocks.uninstallPluginForCommand).toHaveBeenCalled();
      const allWrites = stdoutWriteSpy.mock.calls.map((c) => String(c[0]));
      expect(allWrites.some((w) => w.includes('uninstalled'))).toBe(true);
    });

    it('writes error to stderr on failure', async () => {
      sharedMocks.uninstallPluginForCommand.mockRejectedValueOnce(
        new Error('something went wrong'),
      );

      await handleUninstall({ plugin: 'bad', scope: 'user' });

      const errWrites = stderrWriteSpy.mock.calls.map((c) => String(c[0]));
      expect(errWrites.some((w) => w.includes('something went wrong'))).toBe(
        true,
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
