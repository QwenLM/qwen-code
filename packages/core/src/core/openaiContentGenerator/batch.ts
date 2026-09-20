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
// A settled status normally appears at `expires_at`; this grace covers clock
// skew and a slow final status flip before the wait is abandoned.
const EXPIRY_GRACE_S = 600;
// The provider's completion window is documented as *at least* 24h, so that
// is the bound used when a job reports no `expires_at` of its own.
const MIN_WINDOW_S = 24 * 60 * 60;

interface BatchOutputLine {
  custom_id: string;
  response?: { status_code: number; body: unknown };
  error?: { message?: string } | null;
}

/**
 * A batch failure that must never be retried by the caller.
 *
 * `retryWithBackoff` re-invokes `runBatchCompletion` from the top, which
 * uploads a new input file and creates a SECOND paid job — and when the give-up
 * came from failed polling, the first one is still running, still billing and
 * now unreachable. A plain `Error` is not enough to prevent that: this repo's
 * classifier reads provider payloads out of message TEXT (`getErrorCode` parses
 * the first `{...}` it finds, `getErrorStatus` matches `HTTP_STATUS/\d{3}`,
 * `isStatuslessThrottle` sniffs for rate-limit bodies), and these messages
 * interpolate provider-authored detail. The type is what `shouldRetryOnError`
 * fails fast on, so the invariant holds whatever DashScope happened to return.
 */
export class BatchNotRetryableError extends Error {
  override readonly name = 'BatchNotRetryableError';
}

// Mirrors MAX_TRANSPORT_CAUSE_DEPTH in utils/retryErrorClassification.ts:
// wrappers nest only a handful of times before the predicate gives up.
const MAX_CAUSE_DEPTH = 4;

/**
 * True when `error` is — or wraps — a BatchNotRetryableError.
 *
 * Matched by name, not `instanceof`, so callers need no import of the class
 * itself, and walked along the `cause` chain because the pipeline's error
 * handler rethrows a timeout-shaped give-up as a plain `Error` carrying the
 * original as `cause` (and `redactProxyError` may clone either link, again
 * preserving `name`). Keep this function in this module: `llm-chat.ts` is
 * re-exported from the package barrel, and this retry policy is not public
 * API (same rule as stream-transport-retry.ts).
 */
