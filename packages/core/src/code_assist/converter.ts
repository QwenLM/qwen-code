/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponse,
  type CallableTool,
  type Content,
  type ContentListUnion,
  type ContentUnion,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerationConfigRoutingConfig,
  type MediaResolution,
  type Candidate,
  type ModelSelectionConfig,
  type GenerateContentResponsePromptFeedback,
  type GenerateContentResponseUsageMetadata,
  type Part,
  type SafetySetting,
  type PartUnion,
  type SpeechConfig,
  type ThinkingConfig,
  type Tool,
  type ToolConfig,
  type ToolListUnion,
} from '@google/genai';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import type { Credits } from './types.js';
import { isResponsesReasoningSignature } from '../utils/thoughtUtils.js';

export interface CAGenerateContentRequest {
  model: string;
  project?: string;
  user_prompt_id?: string;
  request: VertexGenerateContentRequest;
  enabled_credit_types?: string[];
}

interface VertexGenerateContentRequest {
  contents: Content[];
  systemInstruction?: Content;
  cachedContent?: string;
  tools?: Tool[];
  toolConfig?: ToolConfig;
  labels?: Record<string, string>;
  safetySettings?: SafetySetting[];
  generationConfig?: VertexGenerationConfig;
  session_id?: string;
}

interface VertexGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  candidateCount?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseLogprobs?: boolean;
  logprobs?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  responseMimeType?: string;
  responseJsonSchema?: unknown;
  responseSchema?: unknown;
  routingConfig?: GenerationConfigRoutingConfig;
  modelSelectionConfig?: ModelSelectionConfig;
  responseModalities?: string[];
  mediaResolution?: MediaResolution;
  speechConfig?: SpeechConfig;
  audioTimestamp?: boolean;
  thinkingConfig?: ThinkingConfig;
  imageConfig?: GenerateContentConfig['imageConfig'];
}

export interface CaGenerateContentResponse {
  response?: VertexGenerateContentResponse;
  traceId?: string;
  consumedCredits?: Credits[];
  remainingCredits?: Credits[];
  error?: {
    code?: number;
    message?: string;
  };
}

interface VertexGenerateContentResponse {
  candidates?: Candidate[];
  automaticFunctionCallingHistory?: Content[];
  promptFeedback?: GenerateContentResponsePromptFeedback;
  usageMetadata?: GenerateContentResponseUsageMetadata;
  modelVersion?: string;
}

export async function toGenerateContentRequest(
  req: GenerateContentParameters,
  userPromptId: string,
  project?: string,
  sessionId?: string,
  generationDefaults?: ContentGeneratorConfig['samplingParams'],
): Promise<CAGenerateContentRequest> {
  if (req.config?.modelArmorConfig !== undefined) {
    throw new Error('Code Assist does not support modelArmorConfig.');
  }
  if (req.config?.serviceTier !== undefined) {
    throw new Error('Code Assist does not support serviceTier.');
  }
  return {
    model: req.model,
    project,
    user_prompt_id: userPromptId,
    request: {
      contents: toContents(req.contents),
      systemInstruction: maybeToContent(req.config?.systemInstruction),
      cachedContent: req.config?.cachedContent,
      tools: await resolveTools(req.config?.tools),
      toolConfig: req.config?.toolConfig,
      labels: req.config?.labels,
      safetySettings: req.config?.safetySettings,
      generationConfig: toVertexGenerationConfig(
        req.config,
        generationDefaults,
      ),
      session_id: sessionId,
    },
  };
}

export function fromGenerateContentResponse(
  res: CaGenerateContentResponse,
): GenerateContentResponse {
  if (res.error) {
    throw new Error(
      `Code Assist request failed: ${res.error.message ?? `code ${res.error.code ?? 'unknown'}`}`,
    );
  }
  const out = new GenerateContentResponse();
  out.responseId = res.traceId;
  const inres = res.response;
  if (!inres) {
    out.candidates = [];
    return out;
  }
  out.candidates = inres.candidates ?? [];
  out.automaticFunctionCallingHistory = inres.automaticFunctionCallingHistory;
  out.promptFeedback = inres.promptFeedback;
  out.usageMetadata = inres.usageMetadata;
  out.modelVersion = inres.modelVersion;
  return out;
}

async function resolveTools(
  tools?: ToolListUnion,
): Promise<Tool[] | undefined> {
  if (!tools) return undefined;
  return Promise.all(
    tools.map(async (entry) => {
      if (typeof (entry as Partial<CallableTool>).tool === 'function') {
        return (entry as CallableTool).tool();
      }
      return entry as Tool;
    }),
  );
}

