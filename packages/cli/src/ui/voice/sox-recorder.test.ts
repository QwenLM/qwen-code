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
  decodeCalls: [] as Buffer[],
}));

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  return {
    ...actual,
    default: { ...actual, spawn: mocks.spawn },
    spawn: mocks.spawn,
  };
});

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

vi.mock('@qwen-code/qwen-code-core', () => ({
  // Encoding-aware decode so the suite can distinguish the recorder routing
  // sox stderr through decodeProcessOutput from a naive chunk.toString()
  // (which yields U+FFFD for these bytes). Valid UTF-8 (ASCII, or a UTF-8
  // multi-byte sequence) decodes as utf-8; anything else decodes as the
  // cp866 system code page. This mirrors shellExecutionService.test.ts.
  decodeProcessOutput: (buffer: Buffer | string) => {
    if (!Buffer.isBuffer(buffer)) return String(buffer);
    if (buffer.length === 0) return '';
    mocks.decodeCalls.push(buffer);
    const strict = new TextDecoder('utf-8', { fatal: true });
    const isUtf8 = (() => {
      try {
        strict.decode(buffer);
        return true;
      } catch {
        return false;
      }
    })();
    return new TextDecoder(isUtf8 ? 'utf-8' : 'cp866').decode(buffer);
  },
}));

import { createSoxRecorder } from './sox-recorder.js';

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
    mocks.decodeCalls.length = 0;
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

  it('decodes non-UTF-8 sox stderr via decodeProcessOutput (not toString)', async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    mocks.mkdtemp.mockResolvedValue('/tmp/qwen-voice-abc');

    const recorder = createSoxRecorder();
    await startRecorder(recorder);
    // CP-866 bytes for "Ошибка". A naive chunk.toString() (utf-8) would
    // garble these into U+FFFD; decodeProcessOutput must decode them to the
    // Cyrillic text. This gates the OEM-code-page stderr decode change —
    // reverting sox-recorder.ts to chunk.toString() fails this test.
    child.stderr.emit(
      'data',
      Buffer.from([0x8e, 0xe8, 0xa8, 0xa1, 0xaa, 0xa0]),
    );
    child.emit('close', 2);

    await expect(recorder.stop()).rejects.toThrow(
      'Voice recorder failed with exit code 2: Ошибка.',
    );
  });

  it('decodes a UTF-8 multi-byte sequence split across data chunks', async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    mocks.mkdtemp.mockResolvedValue('/tmp/qwen-voice-abc');

    const recorder = createSoxRecorder();
    await startRecorder(recorder);
    // A UTF-8 file path whose 2-byte Cyrillic char straddles two OS pipe
    // reads (e.g. a SoX error message). Per-chunk decodeProcessOutput would
    // decode each fragment independently — the split 0xD1 0x84|0x... byte is
    // not valid UTF-8, so it would be decoded through the cp866 system code
    // page as silent Cyrillic mojibake. The recorder must buffer the chunks
    // and decode once, on the complete buffer.
    const text = Buffer.from('файл not found', 'utf-8');
    child.stderr.emit('data', text.subarray(0, 3));
    child.stderr.emit('data', text.subarray(3));
    child.emit('close', 2);

    await expect(recorder.stop()).rejects.toThrow(
      'Voice recorder failed with exit code 2: файл not found.',
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

  it('bounds raw stderr accumulation while sox writes continuously', async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    mocks.mkdtemp.mockResolvedValue('/tmp/qwen-voice-abc');

    const recorder = createSoxRecorder();
    await startRecorder(recorder);
    // A chatty sox session (repeated ALSA xrun/device warnings) far exceeds
    // the decode cap. The raw buffer handed to decodeProcessOutput on close
    // must be bounded — reverting to an unconditional push retains every byte.
    for (let i = 0; i < 100; i++) {
      child.stderr.emit('data', Buffer.from('x'.repeat(1024)));
    }
    child.emit('close', 2);

    const decoded = mocks.decodeCalls.at(-1);
    expect(decoded).toBeDefined();
    // 100 KiB emitted, but the retained raw buffer is capped (4x the 4 KiB
    // decoded cap, headroom for a multi-byte char split at the cap) — not the
    // full stream.
    expect(decoded!.length).toBeLessThan(100 * 1024);
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
