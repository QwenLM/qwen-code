/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stateless, tool-free generation for the daemon request-scoped SSE endpoint.
 * It deliberately bypasses GeminiChat so neither history nor recording is
 * read or mutated.
 */
import { getResponseText, type Config } from '@qwen-code/qwen-code-core';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';

export const GENERATION_MAX_PROMPT_BYTES = 32 * 1024;
export const GENERATION_TIMEOUT_MS = 60_000;

export interface GenerationStartedEvent {
  type: 'started';
  model: string;
  modelSource: 'fast' | 'main';
}

export interface GenerationDeltaEvent {
  type: 'delta';
  seq: number;
  text: string;
}

export interface GenerationThinkingEvent {
  type: 'thinking';
}

export type GenerationEvent =
  | GenerationStartedEvent
  | GenerationThinkingEvent
  | GenerationDeltaEvent;

export interface GenerationResult {
  model: string;
  modelSource: 'fast' | 'main';
  inputTokens?: number;
  outputTokens?: number;
}

export async function executeGeneration(
  config: Config,
  requestId: string,
  prompt: string,
  signal: AbortSignal,
  emit: (event: GenerationEvent) => Promise<void>,
): Promise<GenerationResult> {
  const fastModel = config.getFastModel();
  const mainModel = config.getModel();
  const client = config.getBaseLlmClient();
  let modelSource: 'fast' | 'main' = fastModel ? 'fast' : 'main';
  let resolved;
  if (fastModel) {
    try {
      resolved = await client.resolveForModel(fastModel, { failClosed: true });
    } catch {
      modelSource = 'main';
    }
  }
  resolved ??= await client.resolveForModel(mainModel, { failClosed: true });
  const { contentGenerator, model } = resolved;

  await emit({ type: 'started', model, modelSource });

  const stream = await contentGenerator.generateContentStream(
    {
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        abortSignal: signal,
        tools: [],
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
        temperature: 0.2,
      },
    },
    `generation:${requestId}`,
  );

  let seq = 0;
  let thinkingEmitted = false;
  let usage: GenerateContentResponseUsageMetadata | undefined;
  for await (const chunk of stream) {
    if (
      !thinkingEmitted &&
      chunk.candidates?.some((candidate) =>
        candidate.content?.parts?.some(
          (part) => part.thought && Boolean(part.text),
        ),
      )
    ) {
      thinkingEmitted = true;
      await emit({ type: 'thinking' });
    }
    const text = getResponseText(chunk) ?? '';
    if (text) {
      await emit({ type: 'delta', seq: seq++, text });
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
  }

  return {
    model,
    modelSource,
    ...(usage?.promptTokenCount !== undefined
      ? { inputTokens: usage.promptTokenCount }
      : {}),
    ...(usage?.candidatesTokenCount !== undefined
      ? { outputTokens: usage.candidatesTokenCount }
      : {}),
  };
}
