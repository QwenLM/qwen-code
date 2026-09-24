/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// HTTP client pieces for the DashScope Batch API, shared by the low-level
// `qwen batch submit|status|fetch|cancel` commands (batch.ts) and the
// agent-prepared workflow (batch-workflow.ts). One fetch wrapper carries the
// HTTP status on every failure so callers can tell a definite provider
// refusal (4xx) from an ambiguous one (5xx or a dropped socket after the
// provider accepted the work) — the two need opposite recovery behaviour.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BatchEndpoint, BatchJob } from './batch.js';

export const SETTLED_STATUSES = new Set([
  'completed',
  'failed',
  'expired',
  'cancelled',
]);

// Provider ceilings for one batch input file, checked locally so an
// out-of-range file is refused before it is uploaded rather than after — the
// upload is the slow, billable half of the mistake. These are the numbers the
// user doc states (docs/users/features/batch.md); if the provider raises them,
// both move together.
export const MAX_REQUESTS_PER_FILE = 50_000;
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_LINE_BYTES = 6 * 1024 * 1024;
// `completion_window` bounds, in hours: the provider offers 24h to 14d.
const MIN_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 14 * 24;

/**
 * Reject a completion window the provider does not offer, before anything is
 * uploaded. Forwarding it verbatim costs a full upload to learn that `12h` is
 * not a window — a limit this PR's own docs state.
 */
export function assertValidWindow(window: string): void {
  const match = /^(\d+)([hd])$/.exec(window);
  if (!match) {
    throw new Error(
      `--window must be a number followed by h or d, e.g. 24h or 7d; got "${window}".`,
    );
  }
  const hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1);
  if (hours < MIN_WINDOW_HOURS || hours > MAX_WINDOW_HOURS) {
    throw new Error(`--window must be between 24h and 14d; got "${window}".`);
  }
}

export interface BatchApiError extends Error {
  status?: number;
}

// Every request below carries the API key. The routes this client builds are
// all of these shapes; anything else — an id from argv, a task ledger or a
// provider response that smuggled in `/`, `..` or `?` — would send the key to
// another path on the host, so it is refused before sending, whichever
// caller assembled it.
const BATCH_ROUTE =
  /^\/(?:batches|files)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/(?:cancel|content))?)?(?:\?[A-Za-z0-9_=&.-]*)?$/;

export async function batchRequest(
  ep: BatchEndpoint,
  route: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!BATCH_ROUTE.test(route)) {
    throw new Error(`refusing a request outside the Batch API paths: ${route}`);
  }
  const res = await fetch(`${ep.baseUrl}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${ep.apiKey}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    const error: BatchApiError = new Error(
      `${init.method ?? 'GET'} ${route} -> HTTP ${res.status}: ${detail}`,
    );
    error.status = res.status;
    throw error;
  }
  return res;
}

/** Upload an already-assembled JSONL payload as a batch input file. */
export async function uploadBatchJsonl(
  ep: BatchEndpoint,
  jsonl: string,
  filename: string,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl]), filename);
  return (await (
    await batchRequest(ep, '/files', { method: 'POST', body: form })
  ).json()) as { id: string };
}

export async function createBatchJob(
  ep: BatchEndpoint,
  inputFileId: string,
  completionWindow: string,
): Promise<BatchJob> {
  return (await (
    await batchRequest(ep, '/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input_file_id: inputFileId,
        endpoint: '/v1/chat/completions',
        completion_window: completionWindow,
      }),
    })
  ).json()) as BatchJob;
}

export const getBatchJob = async (ep: BatchEndpoint, id: string) =>
  (await (await batchRequest(ep, `/batches/${id}`)).json()) as BatchJob;

export async function cancelBatchJob(
  ep: BatchEndpoint,
  id: string,
): Promise<BatchJob> {
  return (await (
    await batchRequest(ep, `/batches/${id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  ).json()) as BatchJob;
}

/** Page through the account's recent batches (used to reconcile an
 * ambiguous create: the job may exist even though its id never reached us). */
export async function listBatchJobs(
  ep: BatchEndpoint,
  limit = 100,
): Promise<BatchJob[]> {
  const jobs: BatchJob[] = [];
  let after: string | undefined;
  for (;;) {
    const query = after ? `?limit=${limit}&after=${after}` : `?limit=${limit}`;
    const page = (await (
      await batchRequest(ep, `/batches${query}`)
    ).json()) as { data?: BatchJob[]; has_more?: boolean };
    jobs.push(...(page.data ?? []));
    if (!page.has_more || page.data === undefined || page.data.length === 0) {
      return jobs;
    }
    after = page.data[page.data.length - 1]?.id;
    if (!after) return jobs;
  }
}

/**
 * Download one remote file to `target`, staging under `.part` and renaming
 * only once the body is fully consumed: a download cut short would otherwise
 * leave a truncated file under the exact name a complete one has — and its
 * last line can still be valid JSON, so nothing about it announces that the
 * paid result is short.
 */
export async function downloadRemoteFile(
  ep: BatchEndpoint,
  fileId: string,
  target: string,
): Promise<void> {
  const res = await batchRequest(ep, `/files/${fileId}/content`);
  if (!res.body) throw new Error(`empty response for ${fileId}`);
  const partial = `${target}.part`;
  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      fs.createWriteStream(partial),
    );
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  fs.renameSync(partial, target);
}

/** Deletion is best-effort by contract: callers report failures and move on
 * because the downloaded results are already safe locally. */
export async function deleteRemoteFile(
  ep: BatchEndpoint,
  fileId: string,
): Promise<void> {
  await batchRequest(ep, `/files/${fileId}`, { method: 'DELETE' });
}
