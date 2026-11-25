/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { GenerateContentResponse } from '@google/genai';
import { ENV_FAKE_STREAM_DELAY_MS } from '../../config/brand.js';
import type { FakeResponseStore } from '../../core/fakeResponseStore.js';
import { createAbortError, delay } from '../../utils/delay.js';
import { composeAbortSignals } from '../../utils/fetch.js';
import { isRecord } from '../../utils/markdownUtils.js';
import type { ModelContentBlock } from '../event/modelCompleteEvent.js';
import type { ModelStreamEvent } from '../event/modelStreamEvent.js';
import type { Model, ModelConfig } from '../model/model.js';
import { mergeModelConfig } from '../model/modelConfig.js';
import type { ModelSelectContext } from '../model/modelSelectContext.js';
import type { ModelSelection } from '../model/modelSelection.js';
import { QODER_PROVIDER_ID, type ModelProvider } from '../modelProvider.js';
import type { ModelStreamRequest } from '../modelStreamRequest.js';
import type { ModelStreamResponse } from '../modelStreamResponse.js';
import { createModelStreamResponse } from '../modelStreamResponseFactory.js';

export interface FakeModelProviderOptions {
  readonly defaultModelKey: string;
  readonly getResponseStore: () => Promise<FakeResponseStore | undefined>;
}

/** Explicit --fake-responses sessions replay locally through the normal provider contract. */
export class FakeModelProvider implements ModelProvider {
  readonly providerId = QODER_PROVIDER_ID;
  private readonly models = new Map<string, Model>();
  private readonly configs = new Map<string, ModelConfig>();
  private readonly active = new Set<AbortController>();

  constructor(private readonly options: FakeModelProviderOptions) {
    this.model(options.defaultModelKey);
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    for (const controller of this.active) controller.abort(createAbortError());
    return Promise.resolve();
  }

  listModels(): Promise<Model[]> {
    return Promise.resolve([...this.models.values()]);
  }

  getModel(key: string): Promise<Model> {
    return Promise.resolve(this.model(key));
  }

  private model(key: string): Model {
    let model = this.models.get(key);
    if (!model) {
      model = {
        source: this.providerId,
        key,
        displayName: key,
        capabilities: {
          tools: true,
          vision: true,
          reasoning: {
            supported: true,
            supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          },
          contextWindows: [{ tokens: 200_000 }],
        },
        limits: { maxContextTokens: 200_000, maxOutputTokens: 32_000 },
      };
      this.models.set(key, model);
    }
    return model;
  }

  getModelConfig(model: Model): ModelConfig | undefined {
    return this.configs.get(model.key);
  }

  setModelConfig(model: Model, patch: ModelConfig): boolean {
    const previous = this.configs.get(model.key);
    this.configs.set(model.key, {
      ...previous,
      ...patch,
      ...(patch.reasoning && {
        reasoning: { ...previous?.reasoning, ...patch.reasoning },
      }),
      ...(patch.context && {
        context: { ...previous?.context, ...patch.context },
      }),
      ...(patch.sampling && {
        sampling: { ...previous?.sampling, ...patch.sampling },
      }),
    });
    return true;
  }

  async select(context: ModelSelectContext): Promise<ModelSelection> {
    const inherited = context.overrideSelection ?? context.parentSelection;
    const model =
      inherited && 'model' in inherited
        ? inherited.model
        : inherited?.key !== undefined
          ? this.model(inherited.key)
          : (context.parentSelection?.model ?? context.mainModel);
    if (!model) {
      throw new Error('Model selection requires a main model in context');
    }
    return {
      model,
      config: mergeModelConfig(
        this.getModelConfig(model),
        context.parentSelection?.model.key === model.key
          ? context.parentSelection.config
          : undefined,
        context.overrideSelection?.config,
      ),
    };
  }

