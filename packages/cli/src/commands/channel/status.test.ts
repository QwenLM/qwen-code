import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadServiceInfo = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = vi.fn(() => false);
  const readFileSync = vi.fn();
  return {
    ...actual,
    existsSync,
    readFileSync,
    default: {
      ...actual,
      existsSync,
      readFileSync,
    },
  };
});

vi.mock('./pidfile.js', () => ({
  readServiceInfo: mockReadServiceInfo,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
}));

import { statusCommand } from './status.js';

async function invokeStatus(): Promise<void> {
  const handler = statusCommand.handler;
  if (!handler) throw new Error('status handler missing');
  await handler({ _: [], $0: 'qwen' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('statusCommand', () => {
  it('shows serve ownership for daemon-managed channel workers', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      servePid: 1234,
      workerPid: 5678,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStatus()).rejects.toThrow('process.exit: 0');

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Channel service: managed by qwen serve (PID 1234)',
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('Worker PID:      5678');
  });

  it('omits worker pid when serve-owned metadata has no live worker', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      servePid: 1234,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStatus()).rejects.toThrow('process.exit: 0');

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Channel service: managed by qwen serve (PID 1234)',
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Worker PID:'),
    );
  });
});
