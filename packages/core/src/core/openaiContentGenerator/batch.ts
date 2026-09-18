/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('OPENAI_BATCH');
const SETTLED = new Set(['completed', 'failed', 'expired', 'cancelled']);
// Consecutive failed polls tolerated before the wait is abandoned. A batch
// runs for hours on the provider's side, so a blip while asking after it must
// not end the turn — but a persistently unreachable endpoint must not spin
// forever either.
const MAX_POLL_FAILURES = 5;

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
 * First error message in a batch's error file, or undefined when there is no
 * error file or it cannot be read — a download failure must not mask the
 * batch status the caller is about to report.
 */
async function failureDetail(
  client: OpenAI,
  errorFileId: string | null | undefined,
): Promise<string | undefined> {
  try {
    const [failure] = await readLines(client, errorFileId);
    return (
      failure?.error?.message ??
      (failure?.response?.body as { error?: { message?: string } } | undefined)
        ?.error?.message
    );
  } catch {
    return undefined;
  }
}

/**
 * Upload the single-line JSONL input file and return the created file id.
 *
 * Not `client.files.create`: the SDK rejects multipart whenever the client
 * carries a custom `fetch`, and every Node run installs one (undici's fetch,
 * pinned to the timeout-free dispatcher in runtimeFetchOptions.ts). The SDK
 * probes support by serializing a global `FormData` through that fetch's
 * `Response` class, gets back "[object FormData]", and throws "The provided
 * fetch function does not support file uploads". The global fetch used here
 * takes the same route `qwen batch submit` already uses.
 *
 * Costs of the bypass: no `maxRetries`, no proxy/`QWEN_TLS_INSECURE`
 * dispatcher, no SDK default or user `customHeaders`, and a hand-formatted
 * error instead of a typed `APIError`. Deliberate — it keeps this line for
 * line consistent with the `qwen batch submit` uploader in
 * packages/cli/src/commands/batch.ts, so both halves fail the same way.
 */
async function uploadInputFile(
  client: OpenAI,
  jsonl: string,
  signal?: AbortSignal,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new File([jsonl], 'turn.jsonl'));
  const res = await fetch(`${client.baseURL.replace(/\/+$/, '')}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${client.apiKey}` },
    body: form,
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`POST /files -> HTTP ${res.status}: ${detail}`);
  }
  return (await res.json()) as { id: string };
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
  const file = await uploadInputFile(client, line + '\n', signal);
  const fileIds = [file.id];
  // Set when the job is left running on purpose: the wait was abandoned but
  // the batch is neither settled nor cancelled, so its files must survive for
  // `qwen batch fetch <id>` to recover it.
  let abandoned = false;
  // Declared outside the `try` because `create` is inside it: the `finally`
  // must also cover a failed `create`, or the already-uploaded (and billed)
  // input file is orphaned, and the `catch` needs to tell "create threw"
  // (nothing to cancel) from "polling threw" without hitting a TDZ.
  let batch: Awaited<ReturnType<typeof client.batches.create>> | undefined;
  try {
    batch = await client.batches.create(
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
    let pollFailures = 0;
    while (!SETTLED.has(batch.status)) {
      await sleep(pollMs, signal);
      try {
        batch = await client.batches.retrieve(batch.id, { signal });
        pollFailures = 0;
      } catch (error) {
        if (signal?.aborted) throw error;
        // A transient error here must not escape as-is. The caller's
        // `retryWithBackoff` retries transport errors and 429/5xx, and a retry
        // of this function uploads and creates a SECOND batch — the first one
        // keeps running and billing, unreachable. So poll failures are
        // absorbed here, and the give-up error is a plain one the outer retry
        // will not act on.
        const detail = error instanceof Error ? error.message : String(error);
        if (++pollFailures > MAX_POLL_FAILURES) {
          abandoned = true;
          throw new Error(
            `Batch ${batch.id} is still running, but polling it failed ` +
              `${pollFailures} times in a row (${detail}). Recover the result ` +
              `with \`qwen batch fetch ${batch.id}\`.`,
          );
        }
        debugLogger.debug(
          `batch ${batch.id} poll failed (${pollFailures}/${MAX_POLL_FAILURES}): ${detail}`,
        );
        continue;
      }
      debugLogger.debug(`batch ${batch.id} ${batch.status}`);
    }
    if (batch.output_file_id) fileIds.push(batch.output_file_id);
    if (batch.error_file_id) fileIds.push(batch.error_file_id);
    if (batch.status !== 'completed') {
      // Read the error file before `finally` deletes it: a settled-but-failed
      // batch carries its reason only there, and a bare "failed" leaves
      // nothing to debug with once the remote file is gone.
      const detail = await failureDetail(client, batch.error_file_id);
      throw new Error(
        `Batch ${batch.id} ${batch.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    const [output] = await readLines(client, batch.output_file_id);
    if (output?.response?.status_code === 200) {
      return output.response.body as OpenAI.Chat.ChatCompletion;
    }
    const detail =
      (await failureDetail(client, batch.error_file_id)) ??
      output?.error?.message ??
      (output?.response?.body as { error?: { message?: string } } | undefined)
        ?.error?.message ??
      'no output';
    throw new Error(`Batch ${batch.id} request failed: ${detail}`);
  } catch (error) {
    if (signal?.aborted && batch && !SETTLED.has(batch.status)) {
      await client.batches.cancel(batch.id).catch(() => undefined);
    }
    throw error;
  } finally {
    // An abandoned job still needs its input file (the provider is reading it)
    // and will write its output into the account the user recovers from.
    if (!abandoned) {
      await Promise.allSettled(fileIds.map((id) => client.files.delete(id)));
    }
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
