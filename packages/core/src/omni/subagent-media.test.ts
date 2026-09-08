/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import type { MediaProbeResult } from './ffmpeg.js';
import { ToolNames } from '../tools/tool-names.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
  deliver: vi.fn(),
  gate: vi.fn(),
}));

vi.mock('./ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

vi.mock('./index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./index.js')>()),
  isOmniDeliveryActive: mocks.gate,
  processMediaForOmniDelivery: mocks.deliver,
}));

import { buildMediaSubagentSeed } from './subagent-media.js';

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.alloc(1024, 7),
]);
const WAV = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WAVE', 'latin1'),
  Buffer.alloc(1024, 3),
]);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(1024, 5),
]);

describe('buildMediaSubagentSeed', () => {
  let root: string;
  let inputPath: string;
  const signal = new AbortController().signal;

  const allEnabled = () =>
    Object.fromEntries(
      [ToolNames.SAMPLE_FRAMES, ToolNames.GET_AUDIO, ToolNames.GET_CLIP].map(
        (name) => [name, { modelAccess: { enabled: true } }],
      ),
    );

  const config = (
    policyTools: Record<string, unknown> = allEnabled(),
  ): Config =>
    ({
      isOmniEnabled: () => true,
      getContentGeneratorConfig: () => ({
        modalities: { image: true, audio: true, video: true },
      }),
      getOmniPolicyToolsSettings: () => policyTools,
      storage: { getQwenDir: () => root },
    }) as unknown as Config;

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  const writes = (bytes: Buffer) => async (args: string[]) => {
    await fs.writeFile(args[args.length - 1], bytes);
    return { code: 0, stderr: '' };
  };

  const seed = (overrides: Record<string, unknown> = {}): Promise<Part[]> =>
    buildMediaSubagentSeed(
      {
        subagentType: ToolNames.SAMPLE_FRAMES,
        inputPath,
        start: '00:10',
        end: '00:15',
        fps: 1,
        ...overrides,
      },
      config(),
      signal,
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-seed-'));
    inputPath = path.join(root, 'clip.mp4');
    await fs.writeFile(inputPath, Buffer.alloc(1024));
    probe({
      durationMs: 600_000,
      width: 1280,
      height: 720,
      hasAudioStream: true,
    });
    mocks.runFfmpeg.mockImplementation(writes(JPEG));
    mocks.gate.mockReturnValue(true);
    mocks.deliver.mockResolvedValue({
      fileUri: 'oss://bucket/key',
      mimeType: 'image/jpeg',
      sha256: 'a'.repeat(64),
      recognized: { modality: 'image' },
      tokenEstimate: {
        estimatedTokenCount: 1,
        method: 'raw-resource-v1',
        status: 'ok',
      },
      deduped: false,
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('delivers the summary plus one uploaded part per frame', async () => {
    const parts = await seed();
    expect(parts[1].text).toContain('Sampled 5 frame(s) of clip.mp4');
    const media = parts.filter((part) => part.fileData);
    expect(media).toHaveLength(5);
    expect(media[0].fileData?.fileUri).toBe('oss://bucket/key');
    expect(mocks.deliver).toHaveBeenCalledTimes(5);
  });

  it('keeps each frame next to its own timestamp', async () => {
    // A child's user-role message is order-preserving all the way to the
    // request body, so the pairing the tool built is what the child reads.
    const parts = await seed();
    expect(parts.slice(2).map((part) => part.text ?? 'frame')).toEqual([
      '<00:10.5>',
      'frame',
      '<00:11.5>',
      'frame',
      '<00:12.5>',
      'frame',
      '<00:13.5>',
      'frame',
      '<00:14.5>',
      'frame',
    ]);
  });

  it('names the absolute source path so the child can extract again', async () => {
    // The summary carries only the basename, and the child's own allowlisted
    // tool needs an absolute inputPath.
    const parts = await seed();
    expect(parts[0].text).toContain(inputPath);
  });

  it('never seeds inline base64', async () => {
    // The whole point of seeding through the upload funnel: a data: URL in
    // the child's first message would blow up every request it makes.
    const parts = await seed();
    expect(parts.some((part) => part.inlineData)).toBe(false);
  });

  it('refuses to seed when omni delivery is off, rather than fall back', async () => {
    mocks.gate.mockReturnValue(false);
    await expect(seed()).rejects.toThrow(/require omni media delivery/);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('refuses to seed a type whose tool is not model-accessible', async () => {
    // Seeding runs the tool in-process, so it must not become a way around
    // the switch that keeps that tool fixed-policy-only.
    await expect(
      buildMediaSubagentSeed(
        {
          subagentType: ToolNames.SAMPLE_FRAMES,
          inputPath,
          start: '00:10',
          end: '00:15',
          fps: 1,
        },
        config({}),
        signal,
      ),
    ).rejects.toThrow(/modelAccess\.enabled/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('seeds a clip as one video part', async () => {
    mocks.runFfmpeg.mockImplementation(writes(MP4));
    mocks.deliver.mockResolvedValue({
      fileUri: 'oss://bucket/clip',
      mimeType: 'video/mp4',
      sha256: 'b'.repeat(64),
      recognized: { modality: 'video' },
      tokenEstimate: {
        estimatedTokenCount: 1,
        method: 'raw-resource-v1',
        status: 'ok',
      },
      deduped: false,
    });
    const parts = await seed({ subagentType: ToolNames.GET_CLIP, fps: 2 });
    expect(parts.filter((part) => part.fileData)).toHaveLength(1);
    expect(parts[1].text).toContain('with its audio track');
  });

  it('seeds audio as one part', async () => {
    mocks.runFfmpeg.mockImplementation(writes(WAV));
    mocks.deliver.mockResolvedValue({
      fileUri: 'oss://bucket/audio',
      mimeType: 'audio/wav',
      sha256: 'c'.repeat(64),
      recognized: { modality: 'audio' },
      tokenEstimate: {
        estimatedTokenCount: 1,
        method: 'raw-resource-v1',
        status: 'ok',
      },
      deduped: false,
    });
    const parts = await seed({
      subagentType: ToolNames.GET_AUDIO,
      fps: undefined,
    });
    expect(parts.filter((part) => part.fileData)).toHaveLength(1);
    expect(parts[1].text).toContain('16kHz mono WAV');
  });

  it('propagates the tool refusal for a source with no audio track', async () => {
    probe({ durationMs: 600_000, hasAudioStream: false });
    await expect(
      seed({ subagentType: ToolNames.GET_AUDIO, fps: undefined }),
    ).rejects.toThrow('clip.mp4 has no audio track');
  });

  it('fails on a malformed window before any ffmpeg runs', async () => {
    // The point of extracting in the parent: a bad argument costs an error
    // here, not a whole sub-session that had nothing to look at.
    await expect(seed({ start: '0:90' })).rejects.toThrow(/under 60/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('refuses a visual type with no fps', async () => {
    await expect(seed({ fps: undefined })).rejects.toThrow(/requires fps/);
  });

  it('refuses a type that is not one of the three', async () => {
    await expect(seed({ subagentType: 'general-purpose' })).rejects.toThrow(
      /not a media subagent type/,
    );
  });
});
