/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { ContentGenerator } from '../contentGenerator.js';
import type {
  RedactionManager,
  TextStreamRestorer,
} from '../../security/redaction.js';

export class RedactingContentGenerator implements ContentGenerator {
  constructor(
    private readonly wrapped: ContentGenerator,
    private readonly redaction: RedactionManager,
  ) {}

  getWrapped(): ContentGenerator {
    return this.wrapped;
  }

  async generateContent(
    req: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const redactedReq = this.redactRequest(req);
    const response = await this.wrapped.generateContent(
      redactedReq,
      userPromptId,
    );
    return this.restoreResponse(response);
  }

  async generateContentStream(
    req: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const redactedReq = this.redactRequest(req);
    const stream = await this.wrapped.generateContentStream(
      redactedReq,
      userPromptId,
    );
    return this.restoreStream(stream);
  }

  async countTokens(req: CountTokensParameters): Promise<CountTokensResponse> {
    // Token counting should not leak secrets to providers.
    const redactedReq = this.redactRequest(req);
    return this.wrapped.countTokens(redactedReq);
  }

  async embedContent(
    req: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    // Embeddings are provider calls; apply the same redaction rule.
    const redactedReq = this.redactRequest(req);
    return this.wrapped.embedContent(redactedReq);
  }

  useSummarizedThinking(): boolean {
    return this.wrapped.useSummarizedThinking();
  }

  private redactRequest<T extends { contents: unknown }>(req: T): T {
    if (!this.redaction.isEnabled()) {
      return req;
    }

    // Only redact the contents; preserve other request properties.
    return {
      ...req,
      contents: this.redaction.redactContents(req.contents as never),
    };
  }

  private restoreResponse(
    response: GenerateContentResponse,
  ): GenerateContentResponse {
    if (!this.redaction.isEnabled()) {
      return response;
    }

    for (const candidate of response.candidates ?? []) {
      const parts = candidate.content?.parts;
      if (!parts) continue;

      for (const part of parts) {
        if (!part) continue;
        if (typeof part.text === 'string' && part.text) {
          part.text = this.redaction.restoreString(part.text);
        }
        if (part.functionCall?.args) {
          part.functionCall.args = this.redaction.restoreUnknown(
            part.functionCall.args,
          ) as Record<string, unknown>;
        }
      }
    }

    // Also restore tool call args if the SDK exposes them separately.
    const responseWithFunctionCalls = response as unknown as {
      functionCalls?: Array<{ args?: unknown }>;
    };
    if (Array.isArray(responseWithFunctionCalls.functionCalls)) {
      for (const fnCall of responseWithFunctionCalls.functionCalls) {
        if (!fnCall?.args) continue;
        fnCall.args = this.redaction.restoreUnknown(fnCall.args);
      }
    }

    return response;
  }

  private async *restoreStream(
    stream: AsyncGenerator<GenerateContentResponse>,
  ): AsyncGenerator<GenerateContentResponse> {
    if (!this.redaction.isEnabled()) {
      yield* stream;
      return;
    }

    const restorer = this.redaction.createStreamRestorer();
    for await (const chunk of stream) {
      yield this.restoreStreamChunk(chunk, restorer);
    }
  }

  private restoreStreamChunk(
    chunk: GenerateContentResponse,
    restorer: TextStreamRestorer,
  ): GenerateContentResponse {
    for (const candidate of chunk.candidates ?? []) {
      const parts = candidate.content?.parts;
      if (!parts) continue;

      for (const part of parts) {
        if (!part) continue;

        // Restore non-thought text incrementally to handle placeholders split across chunks.
        if (typeof part.text === 'string' && part.text) {
          part.text = part.thought
            ? this.redaction.restoreString(part.text)
            : restorer.feed(part.text);
        }

        if (part.functionCall?.args) {
          part.functionCall.args = this.redaction.restoreUnknown(
            part.functionCall.args,
          ) as Record<string, unknown>;
        }
      }

      if (candidate.finishReason) {
        const tail = restorer.flush();
        if (tail) {
          const target = parts
            .slice()
            .reverse()
            .find((p) => p && typeof p.text === 'string' && !p.thought);
          if (target && typeof target.text === 'string') {
            target.text += tail;
          } else {
            parts.push({ text: tail });
          }
        }
      }
    }

    const chunkWithFunctionCalls = chunk as unknown as {
      functionCalls?: Array<{ args?: unknown }>;
    };
    if (Array.isArray(chunkWithFunctionCalls.functionCalls)) {
      for (const fnCall of chunkWithFunctionCalls.functionCalls) {
        if (!fnCall?.args) continue;
        fnCall.args = this.redaction.restoreUnknown(fnCall.args);
      }
    }

    return chunk;
  }
}
