/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetSelection = vi.hoisted(() => vi.fn());
const mockDaemonClient = vi.hoisted(() =>
  vi.fn(() => ({ setChannelWorkerSelection: mockSetSelection })),
);
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/sdk/daemon', () => ({ DaemonClient: mockDaemonClient }));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

import { setCommand } from './set.js';

async function runHandler(argv: Record<string, unknown>): Promise<void> {
  if (!setCommand.handler) throw new Error('set handler missing');
  await setCommand.handler({ _: [], $0: 'qwen', ...argv } as never);
}

describe('channel set command', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.unstubAllEnvs();
    vi.stubEnv('QWEN_DAEMON_URL', undefined);
    vi.stubEnv('QWEN_SERVER_TOKEN', undefined);
    vi.stubEnv('QWEN_DAEMON_TOKEN', undefined);
    mockSetSelection.mockResolvedValue({
      changed: true,
      replaced: false,
      partial: false,
      state: { transition: 'idle', workers: [] },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('trims and deduplicates names while preserving first occurrence order', async () => {
    await runHandler({
      names: [' discord ', 'telegram', 'discord'],
      'daemon-url': 'http://daemon:9',
      token: 'secret',
      timeout: 1234,
    });

    expect(mockDaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://daemon:9',
      token: 'secret',
    });
    expect(mockSetSelection).toHaveBeenCalledWith(
      { mode: 'names', names: ['discord', 'telegram'] },
      { timeoutMs: 1234 },
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('accepts all by itself and uses daemon environment defaults', async () => {
    vi.stubEnv('QWEN_DAEMON_URL', 'http://env-daemon:7');
    vi.stubEnv('QWEN_DAEMON_TOKEN', 'env-secret');

    await runHandler({ names: ['all'] });

    expect(mockDaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://env-daemon:7',
      token: 'env-secret',
    });
    expect(mockSetSelection).toHaveBeenCalledWith({ mode: 'all' }, undefined);
  });

  it('rejects all mixed with named channels before loading the SDK', async () => {
    await runHandler({ names: ['all', 'telegram'] });

    expect(mockDaemonClient).not.toHaveBeenCalled();
    expect(mockSetSelection).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('all'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('prints remote errors and exits non-zero', async () => {
    mockSetSelection.mockRejectedValueOnce(new Error('start failed'));

    await runHandler({ names: ['telegram'] });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('start failed'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
