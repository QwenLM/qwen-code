/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { approveCommand } from './approve.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockSetValue = vi.hoisted(() => vi.fn());

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

vi.mock('../../config/settings.js', async () => {
  const actual = await vi.importActual('../../config/settings.js');
  return {
    ...actual,
    loadSettings: vi.fn(),
  };
});

const mockedLoadSettings = vi.mocked(loadSettings);

describe('mcp approve command', () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.resetAllMocks();
    process.exitCode = undefined;
    mockedLoadSettings.mockReturnValue({
      merged: { mcpServers: {} },
      forScope: () => ({ settings: { mcpServers: {} } }),
      setValue: mockSetValue,
    } as never);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('copies a pending project server into user settings without project metadata or sensitive fields', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-mcp-approve-'));
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          project: {
            command: 'node',
            args: ['server.js'],
            env: { SECRET: 'project' },
            cwd: '/tmp/project',
            headers: { Authorization: 'Bearer token' },
            trust: true,
            timeout: 1000,
            discoveryTimeoutMs: 2000,
          },
        },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    await yargs([]).command(approveCommand).parseAsync('approve project');

    expect(mockSetValue).toHaveBeenCalledWith(SettingScope.User, 'mcpServers', {
      project: {
        command: 'node',
        args: ['server.js'],
        timeout: 1000,
        discoveryTimeoutMs: 2000,
      },
    });
    const saved = mockSetValue.mock.calls[0][2].project;
    expect(saved).not.toHaveProperty('source');
    expect(saved).not.toHaveProperty('pendingApproval');
    expect(saved).not.toHaveProperty('projectConfigPath');
    expect(saved).not.toHaveProperty('env');
    expect(saved).not.toHaveProperty('cwd');
    expect(saved).not.toHaveProperty('headers');
    expect(saved).not.toHaveProperty('trust');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Approved MCP server "project".',
    );
  });

  it('does not overwrite an existing user settings server with project config', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-mcp-approve-'));
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          existing: {
            command: 'node',
            args: ['project.js'],
          },
        },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcpServers: {
          existing: {
            command: 'node',
            args: ['trusted.js'],
          },
        },
      },
      forScope: () => ({
        settings: {
          mcpServers: {
            existing: {
              command: 'node',
              args: ['trusted.js'],
            },
          },
        },
      }),
      setValue: mockSetValue,
    } as never);

    await yargs([]).command(approveCommand).parseAsync('approve existing');

    expect(mockSetValue).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('does not approve when any merged settings scope already defines the server', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-mcp-approve-'));
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          existing: {
            command: 'node',
            args: ['project.js'],
          },
        },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcpServers: {
          existing: {
            command: 'node',
            args: ['settings.js'],
          },
        },
      },
      forScope: () => ({ settings: { mcpServers: {} } }),
      setValue: mockSetValue,
    } as never);

    await yargs([]).command(approveCommand).parseAsync('approve existing');

    expect(mockSetValue).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero when the pending project server is not found', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-mcp-approve-'));
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({}));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    await yargs([]).command(approveCommand).parseAsync('approve missing');

    expect(mockSetValue).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Pending project MCP server "missing" not found.',
    );
    expect(process.exitCode).toBe(1);
  });
});
