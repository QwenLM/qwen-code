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
  OMNI_OCR_IMAGE_TOOL_NAME,
  OCR_IMAGE_DEFAULTS,
  OmniOcrImageTool,
} from './ocr-image.js';

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

describe('OmniOcrImageTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let savedKey: string | undefined;

  const tool = new OmniOcrImageTool();

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

  const lastRequestBody = (): Record<string, never> =>
    JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchReturnsSse('发票编号：INV-2026-0817');
    savedKey = process.env[OCR_IMAGE_DEFAULTS.apiKeyEnv];
    process.env[OCR_IMAGE_DEFAULTS.apiKeyEnv] = 'test-key';

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-ocr-'));
    inputPath = path.join(root, 'scan.png');
    await fs.writeFile(inputPath, PNG_BYTES);
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) {
      delete process.env[OCR_IMAGE_DEFAULTS.apiKeyEnv];
    } else {
      process.env[OCR_IMAGE_DEFAULTS.apiKeyEnv] = savedKey;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor with an ocr text output', () => {
    expect(tool.name).toBe(OMNI_OCR_IMAGE_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['image'],
      outputs: [
        {
          kind: 'file',
          role: 'ocr',
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

  it('extracts text into a role:ocr text artifact', async () => {
    const result = await run();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = lastRequestBody();
    const content = (
      body as { messages: Array<{ content: Array<Record<string, unknown>> }> }
    ).messages[0].content;
    expect(content[0].type).toBe('image_url');
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain('OCR');

    expect(result.error).toBeUndefined();
    const artifact = result.artifacts?.[0];
    expect(artifact).toMatchObject({
      kind: 'file',
      mimeType: 'text/plain',
      metadata: { omniRole: 'ocr' },
    });
    const written = await fs.readFile(
      path.join(outputDir, artifact?.workspacePath as string),
      'utf-8',
    );
    expect(written).toBe('发票编号：INV-2026-0817');
    expect(artifact?.metadata?.['omniDisclosure']).toContain('OCR 文本');
  });

  it('appends the language hint to the default instruction', async () => {
    await run({ language: 'en' });
    const body = lastRequestBody() as {
      messages: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(body.messages[0].content[1].text).toContain('文字语言：en');
  });

  it('honors a custom OCR instruction verbatim', async () => {
    await run({ prompt: '只提取表格内容。' });
    const body = lastRequestBody() as {
      messages: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(body.messages[0].content[1].text).toBe('只提取表格内容。');
  });

  it('errors when the API key env var is unset', async () => {
    delete process.env[OCR_IMAGE_DEFAULTS.apiKeyEnv];
    const result = await run();
    expect(result.error?.message).toMatch(/DASHSCOPE_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors on a non-2xx response without leaking the upstream body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal trace abc123'),
    });
    const result = await run();
    expect(result.error?.message).toMatch(/HTTP 500/);
    expect(result.error?.message).not.toContain('abc123');
  });

  it('errors when the input exceeds maxInputBytes', async () => {
    const result = await run({ maxInputBytes: 10 });
    expect(result.error?.message).toMatch(/over the 10-byte OCR limit/);
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
