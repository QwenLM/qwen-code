/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import yargs from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { removeCommand } from './remove.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockDeleteCredentials = vi.hoisted(() => vi.fn());

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
  };
});

vi.mock('../../config/settings.js', async () => {
  const actual = await vi.importActual('../../config/settings.js');
  return {
    ...actual,
    loadSettings: vi.fn(),
  };
});

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    MCPOAuthTokenStorage: vi.fn(() => ({
      deleteCredentials: mockDeleteCredentials,
    })),
  };
});

const mockedLoadSettings = loadSettings as vi.Mock;

describe('mcp remove command', () => {
  let parser: yargs.Argv;
  let mockSetValue: vi.Mock;
  let mockSettings: Record<string, unknown>;

  beforeEach(() => {
    vi.resetAllMocks();
    const yargsInstance = yargs([]).command(removeCommand);
    parser = yargsInstance;
    mockSetValue = vi.fn();
    mockSettings = {
      mcpServers: {
        'test-server': {
          command: 'echo "hello"',
        },
      },
    };
    mockedLoadSettings.mockReturnValue({
      forScope: () => ({ settings: mockSettings }),
      setValue: mockSetValue,
    });
    mockWriteStdoutLine.mockClear();
    mockDeleteCredentials.mockClear();
  });

  it('should remove a server from user settings by default', async () => {
    await parser.parseAsync('remove test-server');

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.User,
      'mcpServers',
      {},
    );
  });

  it('should clean up OAuth tokens when removing a server', async () => {
    await parser.parseAsync('remove test-server');

    expect(mockDeleteCredentials).toHaveBeenCalledWith('test-server');
  });

  it('should not fail if OAuth token cleanup fails', async () => {
    mockDeleteCredentials.mockRejectedValue(new Error('cleanup failed'));

    await parser.parseAsync('remove test-server');

    // Server should still be removed from settings despite token cleanup failure
    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.User,
      'mcpServers',
      {},
    );
  });

  it('should not clean up OAuth tokens if server not found', async () => {
    await parser.parseAsync('remove non-existent-server');

    expect(mockSetValue).not.toHaveBeenCalled();
    expect(mockDeleteCredentials).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Server "non-existent-server" not found in user settings.',
    );
  });
});