export function isNonRetryableBatchError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) return false;
    if (current.name === 'BatchNotRetryableError') return true;
    current = current.cause;
  }
  return false;
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
 * Costs of the bypass: no `maxRetries`, the `QWEN_TLS_INSECURE` dispatcher is
 * not applied (it is pinned onto the SDK's custom fetch, not the global one),
 * and a hand-formatted error instead of a typed `APIError` — so the HTTP
 * status is stamped onto the thrown error for the caller's classifier, and
 * the client's `customHeaders` are passed in explicitly. The global fetch
 * does honour the process-wide proxy dispatcher installed by
 * `Config.initialize`, which this path runs after.
 */
async function uploadInputFile(
  client: OpenAI,
  jsonl: string,
  signal?: AbortSignal,
  customHeaders?: Record<string, string>,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new File([jsonl], 'turn.jsonl'));
  const res = await fetch(`${client.baseURL.replace(/\/+$/, '')}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${client.apiKey}`, ...customHeaders },
    body: form,
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw Object.assign(
      new Error(`POST /files -> HTTP ${res.status}: ${detail}`),
      { status: res.status },
    );
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
  customHeaders?: Record<string, string>,
): Promise<OpenAI.Chat.ChatCompletion> {
  const { stream: _stream, stream_options: _streamOptions, ...body } = request;
  const line = JSON.stringify({
    custom_id: 'turn',
    method: 'POST',
    url: '/v1/chat/completions',
    body,
  });
  const file = await uploadInputFile(
    client,
    line + '\n',
    signal,
    customHeaders,
  );
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
    try {
      // maxRetries: 0 — POST /batches is not idempotent and carries no
      // idempotency key, so the SDK's own retry could start a second paid
      // job underneath the caller's retry policy, which owns retries here.
      batch = await client.batches.create(
        {
          input_file_id: file.id,
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
        },
        { signal, maxRetries: 0 },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      // The create may or may not have been accepted server-side; either way
      // a caller-side retry would risk a duplicate paid job, so fail fast by
      // type. The uploaded input file is deleted by the `finally`.
      const detail = error instanceof Error ? error.message : String(error);
      throw new BatchNotRetryableError(
        `Batch create failed after the input file was uploaded: ${detail}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
    // Written to stderr, not only debug-logged: if this process dies mid-wait
    // the id is the only handle left (`qwen batch fetch <id>`).
    const dueBy = batch.expires_at
      ? new Date(batch.expires_at * 1000).toISOString()
      : 'unknown';
    process.stderr.write(
      `[batch] submitted ${batch.id}; results due by ${dueBy}\n`,
    );
    let pollFailures = 0;
    const waitStartedAt = Date.now();
    while (!SETTLED.has(batch.status)) {
      await sleep(pollMs, signal);
      // A job is supposed to settle by its own deadline; if the provider
      // never flips the status the loop would otherwise wait forever, so
      // give up shortly after expiry and leave the job recoverable.
      // `expires_at` is not always populated (observed null on a token-plan
      // endpoint), so fall back to the documented minimum window measured
      // from the start of this wait — the job was created moments ago.
      const deadlineMs = batch.expires_at
        ? (batch.expires_at + EXPIRY_GRACE_S) * 1000
        : waitStartedAt + (MIN_WINDOW_S + EXPIRY_GRACE_S) * 1000;
      if (Date.now() > deadlineMs) {
        abandoned = true;
        throw new BatchNotRetryableError(
          `Batch ${batch.id} passed its completion window ` +
            `${batch.expires_at ? `(${new Date(batch.expires_at * 1000).toISOString()}) ` : ''}` +
            `without settling. It may still finish — recover the result with ` +
            `\`qwen batch fetch ${batch.id}\`.`,
        );
      }
      // One child signal per poll: the SDK adds an abort listener per
      // request attempt and never removes it, so reusing the turn-long
      // signal would pile thousands of listeners onto it over a 24h wait.
      const pollAc = new AbortController();
      const abortPoll = () => pollAc.abort();
      signal?.addEventListener('abort', abortPoll, { once: true });
      try {
        batch = await client.batches.retrieve(batch.id, {
          signal: pollAc.signal,
        });
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
          throw new BatchNotRetryableError(
            `Batch ${batch.id} is still running, but polling it failed ` +
              `${pollFailures} times in a row (${detail}). Recover the result ` +
              `with \`qwen batch fetch ${batch.id}\`.`,
          );
        }
        debugLogger.debug(
          `batch ${batch.id} poll failed (${pollFailures}/${MAX_POLL_FAILURES}): ${detail}`,
        );
        continue;
      } finally {
        signal?.removeEventListener('abort', abortPoll);
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
      // A job that settles without completing can still hold lines it already
      // finished and was paid for (`expired`, or `failed` after partial
      // progress). Deleting that output would destroy a purchased result, so
      // keep every file and name the recovery command on stderr — the
      // pipeline's error handler rewrites the message, so the hint cannot
      // ride on the throw alone.
      if (batch.output_file_id) {
        abandoned = true;
        process.stderr.write(
          `[batch] ${batch.id} settled as ${batch.status}; keeping its files. ` +
            `Recover what it produced with \`qwen batch fetch ${batch.id}\`.\n`,
        );
      }
      throw new BatchNotRetryableError(
        `Batch ${batch.id} ${batch.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    // A failure reading the result of a settled, paid job must not escape
    // untyped: the caller's retry would create a second job, and the
    // `finally` would delete the completed output. Keep the files and point
    // at the recovery command instead.
    let output: BatchOutputLine | undefined;
    try {
      [output] = await readLines(client, batch.output_file_id);
    } catch (error) {
      if (signal?.aborted) throw error;
      abandoned = true;
      const readDetail = error instanceof Error ? error.message : String(error);
      throw new BatchNotRetryableError(
        `Batch ${batch.id} settled, but reading its output failed ` +
          `(${readDetail}). Recover the result with \`qwen batch fetch ${batch.id}\`.`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
    if (output?.response?.status_code === 200) {
      return output.response.body as OpenAI.Chat.ChatCompletion;
    }
    const detail =
      (await failureDetail(client, batch.error_file_id)) ??
      output?.error?.message ??
      (output?.response?.body as { error?: { message?: string } } | undefined)
        ?.error?.message ??
      'no output';
    throw new BatchNotRetryableError(
      `Batch ${batch.id} request failed: ${detail}`,
    );
  } catch (error) {
    if (signal?.aborted && batch && !SETTLED.has(batch.status)) {
      // Short timeout, no SDK retries: the user is waiting on the interrupt,
      // and a non-idempotent cancel must not pile up attempts.
      const cancelled = await client.batches
        .cancel(batch.id, { maxRetries: 0, timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (!cancelled) {
        // The job may still be running and billing; keep its files and say
        // so, rather than exiting clean while the meter runs.
        abandoned = true;
        process.stderr.write(
          `[batch] could not cancel ${batch.id} (it may still be running). ` +
            `Check with \`qwen batch status ${batch.id}\`, cancel with ` +
            `\`qwen batch cancel ${batch.id}\`.\n`,
        );
      }
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
