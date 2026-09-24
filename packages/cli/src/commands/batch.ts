/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen batch' — the deterministic executor behind `/batch-api`.
// Batch runs at half the realtime price with a >=24h completion window, so it
// is a fan-out tool for many independent single-turn requests, not a path for
// the agent loop. Design: docs/design/2026-09-23-batch-api-design.md
import type { Argv, CommandModule } from 'yargs';
import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import { isTlsVerificationDisabled } from '@qwen-code/qwen-code-core/utils/runtimeFetchOptions.js';
import { loadSettings } from '../config/settings.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../utils/modelConfigUtils.js';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import { resolveProxy } from './channel/proxy.js';
import {
  runPlan,
  collectTask,
  listTasks,
  retryTask,
  cancelTask,
  checkReadiness,
  cleanTask,
  type WorkflowDeps,
} from './batch-workflow.js';
import type { GenerationConfigLike } from './batch-docs.js';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

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
  /** Job-level failures (validation, unsupported model, …). */
  errors?: {
    data?: Array<{ code?: string; message?: string; line?: number | null }>;
  };
}

/**
 * Resolve the API key, base URL, and default model the same way the
 * interactive CLI does, then require OpenAI-compatible key auth: Qwen OAuth
 * tokens and non-DashScope endpoints have no `/batches` route.
 */
export function resolveEndpoint(
  env: Record<string, string | undefined> = process.env,
  options: {
    /** An interactive session's already-loaded settings; re-reading them
     * from disk mid-session could even rewrite a half-edited file. */
    settings?: ReturnType<typeof loadSettings>['merged'];
    /** Where resolver warnings go; stderr would draw over a TUI. */
    warn?: (message: string) => void;
  } = {},
): BatchEndpoint {
  const settings = options.settings ?? loadSettings().merged;
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
  const warn =
    options.warn ??
    ((message: string) => writeStderrLine(`warning: ${message}`));
  for (const warning of warnings ?? []) {
    warn(warning);
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
  // Same route loadCliConfig uses: --insecure surfaces as QWEN_TLS_INSECURE,
  // and either one disables verification for the global fetch used here.
  if (cliOptions.insecure) process.env['QWEN_TLS_INSECURE'] = '1';
  if (
    isTlsVerificationDisabled() &&
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] !== '0'
  ) {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    writeStderrLine(
      'WARNING: TLS certificate verification is disabled (--insecure / QWEN_TLS_INSECURE); ' +
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

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    writeStderrLine(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  // parseArguments exits right after the handler: let queued output reach a
  // pipe first, or a long summary read by the agent is cut off.
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => stream.write('', () => resolve())),
    ),
  );
}

// A session's auto-collector holds a task lock for a few seconds at most;
// waiting beats failing a command the user or agent just ran.
const LOCK_WAIT_MS = 15_000;

/** Deps shared by the agent-prepared workflow subcommands. */
const workflowDeps = (ep: BatchEndpoint): WorkflowDeps => ({
  ep,
  cwd: process.cwd(),
  env: process.env,
  out: writeStdoutLine,
  err: writeStderrLine,
  lockWaitMs: LOCK_WAIT_MS,
});

const runWorkflowCommand: CommandModule = {
  command: 'run <plan>',
  describe:
    'Run an agent-prepared batch plan: assemble requests, submit, record the task',
  builder: (yargs) =>
    yargs
      .positional('plan', {
        describe:
          'Plan JSON (usually written by the /batch-api skill): shared rules + source/target items',
        type: 'string',
        demandOption: true,
      })
      .option('dry-run', {
        describe:
          'Assemble and show items, frozen settings and the estimate without uploading; prints a snapshot digest',
        type: 'boolean',
        default: false,
      })
      .option('expect', {
        describe:
          'Submit only if the batch still matches this snapshot digest from --dry-run',
        type: 'string',
      })
      .check((argv) =>
        argv['dry-run'] && argv['expect'] !== undefined
          ? '--dry-run and --expect cannot be combined'
          : true,
      ),
  handler: (argv) =>
    run(async () => {
      await runPlan(
        workflowDeps(await prepareEndpoint(process.env, cliOptionsOf(argv))),
        argv['plan'] as string,
        {
          dryRun: argv['dry-run'] as boolean,
          expect: argv['expect'] as string | undefined,
        },
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
        describe:
          'Poll (over HTTP, holding no lock) until the batch settles, then collect',
        type: 'boolean',
        default: false,
      })
      .option('timeout', {
        describe:
          'Seconds to wait with --wait before giving up (default: none)',
        type: 'number',
      })
      .check((argv) =>
        argv['timeout'] === undefined ||
        (Number.isFinite(argv['timeout']) && (argv['timeout'] as number) > 0)
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
          timeoutSeconds: argv['timeout'] as number | undefined,
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

const cleanWorkflowCommand: CommandModule = {
  command: 'clean <task-id>',
  describe:
    "Delete a workflow task's local record (cancels nothing; refuses while a batch may be running)",
  builder: (yargs) =>
    yargs
      .positional('task-id', {
        describe: 'Task id',
        type: 'string',
        demandOption: true,
      })
      .option('force', {
        describe:
          'Delete even if a batch may still be running or uncollected (it is not cancelled)',
        type: 'boolean',
        default: false,
      }),
  // Local only: no endpoint or credentials needed.
  handler: (argv) =>
    run(async () => {
      await cleanTask(
        {
          env: process.env,
          out: writeStdoutLine,
          err: writeStderrLine,
          lockWaitMs: LOCK_WAIT_MS,
        },
        argv['task-id'] as string,
        { force: argv['force'] as boolean },
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

const cancelWorkflowCommand: CommandModule = {
  command: 'cancel <task-id>',
  describe:
    "Cancel a workflow task's active batch (already-completed requests are still billed)",
  builder: (yargs) =>
    yargs.positional('task-id', {
      describe: 'Task id',
      type: 'string',
      demandOption: true,
    }),
  handler: (argv) =>
    run(async () => {
      await cancelTask(
        workflowDeps(await prepareEndpoint(process.env, cliOptionsOf(argv))),
        argv['task-id'] as string,
      );
    }),
};

const listWorkflowCommand: CommandModule = {
  command: 'list',
  describe: 'List all recorded workflow tasks with their project',
  builder: (yargs) => yargs,
  // Local only: no endpoint or credentials needed.
  handler: () =>
    run(async () => {
      await listTasks({ env: process.env, out: writeStdoutLine });
    }),
};

export const batchCommand: CommandModule = {
  command: 'batch',
  describe: 'Run many independent requests through the DashScope Batch API',
  builder: (yargs: Argv) =>
    yargs
      .command(runWorkflowCommand)
      .command(collectWorkflowCommand)
      .command(retryWorkflowCommand)
      .command(cancelWorkflowCommand)
      .command(listWorkflowCommand)
      .command(checkWorkflowCommand)
      .command(cleanWorkflowCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
