/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaProbeResult } from '../../ffmpeg.js';
import type { ToolResult } from '../../../tools/tools.js';
import { DEFAULT_POLICY_TOOL_TIMEOUT_MS } from './media-policy-tool.js';
import {
  EXTRACT_KEYFRAMES_DEFAULTS,
  OMNI_EXTRACT_KEYFRAMES_TOOL_NAME,
  OmniExtractKeyframesTool,
  parseShowinfoTimestamps,
} from './extract-keyframes.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

const FRAME_SIZE = 42 * 1024;

/** Realistic showinfo stderr lines, one per kept frame. */
const showinfoStderr = (times: number[]): string =>
  times
    .map(
      (t, i) =>
        `[Parsed_showinfo_2 @ 0x600] n:${String(i).padStart(4, ' ')} pts:  ${Math.round(t * 12800)} pts_time:${t}    pos: 99 fmt:yuvj420p`,
    )
    .join('\n');

describe('OmniExtractKeyframesTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;

  const tool = new OmniExtractKeyframesTool({});

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  /** One ffmpeg run: writes `count` frames from the output arg (a
   * `%04d` pattern on the legacy path, a literal filename on the
   * bucketed path — replace() is a no-op there) and emits matching
   * showinfo stderr. */
  const framesRun =
    (count: number, times: number[]) =>
    async (args: string[]): Promise<{ code: number; stderr: string }> => {
      const pattern = args[args.length - 1];
      for (let i = 1; i <= count; i++) {
        await fs.writeFile(
          pattern.replace('%04d', String(i).padStart(4, '0')),
          Buffer.alloc(FRAME_SIZE),
        );
      }
      return { code: 0, stderr: showinfoStderr(times) };
    };

  /** One ffmpeg run that exits cleanly but produces NO output file —
   * a bucket window with no scene change above the threshold. */
  const noFrameRun = async (): Promise<{ code: number; stderr: string }> => ({
    code: 0,
    stderr: '',
  });

  const run = async (
    params: Record<string, unknown> = {},
  ): Promise<{ result: ToolResult; signal: AbortSignal }> => {
    const invocation = tool.build({
      inputPath,
      outputDir,
      ...params,
    } as never);
    const signal = new AbortController().signal;
    return { result: await invocation.execute(signal), signal };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-kf-'));
    inputPath = path.join(root, 'clip.mp4');
    await fs.writeFile(inputPath, Buffer.alloc(1024));
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
  });

  afterEach(async () => {
    // Un-freeze Date.now for tests that spied on it — the budget-sharing
    // test below depends on real elapsed time.
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor and defaults', () => {
    expect(tool.name).toBe(OMNI_EXTRACT_KEYFRAMES_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      // Bumped with the `omniRole: 'keyframe'` annotation so pre-role
      // cache entries and recorded executions cannot converge onto this
      // fingerprint and keep reporting sampled frames as complete visual
      // coverage.
      version: '2',
      inputMediaTypes: ['video'],
      outputs: [
        {
          kind: 'media',
          mimeTypes: ['image/jpeg'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: expect.objectContaining({ type: 'object' }),
    });
    expect(EXTRACT_KEYFRAMES_DEFAULTS).toEqual({
      maxFrames: 8,
      sceneThreshold: 0.2,
      maxDimension: 768,
      strategy: 'scene',
      fps: 1,
    });
  });

  describe('bucketed extraction (known duration, maxFrames > 1)', () => {
    it('spreads one frame per equal bucket across the FULL duration', async () => {
      // The bucket loop's budget guard calls remainingTimeoutMs() before
      // the ffmpeg call reads it again — on a slow runner a millisecond
      // elapses in between and the exact-equality assertion below turns
      // flaky (observed on CI: 599999 ≠ 600000). Freeze Date so the
      // strong assertion stays deterministic; ffmpeg is mocked and
      // nothing in this test needs real wall-clock time.
      vi.spyOn(Date, 'now').mockReturnValue(1_755_000_000_000);
      probe({ durationMs: 80_000, width: 1920, height: 1080 });
      // Every bucket has a scene change 3.5s into its window.
      mocks.runFfmpeg.mockImplementation(framesRun(1, [3.5]));
      const { result, signal } = await run({ maxFrames: 4 });

      // One scene attempt per bucket, no fallbacks needed.
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(4);
      expect(mocks.runFfmpeg).toHaveBeenNthCalledWith(
        1,
        [
          '-y',
          '-ss',
          '0.000',
          '-t',
          '20.000',
          '-i',
          inputPath,
          '-vf',
          "select='gt(scene,0.2)'," +
            "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease," +
            'showinfo',
          '-vsync',
          'vfr',
          '-frames:v',
          '1',
          '-q:v',
          '4',
          '-update',
          '1',
          path.join(outputDir, 'clip-keyframe-0001.jpg'),
        ],
        { signal, timeoutMs: DEFAULT_POLICY_TOOL_TIMEOUT_MS },
      );
      // Buckets seek to 20s, 40s, 60s — coverage reaches the last
      // quarter of the video instead of stopping at the first scenes.
      const seeks = mocks.runFfmpeg.mock.calls.map(
        (call) => (call[0] as string[])[2],
      );
      expect(seeks).toEqual(['0.000', '20.000', '40.000', '60.000']);

      expect(result.error).toBeUndefined();
      expect(result.artifacts).toHaveLength(4);
      expect(result.llmContent).toContain(
        path.join(outputDir, 'clip-keyframe-0001.jpg'),
      );
      expect(result.llmContent).toContain(
        path.join(outputDir, 'clip-keyframe-0004.jpg'),
      );
      expect(result.llmContent).toContain('Use read_file');
      // Absolute timestamp = bucket start + showinfo pts_time (input
      // seeking resets pts to ~0 within each window).
      // Non-first frames carry ONLY their short timestamp marker; the
      // shared header (source/resolution/sampling/hint) rides on frame 1.
      expect(result.artifacts?.[3]).toEqual({
        kind: 'image',
        storage: 'workspace',
        title: 'Keyframe 4/4',
        workspacePath: 'clip-keyframe-0004.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: FRAME_SIZE,
        metadata: {
          omniDisclosure: '<01:04>',
          omniRole: 'keyframe',
        },
      });
      // The sampling-method note appears once, on the first frame's header.
      const firstDisclosure =
        result.artifacts?.[0]?.metadata?.['omniDisclosure'];
      expect(firstDisclosure).toContain('全片分桶采样');
      expect(firstDisclosure).toContain('原视频 80s/1920×1080');
    });

    it('caps the per-bucket scene search window at 30s on long videos', async () => {
      probe({ durationMs: 4_882_000, width: 1920, height: 804 });
      mocks.runFfmpeg.mockImplementation(framesRun(1, [1]));
      await run({ maxFrames: 2 });

      const first = mocks.runFfmpeg.mock.calls[0][0] as string[];
      const second = mocks.runFfmpeg.mock.calls[1][0] as string[];
      // Bucket = 2441s, but the scene search only decodes 30s of it.
      expect(first.slice(1, 5)).toEqual(['-ss', '0.000', '-t', '30.000']);
      expect(second.slice(1, 5)).toEqual(['-ss', '2441.000', '-t', '30.000']);
    });

    it('falls back to the bucket midpoint when the window has no scene change', async () => {
      probe({ durationMs: 40_000, width: 640, height: 360 });
      mocks.runFfmpeg
        .mockImplementationOnce(noFrameRun) // bucket 1: scene attempt → nothing
        .mockImplementationOnce(framesRun(1, [])) // bucket 1: midpoint frame
        .mockImplementationOnce(framesRun(1, [2])); // bucket 2: scene hit
      const { result, signal } = await run({ maxFrames: 2 });

      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(3);
      // Midpoint fallback: plain seek to bucketStart + bucket/2, no
      // select filter, same literal output file.
      expect(mocks.runFfmpeg).toHaveBeenNthCalledWith(
        2,
        [
          '-y',
          '-ss',
          '10.000',
          '-i',
          inputPath,
          '-vf',
          "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease",
          '-frames:v',
          '1',
          '-q:v',
          '4',
          '-update',
          '1',
          path.join(outputDir, 'clip-keyframe-0001.jpg'),
        ],
        { signal, timeoutMs: expect.any(Number) },
      );
      expect(result.error).toBeUndefined();
      expect(result.artifacts).toHaveLength(2);
      expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
        '<00:10>',
      );
      expect(result.artifacts?.[1]?.metadata?.['omniDisclosure']).toContain(
        '<00:22>',
      );
    });

    it('tolerates individual bucket failures and keeps the surviving frames', async () => {
      probe({ durationMs: 40_000 });
      mocks.runFfmpeg
        .mockResolvedValueOnce({ code: 187, stderr: 'scene boom' }) // bucket 1 scene
        .mockResolvedValueOnce({ code: 187, stderr: 'midpoint boom' }) // bucket 1 midpoint
        .mockImplementationOnce(framesRun(1, [5])); // bucket 2 scene
      const { result } = await run({ maxFrames: 2 });

      expect(result.error).toBeUndefined();
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts?.[0]?.title).toBe('Keyframe 1/1');
      expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
        '<00:25>',
      );
    });

    it('discloses partial bucket coverage when some buckets yield no frame (D8)', async () => {
      probe({ durationMs: 40_000, width: 640, height: 360 });
      mocks.runFfmpeg
        .mockImplementationOnce(framesRun(1, [2])) // bucket 1: scene hit
        .mockImplementationOnce(noFrameRun) // bucket 2: scene attempt → nothing
        .mockImplementationOnce(noFrameRun); // bucket 2: midpoint → nothing
      const { result } = await run({ maxFrames: 2 });

      expect(result.error).toBeUndefined();
      expect(result.artifacts).toHaveLength(1);
      // The blanket 全片分桶采样 claim would be false here — bucket 2 was
      // never sampled, so the note must disclose the actual coverage.
      expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
        '静态抽帧（全片分桶采样，仅覆盖 1/2 个分桶，其余时段未采样）',
      );
    });

    it('surfaces the last ffmpeg failure when every bucket failed', async () => {
      probe({ durationMs: 20_000 });
      mocks.runFfmpeg.mockResolvedValue({ code: 187, stderr: 'boom' });
      const { result } = await run({ maxFrames: 2 });
      expect(result.error?.message).toMatch(/ffmpeg failed \(exit 187\)/);
      expect(result.error?.message).toContain('boom');
      expect(result.artifacts).toBeUndefined();
    });

    it('errors generically when no bucket produced a frame without any ffmpeg failure', async () => {
      probe({ durationMs: 20_000 });
      mocks.runFfmpeg.mockImplementation(noFrameRun);
      const { result } = await run({ maxFrames: 2 });
      // 2 buckets × (scene attempt + midpoint fallback)
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(4);
      expect(result.error?.message).toMatch(/no keyframes could be extracted/);
    });

    it('charges every bucket run against the SAME wall-clock budget', async () => {
      probe({ durationMs: 20_000 });
      mocks.runFfmpeg
        .mockImplementationOnce(async (args: string[]) => {
          // Burn measurable wall-clock time in the first bucket.
          await new Promise((r) => setTimeout(r, 50));
          return framesRun(1, [0])(args);
        })
        .mockImplementationOnce(framesRun(1, [1]));
      const { result } = await run({ maxFrames: 2 });

      expect(result.error).toBeUndefined();
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(2);
      const firstTimeout = (
        mocks.runFfmpeg.mock.calls[0][1] as { timeoutMs: number }
      ).timeoutMs;
      const secondTimeout = (
        mocks.runFfmpeg.mock.calls[1][1] as { timeoutMs: number }
      ).timeoutMs;
      // The loop's budget guard reads the clock just before the ffmpeg
      // call does — this test needs REAL time (the 50ms burn below), so
      // tolerate the guard→use drift instead of freezing Date.
      expect(firstTimeout).toBeGreaterThan(DEFAULT_POLICY_TOOL_TIMEOUT_MS - 40);
      expect(firstTimeout).toBeLessThanOrEqual(DEFAULT_POLICY_TOOL_TIMEOUT_MS);
      // The second bucket gets only what the first one left, never a
      // fresh full budget (timers never fire early, so ≥40ms is gone).
      expect(secondTimeout).toBeLessThanOrEqual(
        DEFAULT_POLICY_TOOL_TIMEOUT_MS - 40,
      );
      expect(secondTimeout).toBeGreaterThan(0);
    });

    it('stops looping and returns the frames gathered so far when the budget runs out', async () => {
      probe({ durationMs: 80_000 });
      const configured = new OmniExtractKeyframesTool({
        getOmniPolicyToolsSettings: () => ({
          [OMNI_EXTRACT_KEYFRAMES_TOOL_NAME]: {
            runtime: { timeoutMs: 60 },
          },
        }),
      });
      mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
        // Outlive the whole 60ms budget inside the first bucket.
        await new Promise((r) => setTimeout(r, 90));
        return framesRun(1, [0])(args);
      });
      const invocation = configured.build({ inputPath, outputDir });
      const result = await invocation.execute(new AbortController().signal);

      // Buckets 2..8 were never attempted.
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
      expect(result.error).toBeUndefined();
      expect(result.artifacts).toHaveLength(1);
    });

    it('threads tunable overrides into every bucket scene attempt', async () => {
      probe({ durationMs: 64_000 });
      mocks.runFfmpeg.mockImplementation(framesRun(1, [0]));
      await run({ maxFrames: 16, sceneThreshold: 0.5, maxDimension: 512 });
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(16);
      const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
      expect(args.join(' ')).toContain('gt(scene,0.5)');
      expect(args.join(' ')).toContain("'min(512,iw)':'min(512,ih)'");
    });

    it('honors a zero scene threshold from tool settings', async () => {
      probe({});
      mocks.runFfmpeg.mockImplementation(framesRun(1, [0]));
      const configured = new OmniExtractKeyframesTool({
        getOmniPolicyToolsSettings: () => ({
          [OMNI_EXTRACT_KEYFRAMES_TOOL_NAME]: {
            settings: { maxFrames: 1, sceneThreshold: 0 },
          },
        }),
      });
      const invocation = configured.build({ inputPath, outputDir });
      await invocation.execute(new AbortController().signal);
      const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
      expect(args.join(' ')).toContain('gt(scene,0)');
    });

    it('threads policyTools.<tool>.runtime.timeoutMs into runFfmpeg', async () => {
      probe({ durationMs: 63_000 });
      mocks.runFfmpeg.mockImplementation(framesRun(1, [0]));
      const configured = new OmniExtractKeyframesTool({
        getOmniPolicyToolsSettings: () => ({
          [OMNI_EXTRACT_KEYFRAMES_TOOL_NAME]: {
            runtime: { timeoutMs: 90_000 },
          },
        }),
      });
      const invocation = configured.build({ inputPath, outputDir });
      await invocation.execute(new AbortController().signal);
      expect(mocks.runFfmpeg).toHaveBeenNthCalledWith(
        1,
        expect.any(Array),
        expect.objectContaining({ timeoutMs: 90_000 }),
      );
    });

    it('reports an aborted run', async () => {
      probe({ durationMs: 63_000 });
      const controller = new AbortController();
      mocks.runFfmpeg.mockImplementation(async () => {
        controller.abort();
        return { code: 0, stderr: '' };
      });
      const invocation = tool.build({ inputPath, outputDir });
      const result = await invocation.execute(controller.signal);
      expect(result.error?.message).toBe('keyframe extraction aborted');
    });
  });

  describe('single-pass extraction (unknown duration or maxFrames 1)', () => {
    it('extracts scene-detected frames in one pass when the duration is unknown', async () => {
      probe({ width: 1920, height: 1080 });
      mocks.runFfmpeg.mockImplementation(framesRun(3, [0, 12.4, 47]));
      const { result, signal } = await run();

      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
      expect(mocks.runFfmpeg).toHaveBeenCalledWith(
        [
          '-y',
          '-i',
          inputPath,
          '-vf',
          "select='eq(n,0)+gt(scene,0.2)'," +
            "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease," +
            'showinfo',
          '-vsync',
          'vfr',
          '-frames:v',
          '8',
          '-q:v',
          '4',
          path.join(outputDir, 'clip-keyframe-%04d.jpg'),
        ],
        { signal, timeoutMs: DEFAULT_POLICY_TOOL_TIMEOUT_MS },
      );

      expect(result.error).toBeUndefined();
      expect(result.artifacts).toHaveLength(3);
      // Header (frame 1) carries the sampling method; later frames only the marker.
      const header = result.artifacts?.[0]?.metadata?.['omniDisclosure'];
      expect(header).toContain('静态抽帧，时间连续性丢失');
      expect(header).not.toContain('全片分桶采样');
      expect(result.artifacts?.[1]?.metadata?.['omniDisclosure']).toBe(
        '<00:12>',
      );
    });

    it('uses a single pass when a single frame is all that was asked for', async () => {
      probe({ durationMs: 10_000 });
      mocks.runFfmpeg.mockImplementation(framesRun(1, [0]));
      const { result } = await run({ maxFrames: 1 });
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
      const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
      expect(args[args.length - 1]).toBe(
        path.join(outputDir, 'clip-keyframe-%04d.jpg'),
      );
      expect(result.artifacts).toHaveLength(1);
    });

    it('does not emit stale frames left by a prior run in a persistent outputDir', async () => {
      // A prior, LARGER extraction of the same source left higher-numbered
      // frames behind. ffmpeg's %04d counter restarts at 1, so this
      // shorter run writes 0001..0003; the stale 0004..0006 must not be
      // reported as this run's output (they would carry no showinfo pts →
      // timeSeconds: undefined). The single-pass path recovers its result
      // by listing outputDir, so it must clear the source's stale frames
      // first.
      probe({ width: 1920, height: 1080 });
      for (const n of ['0004', '0005', '0006']) {
        await fs.writeFile(
          path.join(outputDir, `clip-keyframe-${n}.jpg`),
          Buffer.alloc(FRAME_SIZE),
        );
      }
      mocks.runFfmpeg.mockImplementation(framesRun(3, [0, 12.4, 47]));
      const { result } = await run();

      expect(result.error).toBeUndefined();
      // Exactly this run's three frames — not the six on disk.
      expect(result.artifacts).toHaveLength(3);
      expect(result.artifacts?.map((a) => a.workspacePath).sort()).toEqual([
        'clip-keyframe-0001.jpg',
        'clip-keyframe-0002.jpg',
        'clip-keyframe-0003.jpg',
      ]);
      // The stale files were removed before the run rather than emitted.
      await expect(
        fs.access(path.join(outputDir, 'clip-keyframe-0004.jpg')),
      ).rejects.toThrow();
    });

    it('errors when no frames could be extracted at all', async () => {
      probe({});
      mocks.runFfmpeg.mockResolvedValue({ code: 0, stderr: '' });
      const { result } = await run();
      expect(result.error?.message).toMatch(/no keyframes could be extracted/);
      expect(result.artifacts).toBeUndefined();
    });

    it('reports the ffmpeg error on a failed scene pass', async () => {
      probe({});
      mocks.runFfmpeg.mockResolvedValue({ code: 187, stderr: 'boom' });
      const { result } = await run();
      expect(result.error?.message).toMatch(/ffmpeg failed \(exit 187\)/);
      expect(result.error?.message).toContain('boom');
    });
  });

  it.each([
    ['relative outputDir', { outputDir: 'staging' }],
    ['unknown property', { extra: 1 }],
    ['maxFrames above cap', { maxFrames: 200 }],
    ['sceneThreshold out of range', { sceneThreshold: 1.5 }],
    ['unknown strategy', { strategy: 'spiral' }],
    ['fps above cap', { strategy: 'uniform', fps: 30 }],
  ])('build rejects %s', (_label, overrides) => {
    expect(() =>
      tool.build({ inputPath, outputDir, ...overrides } as never),
    ).toThrow();
  });

  describe('uniform strategy (dynamic fps + parallel seek)', () => {
    it('samples clamp(window × fps, 1, maxFrames) frames at even timestamps', async () => {
      probe({ durationMs: 60_000, width: 1920, height: 1080 });
      // 60s window × 0.5fps = 30 frames (maxFrames lifted past it).
      mocks.runFfmpeg.mockImplementation(framesRun(1, [0]));
      const { result } = await run({
        strategy: 'uniform',
        fps: 0.5,
        maxFrames: 32,
      });

      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(30);
      const first = mocks.runFfmpeg.mock.calls[0] as [string[], unknown];
      // Slice midpoints of a 60s window in 30 slices: t₀ = 1s, t₁ = 3s…
      expect(first[0][2]).toBe('1.000');
      const second = mocks.runFfmpeg.mock.calls[1] as [string[], unknown];
      expect(second[0][2]).toBe('3.000');
      // Every extraction is an input-side seek decoding exactly one frame.
      expect(first[0]).toContain('-ss');
      expect(first[0]).toContain('-frames:v');

      expect(result.error).toBeUndefined();
      expect(result.artifacts).toHaveLength(30);
      expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
        '均匀抽帧',
      );
    });

    it('clamps the frame count at maxFrames for long videos', async () => {
      probe({ durationMs: 3600_000, width: 1920, height: 1080 });
      mocks.runFfmpeg.mockImplementation(framesRun(1, [0]));
      const { result } = await run({
        strategy: 'uniform',
        fps: 1,
        maxFrames: 10,
      });
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(10);
      expect(result.artifacts).toHaveLength(10);
    });

    it('samples inside the startSec/endSec window only', async () => {
      probe({ durationMs: 600_000, width: 1920, height: 1080 });
      mocks.runFfmpeg.mockImplementation(framesRun(1, [0]));
      const { result } = await run({
        strategy: 'uniform',
        fps: 1,
        startSec: 100,
        endSec: 110,
        maxFrames: 4,
      });
      // 10s window × 1fps = 10 → clamped to 4; midpoints: 101.25, 103.75, …
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(4);
      const first = mocks.runFfmpeg.mock.calls[0] as [string[], unknown];
      expect(first[0][2]).toBe('101.250');
      expect(result.artifacts).toHaveLength(4);
    });

    it('sizes frames onto the patch grid when frameTokenBudget is set', async () => {
      probe({ durationMs: 10_000, width: 1920, height: 1080 });
      mocks.runFfmpeg.mockImplementation(framesRun(1, [0]));
      const { result } = await run({
        strategy: 'uniform',
        fps: 0.2,
        frameTokenBudget: 'small',
      });
      const first = mocks.runFfmpeg.mock.calls[0] as [string[], unknown];
      const vfIndex = first[0].indexOf('-vf');
      // 1920×1080 under the 80-token small tier (80 × 28² px), grid-snapped.
      expect(first[0][vfIndex + 1]).toMatch(/^scale=\d+:\d+$/);
      const [w, h] = (first[0][vfIndex + 1] as string)
        .replace('scale=', '')
        .split(':')
        .map(Number);
      expect(w % 28).toBe(0);
      expect(h % 28).toBe(0);
      expect(w * h).toBeLessThanOrEqual(80 * 784 + 8 * 784);
      // The disclosure reports the SAME delivered dimensions the scale filter
      // produced — file-derived from this input + budget, not a constant.
      expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
        `缩放至 ${w}×${h}`,
      );
    });

    it('discloses delivered dimensions derived from the source (not a constant)', async () => {
      // A 640×360 source under the default 768 box is already within the
      // ceiling, so it is delivered at its own size (never enlarged) — a
      // different value than the 1920×1080 cases, proving file-derivation.
      probe({ durationMs: 40_000, width: 640, height: 360 });
      mocks.runFfmpeg.mockImplementation(framesRun(1, [5]));
      const { result } = await run({ maxFrames: 1 });
      expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
        '缩放至 640×360',
      );
    });

    it('falls back to the scene path when the duration is unknown', async () => {
      probe({});
      mocks.runFfmpeg.mockImplementation(framesRun(2, [0, 4]));
      const { result } = await run({ strategy: 'uniform', maxFrames: 2 });
      // Single-pass scene fallback: one ffmpeg run, no -ss seeks.
      expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
      const args = (mocks.runFfmpeg.mock.calls[0] as [string[], unknown])[0];
      expect(args).not.toContain('-ss');
      expect(result.artifacts).toHaveLength(2);
    });

    it('rejects a window starting beyond the video end', async () => {
      probe({ durationMs: 60_000 });
      const { result } = await run({ strategy: 'uniform', startSec: 60 });
      expect(result.error?.message).toMatch(/at or beyond the end/);
      expect(mocks.runFfmpeg).not.toHaveBeenCalled();
    });
  });
});

describe('parseShowinfoTimestamps', () => {
  it('parses pts_time per frame in output order', () => {
    expect(parseShowinfoTimestamps(showinfoStderr([0, 12.4, 47]))).toEqual([
      0, 12.4, 47,
    ]);
  });

  it('ignores unrelated stderr noise', () => {
    const stderr = [
      'frame=    3 fps=0.0 q=4.0 size=N/A',
      showinfoStderr([1.5]),
      '[out#0/image2 @ 0x600] video:126KiB',
    ].join('\n');
    expect(parseShowinfoTimestamps(stderr)).toEqual([1.5]);
  });

  it('returns an empty array when showinfo produced nothing', () => {
    expect(parseShowinfoTimestamps('Conversion failed!')).toEqual([]);
  });
});
