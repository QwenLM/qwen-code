// Shared helpers for the Bailian Batch API probes. Node >= 20, run from the
// repo root so `openai` resolves from the workspace node_modules.
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_URL =
  process.env.DASHSCOPE_BASE_URL ??
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const MODEL = process.env.BATCH_MODEL ?? 'qwen-plus';
export const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'out',
);
fs.mkdirSync(OUT, { recursive: true });

const TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled']);

export function client() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    console.error('DASHSCOPE_API_KEY is not set');
    process.exit(2);
  }
  return new OpenAI({ apiKey, baseURL: BASE_URL });
}

export const ts = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One JSONL request line in the shape /batches expects. */
export function line(customId, body) {
  return {
    custom_id: String(customId),
    method: 'POST',
    url: '/v1/chat/completions',
    body,
  };
}

export function writeJsonl(name, lines) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

export function save(name, obj) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  console.log(`saved ${path.relative(process.cwd(), p)}`);
}

/** files.create(purpose=batch) → batches.create. Returns the batch object. */
export async function submit(oa, jsonlPath, { window = '24h', metadata } = {}) {
  const file = await oa.files.create({
    file: fs.createReadStream(jsonlPath),
    purpose: 'batch',
  });
  let batch;
  try {
    batch = await oa.batches.create(
      {
        input_file_id: file.id,
        endpoint: '/v1/chat/completions',
        completion_window: window,
        ...(metadata ? { metadata } : {}),
      },
      // POST /batches is not idempotent and carries no idempotency key, so
      // the SDK's default two retries can each start another live, paid 24h
      // job whose id nobody records. The production path does the same.
      { maxRetries: 0 },
    );
  } catch (error) {
    // The upload is already a billable object. A 4xx is the provider refusing
    // the job, so the file is an orphan worth deleting; anything else is
    // ambiguous — the job may exist and be billing, and deleting its input
    // would break it.
    const status = error?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      console.warn(
        ts(),
        `batches.create failed; deleting orphaned input file ${file.id}`,
      );
      await oa.files.delete(file.id).catch(() => {});
    } else {
      console.warn(
        ts(),
        `batches.create failed ambiguously; keeping input file ${file.id} ` +
          `(the job may exist)`,
      );
    }
    throw error;
  }
  console.log(ts(), `submitted ${batch.id} (input ${file.id})`);
  return batch;
}

/** Poll until a terminal status. Logs status + request_counts each tick. */
export async function waitFor(oa, id, { every = 30_000, quiet = false } = {}) {
  for (;;) {
    const b = await oa.batches.retrieve(id);
    if (!quiet) {
      console.log(
        ts(),
        id,
        b.status,
        JSON.stringify(b.request_counts ?? {}),
        phase(b),
      );
    }
    if (TERMINAL.has(b.status)) return b;
    await sleep(every);
  }
}

/** Human-readable "queued for Xs / running for Ys" from the timestamps. */
export function phase(b) {
  const now = Math.floor(Date.now() / 1000);
  if (!b.in_progress_at) return `queued ${now - b.created_at}s`;
  if (!b.completed_at)
    return `queued ${b.in_progress_at - b.created_at}s, running ${now - b.in_progress_at}s`;
  return `queued ${b.in_progress_at - b.created_at}s, ran ${b.completed_at - b.in_progress_at}s`;
}

/** Download a result/error file and parse its JSONL. */
export async function download(oa, fileId) {
  if (!fileId) return [];
  const res = await oa.files.content(fileId);
  const text = await res.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Both result files, keyed by custom_id.
 *
 * `rows` is every line of the output file; `ok` is only the lines whose
 * `response.status_code` is 200. The split matters: a request can fail
 * *inside* the output file, and the provider still counts it as completed
 * (`request_counts.failed` stays 0), so labelling every output row `ok` lets
 * a batch in which all three requests failed read as PASS.
 */
export async function collect(oa, batch) {
  const rows = await download(oa, batch.output_file_id);
  const err = await download(oa, batch.error_file_id);
  const ok = rows.filter((r) => r?.response?.status_code === 200);
  const byId = {};
  for (const r of rows) byId[r.custom_id] = r;
  for (const r of err) byId[r.custom_id] = r;
  return { rows, ok, failed: rows.length - ok.length, err, byId };
}

export const bodyOf = (r) => r?.response?.body;
export const usageOf = (r) => bodyOf(r)?.usage;
export const cachedOf = (r) =>
  usageOf(r)?.prompt_tokens_details?.cached_tokens ??
  usageOf(r)?.cached_tokens ??
  0;

/** Delete input/output/error files once results are on disk (see plan §8.1 D). */
export async function cleanup(oa, batch) {
  for (const id of [
    batch.input_file_id,
    batch.output_file_id,
    batch.error_file_id,
  ]) {
    if (!id) continue;
    try {
      await oa.files.delete(id);
    } catch (e) {
      console.warn(`files.delete(${id}) failed: ${e.message}`);
    }
  }
}
