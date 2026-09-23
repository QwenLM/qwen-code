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
import type { Argv, CommandModule } from 'yargs';
import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import { loadSettings } from '../config/settings.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../utils/modelConfigUtils.js';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import { resolveProxy } from './channel/proxy.js';
import {
  SETTLED_STATUSES,
  MAX_REQUESTS_PER_FILE,
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  assertValidWindow,
  batchRequest as api,
  uploadBatchJsonl,
  downloadRemoteFile,
} from './batch-client.js';
import {
  runPlan,
  collectTask,
  listTasks,
  retryTask,
  cancelTask,
  checkReadiness,
  type WorkflowDeps,
} from './batch-workflow.js';
import type { GenerationConfigLike } from './batch-docs.js';

export { assertValidWindow };

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const SETTLED = SETTLED_STATUSES;

export interface BatchEndpoint {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** The realtime generation config, frozen into workflow requests. */
  generationConfig?: GenerationConfigLike;
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
  const selectedAuthType =
    settings.security?.auth?.selectedType ?? getAuthTypeFromEnv(env);
  if (selectedAuthType !== AuthType.USE_OPENAI) {
    throw new Error(
      `qwen batch needs an API key (auth type "openai") for a DashScope endpoint; current auth type is "${selectedAuthType ?? 'none'}".`,
    );
  }
  const { apiKey, baseUrl, model, warnings, authType, generationConfig } =
    resolveCliGenerationConfig({
      argv: {},
      settings,
      selectedAuthType,
      env,
    });
  // The resolver can change the wire: a model pinned to `wireApi: "responses"`
  // resolves an `openai` startup to `openai-responses`, which has no Batch
  // API. Refuse the effective protocol rather than the selected one, or the
  // upload succeeds and every line is rejected by the provider hours later.
  if (authType !== AuthType.USE_OPENAI) {
    throw new Error(
      `qwen batch needs a model on the OpenAI-compatible chat-completions wire; ` +
        `"${model || 'the configured model'}" resolves to auth type "${authType ?? 'none'}".`,
    );
  }
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
    generationConfig,
  };
}

/** What the parsed `qwen batch …` invocation asked for, minus the subcommand. */
export interface BatchCliOptions {
  proxy?: string;
  insecure?: boolean;
}

/**
 * Install the process-wide proxy dispatcher and resolve the endpoint. This
 * command path never builds a `Config` (parseArguments exits right after the
 * subcommand handler), so neither the `Config.initialize` proxy install nor
 * loadCliConfig's `--insecure` env surfacing ever runs, and the global
 * `fetch` used below would dial out directly — ignoring a `--proxy` the
 * operator named explicitly — even when HTTPS_PROXY or settings.proxy is set.
 * One process runs a single subcommand, so this runs exactly once per
 * invocation.
 */
export async function prepareEndpoint(
  env: Record<string, string | undefined> = process.env,
  cliOptions: BatchCliOptions = {},
): Promise<BatchEndpoint> {
  if (cliOptions.insecure) {
    // Same route loadCliConfig uses: the dispatcher layer ORs this with
    // NODE_TLS_REJECT_UNAUTHORIZED, which is what the global fetch obeys.
    process.env['QWEN_TLS_INSECURE'] = '1';
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    writeStderrLine(
      'WARNING: TLS certificate verification is disabled (--insecure); ' +
        'connections made by this command are vulnerable to man-in-the-middle attacks.',
    );
  }
  await resolveProxy(
    cliOptions.proxy,
    loadSettings().merged.proxy as string | undefined,
  );
  return resolveEndpoint(env);
}

