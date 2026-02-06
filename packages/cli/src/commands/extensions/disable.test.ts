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

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    disableExtension: mockDisableExtension,
  }),
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

describe('extensions disable command', () => {
  it('should fail if no name is provided', () => {
    const validationParser = yargs([])
      .command(disableCommand)
      .fail(false)
      .locale('en');
    expect(() => validationParser.parse('disable')).toThrow(
      'Not enough non-option arguments: got 0, need at least 1',
    );
  });

  it('should fail if invalid scope is provided', () => {
    const validationParser = yargs([])
      .command(disableCommand)
      .fail(false)
      .locale('en');
    expect(() =>
      validationParser.parse('disable test-extension --scope=invalid'),
    ).toThrow(/Invalid scope: invalid/);
  });

  it('should accept valid scope values', () => {
    const parser = yargs([]).command(disableCommand).fail(false).locale('en');
    // Just check that the scope option is recognized, actual execution needs name first
    expect(() =>
      parser.parse('disable my-extension --scope=user'),
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

  it('should handle errors and exit with code 1', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockDisableExtension.mockImplementationOnce(() => {
      throw new Error('Disable failed');
    });

    await handleDisable({
      name: 'test-extension',
      scope: 'user',
    });

    expect(mockWriteStderrLine).toHaveBeenCalledWith('Disable failed');
    expect(processExitSpy).toHaveBeenCalledWith(1);

    processExitSpy.mockRestore();
  });
});
