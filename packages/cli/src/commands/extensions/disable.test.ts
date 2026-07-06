/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { disableCommand, handleDisable } from './disable.js';
import yargs from 'yargs';
import { SettingScope } from '../../config/settings.js';

const mockDisableExtension = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
  return {
    ...actual,
    getExtensionManager: vi.fn().mockResolvedValue({
      disableExtension: mockDisableExtension,
    }),
  };
});

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

describe('extensions disable command', () => {
  const parseDisableCommand = (command: string) =>
    yargs([]).command(disableCommand).fail(false).locale('en').parse(command);

  it('should fail if no name is provided', () => {
    expect(() => parseDisableCommand('disable')).toThrow(
      'Not enough non-option arguments: got 0, need at least 1',
    );
  });

  it('should fail if invalid scope is provided', () => {
    expect(() =>
      parseDisableCommand('disable test-extension --scope=invalid'),
    ).toThrow(/Invalid scope: invalid/);
  });

  it('should fail if unsupported system scopes are provided', () => {
    expect(() =>
      parseDisableCommand('disable test-extension --scope=system'),
    ).toThrow(/Invalid scope: system/);
    expect(() =>
      parseDisableCommand('disable test-extension --scope=systemdefaults'),
    ).toThrow(/Invalid scope: systemdefaults/);
  });

  it('should accept valid scope values', () => {
    // Just check that the scope option is recognized, actual execution needs name first
    expect(() =>
      parseDisableCommand('disable my-extension --scope=user'),
    ).not.toThrow();
    expect(() =>
      parseDisableCommand('disable my-extension --scope=workspace'),
    ).not.toThrow();
  });
});

describe('handleDisable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should disable an extension with user scope', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    await handleDisable({
      name: 'test-extension',
      scope: 'user',
    });

    expect(mockDisableExtension).toHaveBeenCalledWith(
      'test-extension',
      SettingScope.User,
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "test-extension" successfully disabled for scope "user".',
    );

    processExitSpy.mockRestore();
  });

  it('should disable an extension with workspace scope', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    await handleDisable({
      name: 'test-extension',
      scope: 'workspace',
    });

    expect(mockDisableExtension).toHaveBeenCalledWith(
      'test-extension',
      SettingScope.Workspace,
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "test-extension" successfully disabled for scope "workspace".',
    );

    processExitSpy.mockRestore();
  });

  it('should default to user scope when no scope is provided', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    await handleDisable({
      name: 'test-extension',
    });

    expect(mockDisableExtension).toHaveBeenCalledWith(
      'test-extension',
      SettingScope.User,
    );

    processExitSpy.mockRestore();
  });

  it('should reject unsupported system scopes without disabling at user scope', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    await handleDisable({
      name: 'test-extension',
      scope: 'system',
    });

    expect(mockDisableExtension).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringMatching(/Invalid scope: system/),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);

    processExitSpy.mockRestore();
  });

  it('should handle errors and exit with code 1', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockDisableExtension.mockRejectedValueOnce(new Error('Disable failed'));

    await handleDisable({
      name: 'test-extension',
      scope: 'user',
    });

    expect(mockWriteStderrLine).toHaveBeenCalledWith('Disable failed');
    expect(processExitSpy).toHaveBeenCalledWith(1);

    processExitSpy.mockRestore();
  });
});
