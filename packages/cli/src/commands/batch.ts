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
import type { Argv, CommandModule } from 'yargs';
import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import { loadSettings } from '../config/settings.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../utils/modelConfigUtils.js';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';

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
  const { apiKey, baseUrl, model } = resolveCliGenerationConfig({
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
  return {
    apiKey,
    baseUrl: (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model,
  };
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
 */
export function toRequestLine(
  line: Record<string, unknown>,
  index: number,
  model: string,
): Record<string, unknown> {
  const req = 'body' in line ? line : { body: line };
  return {
    custom_id: req['custom_id'] ?? String(index),
    method: 'POST',
    url: '/v1/chat/completions',
    body: { model, ...(req['body'] as Record<string, unknown>) },
  };
}

export async function submitBatch(
  ep: BatchEndpoint,
  file: string,
  window: string,
): Promise<BatchJob> {
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  if (lines.length === 0) throw new Error(`${file} has no requests.`);
  const jsonl =
    lines
      .map((l, i) => JSON.stringify(toRequestLine(JSON.parse(l), i, ep.model)))
      .join('\n') + '\n';

  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl]), path.basename(file));
  const uploaded = (await (
    await api(ep, '/files', { method: 'POST', body: form })
  ).json()) as { id: string };

  return (await (
    await postJson(ep, '/batches', {
      input_file_id: uploaded.id,
      endpoint: '/v1/chat/completions',
      completion_window: window,
    })
  ).json()) as BatchJob;
}

export const getBatch = async (ep: BatchEndpoint, id: string) =>
  (await (await api(ep, `/batches/${id}`)).json()) as BatchJob;

/** One line: id, status, N/M done, phase from the timestamps, deadline. */
export function describeBatch(job: BatchJob, now = Date.now() / 1000): string {
  const rc = job.request_counts ?? {};
  const phase = !job.in_progress_at
    ? `queued ${Math.max(0, Math.floor(now - job.created_at))}s`
    : !job.completed_at
      ? `running ${Math.floor(now - job.in_progress_at)}s`
      : `ran ${job.completed_at - job.in_progress_at}s`;
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
    const text = await (await api(ep, `/files/${fileId}/content`)).text();
    const target = path.join(outDir, `${id}.${suffix}.jsonl`);
    fs.writeFileSync(target, text);
    written.push(target);
  }
  if (remove) {
    for (const fileId of [
      job.input_file_id,
      job.output_file_id,
      job.error_file_id,
    ]) {
      if (fileId) await api(ep, `/files/${fileId}`, { method: 'DELETE' });
    }
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
        resolveEndpoint(),
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
      const job = await getBatch(resolveEndpoint(), argv['id'] as string);
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
        resolveEndpoint(),
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
      const ep = resolveEndpoint();
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
