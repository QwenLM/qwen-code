/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { ImageGenTool } from './image-gen.js';
import { ToolErrorType } from './tool-error.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const workspaces: string[] = [];

function createConfig(
  workspace: string,
  imageCapable: boolean,
): Pick<
  Config,
  | 'getEffectiveInputModalities'
  | 'getImageGenerationConfig'
  | 'getSessionId'
  | 'getTargetDir'
> {
  return {
    getEffectiveInputModalities: () => (imageCapable ? { image: true } : {}),
    getImageGenerationConfig: () => ({
      model: 'qwen-image-2.0',
      baseUrl: 'https://images.example.com/api/v1',
      apiKeyEnv: 'TEST_IMAGE_API_KEY',
    }),
    getSessionId: () => 'session-1',
    getTargetDir: () => workspace,
  };
}

afterEach(async () => {
  delete process.env['TEST_IMAGE_API_KEY'];
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe('ImageGenTool', () => {
  it('persists a workspace image artifact and returns it to an image-capable model', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'image-gen-'));
    workspaces.push(workspace);
    process.env['TEST_IMAGE_API_KEY'] = 'secret';
    const generateImage = vi.fn().mockResolvedValue({
      bytes: PNG_BYTES,
      mimeType: 'image/png',
      requestId: 'request-1',
    });
    const tool = new ImageGenTool(
      createConfig(workspace, true) as Config,
      generateImage,
    );

    const result = await tool.buildAndExecute(
      { prompt: 'A Qwen Code poster', size: '1536*864' },
      new AbortController().signal,
    );

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'qwen-image-2.0',
        prompt: 'A Qwen Code poster',
        size: '1536*864',
        apiKey: 'secret',
      }),
    );
    expect(result.resultFilePaths).toHaveLength(1);
    const outputPath = result.resultFilePaths?.[0];
    expect(outputPath).toBeDefined();
    await expect(readFile(outputPath!)).resolves.toEqual(PNG_BYTES);
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        kind: 'image',
        storage: 'workspace',
        workspacePath: expect.stringMatching(
          /^\.qwen\/generated-images\/session-1\/.+\.png$/,
        ),
        mimeType: 'image/png',
        sizeBytes: PNG_BYTES.length,
        metadata: {
          model: 'qwen-image-2.0',
          requestId: 'request-1',
          size: '1536*864',
        },
      }),
    ]);
    const parts = result.llmContent as Part[];
    expect(
      parts.some((part) => part.inlineData?.mimeType === 'image/png'),
    ).toBe(true);
    expect(
      parts.some(
        (part) => part.inlineData?.data === PNG_BYTES.toString('base64'),
      ),
    ).toBe(true);
  });

  it('returns only the saved path to a text-only primary model', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'image-gen-'));
    workspaces.push(workspace);
    process.env['TEST_IMAGE_API_KEY'] = 'secret';
    const tool = new ImageGenTool(
      createConfig(workspace, false) as Config,
      vi.fn().mockResolvedValue({
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        requestId: 'request-2',
      }),
    );

    const result = await tool.buildAndExecute(
      { prompt: 'A poster' },
      new AbortController().signal,
    );

    expect(JSON.stringify(result.llmContent)).not.toContain('inlineData');
    expect(result.resultFilePaths).toHaveLength(1);
    expect(result.artifacts?.[0]?.kind).toBe('image');
  });

  it('rejects image sizes outside the documented total-pixel range', () => {
    const tool = new ImageGenTool(
      createConfig('/workspace', true) as Config,
      vi.fn(),
    );

    expect(() => tool.build({ prompt: 'poster', size: '100*100' })).toThrow(
      /total pixels/i,
    );
    expect(() =>
      tool.build({ prompt: 'poster', size: '2688*1536' }),
    ).not.toThrow();
  });

  it('requires approval because generation is a billable external request', async () => {
    const tool = new ImageGenTool(
      createConfig('/workspace', true) as Config,
      vi.fn(),
    );

    await expect(
      tool.build({ prompt: 'poster' }).getDefaultPermission(),
    ).resolves.toBe('ask');
  });

  it('does not start a billable request when already cancelled', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'image-gen-'));
    workspaces.push(workspace);
    process.env['TEST_IMAGE_API_KEY'] = 'secret';
    const generateImage = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const tool = new ImageGenTool(
      createConfig(workspace, true) as Config,
      generateImage,
    );

    const result = await tool
      .build({ prompt: 'A poster' })
      .execute(controller.signal);

    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('rejects an unsafe output directory before starting generation', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'image-gen-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'image-gen-outside-'));
    workspaces.push(workspace, outside);
    process.env['TEST_IMAGE_API_KEY'] = 'secret';
    const generatedImagesDir = path.join(
      workspace,
      '.qwen',
      'generated-images',
    );
    await mkdir(generatedImagesDir, { recursive: true });
    await symlink(
      outside,
      path.join(generatedImagesDir, 'session-1'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const generateImage = vi.fn();
    const tool = new ImageGenTool(
      createConfig(workspace, true) as Config,
      generateImage,
    );

    const result = await tool.buildAndExecute(
      { prompt: 'A poster' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(result.error?.message).toMatch(/inside the workspace/i);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('does not write an image when cancellation wins before persistence', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'image-gen-'));
    workspaces.push(workspace);
    process.env['TEST_IMAGE_API_KEY'] = 'secret';
    const controller = new AbortController();
    const tool = new ImageGenTool(
      createConfig(workspace, true) as Config,
      vi.fn().mockImplementation(async () => {
        controller.abort();
        return {
          bytes: PNG_BYTES,
          mimeType: 'image/png',
          requestId: 'request-3',
        };
      }),
    );
    const invocation = tool.build({ prompt: 'A poster' });
    const outputPath = invocation.toolLocations()[0]?.path;

    const result = await invocation.execute(controller.signal);

    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(outputPath).toBeDefined();
    await expect(access(outputPath!)).rejects.toThrow();
  });
});
