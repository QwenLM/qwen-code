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
  CAPTION_IMAGE_DEFAULTS,
  OMNI_CAPTION_IMAGE_TOOL_NAME,
  OmniCaptionImageTool,
} from './caption-image.js';

/** Minimal PNG header so recognition sniffs image/png. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
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

describe('OmniCaptionImageTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let savedKey: string | undefined;

  const tool = new OmniCaptionImageTool();

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

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchReturnsSse('一只橘猫趴在沙发上。');
    savedKey = process.env[CAPTION_IMAGE_DEFAULTS.apiKeyEnv];
    process.env[CAPTION_IMAGE_DEFAULTS.apiKeyEnv] = 'test-key';

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-cap-img-'));
    inputPath = path.join(root, 'photo.png');
    await fs.writeFile(inputPath, PNG_BYTES);
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) {
      delete process.env[CAPTION_IMAGE_DEFAULTS.apiKeyEnv];
    } else {
      process.env[CAPTION_IMAGE_DEFAULTS.apiKeyEnv] = savedKey;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor with a caption text output', () => {
    expect(tool.name).toBe(OMNI_CAPTION_IMAGE_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['image'],
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

  it('captions an image into a role:caption text artifact', async () => {
    const result = await run();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CAPTION_IMAGE_DEFAULTS.baseUrl}/chat/completions`);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(CAPTION_IMAGE_DEFAULTS.model);
    const content = body.messages[0].content;
    expect(content[0].type).toBe('image_url');
    expect(content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(content[1].type).toBe('text');
    expect(content[1].text).toBe(CAPTION_IMAGE_DEFAULTS.prompt);

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
    expect(written).toBe('一只橘猫趴在沙发上。');
    expect(artifact?.metadata?.['omniDisclosure']).toContain('语义描述');
  });

  it('passes a custom prompt through', async () => {
    await run({ prompt: '只描述颜色。' });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.messages[0].content[1].text).toBe('只描述颜色。');
  });

  it('errors when the API key env var is unset', async () => {
    delete process.env[CAPTION_IMAGE_DEFAULTS.apiKeyEnv];
    const result = await run();
    expect(result.error?.message).toMatch(/DASHSCOPE_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors on a non-2xx response without leaking the upstream body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('{"error":"rate limited, retry at ..."}'),
    });
    const result = await run();
    expect(result.error?.message).toMatch(/HTTP 429/);
    expect(result.error?.message).not.toContain('rate limited');
  });

  it('errors on an empty caption', async () => {
    fetchReturnsSse();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('data: [DONE]\n'),
    });
    const result = await run();
    expect(result.error?.message).toMatch(/empty text/);
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
