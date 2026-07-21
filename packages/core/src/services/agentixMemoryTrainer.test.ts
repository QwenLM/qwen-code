/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const readSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('./agentixMemoryContext.js', () => ({
  readAgentixMemorySnapshot: readSnapshotMock,
}));

import {
  isAgentixAutoTrainingEnabled,
  refreshAgentixMemory,
} from './agentixMemoryTrainer.js';

describe('Agentix memory trainer', () => {
  beforeEach(() => {
    vi.stubEnv('QWEN_AGENTIX_AUTO_TRAIN', '1');
    vi.stubEnv('QWEN_AGENTIX_BINARY', '/test/qwen-agentix');
    vi.stubEnv('QWEN_AGENTIX_EXTRACT_SCRIPT', '/test/extract-qwen.js');
    execFileMock.mockImplementation(
      (
        _binary: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null) => void,
      ) => callback(null),
    );
    readSnapshotMock.mockReturnValue('Updated memory snapshot.');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('runs only the documented Agentix CLI commands in order', async () => {
    await expect(refreshAgentixMemory('session-1')).resolves.toBe(
      'Updated memory snapshot.',
    );

    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      ['/test/extract-qwen.js'],
      ['train'],
      ['snapshot'],
    ]);
    expect(execFileMock.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(execFileMock.mock.calls.slice(1).map((call) => call[0])).toEqual([
      '/test/qwen-agentix',
      '/test/qwen-agentix',
    ]);
  });

  it('coalesces concurrent refreshes for the same session only', async () => {
    await Promise.all([
      refreshAgentixMemory('session-1'),
      refreshAgentixMemory('session-1'),
    ]);

    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(
      execFileMock.mock.calls.filter((call) => call[0] === process.execPath),
    ).toHaveLength(1);
    expect(
      execFileMock.mock.calls.filter(
        (call) => call[0] === '/test/qwen-agentix',
      ),
    ).toHaveLength(2);
  });

  it('keeps concurrent refreshes isolated across sessions', async () => {
    await Promise.all([
      refreshAgentixMemory('session-1'),
      refreshAgentixMemory('session-2'),
    ]);

    expect(execFileMock).toHaveBeenCalledTimes(6);
    expect(
      execFileMock.mock.calls.filter((call) => call[0] === process.execPath),
    ).toHaveLength(2);
    expect(
      execFileMock.mock.calls.filter(
        (call) => call[0] === '/test/qwen-agentix',
      ),
    ).toHaveLength(4);
  });

  it('is disabled unless explicitly enabled by the launcher', () => {
    expect(isAgentixAutoTrainingEnabled()).toBe(true);
    vi.stubEnv('QWEN_AGENTIX_AUTO_TRAIN', '0');
    expect(isAgentixAutoTrainingEnabled()).toBe(false);
  });
});