export function toContents(contents: ContentListUnion): Content[] {
  if (!Array.isArray(contents)) return [toContent(contents)];
  if (contents.every((entry) => isPart(entry))) {
    return [toContent(contents as PartUnion[])];
  }
  if (contents.every((entry) => !isPart(entry))) {
    return contents.map(toContent);
  }
  throw new Error('Code Assist cannot mix Content and Part arrays.');
}

function maybeToContent(content?: ContentUnion): Content | undefined {
  if (!content) return undefined;
  return toContent(content);
}

function isPart(c: ContentUnion): c is PartUnion {
  return (
    typeof c === 'object' &&
    c !== null &&
    !Array.isArray(c) &&
    !('parts' in c) &&
    !('role' in c)
  );
}

function toContent(content: ContentUnion): Content {
  if (Array.isArray(content)) {
    return { role: 'user', parts: toParts(content) };
  }
  if (typeof content === 'string') {
    return { role: 'user', parts: [{ text: content }] };
  }
  if (!isPart(content)) {
    return {
      ...content,
      parts: content.parts
        ? toParts(content.parts.filter((p) => p != null))
        : [],
    };
  }
  return { role: 'user', parts: [toPart(content)] };
}

export function toParts(parts: PartUnion[]): Part[] {
  return parts.map(toPart);
}

function sanitizePart(part: Part): Part {
  const result = { ...part };
  delete result.partMetadata;
  if (result.inlineData) {
    const { displayName: _, ...inlineData } = result.inlineData as {
      displayName?: string;
      [key: string]: unknown;
    };
    result.inlineData = inlineData as Part['inlineData'];
  }
  if (result.fileData) {
    const { displayName: _, ...fileData } = result.fileData as {
      displayName?: string;
      [key: string]: unknown;
    };
    result.fileData = fileData as Part['fileData'];
  }
  if (isResponsesReasoningSignature(result.thoughtSignature)) {
    delete result.thoughtSignature;
  }
  if (result.functionResponse?.parts) {
    result.functionResponse = {
      ...result.functionResponse,
      parts: result.functionResponse.parts.map((nested) => {
        const sanitized = sanitizePart(nested);
        const mimeType =
          sanitized.inlineData?.mimeType || sanitized.fileData?.mimeType || '';
        if (/^(audio|video)\//i.test(mimeType)) {
          const displayName = (
            (nested.inlineData ?? nested.fileData) as {
              displayName?: string;
            }
          )?.displayName;
          return {
            text: `Unsupported media type for Gemini: ${mimeType}${displayName ? ` (${displayName})` : ''}.`,
          };
        }
        return sanitized;
      }),
    };
  }
  return result;
}

function toPart(part: PartUnion): Part {
  return typeof part === 'string' ? { text: part } : sanitizePart(part);
}

function toVertexGenerationConfig(
  config?: GenerateContentConfig,
  defaults?: ContentGeneratorConfig['samplingParams'],
): VertexGenerationConfig | undefined {
  if (!config && !defaults) return undefined;
  const source = config ?? {};
  const maxOutputTokens =
    defaults?.max_tokens !== undefined && source.maxOutputTokens !== undefined
      ? Math.min(defaults.max_tokens, source.maxOutputTokens)
      : (defaults?.max_tokens ?? source.maxOutputTokens);
  const seed = defaults?.['seed'];
  return {
    temperature: defaults?.temperature ?? source.temperature,
    topP: defaults?.top_p ?? source.topP,
    topK: defaults?.top_k ?? source.topK,
    candidateCount: source.candidateCount,
    maxOutputTokens,
    stopSequences: source.stopSequences,
    responseLogprobs: source.responseLogprobs,
    logprobs: source.logprobs,
    presencePenalty: defaults?.presence_penalty ?? source.presencePenalty,
    frequencyPenalty: defaults?.frequency_penalty ?? source.frequencyPenalty,
    seed: (seed as number | undefined) ?? source.seed,
    responseMimeType: source.responseMimeType,
    responseSchema: source.responseSchema,
    responseJsonSchema: source.responseJsonSchema,
    routingConfig: source.routingConfig,
    modelSelectionConfig: source.modelSelectionConfig,
    responseModalities: source.responseModalities,
    mediaResolution: source.mediaResolution,
    speechConfig:
      typeof source.speechConfig === 'string'
        ? {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: source.speechConfig },
            },
          }
        : source.speechConfig,
    audioTimestamp: source.audioTimestamp,
    thinkingConfig: source.thinkingConfig,
    imageConfig: source.imageConfig,
  };
}
