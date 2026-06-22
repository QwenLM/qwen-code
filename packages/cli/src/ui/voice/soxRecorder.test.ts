/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  default: { spawn: mocks.spawn },
  spawn: mocks.spawn,
}));

vi.mock('node:fs/promises', () => ({
  default: {
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
  },
  mkdtemp: mocks.mkdtemp,
  readFile: mocks.readFile,
  rm: mocks.rm,
}));

import { createSoxRecorder } from './soxRecorder.js';

class FakeChildProcess extends EventEmitter {
  stderr = new EventEmitter();
  kill = vi.fn();
}

async function startRecorder(recorder: ReturnType<typeof createSoxRecorder>) {
  const startPromise = Promise.resolve(recorder.start());
  await Promise.resolve();
  const child = mocks.spawn.mock.results.at(-1)?.value as FakeChildProcess;
  child.emit('spawn');
  await startPromise;
  return child;
}

describe('createSoxRecorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records mono 16k wav audio with sox and returns the file bytes', async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    mocks.mkdtemp.mockResolvedValue('/tmp/qwen-voice-abc');
    mocks.readFile.mockResolvedValue(Buffer.from([1, 2, 3]));

    const recorder = createSoxRecorder();
    await startRecorder(recorder);

    expect(mocks.spawn).toHaveBeenCalledWith('sox', [
      '-d',
      '-r',
      '16000',
      '-c',
      '1',
      '-b',
      '16',
      path.join('/tmp/qwen-voice-abc', 'recording.wav'),
    ]);
    const stopPromise = recorder.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    child.emit('close', 0);

    await expect(stopPromise).resolves.toEqual({
      data: Buffer.from([1, 2, 3]),
      mimeType: 'audio/wav',
    });
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/qwen-voice-abc', {
      recursive: true,
      force: true,
    });
  });

  it('rejects promptly when sox closed before stop is requested', async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    mocks.mkdtemp.mockResolvedValue('/tmp/qwen-voice-abc');

    const recorder = createSoxRecorder();
    await startRecorder(recorder);
    child.emit('close', 1);

    const stopResult = Promise.race([
      recorder.stop().then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof Error ? `rejected:${error.message}` : 'rejected',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ]);

    await expect(stopResult).resolves.toMatch(/^rejected:/);
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/qwen-voice-abc', {
      recursive: true,
      force: true,
    });
  });

  it('includes sox stderr when recording fails', async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    mocks.mkdtemp.mockResolvedValue('/tmp/qwen-voice-abc');

    const recorder = createSoxRecorder();
    await startRecorder(recorder);
    child.stderr.emit('data', Buffer.from('permission denied\n'));
    child.emit('close', 2);

    await expect(recorder.stop()).rejects.toThrow(
      'Voice recorder failed with exit code 2: permission denied.',
    );
  });

  it('caps captured sox stderr used in failure messages', async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    mocks.mkdtemp.mockResolvedValue('/tmp/qwen-voice-abc');

    const recorder = createSoxRecorder();
    await startRecorder(recorder);
    child.stderr.emit('data', Buffer.from('x'.repeat(5000)));
    child.emit('close', 2);

    await expect(recorder.stop()).rejects.toThrow(
      `Voice recorder failed with exit code 2: ${'x'.repeat(4096)}.`,
    );
  });

  it('explains how to fix a missing sox executable', async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    mocks.mkdtemp.mockResolvedValue('/tmp/qwen-voice-abc');

    const recorder = createSoxRecorder();
    const startPromise = Promise.resolve(recorder.start());
    const startResult = startPromise.then(
      () => 'resolved',
      (error: unknown) =>
        error instanceof Error ? `rejected:${error.message}` : 'rejected',
    );
    await Promise.resolve();
    const error = Object.assign(new Error('spawn sox ENOENT'), {
      code: 'ENOENT',
    });
    child.emit('error', error);

    await expect(startResult).resolves.toBe(
      'rejected:SoX is not installed or not on PATH. Install SoX and try again.',
    );
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/qwen-voice-abc', {
      recursive: true,
      force: true,
    });
  });
});
