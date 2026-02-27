/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import yargs from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { enableCommand } from './enable.js';

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

describe('mcp enable command', () => {
  let parser: yargs.Argv;
  let mockSetValue: vi.Mock;
  let mockSettings: Record<string, unknown>;

  beforeEach(() => {
    vi.resetAllMocks();
    const yargsInstance = yargs([]).command(enableCommand);
    parser = yargsInstance;
    mockSetValue = vi.fn();
    mockSettings = {
      mcp: {
        excluded: ['test-server', 'other-server'],
      },
    };
    mockedLoadSettings.mockReturnValue({
      forScope: () => ({ settings: mockSettings }),
      setValue: mockSetValue,
    });
    mockWriteStdoutLine.mockClear();
  });

  it('should enable a server in user settings by default', async () => {
    await parser.parseAsync('enable test-server');

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.User,
      'mcp.excluded',
      ['other-server'],
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Server "test-server" enabled in user settings.',
    );
  });

  it('should enable a server in project settings when --scope project is provided', async () => {
    await parser.parseAsync('enable test-server --scope project');

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'mcp.excluded',
      ['other-server'],
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Server "test-server" enabled in project settings.',
    );
  });

  it('should be a no-op if server is already enabled', async () => {
    await parser.parseAsync('enable missing-server');

    expect(mockSetValue).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Server "missing-server" is already enabled in user settings.',
    );
  });
});
