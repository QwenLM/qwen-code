/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentResponse,
  CountTokensResponse,
  EmbedContentResponse,
} from '@google/genai';
import { promises } from 'node:fs';
import { ENV_FAKE_STREAM_DELAY_MS } from '../config/brand.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import { SessionIdInvariantError } from '../utils/sessionIdInvariantError.js';

export type FakeResponse =
  | {
      method: 'generateContent';
      response: GenerateContentResponse;
    }
  | {
      method: 'generateContentStream';
      response: GenerateContentResponse[];
    }
  | {
      method: 'countTokens';
      response: CountTokensResponse;
    }
  | {
      method: 'embedContent';
      response: EmbedContentResponse;
    }
  | {
      method: 'utilityGenerateContent';
      response: string;
      /** Fails the fake request when the assembled wire session differs. */
      expectedSessionId?: string;
    };

export class FakeResponseStore {
  private callCounter = 0;
  private perMethodCursors = new Map<FakeResponse['method'], number>();

  constructor(private readonly responses: FakeResponse[]) {}

  static async fromFile(filePath: string): Promise<FakeResponseStore> {
    const fileContent = await promises.readFile(filePath, 'utf-8');
    const responses = fileContent
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as FakeResponse);
    return new FakeResponseStore(responses);
  }

  getNextResponse<
    M extends FakeResponse['method'],
    R = Extract<FakeResponse, { method: M }>['response'],
  >(method: M, request: unknown): R {
    // Streaming-replay mode (ENV_FAKE_STREAM_DELAY_MS set): consume per
    // method instead of one strict FIFO. Background utility calls (session
    // title, suggestions) fire concurrently with turns at nondeterministic
    // times; per-method queues keep turn replay deterministic regardless.
    // Legacy mode (env unset) stays bit-identical.
    if (process.env[ENV_FAKE_STREAM_DELAY_MS] !== undefined) {
      let cursor = this.perMethodCursors.get(method) ?? 0;
      while (cursor < this.responses.length && this.responses[cursor].method !== method) {
        cursor++;
      }
      const match = this.responses[cursor];
      this.perMethodCursors.set(method, cursor + 1);
      if (!match) {
        throw new Error(
          `No more mock responses for ${method}, got request:\n` +
            safeJsonStringify(request),
        );
      }
      return match.response as R;
    }

    const response = this.responses[this.callCounter++];
    if (!response) {
      throw new Error(
        `No more mock responses for ${method}, got request:\n` +
          safeJsonStringify(request),
      );
    }
    if (response.method !== method) {
      throw new Error(
        `Unexpected response type, next response was for ${response.method} but expected ${method}`,
      );
    }
    if (
      response.method === 'utilityGenerateContent' &&
      response.expectedSessionId !== undefined
    ) {
      const actualSessionId = (request as { sessionId?: unknown }).sessionId;
      if (actualSessionId !== response.expectedSessionId) {
        throw new SessionIdInvariantError(
          `Unexpected utility sessionId: expected ${JSON.stringify(response.expectedSessionId)}, got ${JSON.stringify(actualSessionId)}`,
        );
      }
    }
    return response.response as R;
  }
}