/** Read the CLI-level options every subcommand handler forwards. */
const cliOptionsOf = (argv: Record<string, unknown>): BatchCliOptions => ({
  proxy: argv['proxy'] as string | undefined,
  insecure: argv['insecure'] as boolean | undefined,
});

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
  // Any envelope key makes it a full request line. Testing only `body` would
  // read `{custom_id, method, url}` — an envelope whose body is missing — as
  // a bare chat body, nest the envelope into `body`, and rewrite its declared
  // method/url to the defaults instead of failing here.
  const isEnvelope = 'body' in line || 'method' in line || 'url' in line;
  const suppliedId = line['custom_id'];
  const label = suppliedId === undefined ? String(index) : String(suppliedId);
  if (isEnvelope && !('body' in line)) {
    throw new Error(
      `custom_id ${label}: a full request line must carry a "body" — ` +
        `or write the bare chat-completions body on its own`,
    );
  }
  const method = isEnvelope
    ? ((line['method'] as string | undefined) ?? 'POST')
    : 'POST';
  const url = isEnvelope
    ? ((line['url'] as string | undefined) ?? '/v1/chat/completions')
    : '/v1/chat/completions';
  if (method !== 'POST' || url !== '/v1/chat/completions') {
    throw new Error(
      `custom_id ${label}: only ` +
        `POST /v1/chat/completions is supported, got ${method} ${url}`,
    );
  }
  const body = {
    ...((isEnvelope ? line['body'] : line) as Record<string, unknown>),
  };
  if (!isEnvelope) {
    // A bare body's own `custom_id` is the caller's handle for that request:
    // hoist it into the envelope rather than both losing it as an identifier
    // and sending it to the provider as an unrecognised request field.
    delete body['custom_id'];
  }
  return {
    custom_id: suppliedId === undefined ? String(index) : String(suppliedId),
    method,
    url,
    body: { model, ...body },
  };
}

/**
 * Pick the input file's encoding from its BOM. Windows PowerShell 5.1's `>`
 * and `Out-File` default to UTF-16LE (`FF FE`), Notepad and
 * `Out-File -Encoding utf8` to a UTF-8 BOM (`EF BB BF`); reading either as
 * plain UTF-8 makes `JSON.parse` fail on line 1 with a `\uFFFD` message that
 * does not name the actual problem. Node decodes UTF-16LE (leaving the BOM as
 * a `\uFEFF` the caller strips) but has no UTF-16BE, so that one is refused
 * with the remedy instead.
 */
function detectJsonlEncoding(file: string): BufferEncoding {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(2);
    const bytesRead = fs.readSync(fd, head, 0, 2, 0);
    if (bytesRead < 2) return 'utf8';
    if (head[0] === 0xff && head[1] === 0xfe) return 'utf16le';
    if (head[0] === 0xfe && head[1] === 0xff) {
      throw new Error(
        `${file}: UTF-16BE (big-endian) input is not supported; re-save it as ` +
          `UTF-8 (PowerShell: Out-File -Encoding utf8).`,
      );
    }
    return 'utf8';
  } finally {
    fs.closeSync(fd);
  }
}

