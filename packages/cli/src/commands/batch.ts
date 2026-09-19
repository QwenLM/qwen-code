/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen batch' — submit, inspect, fetch, and cancel DashScope Batch
// API jobs. Batch runs at half the realtime price with a >=24h completion
// window, so it is a fan-out tool for many independent single-turn requests,
// not a path for the agent loop. Rationale and probe results:
// docs/plans/2026-09-14-batch-api-feasibility.md
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Argv, CommandModule } from 'yargs';
import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import { loadSettings } from '../config/settings.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../utils/modelConfigUtils.js';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import { resolveProxy } from './channel/proxy.js';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const SETTLED = new Set(['completed', 'failed', 'expired', 'cancelled']);

export interface BatchEndpoint {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface BatchJob {
  id: string;
  status: string;
  request_counts?: { total?: number; completed?: number; failed?: number };
  created_at: number;
  in_progress_at?: number;
  completed_at?: number;
  expires_at?: number;
  input_file_id?: string;
  output_file_id?: string;
  error_file_id?: string;
}

/**
 * Resolve the API key, base URL, and default model the same way the
 * interactive CLI does, then require OpenAI-compatible key auth: Qwen OAuth
 * tokens and non-DashScope endpoints have no `/batches` route.
 */
export function resolveEndpoint(
  env: Record<string, string | undefined> = process.env,
): BatchEndpoint {
  const settings = loadSettings().merged;
  const authType =
    settings.security?.auth?.selectedType ?? getAuthTypeFromEnv(env);
  if (authType !== AuthType.USE_OPENAI) {
    throw new Error(
      `qwen batch needs an API key (auth type "openai") for a DashScope endpoint; current auth type is "${authType ?? 'none'}".`,
    );
  }
  const { apiKey, baseUrl, model, warnings } = resolveCliGenerationConfig({
    argv: {},
    settings,
    selectedAuthType: authType,
    env,
  });
  if (!apiKey) {
    throw new Error(
      'No API key found: set OPENAI_API_KEY or security.auth.apiKey.',
    );
  }
  // The resolver's model/provider diagnostics go to stderr (never stdout:
  // submit prints exactly one line there) so a misroute is visible before
  // the upload, not hours later as a provider rejection.
  for (const warning of warnings ?? []) {
    writeStderrLine(`warning: ${warning}`);
  }
  return {
    apiKey,
    baseUrl: (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model,
  };
}

/**
 * Install the process-wide proxy dispatcher and resolve the endpoint. This
 * command path never builds a `Config` (parseArguments exits right after the
 * subcommand handler), so the `Config.initialize` install never runs and the
 * global `fetch` used below would dial out directly even when HTTPS_PROXY or
 * settings.proxy is set. One process runs a single subcommand, so this runs
 * exactly once per invocation.
 */
export async function prepareEndpoint(
  env: Record<string, string | undefined> = process.env,
): Promise<BatchEndpoint> {
  await resolveProxy(
    undefined,
    loadSettings().merged.proxy as string | undefined,
  );
  return resolveEndpoint(env);
}

async function api(
  ep: BatchEndpoint,
  route: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${ep.baseUrl}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${ep.apiKey}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(
      `${init.method ?? 'GET'} ${route} -> HTTP ${res.status}: ${detail}`,
    );
  }
  return res;
}

const postJson = (ep: BatchEndpoint, route: string, body: unknown) =>
  api(ep, route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * Accept either a full batch request line (`{custom_id, method, url, body}`)
 * or a bare chat-completions body; fill in the envelope and default model.
 * A full line's `method`/`url` must match what the file-level endpoint will
 * be: silently rewriting `/v1/embeddings` (or a `GET`) to
 * `POST /v1/chat/completions` would only surface hours later as per-line
 * provider rejections, so a mismatch fails here instead.
 */
export function toRequestLine(
  line: Record<string, unknown>,
  index: number,
  model: string,
): Record<string, unknown> {
  const req = 'body' in line ? line : { body: line };
  const method = (req['method'] as string | undefined) ?? 'POST';
  const url = (req['url'] as string | undefined) ?? '/v1/chat/completions';
  if (method !== 'POST' || url !== '/v1/chat/completions') {
    throw new Error(
      `custom_id ${String(req['custom_id'] ?? index)}: only ` +
        `POST /v1/chat/completions is supported, got ${method} ${url}`,
    );
  }
  return {
    custom_id: req['custom_id'] ?? String(index),
    method,
    url,
    body: { model, ...(req['body'] as Record<string, unknown>) },
  };
}

export async function submitBatch(
  ep: BatchEndpoint,
  file: string,
  window: string,
): Promise<BatchJob> {
  // Stream the input line by line instead of readFileSync+split+map+join:
  // the provider ceiling is 500 MB / 50 000 lines and this command path
  // never reaches the CLI's larger-heap relaunch, so four live copies of the
  // file would OOM the default heap. Only the joined output is held.
  const rl = readline.createInterface({
    input: fs.createReadStream(file, 'utf8'),
    crlfDelay: Infinity,
  });
  let jsonl = '';
  let lineNo = 0;
  try {
    for await (const raw of rl) {
      lineNo += 1;
      // A UTF-8 BOM is what PowerShell 5.1 and Notepad write by default;
      // JSON.parse does not strip it.
      const text = lineNo === 1 ? raw.replace(/^\uFEFF/, '') : raw;
      if (!text.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `${file}:${lineNo}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error(
          `${file}:${lineNo}: each line must be a JSON object (a chat body or a full batch request line)`,
        );
      }
      try {
        // custom_id is the 0-based file line index, so results map back to
        // the input file's own numbering even when blank lines were skipped.
        jsonl +=
          JSON.stringify(
            toRequestLine(
              parsed as Record<string, unknown>,
              lineNo - 1,
              ep.model,
            ),
          ) + '\n';
      } catch (error) {
        throw new Error(
          `${file}:${lineNo}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    rl.close();
  }
  if (lineNo === 0 || jsonl.length === 0) {
    throw new Error(`${file} has no requests.`);
  }

  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl]), path.basename(file));
  const uploaded = (await (
    await api(ep, '/files', { method: 'POST', body: form })
  ).json()) as { id: string };
  // The input file is a billable object and this CLI has no `files`
  // subcommand, so name it before the create: if the create fails (or the
  // transport drops ambiguously after the provider accepted it), the id is
  // the only handle the user has. stderr, to keep stdout to the batch id.
  writeStderrLine(`[batch] uploaded input file ${uploaded.id}`);

  try {
    return (await (
      await postJson(ep, '/batches', {
        input_file_id: uploaded.id,
        endpoint: '/v1/chat/completions',
        completion_window: window,
      })
    ).json()) as BatchJob;
  } catch (error) {
    await api(ep, `/files/${uploaded.id}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
    throw error;
  }
}

export const getBatch = async (ep: BatchEndpoint, id: string) =>
  (await (await api(ep, `/batches/${id}`)).json()) as BatchJob;

/** One line: id, status, N/M done, phase from the timestamps, deadline. */
export function describeBatch(job: BatchJob, now = Date.now() / 1000): string {
  const rc = job.request_counts ?? {};
  // Status first: failed/expired/cancelled are terminal, and deriving the
  // phase from timestamps alone would report them as still "running".
  const phase = SETTLED.has(job.status)
    ? job.status === 'completed' && job.in_progress_at && job.completed_at
      ? `ran ${job.completed_at - job.in_progress_at}s`
      : job.status
    : !job.in_progress_at
      ? `queued ${Math.max(0, Math.floor(now - job.created_at))}s`
      : `running ${Math.floor(now - job.in_progress_at)}s`;
  const deadline = job.expires_at
    ? new Date(job.expires_at * 1000).toISOString()
    : '-';
  return `${job.id}\t${job.status}\t${rc.completed ?? 0}/${rc.total ?? 0} done, ${rc.failed ?? 0} failed\t${phase}\texpires ${deadline}`;
}

/** Download output/error files to `<outDir>/<id>.{output,error}.jsonl`. */
export async function fetchBatch(
  ep: BatchEndpoint,
  id: string,
  outDir: string,
  remove: boolean,
): Promise<{ job: BatchJob; written: string[] }> {
  const job = await getBatch(ep, id);
  if (!SETTLED.has(job.status)) {
    throw new Error(
      `${id} is ${job.status}; results are only available once the batch settles.`,
    );
  }
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [fileId, suffix] of [
    [job.output_file_id, 'output'],
    [job.error_file_id, 'error'],
  ] as const) {
    if (!fileId) continue;
    const res = await api(ep, `/files/${fileId}/content`);
    const target = path.join(outDir, `${id}.${suffix}.jsonl`);
    // Stream to disk: the output file can approach the provider's 500 MB
    // ceiling and materialising it as one JS string risks the default heap.
    if (!res.body) throw new Error(`empty response for ${fileId}`);
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      fs.createWriteStream(target),
    );
    written.push(target);
  }
  if (remove) {
    // Non-fatal: the results are already on disk, so a failed DELETE must
    // not abort the command before the written paths are reported (the core
    // runner uses Promise.allSettled for the same reason).
    const fileIds = [
      job.input_file_id,
      job.output_file_id,
      job.error_file_id,
    ].filter((fileId): fileId is string => Boolean(fileId));
    const results = await Promise.allSettled(
      fileIds.map((fileId) =>
        api(ep, `/files/${fileId}`, { method: 'DELETE' }),
      ),
    );
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        writeStderrLine(
          `[batch] warning: could not delete remote file ${fileIds[i]}: ${result.reason}`,
        );
      }
    });
  }
  return { job, written };
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    writeStderrLine(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const submitCommand: CommandModule = {
  command: 'submit <file>',
  describe: 'Upload a JSONL file of chat requests and start a batch job',
  builder: (yargs) =>
    yargs
      .positional('file', {
        describe:
          'JSONL: one chat-completions body per line, or full batch request lines',
        type: 'string',
        demandOption: true,
      })
      .option('window', {
        describe: 'Completion window, e.g. 24h or 7d (min 24h, max 14d)',
        type: 'string',
        default: '24h',
      }),
  handler: (argv) =>
    run(async () => {
      const job = await submitBatch(
        await prepareEndpoint(),
        argv['file'] as string,
        argv['window'] as string,
      );
      writeStdoutLine(job.id);
    }),
};

const statusCommand: CommandModule = {
  command: 'status <id>',
  describe: 'Show status, progress, and deadline of a batch job',
  builder: (yargs) =>
    yargs
      .positional('id', {
        describe: 'Batch id',
        type: 'string',
        demandOption: true,
      })
      .option('json', {
        describe: 'Print the raw batch object',
        type: 'boolean',
        default: false,
      }),
  handler: (argv) =>
    run(async () => {
      const job = await getBatch(await prepareEndpoint(), argv['id'] as string);
      writeStdoutLine(
        argv['json'] ? JSON.stringify(job, null, 2) : describeBatch(job),
      );
    }),
};

const fetchCommand: CommandModule = {
  command: 'fetch <id>',
  describe: 'Download the results of a settled batch job',
  builder: (yargs) =>
    yargs
      .positional('id', {
        describe: 'Batch id',
        type: 'string',
        demandOption: true,
      })
      .option('out', {
        describe: 'Directory to write <id>.output.jsonl / <id>.error.jsonl',
        type: 'string',
        default: '.',
      })
      .option('delete', {
        describe: 'Delete the remote input/output/error files after download',
        type: 'boolean',
        default: false,
      }),
  handler: (argv) =>
    run(async () => {
      const { job, written } = await fetchBatch(
        await prepareEndpoint(),
        argv['id'] as string,
        argv['out'] as string,
        argv['delete'] as boolean,
      );
      writeStdoutLine(describeBatch(job));
      for (const p of written) writeStdoutLine(p);
    }),
};

const cancelCommand: CommandModule = {
  command: 'cancel <id>',
  describe: 'Cancel a batch job (already-completed requests are still billed)',
  builder: (yargs) =>
    yargs.positional('id', {
      describe: 'Batch id',
      type: 'string',
      demandOption: true,
    }),
  handler: (argv) =>
    run(async () => {
      const ep = await prepareEndpoint();
      const job = (await (
        await postJson(ep, `/batches/${argv['id'] as string}/cancel`, {})
      ).json()) as BatchJob;
      writeStdoutLine(describeBatch(job));
    }),
};

export const batchCommand: CommandModule = {
  command: 'batch',
  describe: 'Run many independent requests through the DashScope Batch API',
  builder: (yargs: Argv) =>
    yargs
      .command(submitCommand)
      .command(statusCommand)
      .command(fetchCommand)
      .command(cancelCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
