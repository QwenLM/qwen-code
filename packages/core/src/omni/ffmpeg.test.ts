/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import {
  assertOmniRuntimeDependencies,
  isFfmpegAvailable,
  isFfprobeAvailable,
  probeVideoMetadata,
  resetFfmpegCachesForTests,
} from './ffmpeg.js';

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

function mockExecResult(
  handler: (
    command: string,
    args: string[],
  ) => {
    error?: Error & { code?: number | string };
    stdout?: string;
    stderr?: string;
  },
): void {
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback: ExecCallback,
    ) => {
      const result = handler(command, args);
      callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
    },
  );
}

beforeEach(() => {
  resetFfmpegCachesForTests();
  execFileMock.mockReset();
});

afterEach(() => {
  resetFfmpegCachesForTests();
});

describe('availability checks', () => {
  it('returns true when the binary exits 0 and caches the result', async () => {
    mockExecResult(() => ({ stdout: 'ffmpeg version 7' }));
    await expect(isFfmpegAvailable()).resolves.toBe(true);
    await expect(isFfmpegAvailable()).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('returns false when the binary is missing', async () => {
    mockExecResult(() => ({
      error: Object.assign(new Error('spawn ffprobe ENOENT'), {
        code: 'ENOENT',
      }),
    }));
    await expect(isFfprobeAvailable()).resolves.toBe(false);
  });

  it('shares one probe among concurrent callers', async () => {
    mockExecResult(() => ({ stdout: 'ok' }));
    const results = await Promise.all([
      isFfmpegAvailable(),
      isFfmpegAvailable(),
      isFfmpegAvailable(),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe('assertOmniRuntimeDependencies', () => {
  it('passes when both binaries are present', async () => {
    mockExecResult(() => ({ stdout: 'ok' }));
    await expect(assertOmniRuntimeDependencies()).resolves.toBeUndefined();
  });

  it('throws an actionable FatalConfigError naming the missing binary', async () => {
    mockExecResult((command) =>
      command === 'ffmpeg'
        ? { stdout: 'ok' }
        : {
            error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
          },
    );
    await expect(assertOmniRuntimeDependencies()).rejects.toThrow(
      /ffprobe was not found on PATH.*brew install ffmpeg/s,
    );
  });

  it('names both binaries when neither is present', async () => {
    mockExecResult(() => ({
      error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    }));
    await expect(assertOmniRuntimeDependencies()).rejects.toThrow(
      /ffmpeg and ffprobe was not found/,
    );
  });
});

describe('probeVideoMetadata', () => {
  it('parses format and first-video-stream fields', async () => {
    mockExecResult((command) => {
      expect(command).toBe('ffprobe');
      return {
        stdout: JSON.stringify({
          format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '5.5' },
          streams: [
            { codec_type: 'audio', codec_name: 'aac' },
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 1280,
              height: 720,
              avg_frame_rate: '30000/1001',
            },
          ],
        }),
      };
    });
    await expect(probeVideoMetadata('/v.mp4')).resolves.toEqual({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationMs: 5500,
      width: 1280,
      height: 720,
      frameRate: 30000 / 1001,
      codec: 'h264',
    });
  });

  it('falls back to r_frame_rate when avg is 0/0', async () => {
    mockExecResult(() => ({
      stdout: JSON.stringify({
        format: {},
        streams: [
          {
            codec_type: 'video',
            avg_frame_rate: '0/0',
            r_frame_rate: '25/1',
          },
        ],
      }),
    }));
    const result = await probeVideoMetadata('/v.mp4');
    expect(result.frameRate).toBe(25);
    expect(result.durationMs).toBeUndefined();
  });

  it('throws on non-zero ffprobe exit', async () => {
    mockExecResult(() => ({
      error: Object.assign(new Error('bad'), { code: 1 }),
      stderr: 'moov atom not found',
    }));
    await expect(probeVideoMetadata('/broken.mp4')).rejects.toThrow(
      /ffprobe failed \(exit 1\).*moov atom/s,
    );
  });

  it('throws on unparseable ffprobe output', async () => {
    mockExecResult(() => ({ stdout: 'not-json' }));
    await expect(probeVideoMetadata('/v.mp4')).rejects.toThrow(
      /unparseable output/,
    );
  });
});
