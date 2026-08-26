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

export const OMNI_OCR_IMAGE_TOOL_NAME = ToolNames.OMNI_OCR_IMAGE;

/**
 * Backend defaults: the same DashScope OpenAI-compatible omni endpoint
 * the ASR/caption tools use, overridable per call via tool arguments and
 * per deployment via `policyTools.omni_ocr_image.settings`.
 */
export const OCR_IMAGE_DEFAULTS = {
  model: 'qwen3.5-omni-plus',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  maxInputBytes: 10 * 1024 * 1024,
} as const;

/** Default OCR instruction (language auto-detection when no hint given). */
const DEFAULT_OCR_PROMPT =
  '请对这张图片进行OCR文字识别，提取图片中所有可见的文字内容，保持原始排版格式。只输出识别到的文字，不要添加任何解释。';

export interface OcrImageParams extends MediaPolicyIoParams {
  /** Optional language hint (e.g. "zh", "en"); auto-detection when omitted. */
  language?: string;
  /** Optional custom OCR instruction (overrides the default). */
  prompt?: string;
  /** OCR model id. */
  model?: string;
  /** OpenAI-compatible endpoint base URL. */
  baseUrl?: string;
  /** Name of the environment variable holding the API key. */
  apiKeyEnv?: string;
  /** Maximum input image size in bytes. */
  maxInputBytes?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  language: {
    type: 'string',
    description:
      'Optional language hint for the recognition (e.g. "zh", "en"). Default: automatic detection.',
  },
  prompt: {
    type: 'string',
    description:
      'Custom OCR instruction (e.g. to focus on specific regions or languages). Default: extract all visible text preserving layout.',
  },
  model: {
    type: 'string',
    description: "OCR model id. Default 'qwen3.5-omni-plus'.",
  },
  baseUrl: {
    type: 'string',
    description:
      'OpenAI-compatible endpoint base URL the OCR request is sent to. Defaults to the DashScope compatible-mode endpoint.',
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
      // Same text-product protocol as the transcript/caption tools:
      // strict UTF-8 text/plain, delivered as a text Part, labeled
      // `metadata.omniRole: 'ocr'` (memory role enum预留, M §5.5; memory
      // maps it to the onscreen_text channel).
      kind: 'file',
      role: 'ocr',
      mimeTypes: ['text/plain'],
      required: true,
      // OCR keeps only the text layer: layout beyond reading order,
      // typography and all non-text content are lost, and recognition
      // may err.
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

class OcrImageInvocation extends BaseMediaPolicyToolInvocation<OcrImageParams> {
  constructor(
    params: OcrImageParams,
    private readonly settingsDefaults: Record<string, unknown>,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Extract text from ${path.basename(this.params.inputPath)} (OCR)`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const settings = this.settingsDefaults;
    const model =
      this.params.model ??
      readString(settings, 'model') ??
      OCR_IMAGE_DEFAULTS.model;
    const baseUrl =
      this.params.baseUrl ??
      readString(settings, 'baseUrl') ??
      OCR_IMAGE_DEFAULTS.baseUrl;
    const apiKeyEnv =
      this.params.apiKeyEnv ??
      readString(settings, 'apiKeyEnv') ??
      OCR_IMAGE_DEFAULTS.apiKeyEnv;
    const maxInputBytes =
      this.params.maxInputBytes ??
      readNumber(settings, 'maxInputBytes') ??
      OCR_IMAGE_DEFAULTS.maxInputBytes;
    const language = this.params.language ?? readString(settings, 'language');
    const prompt =
      this.params.prompt ??
      readString(settings, 'prompt') ??
      DEFAULT_OCR_PROMPT + (language ? `文字语言：${language}。` : '');

    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      if (inputSizeBytes > maxInputBytes) {
        return mediaPolicyToolError(
          `input image is ${inputSizeBytes} bytes, over the ${maxInputBytes}-byte OCR limit`,
        );
      }

      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        return mediaPolicyToolError(
          `environment variable ${apiKeyEnv} is not set; OCR is unavailable`,
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
        // would be OCR'd from its first frame only, silently dropping the
        // rest of the animation.
        return mediaPolicyToolError(
          `animated image (${recognized.metadata.frameCount} frames) is not supported by ${OMNI_OCR_IMAGE_TOOL_NAME}`,
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
      });
      if (!response.ok) {
        return mediaPolicyToolError(`OCR request failed: ${response.error}`);
      }
      const text = response.text;
      if (!text) {
        return mediaPolicyToolError('OCR request returned empty text');
      }

      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: 'ocr',
        extension: '.txt',
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const encoded = Buffer.from(text, 'utf-8');
      await fs.writeFile(outputPath, encoded);

      const m = recognized.metadata;
      const original =
        m.width !== undefined && m.height !== undefined
          ? `${m.width}×${m.height}/${formatBytesShort(inputSizeBytes)}`
          : formatBytesShort(inputSizeBytes);
      const languagePart = language ? `，语言提示 ${language}` : '';
      const disclosure = `原 ${original} 图片 → OCR 文本 ${[...text].length} 字（${model}${languagePart}），仅保留文字层，版式细节与非文字内容丢失，识别可能有误`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: 'file',
        title: 'OCR text',
        mimeType: 'text/plain',
        sizeBytes: encoded.length,
        disclosure,
        role: 'ocr',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'TimeoutError' &&
        !signal.aborted
      ) {
        return mediaPolicyToolError(
          `OCR request timed out after ${this.timeoutMs}ms`,
        );
      }
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * `omni_ocr_image` — image text extraction (design doc §3.1): an
 * OpenAI-compatible omni model performs OCR under the (default or
 * caller-supplied) instruction, with an optional language hint (auto
 * detection when omitted). Produces an OCR-protocol file artifact
 * (`metadata.omniRole: 'ocr'`) plus the mandatory disclosure.
 * Fixed-policy-only unless modelAccess opens it up — this is the tool
 * the §4.5 文档/文字图片 OCR fixedPolicy waits on.
 */
export class OmniOcrImageTool extends BaseMediaPolicyTool<OcrImageParams> {
  constructor(config: MediaPolicyToolConfigView = {}) {
    super(
      OMNI_OCR_IMAGE_TOOL_NAME,
      'OcrImage',
      'Extracts the text visible in an image (OCR) with a VL model — printed text, handwriting, documents, signs — with automatic language detection or an optional language hint, and a disclosure of the loss.',
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
    params: OcrImageParams,
  ): ToolInvocation<OcrImageParams, ToolResult> {
    return new OcrImageInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
