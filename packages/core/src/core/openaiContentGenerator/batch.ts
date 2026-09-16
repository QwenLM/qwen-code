/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('OPENAI_BATCH');
const SETTLED = new Set(['completed', 'failed', 'expired', 'cancelled']);

interface BatchOutputLine {
  custom_id: string;
  response?: { status_code: number; body: unknown };
  error?: { message?: string } | null;
}

const abortError = () =>
  Object.assign(new Error('Batch request aborted'), { name: 'AbortError' });

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readLines(
  client: OpenAI,
  fileId: string | null | undefined,
): Promise<BatchOutputLine[]> {
  if (!fileId) return [];
  const text = await (await client.files.content(fileId)).text();
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as BatchOutputLine);
}

/**
 * Run one chat-completions request through the OpenAI-compatible Batch API:
 * upload a single-line JSONL, create the batch, poll until it settles, read
 * the output file. Batch has no streaming, so `stream` is stripped and the
 * caller gets a plain completion. Aborting cancels the batch server-side
 * (already-completed requests are still billed). Uploaded and produced files
 * are deleted on the way out.
 */
export async function runBatchCompletion(
  client: OpenAI,
  request: OpenAI.Chat.ChatCompletionCreateParams,
  signal?: AbortSignal,
  pollMs = 30_000,
): Promise<OpenAI.Chat.ChatCompletion> {
  const { stream: _stream, stream_options: _streamOptions, ...body } = request;
  const line = JSON.stringify({
    custom_id: 'turn',
    method: 'POST',
    url: '/v1/chat/completions',
    body,
  });
  const file = await client.files.create(
    { file: new File([line + '\n'], 'turn.jsonl'), purpose: 'batch' },
    { signal },
  );
  const fileIds = [file.id];
  let batch = await client.batches.create(
    {
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    },
    { signal },
  );
  // Written to stderr, not only debug-logged: if this process dies mid-wait
  // the id is the only handle left (`qwen batch fetch <id>`).
  const dueBy = batch.expires_at
    ? new Date(batch.expires_at * 1000).toISOString()
    : 'unknown';
  process.stderr.write(
    `[batch] submitted ${batch.id}; results due by ${dueBy}\n`,
  );
  try {
    while (!SETTLED.has(batch.status)) {
      await sleep(pollMs, signal);
      batch = await client.batches.retrieve(batch.id, { signal });
      debugLogger.debug(`batch ${batch.id} ${batch.status}`);
    }
    if (batch.output_file_id) fileIds.push(batch.output_file_id);
    if (batch.error_file_id) fileIds.push(batch.error_file_id);
    if (batch.status !== 'completed') {
      throw new Error(`Batch ${batch.id} ${batch.status}`);
    }
    const [output] = await readLines(client, batch.output_file_id);
    if (output?.response?.status_code === 200) {
      return output.response.body as OpenAI.Chat.ChatCompletion;
    }
    const [failure] = await readLines(client, batch.error_file_id);
    const detail =
      failure?.error?.message ??
      output?.error?.message ??
      (output?.response?.body as { error?: { message?: string } } | undefined)
        ?.error?.message ??
      'no output';
    throw new Error(`Batch ${batch.id} request failed: ${detail}`);
  } catch (error) {
    if (signal?.aborted && !SETTLED.has(batch.status)) {
      await client.batches.cancel(batch.id).catch(() => undefined);
    }
    throw error;
  } finally {
    await Promise.allSettled(fileIds.map((id) => client.files.delete(id)));
  }
}

/** Replay a finished completion as the single chunk of a stream. */
export function completionAsChunk(
  completion: OpenAI.Chat.ChatCompletion,
): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
    usage: completion.usage ?? null,
    choices: completion.choices.map((choice) => {
      // DashScope thinking lives outside the SDK's message type.
      const { reasoning_content } = choice.message as {
        reasoning_content?: string;
      };
      return {
        index: choice.index,
        finish_reason: choice.finish_reason,
        delta: {
          role: choice.message.role,
          content: choice.message.content,
          ...(reasoning_content !== undefined && { reasoning_content }),
          ...(choice.message.tool_calls && {
            tool_calls: choice.message.tool_calls.map((call, index) => ({
              index,
              ...call,
            })),
          }),
        },
      };
    }),
  } as OpenAI.Chat.ChatCompletionChunk;
}

export async function* singleChunkStream(
  chunk: OpenAI.Chat.ChatCompletionChunk,
): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
  yield chunk;
}
