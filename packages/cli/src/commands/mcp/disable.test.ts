/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import yargs from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { disableCommand } from './disable.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

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

const mockedLoadSettings = loadSettings as vi.Mock;

describe('mcp disable command', () => {
  let parser: yargs.Argv;
  let mockSetValue: vi.Mock;
  let mockSettings: Record<string, unknown>;

  beforeEach(() => {
    vi.resetAllMocks();
    const yargsInstance = yargs([]).command(disableCommand);
    parser = yargsInstance;
    mockSetValue = vi.fn();
    mockSettings = {
      mcp: {
        excluded: ['other-server'],
      },
    };
    mockedLoadSettings.mockReturnValue({
      forScope: () => ({ settings: mockSettings }),
      setValue: mockSetValue,
    });
    mockWriteStdoutLine.mockClear();
  });

  it('should disable a server in user settings by default', async () => {
    await parser.parseAsync('disable test-server');

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.User,
      'mcp.excluded',
      ['other-server', 'test-server'],
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Server "test-server" disabled in user settings.',
    );
  });

  it('should disable a server in project settings when --scope project is provided', async () => {
    await parser.parseAsync('disable test-server --scope project');

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'mcp.excluded',
      ['other-server', 'test-server'],
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Server "test-server" disabled in project settings.',
    );
  });

  it('should be a no-op if server is already disabled', async () => {
    await parser.parseAsync('disable other-server');

    expect(mockSetValue).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Server "other-server" is already disabled in user settings.',
    );
  });
});
