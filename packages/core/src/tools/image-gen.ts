/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import {
  generateImage as generateConfiguredImage,
  type GenerateImage,
} from '../services/image-generation-service.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { getErrorMessage } from '../utils/errors.js';
import { ToolErrorType } from './tool-error.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import type { ToolInvocation, ToolLocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';

const MIN_TOTAL_PIXELS = 512 * 512;
const MAX_TOTAL_PIXELS = 2048 * 2048;
const MAX_PROMPT_CHARS = 10_000;

export interface ImageGenParams {
  prompt: string;
  size?: string;
}

class ImageGenInvocation extends BaseToolInvocation<
  ImageGenParams,
  ToolResult
> {
  private readonly outputPath: string;

  constructor(
    private readonly config: Config,
    private readonly generateImage: GenerateImage,
    params: ImageGenParams,
  ) {
    super(params);
    const sessionDir = Storage.sanitizePlanSessionId(config.getSessionId());
    this.outputPath = path.join(
      config.getTargetDir(),
      '.qwen',
      'generated-images',
      sessionDir,
      `${randomUUID()}.png`,
    );
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.outputPath }];
  }

  override getDescription(): string {
    const imageConfig = this.config.getImageGenerationConfig();
    const size = this.params.size ? ` at ${this.params.size}` : '';
    return `Generate an image with ${imageConfig?.model ?? 'the configured model'}${size}: ${this.params.prompt}`;
  }

  override getDefaultPermission(): Promise<'ask'> {
    return Promise.resolve('ask');
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const imageConfig = this.config.getImageGenerationConfig();
    if (!imageConfig) {
      return failureResult(
        'Image generation is not configured with a valid endpoint.',
      );
    }
    const apiKey = process.env[imageConfig.apiKeyEnv]?.trim();
    if (!apiKey) {
      return failureResult(
        `Image generation requires the ${imageConfig.apiKeyEnv} environment variable.`,
      );
    }

    try {
      signal.throwIfAborted();
      const outputDir = path.dirname(this.outputPath);
      Storage.assertPathWithinDirectory(
        outputDir,
        this.config.getTargetDir(),
        'Generated image path must stay inside the workspace.',
      );
      await mkdir(outputDir, { recursive: true });
      Storage.assertPathWithinDirectory(
        outputDir,
        this.config.getTargetDir(),
        'Generated image path must stay inside the workspace.',
      );
      signal.throwIfAborted();
      const generated = await this.generateImage({
        baseUrl: imageConfig.baseUrl,
        apiKey,
        model: imageConfig.model,
        prompt: this.params.prompt,
        size: this.params.size,
        signal,
      });
      signal.throwIfAborted();
      Storage.assertPathWithinDirectory(
        outputDir,
        this.config.getTargetDir(),
        'Generated image path must stay inside the workspace.',
      );
      await atomicWriteFile(this.outputPath, generated.bytes, {
        mode: 0o600,
        noFollow: true,
      });

      const workspacePath = path
        .relative(this.config.getTargetDir(), this.outputPath)
        .split(path.sep)
        .join('/');
      const metadata: Record<string, string | number | boolean | null> = {
        model: imageConfig.model,
        ...(generated.requestId ? { requestId: generated.requestId } : {}),
        ...(this.params.size ? { size: this.params.size } : {}),
      };
      const llmContent: Part[] = [
        {
          text: `Generated image saved to ${this.outputPath}.`,
        },
      ];
      if (this.config.getEffectiveInputModalities().image === true) {
        llmContent.push({
          inlineData: {
            mimeType: generated.mimeType,
            data: generated.bytes.toString('base64'),
          },
        });
      }

      return {
        llmContent,
        returnDisplay: `Generated image saved to **${this.outputPath}**.`,
        resultFilePaths: [this.outputPath],
        artifacts: [
          {
            title: 'Generated image',
            kind: 'image',
            storage: 'workspace',
            workspacePath,
            mimeType: generated.mimeType,
            sizeBytes: generated.bytes.length,
            metadata,
          },
        ],
      };
    } catch (error) {
      return failureResult(getErrorMessage(error));
    }
  }
}

export class ImageGenTool extends BaseDeclarativeTool<
  ImageGenParams,
  ToolResult
> {
  static readonly Name = ToolNames.IMAGE_GEN;

  constructor(
    private readonly config: Config,
    private readonly generateImage: GenerateImage = generateConfiguredImage,
  ) {
    super(
      ImageGenTool.Name,
      ToolDisplayNames.IMAGE_GEN,
      'Generates a PNG image with the configured image model and saves it as a workspace artifact. Use size in width*height form when the user requests a specific aspect ratio.',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_PROMPT_CHARS,
            description: 'Detailed text description of the image to generate.',
          },
          size: {
            type: 'string',
            pattern: '^\\d+\\*\\d+$',
            description:
              'Optional output size in width*height form, for example 1536*864.',
          },
        },
        required: ['prompt'],
      },
      true,
      false,
      false,
      false,
      'image generation picture poster illustration',
    );
  }

  protected override validateToolParamValues(
    params: ImageGenParams,
  ): string | null {
    params.prompt = params.prompt.trim();
    if (!params.prompt) {
      return 'The image prompt must be non-empty.';
    }
    if (params.prompt.length > MAX_PROMPT_CHARS) {
      return `The image prompt must not exceed ${MAX_PROMPT_CHARS} characters.`;
    }
    if (!params.size) {
      return null;
    }

    const match = /^(\d+)\*(\d+)$/.exec(params.size);
    if (!match) {
      return 'Image size must use width*height form, for example 1536*864.';
    }
    const width = Number(match[1]);
    const height = Number(match[2]);
    const totalPixels = width * height;
    if (
      !Number.isSafeInteger(totalPixels) ||
      totalPixels < MIN_TOTAL_PIXELS ||
      totalPixels > MAX_TOTAL_PIXELS
    ) {
      return `Image size total pixels must be between 512*512 and 2048*2048.`;
    }
    return null;
  }

  protected createInvocation(
    params: ImageGenParams,
  ): ToolInvocation<ImageGenParams, ToolResult> {
    return new ImageGenInvocation(this.config, this.generateImage, params);
  }
}

function failureResult(message: string): ToolResult {
  return {
    llmContent: `Image generation failed: ${message}`,
    returnDisplay: `Image generation failed: ${message}`,
    error: {
      message,
      type: ToolErrorType.EXECUTION_FAILED,
    },
  };
}
