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
  probeMediaMetadata,
  resetFfmpegCachesForTests,
  runFfmpeg,
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

describe('probeMediaMetadata (video)', () => {
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
    await expect(probeMediaMetadata('/v.mp4', 'video')).resolves.toEqual({
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
    const result = await probeMediaMetadata('/v.mp4', 'video');
    expect(result.frameRate).toBe(25);
    expect(result.durationMs).toBeUndefined();
  });

  it('throws on non-zero ffprobe exit', async () => {
    mockExecResult(() => ({
      error: Object.assign(new Error('bad'), { code: 1 }),
      stderr: 'moov atom not found',
    }));
    await expect(probeMediaMetadata('/broken.mp4', 'video')).rejects.toThrow(
      /ffprobe failed \(exit 1\).*moov atom/s,
    );
  });

  it('throws on unparseable ffprobe output', async () => {
    mockExecResult(() => ({ stdout: 'not-json' }));
    await expect(probeMediaMetadata('/v.mp4', 'video')).rejects.toThrow(
      /unparseable output/,
    );
  });
});

describe('probeMediaMetadata per-modality branches', () => {
  it("reads the AUDIO stream (not video) for modality 'audio'", async () => {
    // A file carrying both streams proves the audio branch selects the
    // audio stream: reading videoStream?.codec_name here would yield 'h264'.
    mockExecResult(() => ({
      stdout: JSON.stringify({
        format: { format_name: 'mov,mp4', duration: '12.5' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 640, height: 480 },
          {
            codec_type: 'audio',
            codec_name: 'aac',
            sample_rate: '44100',
            channels: 2,
          },
        ],
      }),
    }));
    await expect(probeMediaMetadata('/a.m4a', 'audio')).resolves.toEqual({
      formatName: 'mov,mp4',
      durationMs: 12_500,
      codec: 'aac',
      sampleRateHz: 44_100,
      channels: 2,
    });
  });

  it('prefers the format-level bit rate and falls back to the stream', async () => {
    mockExecResult(() => ({
      stdout: JSON.stringify({
        format: { format_name: 'mp3', duration: '10', bit_rate: '320000' },
        streams: [
          { codec_type: 'audio', codec_name: 'mp3', bit_rate: '128000' },
        ],
      }),
    }));
    await expect(probeMediaMetadata('/a.mp3', 'audio')).resolves.toMatchObject({
      bitRate: 320_000,
    });

    mockExecResult(() => ({
      stdout: JSON.stringify({
        format: { format_name: 'mp3', duration: '10' },
        streams: [
          { codec_type: 'audio', codec_name: 'mp3', bit_rate: '128000' },
        ],
      }),
    }));
    await expect(probeMediaMetadata('/a.mp3', 'audio')).resolves.toMatchObject({
      bitRate: 128_000,
    });
  });

  it('reports the video bit rate for modality video', async () => {
    mockExecResult(() => ({
      stdout: JSON.stringify({
        format: { format_name: 'mp4', duration: '5', bit_rate: '2500000' },
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
      }),
    }));
    await expect(probeMediaMetadata('/v.mp4', 'video')).resolves.toMatchObject({
      bitRate: 2_500_000,
    });
  });

  it('omits bitRate/sampleRateHz/channels when unusable', async () => {
    mockExecResult(() => ({
      stdout: JSON.stringify({
        format: { format_name: 'wav', duration: '3', bit_rate: 'N/A' },
        streams: [
          {
            codec_type: 'audio',
            codec_name: 'pcm_s16le',
            sample_rate: 'N/A',
            channels: 0,
          },
        ],
      }),
    }));
    const result = await probeMediaMetadata('/a.wav', 'audio');
    expect(result.bitRate).toBeUndefined();
    expect(result.sampleRateHz).toBeUndefined();
    expect(result.channels).toBeUndefined();
  });

  it("reads only dimensions for modality 'image' (no duration)", async () => {
    mockExecResult(() => ({
      stdout: JSON.stringify({
        format: { format_name: 'png_pipe', duration: '0.04' },
        streams: [
          { codec_type: 'video', codec_name: 'png', width: 1920, height: 1080 },
        ],
      }),
    }));
    // Images must not report a duration even when ffprobe invents one.
    await expect(probeMediaMetadata('/i.png', 'image')).resolves.toEqual({
      formatName: 'png_pipe',
      width: 1920,
      height: 1080,
      codec: 'png',
    });
  });

  it('reports frameCount for animated images (nb_frames)', async () => {
    // Animated GIF/APNG/WebP report nb_frames on the video stream; the token
    // estimator needs the real count — a 300-frame GIF estimated as a single
    // frame would sail under the transport guard at ~1/300 of its real cost.
    mockExecResult(() => ({
      stdout: JSON.stringify({
        format: { format_name: 'gif' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'gif',
            width: 480,
            height: 480,
            nb_frames: '300',
          },
        ],
      }),
    }));
    await expect(probeMediaMetadata('/anim.gif', 'image')).resolves.toEqual({
      formatName: 'gif',
      width: 480,
      height: 480,
      codec: 'gif',
      frameCount: 300,
    });
  });

  it('omits frameCount when nb_frames is absent or unusable', async () => {
    for (const nb of [undefined, '0', 'N/A']) {
      mockExecResult(() => ({
        stdout: JSON.stringify({
          format: { format_name: 'webp' },
          streams: [
            {
              codec_type: 'video',
              codec_name: 'webp',
              width: 64,
              height: 64,
              ...(nb === undefined ? {} : { nb_frames: nb }),
            },
          ],
        }),
      }));
      const result = await probeMediaMetadata('/i.webp', 'image');
      expect(result.frameCount).toBeUndefined();
    }
  });

  it("audio with no audio stream yields undefined codec, not the video's", async () => {
    mockExecResult(() => ({
      stdout: JSON.stringify({
        format: { format_name: 'mp4', duration: '3' },
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
      }),
    }));
    const result = await probeMediaMetadata('/silent.mp4', 'audio');
    expect(result.codec).toBeUndefined();
  });
});

