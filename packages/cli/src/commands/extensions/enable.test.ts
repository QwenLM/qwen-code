/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enableCommand, handleEnable } from './enable.js';
import yargs from 'yargs';
import { SettingScope } from '../../config/settings.js';

const mockEnableExtension = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
  return {
    ...actual,
    getExtensionManager: vi.fn().mockResolvedValue({
      enableExtension: mockEnableExtension,
    }),
  };
});

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

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: vi.fn(),
  clearScreen: vi.fn(),
}));

describe('extensions enable command', () => {
  const parseEnableCommand = (command: string) =>
    yargs([]).command(enableCommand).fail(false).locale('en').parse(command);

  it('should fail if no name is provided', () => {
    expect(() => parseEnableCommand('enable')).toThrow(
      'Not enough non-option arguments: got 0, need at least 1',
    );
  });

  it('should fail if invalid scope is provided', () => {
    expect(() =>
      parseEnableCommand('enable test-extension --scope=invalid'),
    ).toThrow(/Invalid scope: invalid/);
  });

  it('should fail if unsupported system scopes are provided', () => {
    expect(() =>
      parseEnableCommand('enable test-extension --scope=system'),
    ).toThrow(/Invalid scope: system/);
    expect(() =>
      parseEnableCommand('enable test-extension --scope=systemdefaults'),
    ).toThrow(/Invalid scope: systemdefaults/);
  });

  it('should accept valid scope values', () => {
    // Just check that the scope option is recognized, actual execution needs name first
    expect(() =>
      parseEnableCommand('enable my-extension --scope=user'),
    ).not.toThrow();
    expect(() =>
      parseEnableCommand('enable my-extension --scope=workspace'),
    ).not.toThrow();
  });
});

describe('handleEnable', () => {
  beforeEach(() => {
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
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
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
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
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
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "test-extension" successfully enabled in all scopes.',
    );
  });

  it('should reject unsupported system scopes without enabling at user scope', async () => {
    await expect(
      handleEnable({
        name: 'test-extension',
        scope: 'system',
      }),
    ).rejects.toThrow(/Invalid scope: system/);

    expect(mockEnableExtension).not.toHaveBeenCalled();
  });

  it('should throw FatalConfigError when enable fails', async () => {
    mockEnableExtension.mockRejectedValueOnce(new Error('Enable failed'));

    await expect(
      handleEnable({
        name: 'test-extension',
        scope: 'user',
      }),
    ).rejects.toThrow('Enable failed');
  });
});
