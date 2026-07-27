/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import { dispatchMediaSegments } from './media-dispatch.js';
import { getMediaMemory } from '../../memory/media/media-memory-store.js';
import { probeMedia } from './probe.js';

let dir: string;
let videoPath: string;
let ffmpegOk = false;
const originalRuntime = process.env['QWEN_RUNTIME_DIR'];

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-test-'));
  process.env['QWEN_RUNTIME_DIR'] = dir;
  videoPath = path.join(dir, 'clip.mp4');
  ffmpegOk = await new Promise<boolean>((resolve) => {
    execFile(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=6:size=320x240:rate=10',
        '-pix_fmt',
        'yuv420p',
        videoPath,
      ],
      (err) => resolve(!err),
    );
  });
});

afterAll(async () => {
  if (originalRuntime === undefined) delete process.env['QWEN_RUNTIME_DIR'];
  else process.env['QWEN_RUNTIME_DIR'] = originalRuntime;
  await fs.rm(dir, { recursive: true, force: true });
});

interface Captured {
  parts: Array<{ inlineData?: unknown; text?: string }>;
  model: string;
}

function fakeConfig(
  captured: Captured[],
  opts: { multimodal: boolean; visionModelId?: string },
): Config {
  return {
    getEffectiveInputModalities: () => (opts.multimodal ? { image: true } : {}),
    getModel: () => 'main-model',
    getDefaultVisionBridgeModel: () =>
      opts.visionModelId ? { id: opts.visionModelId } : undefined,
    // dispatch now reads segments through the trunk, which resolves the media
    // config and provider profile — a trunk-complete fake needs these.
    getMediaConfig: () => undefined,
    getContentGeneratorConfig: () => ({}),
    getGeminiClient: () => ({
      generateContent: async (
        contents: Array<{
          parts: Array<{ inlineData?: unknown; text?: string }>;
        }>,
        _genConfig: unknown,
        _signal: unknown,
        model: string,
      ) => {
        captured.push({ parts: contents[0].parts, model });
        return {
          candidates: [
            { content: { parts: [{ text: `described ${model}` }] } },
          ],
        };
      },
    }),
  } as unknown as Config;
}

describe('media_dispatch', () => {
  it('splits the video into segments and understands each in parallel', async () => {
    if (!ffmpegOk) return;
    const captured: Captured[] = [];
    const config = fakeConfig(captured, { multimodal: true });
    const result = await dispatchMediaSegments(videoPath, config, {
      segments: 3,
      force: true,
      signal: new AbortController().signal,
    });

    expect(result.segments).toHaveLength(3);
    expect(result.model).toBe('main-model');
    // Each segment produced a note from the (mocked) model.
    for (const seg of result.segments) {
      expect(seg.note).toBe('described main-model');
      expect(seg.frameCount).toBeGreaterThan(0);
    }
    // Ranges partition the duration in order.
    expect(result.segments[0].range[0]).toBe(0);
    expect(result.segments[2].range[1]).toBeCloseTo(result.durationSec, 1);

    // Each understanding call carried real keyframe image parts.
    expect(captured).toHaveLength(3);
    for (const c of captured) {
      expect(c.parts.some((p) => p.inlineData)).toBe(true);
      expect(c.parts.some((p) => typeof p.text === 'string')).toBe(true);
    }
  });

  it('records the combined understanding in media memory', async () => {
    if (!ffmpegOk) return;
    const config = fakeConfig([], { multimodal: true });
    await dispatchMediaSegments(videoPath, config, {
      segments: 2,
      force: true,
      signal: new AbortController().signal,
    });
    const probe = await probeMedia(videoPath);
    const rec = await getMediaMemory().get(probe.hash);
    expect(rec?.body).toContain('Segment 1');
    expect(rec?.body).toContain('Segment 2');
    expect(rec?.body).toContain('[dispatch-focus] overview');
  });

  it('uses a vision model when the main model is not multimodal', async () => {
    if (!ffmpegOk) return;
    const captured: Captured[] = [];
    const config = fakeConfig(captured, {
      multimodal: false,
      visionModelId: 'vision-x',
    });
    const result = await dispatchMediaSegments(videoPath, config, {
      segments: 2,
      force: true,
      signal: new AbortController().signal,
    });
    expect(result.model).toBe('vision-x');
    expect(captured.every((c) => c.model === 'vision-x')).toBe(true);
  });

  it('fails closed with a remedy when no image-capable model exists', async () => {
    if (!ffmpegOk) return;
    const config = fakeConfig([], { multimodal: false });
    await expect(
      dispatchMediaSegments(videoPath, config, {
        force: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/image-capable model/);
  });

  it('recalls the same prompt from memory but re-runs a different prompt', async () => {
    if (!ffmpegOk) return;
    // First analysis for a specific question -> real model calls.
    const cap1: Captured[] = [];
    await dispatchMediaSegments(
      videoPath,
      fakeConfig(cap1, { multimodal: true }),
      {
        segments: 2,
        prompt: 'count the distinct songs',
        signal: new AbortController().signal,
      },
    );
    expect(cap1.length).toBeGreaterThan(0);

    // Same prompt, new call -> served from memory, no model calls.
    const cap2: Captured[] = [];
    const cached = await dispatchMediaSegments(
      videoPath,
      fakeConfig(cap2, { multimodal: true }),
      {
        segments: 2,
        prompt: 'count the distinct songs',
        signal: new AbortController().signal,
      },
    );
    expect(cached.fromMemory).toBe(true);
    expect(cap2).toHaveLength(0);

    // A different prompt -> cache miss -> real model calls again.
    const cap3: Captured[] = [];
    const fresh = await dispatchMediaSegments(
      videoPath,
      fakeConfig(cap3, { multimodal: true }),
      {
        segments: 2,
        prompt: 'identify the team or brand behind this video',
        signal: new AbortController().signal,
      },
    );
    expect(fresh.fromMemory).toBeFalsy();
    expect(cap3.length).toBeGreaterThan(0);
  });
});
