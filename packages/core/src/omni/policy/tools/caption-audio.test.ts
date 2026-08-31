/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '../../../tools/tools.js';
import {
  CAPTION_AUDIO_DEFAULTS,
  OMNI_CAPTION_AUDIO_TOOL_NAME,
  OmniCaptionAudioTool,
} from './caption-audio.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

/** Minimal RIFF/WAVE header so recognition sniffs audio/wav. */
const WAV_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WAVE'),
  Buffer.alloc(1024),
]);

const sse = (...contents: string[]): string =>
  contents
    .map(
      (c) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`,
    )
    .concat(['data: [DONE]'])
    .join('\n\n') + '\n';

describe('OmniCaptionAudioTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let savedKey: string | undefined;

  const tool = new OmniCaptionAudioTool();

  const fetchReturnsSse = (...contents: string[]): void => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(sse(...contents)),
    });
  };

  const run = async (
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    const invocation = tool.build({ inputPath, outputDir, ...params } as never);
    return invocation.execute(new AbortController().signal);
  };

  const lastRequestBody = (): {
    model: string;
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  } =>
    JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    // Probe reports nothing → single-shot (no duration → no chunking).
    mocks.probeMediaMetadata.mockResolvedValue({});
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchReturnsSse('一段轻松的钢琴曲，背景有雨声。');
    savedKey = process.env[CAPTION_AUDIO_DEFAULTS.apiKeyEnv];
    process.env[CAPTION_AUDIO_DEFAULTS.apiKeyEnv] = 'test-key';

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-cap-aud-'));
    inputPath = path.join(root, 'clip.wav');
    await fs.writeFile(inputPath, WAV_BYTES);
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) {
      delete process.env[CAPTION_AUDIO_DEFAULTS.apiKeyEnv];
    } else {
      process.env[CAPTION_AUDIO_DEFAULTS.apiKeyEnv] = savedKey;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor with a caption text output', () => {
    expect(tool.name).toBe(OMNI_CAPTION_AUDIO_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['audio'],
      outputs: [
        {
          kind: 'file',
          role: 'caption',
          mimeTypes: ['text/plain'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: expect.objectContaining({ type: 'object' }),
      operatorOnlyParams: ['baseUrl', 'apiKeyEnv'],
    });
  });

  it('describes short audio in one request with an input_audio part', async () => {
    const result = await run();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
    const body = lastRequestBody();
    expect(body.model).toBe(CAPTION_AUDIO_DEFAULTS.model);
    const content = body.messages[0].content;
    expect(content[0].type).toBe('input_audio');
    expect(
      (content[0] as { input_audio: { data: string; format: string } })
        .input_audio.format,
    ).toBe('wav');
    expect(content[1].text).toBe(CAPTION_AUDIO_DEFAULTS.prompt);

    expect(result.error).toBeUndefined();
    const artifact = result.artifacts?.[0];
    expect(artifact).toMatchObject({
      kind: 'file',
      mimeType: 'text/plain',
      metadata: { omniRole: 'caption' },
    });
    const written = await fs.readFile(
      path.join(outputDir, artifact?.workspacePath as string),
      'utf-8',
    );
    expect(written).toBe('一段轻松的钢琴曲，背景有雨声。');
    expect(artifact?.metadata?.['omniDisclosure']).toContain('语义描述');
  });

  it('passes a custom prompt through', async () => {
    await run({ prompt: '只描述说话人情绪。' });
    expect(lastRequestBody().messages[0].content[1].text).toBe(
      '只描述说话人情绪。',
    );
  });

  it('errors when the API key env var is unset', async () => {
    delete process.env[CAPTION_AUDIO_DEFAULTS.apiKeyEnv];
    const result = await run();
    expect(result.error?.message).toMatch(/DASHSCOPE_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors on a non-2xx response without leaking the upstream body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"key":"sk-live-secret"}'),
    });
    const result = await run();
    expect(result.error?.message).toMatch(/HTTP 401/);
    expect(result.error?.message).not.toContain('sk-live-secret');
  });

  it('errors when the input exceeds maxInputBytes', async () => {
    const result = await run({ maxInputBytes: 10 });
    expect(result.error?.message).toMatch(/over the 10-byte caption limit/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors when the input file is missing', async () => {
    await fs.rm(inputPath);
    const result = await run();
    expect(result.error?.message).toMatch(/input file not found/);
  });

  it.each([
    ['relative outputDir', { outputDir: 'staging' }],
    ['unknown property', { extra: 1 }],
  ])('build rejects %s', (_label, overrides) => {
    expect(() =>
      tool.build({ inputPath, outputDir, ...overrides } as never),
    ).toThrow();
  });
});
