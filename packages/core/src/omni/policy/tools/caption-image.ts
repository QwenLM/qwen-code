/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MediaPolicyToolDescriptor,
  ToolInvocation,
  ToolResult,
} from '../../../tools/tools.js';
import { Kind } from '../../../tools/tools.js';
import { ToolNames } from '../../../tools/tool-names.js';
import { recognizeMediaFile } from '../../recognition.js';
import {
  assertMediaPolicyIo,
  BaseMediaPolicyTool,
  BaseMediaPolicyToolInvocation,
  formatBytesShort,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  mediaPolicyToolSuccess,
  policyOutputFileName,
  resolvePolicyToolSettings,
  resolvePolicyToolTimeoutMs,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';
import { requestOmniChatCompletion } from './omni-chat-request.js';

export const OMNI_CAPTION_IMAGE_TOOL_NAME = ToolNames.OMNI_CAPTION_IMAGE;

/**
 * Backend defaults: the same DashScope OpenAI-compatible omni endpoint
 * the ASR tool uses (omni models accept image inputs), overridable per
 * call via tool arguments and per deployment via
 * `policyTools.omni_caption_image.settings` (same merge semantics as
 * omni_transcribe_audio).
 */
export const CAPTION_IMAGE_DEFAULTS = {
  model: 'qwen3.5-omni-plus',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  maxInputBytes: 10 * 1024 * 1024,
  prompt: '请详细描述这张图片的内容。',
} as const;

export interface CaptionImageParams extends MediaPolicyIoParams {
  /** Instruction the caption is written to (e.g. what to focus on). */
  prompt?: string;
  /** Captioning model id. */
  model?: string;
  /** OpenAI-compatible endpoint base URL. */
  baseUrl?: string;
  /** Name of the environment variable holding the API key. */
  apiKeyEnv?: string;
  /** Maximum input image size in bytes. */
  maxInputBytes?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  prompt: {
    type: 'string',
    description:
      'Understanding instruction the caption is written to (what to describe, what to focus on). Default: a general detailed description of the image.',
  },
  model: {
    type: 'string',
    description: "Captioning model id. Default 'qwen3.5-omni-plus'.",
  },
  baseUrl: {
    type: 'string',
    description:
      'OpenAI-compatible endpoint base URL the caption request is sent to. Defaults to the DashScope compatible-mode endpoint.',
  },
  apiKeyEnv: {
    type: 'string',
    description:
      "Environment variable holding the API key for the endpoint. Default 'DASHSCOPE_API_KEY'.",
  },
  maxInputBytes: {
    type: 'number',
    description: 'Maximum input image size in bytes. Default 10485760 (10MiB).',
    minimum: 1,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  version: '1',
  inputMediaTypes: ['image'],
  outputs: [
    {
      // Same text-product protocol as the transcript tool: a strict
      // UTF-8 text/plain file artifact, delivered as a text Part, labeled
      // `metadata.omniRole: 'caption'` (memory role enum预留, M §5.5).
      kind: 'file',
      role: 'caption',
      mimeTypes: ['text/plain'],
      required: true,
      // A caption is a lossy rendering of the visual content by
      // definition: fine detail, exact text and spatial relationships may
      // be dropped or misdescribed.
      lossy: true,
    },
    { kind: 'text', role: 'disclosure', required: true },
  ],
  settingsSchema: {
    type: 'object',
    properties: TUNABLE_SCHEMA_PROPERTIES,
    additionalProperties: false,
  },
  // Endpoint + credential selection stays operator-controlled (same
  // rationale as omni_transcribe_audio).
  operatorOnlyParams: ['baseUrl', 'apiKeyEnv'],
};

const readString = (
  settings: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = settings[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const readNumber = (
  settings: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = settings[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
};

class CaptionImageInvocation extends BaseMediaPolicyToolInvocation<CaptionImageParams> {
  constructor(
    params: CaptionImageParams,
    private readonly settingsDefaults: Record<string, unknown>,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Caption ${path.basename(this.params.inputPath)} with a VL model`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const settings = this.settingsDefaults;
    const model =
      this.params.model ??
      readString(settings, 'model') ??
      CAPTION_IMAGE_DEFAULTS.model;
    const baseUrl =
      this.params.baseUrl ??
      readString(settings, 'baseUrl') ??
      CAPTION_IMAGE_DEFAULTS.baseUrl;
    const apiKeyEnv =
      this.params.apiKeyEnv ??
      readString(settings, 'apiKeyEnv') ??
      CAPTION_IMAGE_DEFAULTS.apiKeyEnv;
    const maxInputBytes =
      this.params.maxInputBytes ??
      readNumber(settings, 'maxInputBytes') ??
      CAPTION_IMAGE_DEFAULTS.maxInputBytes;
    const prompt =
      this.params.prompt ??
      readString(settings, 'prompt') ??
      CAPTION_IMAGE_DEFAULTS.prompt;

    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      if (inputSizeBytes > maxInputBytes) {
        return mediaPolicyToolError(
          `input image is ${inputSizeBytes} bytes, over the ${maxInputBytes}-byte caption limit`,
        );
      }

      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        return mediaPolicyToolError(
          `environment variable ${apiKeyEnv} is not set; image captioning is unavailable`,
        );
      }

      // Content recognition: confirms the input really is an image and
      // feeds the disclosure (dimensions) and the request's data-URI MIME.
      const recognized = await recognizeMediaFile(this.params.inputPath, {
        expectedModality: 'image',
        signal,
      });
      if ((recognized.metadata.frameCount ?? 1) > 1) {
        // Same stance as the image derivative tools: a multi-frame input
        // would be captioned from its first frame only, silently dropping
        // the rest of the animation.
        return mediaPolicyToolError(
          `animated image (${recognized.metadata.frameCount} frames) is not supported by ${OMNI_CAPTION_IMAGE_TOOL_NAME}`,
        );
      }

      const bytes = await fs.readFile(this.params.inputPath);
      const dataUri = `data:${recognized.detectedMimeType};base64,${bytes.toString('base64')}`;
      const response = await requestOmniChatCompletion({
        model,
        baseUrl,
        apiKey,
        prompt,
        media: [{ type: 'image_url', url: dataUri }],
        timeoutMs: this.timeoutMs,
        signal,
        tool: 'omni_caption_image',
      });
      if (!response.ok) {
        return mediaPolicyToolError(
          `caption request failed: ${response.error}`,
        );
      }
      const caption = response.text;
      if (!caption) {
        return mediaPolicyToolError('caption request returned empty text');
      }

      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: 'caption',
        extension: '.txt',
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const encoded = Buffer.from(caption, 'utf-8');
      await fs.writeFile(outputPath, encoded);

      const m = recognized.metadata;
      const original =
        m.width !== undefined && m.height !== undefined
          ? `${m.width}×${m.height}/${formatBytesShort(inputSizeBytes)}`
          : formatBytesShort(inputSizeBytes);
      const disclosure = `原 ${original} 图片 → 语义描述 ${[...caption].length} 字（${model}），视觉细节有损、描述可能有误`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: 'file',
        title: 'Image caption',
        mimeType: 'text/plain',
        sizeBytes: encoded.length,
        disclosure,
        role: 'caption',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'TimeoutError' &&
        !signal.aborted
      ) {
        return mediaPolicyToolError(
          `caption request timed out after ${this.timeoutMs}ms`,
        );
      }
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * `omni_caption_image` — VL image captioning (design doc §3.1): an
 * OpenAI-compatible omni model describes the image under the caller's
 * prompt, turning visual content into text that enters the context.
 * Produces a caption-protocol file artifact (`metadata.omniRole:
 * 'caption'`) plus the mandatory disclosure. Fixed-policy-only unless
 * modelAccess opens it up.
 */
export class OmniCaptionImageTool extends BaseMediaPolicyTool<CaptionImageParams> {
  constructor(config: MediaPolicyToolConfigView = {}) {
    super(
      OMNI_CAPTION_IMAGE_TOOL_NAME,
      'CaptionImage',
      "Generates a semantic text description (caption) of an image with a VL model under the caller's prompt, turning visual content into context text, with a disclosure of the loss.",
      Kind.Other,
      {
        type: 'object',
        properties: {
          ...MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
          ...TUNABLE_SCHEMA_PROPERTIES,
        },
        required: ['outputDir'],
        additionalProperties: false,
      },
      config,
    );
  }

  override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
    return DESCRIPTOR;
  }

  protected createInvocation(
    params: CaptionImageParams,
  ): ToolInvocation<CaptionImageParams, ToolResult> {
    return new CaptionImageInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