  async inference(request: ModelStreamRequest): Promise<ModelStreamResponse> {
    request.control?.signal?.throwIfAborted();
    const store = await this.options.getResponseStore();
    request.control?.signal?.throwIfAborted();
    if (!store) throw new Error('Fake response store is unavailable');
    const responses = store.getNextResponse('generateContentStream', request);
    if (!Array.isArray(responses) || responses.length === 0) {
      throw new Error('Fake generateContentStream response must not be empty');
    }
    const delayMs = getFakeStreamDelayMs();
    const controller = new AbortController();
    const combined = composeAbortSignals([
      controller.signal,
      ...(request.control?.signal ? [request.control.signal] : []),
    ]);
    this.active.add(controller);
    const response = createModelStreamResponse(
      replay(responses, request.resolution.model.key, delayMs, combined.signal),
      (reason) => controller.abort(reason ?? createAbortError()),
    );
    const cleanup = () => {
      this.active.delete(controller);
      combined.cleanup();
    };
    void response.completed.then(cleanup, cleanup);
    return {
      ...response,
      cancel: (reason) => {
        const abortReason = reason ?? createAbortError();
        controller.abort(abortReason);
        return response.cancel?.(abortReason);
      },
    };
  }
}

function getFakeStreamDelayMs(): number | undefined {
  const raw = process.env[ENV_FAKE_STREAM_DELAY_MS];
  if (raw === undefined) return undefined;
  const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Invalid ${ENV_FAKE_STREAM_DELAY_MS}=${JSON.stringify(raw)}: ` +
        'expected a finite non-negative number of milliseconds',
    );
  }
  return parsed;
}

async function* replay(
  responses: GenerateContentResponse[],
  model: string,
  delayMs: number | undefined,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  // Preserve legacy replay: env unset uses only the final response and includes
  // thought text; paced mode combines visible chunks and collects all tool calls.
  const selected = delayMs === undefined ? responses.slice(-1) : responses;
  const textChunks: string[] = [];
  const blocks: ModelContentBlock[] = [];
  let usage: GenerateContentResponse['usageMetadata'];
  let finishReason: string | undefined;
  for (const response of selected) {
    let chunk = '';
    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (part.text && (delayMs === undefined || !part.thought)) {
        if (delayMs === undefined)
          blocks.push({ type: 'text', text: part.text });
        else chunk += part.text;
      }
      if (part.functionCall?.name) {
        blocks.push({
          type: 'tool_use',
          id: `toolu_${randomUUID()}`,
          name: part.functionCall.name,
          input: isRecord(part.functionCall.args) ? part.functionCall.args : {},
        });
      }
    }
    if (chunk) textChunks.push(chunk);
    if (response.usageMetadata) usage = response.usageMetadata;
    if (response.candidates?.[0]?.finishReason) {
      finishReason = response.candidates[0].finishReason;
    }
  }
  if (textChunks.length) {
    blocks.unshift({ type: 'text', text: textChunks.join('') });
  }
  signal.throwIfAborted();
  yield {
    type: 'message_start',
    message: { id: `msg_${randomUUID()}`, role: 'assistant', model },
  };
  const startedAt = performance.now();
  for (const [index, block] of blocks.entries()) {
    signal.throwIfAborted();
    if (block.type === 'text') {
      yield {
        type: 'content_block_start',
        index,
        contentBlock: { type: 'text', text: '' },
      };
      const chunks = delayMs === undefined ? [block.text] : textChunks;
      for (const [chunkIndex, text] of chunks.entries()) {
        const wait =
          startedAt + chunkIndex * (delayMs ?? 0) - performance.now();
        if (wait > 0) await delay(wait, signal);
        signal.throwIfAborted();
        yield {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text },
        };
      }
    } else if (block.type === 'tool_use') {
      yield {
        type: 'content_block_start',
        index,
        contentBlock: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      };
      yield {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input),
        },
      };
    }
    signal.throwIfAborted();
    yield { type: 'content_block_stop', index };
  }
  signal.throwIfAborted();
  yield {
    type: 'message_delta',
    delta: {
      stopReason: ['content_filter', 'refusal', 'sensitive'].includes(
        finishReason ?? '',
      )
        ? 'refusal'
        : blocks.some((block) => block.type === 'tool_use')
          ? 'tool_use'
          : 'end_turn',
    },
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    },
  };
  yield { type: 'message_stop' };
}
