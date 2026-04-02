/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';

const mockSpawn = vi.fn();
const mockExecSync = vi.fn();

vi.mock('node:child_process', () => ({
  default: { spawn: mockSpawn, execSync: mockExecSync },
  spawn: mockSpawn,
  execSync: mockExecSync,
}));

// Import the module AFTER setting up mocks
const { startRecording, stopRecording, detectBackend } = await import(
  './audioCapture.js'
);

function makeMockProc(): ChildProcess {
  return {
    once: vi.fn(),
    kill: vi.fn(),
  } as unknown as ChildProcess;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectBackend', () => {
  it('returns none when no backend available', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    const result = detectBackend();
    expect(result).toBe('none');
  });

  it('returns sox when rec is available', () => {
    // First call: 'which rec' succeeds
    mockExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/rec'));
    const result = detectBackend();
    expect(result).toBe('sox');
  });
});

describe('startRecording', () => {
  it('spawns rec with correct sox args', async () => {
    const mockProc = makeMockProc();
    mockSpawn.mockReturnValue(mockProc);

    const proc = await startRecording('/tmp/test.wav', 'sox');

    expect(mockSpawn).toHaveBeenCalledWith(
      'rec',
      expect.arrayContaining([
        '-r',
        '16000',
        '-c',
        '1',
        '-e',
        'signed',
        '-b',
        '16',
        '/tmp/test.wav',
      ]),
    );
    expect(proc).toBe(mockProc);
  });

  it('spawns arecord with correct args', async () => {
    const mockProc = makeMockProc();
    mockSpawn.mockReturnValue(mockProc);

    const proc = await startRecording('/tmp/test.wav', 'arecord');

    expect(mockSpawn).toHaveBeenCalledWith(
      'arecord',
      expect.arrayContaining([
        '-r',
        '16000',
        '-c',
        '1',
        '-f',
        'S16_LE',
        '/tmp/test.wav',
      ]),
    );
    expect(proc).toBe(mockProc);
  });

  it('throws for none backend', async () => {
    await expect(startRecording('/tmp/test.wav', 'none')).rejects.toThrow(
      'No audio capture backend available',
    );
  });
});

describe('stopRecording', () => {
  it('sends SIGINT and resolves on exit', async () => {
    const mockProc = makeMockProc();
    (mockProc.once as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: () => void) => {
        if (event === 'exit') {
          setTimeout(cb, 0);
        }
      },
    );

    await stopRecording(mockProc);

    expect(mockProc.kill).toHaveBeenCalledWith('SIGINT');
  });
});
