/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type MockInstance,
} from 'vitest';
import { disableCommand, handleDisable } from './disable.js';
import yargs from 'yargs';
import { SettingScope } from '../../config/settings.js';

const mockDisableExtension = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    disableExtension: mockDisableExtension,
  }),
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
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
  let consoleLogSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  let processExitSpy: MockInstance;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    vi.clearAllMocks();
  });

  it('should disable an extension with user scope', async () => {
    await handleDisable({
      name: 'test-extension',
      scope: 'user',
    });

    expect(mockDisableExtension).toHaveBeenCalledWith(
      'test-extension',
      SettingScope.User,
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "test-extension" successfully disabled for scope "user".',
    );
  });

  it('should disable an extension with workspace scope', async () => {
    await handleDisable({
      name: 'test-extension',
      scope: 'workspace',
    });

    expect(mockDisableExtension).toHaveBeenCalledWith(
      'test-extension',
      SettingScope.Workspace,
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "test-extension" successfully disabled for scope "workspace".',
    );
  });

  it('should default to user scope when no scope is provided', async () => {
    await handleDisable({
      name: 'test-extension',
    });

    expect(mockDisableExtension).toHaveBeenCalledWith(
      'test-extension',
      SettingScope.User,
    );
  });

  it('should handle errors and exit with code 1', async () => {
    mockDisableExtension.mockImplementationOnce(() => {
      throw new Error('Disable failed');
    });

    await handleDisable({
      name: 'test-extension',
      scope: 'user',
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('Disable failed');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