describe('runFfmpeg', () => {
  it('invokes ffmpeg with the given args and resolves code 0 on success', async () => {
    mockExecResult(() => ({ stderr: 'frame= 100' }));
    await expect(
      runFfmpeg(['-y', '-i', '/in.mov', '/out.mp4']),
    ).resolves.toEqual({
      code: 0,
      stderr: 'frame= 100',
    });
    const [command, args, options] = execFileMock.mock.calls[0];
    expect(command).toBe('ffmpeg');
    expect(args).toEqual(['-y', '-i', '/in.mov', '/out.mp4']);
    expect(options).toMatchObject({ maxBuffer: 16 * 1024 * 1024 });
    expect(options).not.toHaveProperty('timeout');
  });

  it('threads timeoutMs and signal into execFile options', async () => {
    mockExecResult(() => ({}));
    const signal = new AbortController().signal;
    await runFfmpeg(['-version'], { signal, timeoutMs: 120_000 });
    const options = execFileMock.mock.calls[0][2];
    expect(options).toMatchObject({ timeout: 120_000, signal });
  });

  it('never rejects: a failing run resolves with the exit code and stderr', async () => {
    mockExecResult(() => ({
      error: Object.assign(new Error('exit 187'), { code: 187 }),
      stderr: 'Conversion failed!',
    }));
    await expect(runFfmpeg(['-i', '/in.mov'])).resolves.toEqual({
      code: 187,
      stderr: 'Conversion failed!',
    });
  });

  it('maps a non-numeric error code (e.g. ENOENT/abort kill) to 1', async () => {
    mockExecResult(() => ({
      error: Object.assign(new Error('spawn ffmpeg ENOENT'), {
        code: 'ENOENT',
      }),
    }));
    await expect(runFfmpeg(['-version'])).resolves.toEqual({
      code: 1,
      stderr: '',
    });
  });
});