export async function submitBatch(
  ep: BatchEndpoint,
  file: string,
  window: string,
): Promise<BatchJob> {
  assertValidWindow(window);
  // Stream the input line by line instead of readFileSync+split+map+join:
  // the provider ceiling is 500 MB / 50 000 lines and this command path
  // never reaches the CLI's larger-heap relaunch, so four live copies of the
  // file would OOM the default heap. Only the joined output is held.
  const rl = readline.createInterface({
    input: fs.createReadStream(file, detectJsonlEncoding(file)),
    crlfDelay: Infinity,
  });
  let jsonl = '';
  let lineNo = 0;
  let requests = 0;
  let bytes = 0;
  const lineOfId = new Map<string, number>();
  try {
    for await (const raw of rl) {
      lineNo += 1;
      // A BOM is what PowerShell 5.1 and Notepad write by default;
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
      let requestLine: Record<string, unknown>;
      try {
        // custom_id defaults to the 0-based file line index, so results map
        // back to the input file's own numbering even when blank lines were
        // skipped.
        requestLine = toRequestLine(
          parsed as Record<string, unknown>,
          lineNo - 1,
          ep.model,
        );
      } catch (error) {
        throw new Error(
          `${file}:${lineNo}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Duplicate ids make the output rows unmappable back to the input —
      // the one thing the docs tell users to do themselves — so refuse the
      // file here rather than let the provider return ambiguous results.
      const id = String(requestLine['custom_id']);
      const firstLine = lineOfId.get(id);
      if (firstLine !== undefined) {
        throw new Error(
          `${file}:${lineNo}: custom_id "${id}" is already used by line ${firstLine}; ids must be unique`,
        );
      }
      lineOfId.set(id, lineNo);
      const encoded = JSON.stringify(requestLine) + '\n';
      const encodedBytes = Buffer.byteLength(encoded);
      if (encodedBytes > MAX_LINE_BYTES) {
        throw new Error(
          `${file}:${lineNo}: request is ${encodedBytes} bytes, over the ${MAX_LINE_BYTES}-byte per-line limit.`,
        );
      }
      requests += 1;
      if (requests > MAX_REQUESTS_PER_FILE) {
        throw new Error(
          `${file}: more than ${MAX_REQUESTS_PER_FILE} requests; split the file and submit the parts as separate jobs.`,
        );
      }
      bytes += encodedBytes;
      if (bytes > MAX_FILE_BYTES) {
        throw new Error(
          `${file}: over the ${MAX_FILE_BYTES}-byte per-file limit at line ${lineNo}; split the file and submit the parts as separate jobs.`,
        );
      }
      jsonl += encoded;
    }
  } finally {
    rl.close();
  }
  if (lineNo === 0 || jsonl.length === 0) {
    throw new Error(`${file} has no requests.`);
  }

  const uploaded = await uploadBatchJsonl(ep, jsonl, path.basename(file));
  // The input file is a billable object and this CLI has no `files`
  // subcommand, so name it before the create: if the create fails (or the
  // transport drops ambiguously after the provider accepted it), the id is
  // the only handle the user has. stderr, to keep stdout to the batch id.
  writeStderrLine(`[batch] uploaded input file ${uploaded.id}`);

  let res: Response;
  try {
    res = await postJson(ep, '/batches', {
      input_file_id: uploaded.id,
      endpoint: '/v1/chat/completions',
      completion_window: window,
    });
  } catch (error) {
    // Only a 4xx is the provider definitely refusing the job, which makes the
    // uploaded input an orphan worth deleting. A 5xx or a dropped socket is
    // ambiguous — the job may exist and be billing — and deleting its input
    // file would break it, so keep the file and name it instead.
    const status = (error as { status?: number } | undefined)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      await api(ep, `/files/${uploaded.id}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    } else {
      writeStderrLine(
        `[batch] warning: POST /batches did not complete cleanly, so the job ` +
          `may exist and be billing. Input file ${uploaded.id} was kept; ` +
          `check the provider's batch list before submitting again.`,
      );
    }
    throw error;
  }
  try {
    return (await res.json()) as BatchJob;
  } catch (error) {
    // The create was accepted but its body is unreadable (a gateway HTML
    // error page, say), so the job exists and its id never reached us.
    // Deleting the input would destroy a live job's only local trace.
    writeStderrLine(
      `[batch] warning: POST /batches returned an unreadable body; the job ` +
        `may have been created and its id was not reported. Input file ` +
        `${uploaded.id} was kept; check the provider's batch list.`,
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
    const target = path.join(outDir, `${id}.${suffix}.jsonl`);
    await downloadRemoteFile(ep, fileId, target);
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
        await prepareEndpoint(process.env, cliOptionsOf(argv)),
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
      const job = await getBatch(
        await prepareEndpoint(process.env, cliOptionsOf(argv)),
        argv['id'] as string,
      );
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
        await prepareEndpoint(process.env, cliOptionsOf(argv)),
        argv['id'] as string,
        argv['out'] as string,
        argv['delete'] as boolean,
      );
      writeStdoutLine(describeBatch(job));
      for (const p of written) writeStdoutLine(p);
    }),
};

const cancelCommand: CommandModule = {
  command: 'cancel [id]',
  describe: 'Cancel a batch job (already-completed requests are still billed)',
  builder: (yargs) =>
    yargs
      .positional('id', {
        describe: 'Batch id',
        type: 'string',
      })
      .option('task', {
        describe:
          'Cancel the active batch of a workflow task instead of a bare batch id',
        type: 'string',
      })
      .check((argv) =>
        argv['task'] || argv['id']
          ? true
          : 'cancel needs a batch id or --task <task-id>',
      ),
  handler: (argv) =>
    run(async () => {
      const ep = await prepareEndpoint(process.env, cliOptionsOf(argv));
      if (argv['task']) {
        await cancelTask(workflowDeps(ep), argv['task'] as string);
        return;
      }
      const job = (await (
        await postJson(ep, `/batches/${argv['id'] as string}/cancel`, {})
      ).json()) as BatchJob;
      writeStdoutLine(describeBatch(job));
    }),
};

/** Deps shared by the agent-prepared workflow subcommands. */
const workflowDeps = (ep: BatchEndpoint): WorkflowDeps => ({
  ep,
  cwd: process.cwd(),
  env: process.env,
  out: writeStdoutLine,
  err: writeStderrLine,
});

const runWorkflowCommand: CommandModule = {
  command: 'run <plan>',
  describe:
    'Run an agent-prepared batch plan: assemble requests, submit, record the task',
  builder: (yargs) =>
    yargs.positional('plan', {
      describe:
        'Plan JSON (usually written by the /batch-api skill): shared rules + source/target items',
      type: 'string',
      demandOption: true,
    }),
  handler: (argv) =>
    run(async () => {
      await runPlan(
        workflowDeps(await prepareEndpoint(process.env, cliOptionsOf(argv))),
        argv['plan'] as string,
      );
    }),
};

const collectWorkflowCommand: CommandModule = {
  command: 'collect <task-id>',
  describe:
    'Collect a workflow task: reconcile, download, validate, and deliver results',
  builder: (yargs) =>
    yargs
      .positional('task-id', {
        describe: 'Task id printed by `qwen batch run`',
        type: 'string',
        demandOption: true,
      })
      .option('wait', {
        describe: 'Poll until the batch settles (see --timeout)',
        type: 'boolean',
        default: false,
      })
      .option('timeout', {
        describe: 'Seconds to wait with --wait before giving up',
        type: 'number',
        default: 3600,
      })
      .option('keep-remote', {
        describe: 'Keep the uploaded input/output files on the provider',
        type: 'boolean',
        default: false,
      })
      .check((argv) =>
        Number.isFinite(argv['timeout']) && (argv['timeout'] as number) > 0
          ? true
          : '--timeout must be a positive number of seconds',
      ),
  handler: (argv) =>
    run(async () => {
      await collectTask(
        workflowDeps(await prepareEndpoint(process.env, cliOptionsOf(argv))),
        argv['task-id'] as string,
        {
          wait: argv['wait'] as boolean,
          timeoutSeconds: argv['timeout'] as number,
          keepRemote: argv['keep-remote'] as boolean,
        },
      );
    }),
};

const retryWorkflowCommand: CommandModule = {
  command: 'retry <task-id>',
  describe: 'Resubmit only the failed items of a workflow task',
  builder: (yargs) =>
    yargs
      .positional('task-id', {
        describe: 'Task id',
        type: 'string',
        demandOption: true,
      })
      .option('max-output-tokens', {
        describe:
          'Output limit for the new attempt; required to resend items that were truncated',
        type: 'number',
      })
      .check((argv) =>
        argv['max-output-tokens'] === undefined ||
        (Number.isInteger(argv['max-output-tokens']) &&
          (argv['max-output-tokens'] as number) > 0)
          ? true
          : '--max-output-tokens must be a positive integer',
      ),
  handler: (argv) =>
    run(async () => {
      await retryTask(
        workflowDeps(await prepareEndpoint(process.env, cliOptionsOf(argv))),
        argv['task-id'] as string,
        { maxOutputTokens: argv['max-output-tokens'] as number | undefined },
      );
    }),
};

const checkWorkflowCommand: CommandModule = {
  command: 'check',
  describe:
    'Verify credentials and the Batch route, and show the settings a run would freeze (no billed request)',
  builder: (yargs) => yargs,
  handler: (argv) =>
    run(async () => {
      await checkReadiness(
        workflowDeps(await prepareEndpoint(process.env, cliOptionsOf(argv))),
      );
    }),
};

const listWorkflowCommand: CommandModule = {
  command: 'list',
  describe: 'List workflow tasks recorded under this project',
  builder: (yargs) => yargs,
  handler: (argv) =>
    run(async () => {
      await listTasks(
        workflowDeps(await prepareEndpoint(process.env, cliOptionsOf(argv))),
      );
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
      .command(runWorkflowCommand)
      .command(collectWorkflowCommand)
      .command(retryWorkflowCommand)
      .command(listWorkflowCommand)
      .command(checkWorkflowCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
