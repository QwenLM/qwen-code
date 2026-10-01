/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Builders for the model-facing shapes core tests build most often:
// conversation content, function-call and function-response parts,
// streamed response chunks, and the streams that carry them.
//
// Each builder emits exactly the keys its arguments name, in the key order
// the hand-written literals use, and nothing else: an omitted optional
// argument means an absent key, never `undefined`. A test that needs an
// unusual shape (extra fields, missing `content`, a candidate without
// `role`) should keep its literal; that shape is usually the point.

import type {
  Content,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';

/** `{ role, parts }` with the given parts. */
export function content(role: 'user' | 'model', ...parts: Part[]): Content {
  return { role, parts };
}

/** A user turn holding one text part. */
export function userText(text: string): Content {
  return { role: 'user', parts: [{ text }] };
}

/** A model turn holding one text part. */
export function modelText(text: string): Content {
  return { role: 'model', parts: [{ text }] };
}

/** A `functionCall` part: `{ functionCall: { id?, name, args? } }`. */
export function fnCall(
  name: string,
  args?: Record<string, unknown>,
  id?: string,
): Part {
  return {
    functionCall: {
      ...(id !== undefined ? { id } : {}),
      name,
      ...(args !== undefined ? { args } : {}),
    },
  };
}

/** A `functionResponse` part: `{ functionResponse: { id?, name, response } }`. */
export function fnResponse(
  name: string,
  response: Record<string, unknown>,
  id?: string,
): Part {
  return {
    functionResponse: {
      ...(id !== undefined ? { id } : {}),
      name,
      response,
    },
  };
}

/**
 * One streamed response chunk: a single model candidate carrying `parts`,
 * with `finishReason` and top-level `usageMetadata` only when given.
 */
export function modelChunk(
  // unknown[] rather than Part[]: tests pass provider-specific or deliberately
  // malformed parts through this builder.
  parts: unknown[],
  finishReason?: string,
  usageMetadata?: GenerateContentResponseUsageMetadata,
): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { role: 'model', parts },
        ...(finishReason !== undefined ? { finishReason } : {}),
      },
    ],
    ...(usageMetadata !== undefined ? { usageMetadata } : {}),
  } as unknown as GenerateContentResponse;
}

/** An async generator that yields `items` in order and completes. */
export function streamOf<T>(...items: T[]): AsyncGenerator<T> {
  return (async function* () {
    yield* items;
  })();
}

/** Consume an async iterable to completion, discarding what it yields. */
export async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
    // consume
  }
}

/** Collect everything an async iterable yields, in order. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
