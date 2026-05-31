/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import { loadSettings } from '../../config/settings.js';
import { getCommand } from './get.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(),
}));

vi.mock('../../config/trustedFolders.js', () => ({
  isWorkspaceTrusted: vi.fn(() => true),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    ExtensionManager: vi.fn(() => ({
      refreshCache: vi.fn().mockResolvedValue(undefined),
      getLoadedExtensions: vi.fn().mockReturnValue([]),
    })),
  };
});

const mockedLoadSettings = vi.mocked(loadSettings);

describe('mcp get command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedLoadSettings.mockReturnValue({ merged: { mcpServers: {} } } as never);
  });

  it('shows pending project-scoped server config without connecting', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-mcp-get-'));
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          project: {
            command: 'node',
            args: ['server.js'],
          },
        },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    await yargs([]).command(getCommand).parseAsync('get project');

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'project - Pending approval',
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('"command": "node"'),
    );
    const output = JSON.parse(mockWriteStdoutLine.mock.calls[1][0]);
    expect(output).toEqual({
      command: 'node',
      args: ['server.js'],
    });
    expect(output).not.toHaveProperty('source');
    expect(output).not.toHaveProperty('pendingApproval');
    expect(output).not.toHaveProperty('projectConfigPath');
  });

  it('shows configured settings server config', async () => {
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcpServers: {
          configured: {
            command: 'node',
            args: ['settings.js'],
          },
        },
      },
    } as never);

    await yargs([]).command(getCommand).parseAsync('get configured');

    expect(mockWriteStdoutLine).toHaveBeenCalledWith('configured - Configured');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      JSON.stringify(
        {
          command: 'node',
          args: ['settings.js'],
        },
        null,
        2,
      ),
    );
  });
});
