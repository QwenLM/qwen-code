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
import { enableCommand, handleEnable } from './enable.js';
import yargs from 'yargs';
import { SettingScope } from '../../config/settings.js';

const mockEnableExtension = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    enableExtension: mockEnableExtension,
  }),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    FatalConfigError: class FatalConfigError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'FatalConfigError';
      }
    },
    getErrorMessage: (error: Error) => error.message,
  };
});

describe('extensions enable command', () => {
  it('should fail if no name is provided', () => {
    const validationParser = yargs([])
      .command(enableCommand)
      .fail(false)
      .locale('en');
    expect(() => validationParser.parse('enable')).toThrow(
      'Not enough non-option arguments: got 0, need at least 1',
    );
  });

  it('should fail if invalid scope is provided', () => {
    const validationParser = yargs([])
      .command(enableCommand)
      .fail(false)
      .locale('en');
    expect(() =>
      validationParser.parse('enable test-extension --scope=invalid'),
    ).toThrow(/Invalid scope: invalid/);
  });

  it('should accept valid scope values', () => {
    const parser = yargs([]).command(enableCommand).fail(false).locale('en');
    // Just check that the scope option is recognized, actual execution needs name first
    expect(() =>
      parser.parse('enable my-extension --scope=user'),
    ).not.toThrow();
  });
});

describe('handleEnable', () => {
  let consoleLogSpy: MockInstance;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  it('should enable an extension with user scope', async () => {
    await handleEnable({
      name: 'test-extension',
      scope: 'user',
    });

    expect(mockEnableExtension).toHaveBeenCalledWith(
      'test-extension',
      SettingScope.User,
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "test-extension" successfully enabled for scope "user".',
    );
  });

  it('should enable an extension with workspace scope', async () => {
    await handleEnable({
      name: 'test-extension',
      scope: 'workspace',
    });

    expect(mockEnableExtension).toHaveBeenCalledWith(
      'test-extension',
      SettingScope.Workspace,
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "test-extension" successfully enabled for scope "workspace".',
    );
  });

  it('should default to user scope when no scope is provided', async () => {
    await handleEnable({
      name: 'test-extension',
    });

    expect(mockEnableExtension).toHaveBeenCalledWith(
      'test-extension',
      SettingScope.User,
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "test-extension" successfully enabled in all scopes.',
    );
  });

  it('should throw FatalConfigError when enable fails', async () => {
    mockEnableExtension.mockImplementationOnce(() => {
      throw new Error('Enable failed');
    });

    await expect(
      handleEnable({
        name: 'test-extension',
        scope: 'user',
      }),
    ).rejects.toThrow('Enable failed');
  });
});
