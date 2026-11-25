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
  installPluginForCommand: vi.fn(async () => ({
    message: 'Plugin installed successfully.',
    runtimeReloadRequired: true as const,
    pluginId: 'test-plugin',
    version: '1.0.0',
    installPath: '/tmp/plugins/test-plugin',
  })),
  inferPluginErrorCode: vi.fn(() => 'plugin_operation_failed'),
  normalizePluginScope: vi.fn((s: string) => s),
}));

vi.mock('@qwen-code/core/plugin-management', () => ({
  installPluginForCommand: sharedMocks.installPluginForCommand,
  inferPluginErrorCode: sharedMocks.inferPluginErrorCode,
  normalizePluginScope: sharedMocks.normalizePluginScope,
}));

vi.mock('../../config/createCliSettingsService.js', () => ({
  resolveCommandSettings: vi.fn(() => ({ merged: {} })),
}));

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: vi.fn(async () => {}),
}));

import { handleInstall, createInstallCommand } from './install.js';

describe('plugins install command', () => {
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;
  let stderrWriteSpy: MockInstance<typeof process.stderr.write>;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    sharedMocks.installPluginForCommand.mockResolvedValue({
      message: 'Plugin installed successfully.',
      runtimeReloadRequired: true,
      pluginId: 'test-plugin',
      version: '1.0.0',
      installPath: '/tmp/plugins/test-plugin',
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
    const cmd = createInstallCommand();
    expect(cmd.name()).toBe('install');
    expect(cmd.description()).toContain('remote HTTPS .zip URL');
    expect(cmd.helpInformation()).toContain('remote HTTPS .zip URL');
  });

  describe('--json flag', () => {
    it('outputs structured JSON on success', async () => {
      await handleInstall({ plugin: './my-plugin', scope: 'user', json: true });

      const jsonOutput = stdoutWriteSpy.mock.calls
        .map((c) => c[0])
        .find((s) => typeof s === 'string' && s.includes('"ok"'));
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput as string);
      expect(parsed).toEqual({
        ok: true,
        pluginId: 'test-plugin',
        version: '1.0.0',
        path: '/tmp/plugins/test-plugin',
      });
    });

    it('suppresses progress message', async () => {
      await handleInstall({ plugin: './my-plugin', scope: 'user', json: true });

      const allWrites = stdoutWriteSpy.mock.calls.map((c) => String(c[0]));
      expect(allWrites.some((w) => w.includes('Installing plugin'))).toBe(
        false,
      );
    });

    it('outputs structured JSON error on failure', async () => {
      sharedMocks.installPluginForCommand.mockRejectedValueOnce(
        new Error('Plugin directory not found'),
      );
      sharedMocks.inferPluginErrorCode.mockReturnValueOnce('plugin_not_found');

      await handleInstall({ plugin: 'nonexistent', scope: 'user', json: true });

      const jsonOutput = stdoutWriteSpy.mock.calls
        .map((c) => c[0])
        .find((s) => typeof s === 'string' && s.includes('"error"'));
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput as string);
      expect(parsed).toEqual({
        error: true,
        code: 'plugin_not_found',
        message: 'Plugin directory not found',
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('sets exit context on error', async () => {
      const err = new Error('manifest invalid');
      err.name = 'PluginManifestError';
      sharedMocks.installPluginForCommand.mockRejectedValueOnce(err);

      await handleInstall({ plugin: './bad-plugin', scope: 'user', json: true });

      expect(coreMocks.sessionLogger.setExitContext).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'fatal_error',
          exit_code: 1,
          source: 'plugins.install',
          error_name: 'PluginManifestError',
        }),
      );
    });
  });

  it('accepts non-user scope', async () => {
    await handleInstall({ plugin: './my-plugin', scope: 'project', json: true });

    expect(sharedMocks.installPluginForCommand).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project' }),
    );
  });

  describe('non-json mode (default)', () => {
    it('shows progress message before install', async () => {
      await handleInstall({ plugin: './my-plugin', scope: 'user' });

      const allWrites = stdoutWriteSpy.mock.calls.map((c) => String(c[0]));
      expect(
        allWrites.some((w) => w.includes('Installing plugin "./my-plugin"')),
      ).toBe(true);
    });

    it('writes success message to stdout', async () => {
      await handleInstall({ plugin: './my-plugin', scope: 'user' });

      expect(sharedMocks.installPluginForCommand).toHaveBeenCalled();
      const allWrites = stdoutWriteSpy.mock.calls.map((c) => String(c[0]));
      expect(allWrites.some((w) => w.includes('Plugin installed'))).toBe(true);
      expect(allWrites.some((w) => w.includes('/plugins reload'))).toBe(false);
    });

    it('writes error to stderr on failure', async () => {
      sharedMocks.installPluginForCommand.mockRejectedValueOnce(
        new Error('something broke'),
      );

      await handleInstall({ plugin: './bad', scope: 'user' });

      const errWrites = stderrWriteSpy.mock.calls.map((c) => String(c[0]));
      expect(errWrites.some((w) => w.includes('something broke'))).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
