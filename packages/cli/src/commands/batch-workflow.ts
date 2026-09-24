/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Orchestration for the agent-prepared Batch workflow (`qwen batch
// run|collect|list|retry|cancel`). The agent owns understanding the
// task and writing a small plan file; everything here is deterministic:
// assemble requests, persist intent before money moves, submit, later
// collect, validate, deliver, and account for every attempt. No model calls
// live in this file, and none of the usage seen here enters the interactive
// session's realtime cache statistics — the two price models stay separate.
import fs from 'node:fs';
import path from 'node:path';
import {
  SETTLED_STATUSES,
  MAX_REQUESTS_PER_FILE,
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  assertValidWindow,
  uploadBatchJsonl,
  createBatchJob,
  getBatchJob,
  cancelBatchJob,
  listBatchJobs,
  downloadRemoteFile,
  deleteRemoteFile,
  batchRequest,
} from './batch-client.js';
import type { BatchApiError } from './batch-client.js';
import type { BatchEndpoint, BatchJob } from './batch.js';
import {
  loadPlanFile,
  BatchTaskStore,
  batchHomeDir,
  refreshTaskStatus,
  parseCustomId,
  isAmbiguous,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
} from './batch-task.js';
import type {
  BatchPlan,
  BatchTask,
  TaskAttempt,
  TaskItem,
} from './batch-task.js';
import {
  assembleRequests,
  parseOutputJsonl,
  classifyResult,
  deliverResult,
  sha256,
  freezeRequest,
  describeThinking,
} from './batch-docs.js';

// Batch bills successful requests at half the realtime list price and does
// not hit the context cache. Monetary estimates exist only when the operator
// supplies unit prices — a hardcoded table would go stale against the
// provider's pricing page.
const BATCH_PRICE_FACTOR = 0.5;
const ENV_PRICE_INPUT = 'QWEN_BATCH_INPUT_PRICE_PER_1M_USD';
const ENV_PRICE_OUTPUT = 'QWEN_BATCH_OUTPUT_PRICE_PER_1M_USD';

export interface WorkflowApi {
  uploadJsonl(
    ep: BatchEndpoint,
    jsonl: string,
    filename: string,
  ): Promise<{ id: string }>;
  createBatch(
    ep: BatchEndpoint,
    inputFileId: string,
    completionWindow: string,
  ): Promise<BatchJob>;
  getBatch(ep: BatchEndpoint, id: string): Promise<BatchJob>;
  listBatches(ep: BatchEndpoint): Promise<BatchJob[]>;
  downloadFile(
    ep: BatchEndpoint,
    fileId: string,
    target: string,
  ): Promise<void>;
  deleteFile(ep: BatchEndpoint, fileId: string): Promise<void>;
  cancelBatch(ep: BatchEndpoint, id: string): Promise<BatchJob>;
  /** Cheapest authenticated call that proves the Batch route exists. */
  probe(ep: BatchEndpoint): Promise<void>;
}

const liveApi: WorkflowApi = {
  uploadJsonl: uploadBatchJsonl,
  createBatch: createBatchJob,
  getBatch: getBatchJob,
  listBatches: listBatchJobs,
  downloadFile: downloadRemoteFile,
  deleteFile: deleteRemoteFile,
  cancelBatch: cancelBatchJob,
  probe: async (ep) => {
    await batchRequest(ep, '/batches?limit=1');
  },
};

export interface WorkflowDeps {
  ep: BatchEndpoint;
  /** Project root for `run`: sources/targets resolve against it. Task
   * records live under the user's qwen home (QWEN_BATCH_HOME overrides). */
  cwd: string;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  api?: WorkflowApi;
  sleep?: (ms: number) => Promise<void>;
  /** How long a command waits for a task lock held by another process
   * (typically a session's auto-collector) before giving up. */
  lockWaitMs?: number;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const unitPrice = (
  env: Record<string, string | undefined>,
  name: string,
): number | undefined => {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
};

interface AttemptAssembly {
  jsonl: string;
  inputTokens: number;
  outputTokens: number;
}

function assembleAttempt(
  task: BatchTask,
  attemptNumber: number,
  itemIds: string[],
  maxOutputTokens?: number,
): AttemptAssembly {
  const wanted = new Set(itemIds);
  const items = task.items.filter((item) => wanted.has(item.id));
  const itemById = new Map(items.map((item) => [item.id, item]));
  // Output estimate per item: the plan's figure, else the input size, never
  // above the output limit the requests carry (thinking is not included).
  const limit = outputLimitOf(task, maxOutputTokens);
  const assembled = assembleRequests(
    maxOutputTokens === undefined
      ? task.plan
      : { ...task.plan, maxOutputTokens },
    items,
    attemptNumber,
    task.projectRoot,
    task.model,
    task.request,
  );
  let jsonl = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (const request of assembled) {
    const encoded = JSON.stringify(request.line) + '\n';
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_LINE_BYTES) {
      throw new Error(
        `item "${request.itemId}": assembled request is ${bytes} bytes, over the ` +
          `provider's ${MAX_LINE_BYTES}-byte line limit; split the document.`,
      );
    }
    jsonl += encoded;
    inputTokens += request.inputTokens;
    const expected =
      task.plan.expectedOutputTokensPerItem ?? request.inputTokens;
    outputTokens += limit === undefined ? expected : Math.min(expected, limit);
    const item = itemById.get(request.itemId);
    if (item) item.sourceSha256 = request.sourceSha256;
  }
  if (assembled.length > MAX_REQUESTS_PER_FILE) {
    throw new Error(
      `${assembled.length} items exceed the provider's ${MAX_REQUESTS_PER_FILE}-request per-file limit; split the plan.`,
    );
  }
  if (Buffer.byteLength(jsonl) > MAX_FILE_BYTES) {
    throw new Error(
      `assembled input is over the provider's ${MAX_FILE_BYTES}-byte per-file limit; split the plan.`,
    );
  }
  return { jsonl, inputTokens, outputTokens };
}

function costLine(
  inputTokens: number,
  outputTokens: number,
  env: Record<string, string | undefined>,
): { text: string; costUsd?: number } {
  const inputPrice = unitPrice(env, ENV_PRICE_INPUT);
  const outputPrice = unitPrice(env, ENV_PRICE_OUTPUT);
  const tokens = `~${inputTokens.toLocaleString()} in / ~${outputTokens.toLocaleString()} out tokens (rough estimate)`;
  if (inputPrice === undefined || outputPrice === undefined) {
    return {
      text:
        `${tokens}; set ${ENV_PRICE_INPUT} and ${ENV_PRICE_OUTPUT} ` +
        `for a monetary estimate (Batch bills successful requests at 50% of realtime list)`,
    };
  }
  const costUsd =
    ((inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000) *
    BATCH_PRICE_FACTOR;
  return {
    text:
      `${tokens}; estimated Batch cost ≈ $${costUsd.toFixed(4)} ` +
      `(estimate only — the provider bill is authoritative; excludes the preparation spent in this session)`,
    costUsd,
  };
}

function enforceBudget(plan: BatchPlan, cost: { costUsd?: number }): void {
  if (plan.maxCostUsd === undefined) return;
  if (cost.costUsd === undefined) {
    throw new Error(
      `plan sets maxCostUsd=$${plan.maxCostUsd} but no unit prices are configured ` +
        `(${ENV_PRICE_INPUT}, ${ENV_PRICE_OUTPUT}); the budget cannot be enforced, refusing to submit.`,
    );
  }
  if (cost.costUsd > plan.maxCostUsd) {
    throw new Error(
      `estimated Batch cost $${cost.costUsd.toFixed(4)} exceeds the plan's ` +
        `maxCostUsd=$${plan.maxCostUsd}; refusing to submit. Adjust the plan or its budget.`,
    );
  }
}

const ownedBy = (item: TaskItem, attempt: TaskAttempt) =>
  (item.lastAttempt ?? attempt.attempt) === attempt.attempt;

const endpointOf = (ep: BatchEndpoint) => ({
  baseUrl: ep.baseUrl,
  // Enough to notice a different key; not enough to recover or use one.
  keyFingerprint: sha256(ep.apiKey).slice(0, 12),
});

/**
 * A batch is only visible to the account and region that created it. With
 * settings switched since `run`, every query would hit the wrong account —
 * reporting the batch missing, or reconciling against the wrong list.
 */
function assertSameEndpoint(task: BatchTask, ep: BatchEndpoint): void {
  if (!task.endpoint) return;
  const current = endpointOf(ep);
  if (current.baseUrl !== task.endpoint.baseUrl) {
    throw new Error(
      `task ${task.id} was submitted to ${task.endpoint.baseUrl}, but the current settings point at ${current.baseUrl}. ` +
        `Switch back to that endpoint; its batches are not visible from another region or provider.`,
    );
  }
  if (current.keyFingerprint !== task.endpoint.keyFingerprint) {
    throw new Error(
      `task ${task.id} was submitted with a different API key than the one configured now. ` +
        `Switch back to that key; its batches are not visible from another account.`,
    );
  }
}

/** The attempt now owns these items: only its result lines count. */
function markSubmitted(task: BatchTask, attempt: TaskAttempt): void {
  const ids = new Set(attempt.itemIds);
  for (const item of task.items) {
    if (ids.has(item.id)) {
      item.state = 'submitted';
      item.lastAttempt = attempt.attempt;
      item.lastError = undefined;
      item.heldReason = undefined;
      item.truncated = undefined;
      item.sourceChanged = undefined;
    }
  }
}

/** The output limit requests carry, given an attempt's own override. */
function outputLimitOf(
  task: BatchTask,
  attemptLimit: number | undefined,
): number | undefined {
  const frozen = task.request?.params['max_tokens'];
  return (
    attemptLimit ??
    task.plan.maxOutputTokens ??
    (typeof frozen === 'number' ? frozen : undefined)
  );
}

/**
 * The upload→create dance with intent persisted between every step. The
 * ledger must always be able to answer "which remote objects might exist?"
 * without guessing, because the wrong answer costs money twice. `attempt`
 * must already live in `task.attempts` — a crash between upload and create
 * otherwise loses the only record of the uploaded input file.
 */
async function submitAttempt(
  deps: WorkflowDeps,
  task: BatchTask,
  attempt: TaskAttempt,
  store: BatchTaskStore,
  preassembled?: AttemptAssembly,
): Promise<void> {
  const api = deps.api ?? liveApi;
  attempt.submitState = 'intent';
  store.save(task);

  const attemptDir = store.attemptDir(task.id, attempt.attempt);
  const assembly =
    preassembled ??
    assembleAttempt(
      task,
      attempt.attempt,
      attempt.itemIds,
      attempt.maxOutputTokens,
    );
  fs.mkdirSync(attemptDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  fs.writeFileSync(path.join(attemptDir, 'input.jsonl'), assembly.jsonl, {
    mode: PRIVATE_FILE_MODE,
  });

  const uploaded = await api.uploadJsonl(
    deps.ep,
    assembly.jsonl,
    `${task.id}-attempt-${attempt.attempt}.jsonl`,
  );
  attempt.inputFileId = uploaded.id;
  attempt.submitState = 'uploaded';
  store.save(task);

  try {
    const job = await api.createBatch(
      deps.ep,
      uploaded.id,
      task.completionWindow,
    );
    // An accepted create whose body names no batch (a proxy page, a dialect
    // difference) is as ambiguous as a lost answer: reconcile, never guess.
    if (typeof job?.id !== 'string' || !job.id) {
      throw new Error('the create response carried no batch id');
    }
    attempt.batchId = job.id;
    attempt.submitState = 'created';
    attempt.submittedAt = new Date().toISOString();
    markSubmitted(task, attempt);
    refreshTaskStatus(task);
    store.save(task);
    deps.out(`batch job: ${job.id}`);
  } catch (error) {
    const status = (error as BatchApiError | undefined)?.status;
    // 408 is a timeout, not a refusal: the create may still have landed.
    if (
      typeof status === 'number' &&
      status >= 400 &&
      status < 500 &&
      status !== 408
    ) {
      // Definite refusal: no job exists. The orphaned input file is deleted
      // best-effort and the attempt can be retried safely.
      await api.deleteFile(deps.ep, uploaded.id).catch(() => undefined);
      attempt.submitState = 'intent';
      attempt.inputFileId = undefined;
      attempt.error = `create refused by provider: ${error instanceof Error ? error.message : String(error)}`;
      for (const item of task.items) {
        if (attempt.itemIds.includes(item.id)) {
          item.state = 'failed';
          item.lastError = attempt.error;
        }
      }
      refreshTaskStatus(task);
      store.save(task);
      throw new Error(attempt.error);
    }
    // Ambiguous: the create may have succeeded without its answer reaching
    // us. Record everything known and stop — `collect` reconciles against
    // the provider's list; nothing resubmits on its own.
    attempt.submitState = 'unknown';
    attempt.error = `create did not complete cleanly: ${error instanceof Error ? error.message : String(error)}`;
    refreshTaskStatus(task);
    store.save(task);
    deps.err(
      `[batch] the create request did not complete cleanly; the batch may exist and be billing.`,
    );
    deps.err(
      `[batch] run \`qwen batch collect ${task.id}\` to reconcile before doing anything else.`,
    );
  }
}

/**
 * Plans live in the project (the agent writes them with its normal file
 * tools) under `.qwen/batch/plans/`; they are working files, not source.
 */
function keepPlansOutOfGit(cwd: string, planPath: string): void {
  const plansHome = path.join(cwd, '.qwen', 'batch');
  if (!planPath.startsWith(plansHome + path.sep)) return;
  const ignore = path.join(plansHome, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
}

export async function runPlan(
  deps: WorkflowDeps,
  planFile: string,
): Promise<void> {
  const planPath = path.resolve(deps.cwd, planFile);
  const plan = loadPlanFile(planPath);
  const window = plan.completionWindow ?? '24h';
  assertValidWindow(window);
  keepPlansOutOfGit(deps.cwd, planPath);
  const store = new BatchTaskStore(batchHomeDir(deps.env));
  const task = store.create(plan, deps.cwd, deps.ep.model);
  const request = freezeRequest(deps.ep.generationConfig);
  task.request = request;
  task.endpoint = endpointOf(deps.ep);

  const attemptNumber = 1;
  const attempt: TaskAttempt = {
    attempt: attemptNumber,
    itemIds: plan.items.map((item) => item.id),
    submitState: 'intent',
  };
  task.attempts.push(attempt);
  let assembly: AttemptAssembly;
  let cost: { text: string; costUsd?: number };
  try {
    if (plan.enableThinking === false && request.thinkingMandatory) {
      throw new Error(
        `plan sets enableThinking=false but ${task.model} requires thinking; remove the field.`,
      );
    }
    assembly = assembleAttempt(task, attemptNumber, attempt.itemIds);
    cost = costLine(assembly.inputTokens, assembly.outputTokens, deps.env);
    enforceBudget(plan, cost);
  } catch (error) {
    // Nothing reached the provider: leave no empty task behind in `list`.
    store.remove(task.id);
    throw error;
  }
  store.save(task);

  deps.out(
    `task ${task.id}: ${task.items.length} item(s), window ${task.completionWindow}`,
  );
  const effective = {
    ...request,
    params: {
      ...request.params,
      ...(plan.enableThinking === undefined
        ? {}
        : { enable_thinking: plan.enableThinking }),
    },
  };
  const limit = outputLimitOf(task, attempt.maxOutputTokens);
  deps.out(
    `model ${task.model}, ${describeThinking(effective)}, ` +
      `max output ${limit === undefined ? 'provider default' : `${limit} tokens`} ` +
      `(frozen from your current settings; retries reuse them)`,
  );
  for (const note of request.notes) {
    deps.err(`[batch] note: ${note}`);
  }
  deps.out(cost.text);
  await store.withLock(
    task.id,
    () => submitAttempt(deps, task, attempt, store, assembly),
    { waitMs: deps.lockWaitMs },
  );
  deps.out(`collect later with: qwen batch collect ${task.id}`);
}

async function reconcileUnknownAttempt(
  deps: WorkflowDeps,
  task: BatchTask,
  attempt: TaskAttempt,
  store: BatchTaskStore,
): Promise<boolean> {
  const api = deps.api ?? liveApi;
  if (attempt.inputFileId === undefined) {
    deps.err(
      `[batch] attempt ${attempt.attempt} is marked unknown but has no uploaded file id; nothing to reconcile.`,
    );
    return false;
  }
  const jobs = await api.listBatches(deps.ep);
  const candidates = jobs.filter(
    (job) => job.input_file_id === attempt.inputFileId,
  );
  if (candidates.length === 1) {
    attempt.batchId = candidates[0].id;
    attempt.submitState = 'created';
    attempt.error = undefined;
    markSubmitted(task, attempt);
    refreshTaskStatus(task);
    store.save(task);
    deps.out(
      `reconciled: attempt ${attempt.attempt} is batch ${attempt.batchId}`,
    );
    return true;
  }
  if (candidates.length > 1) {
    deps.err(
      `[batch] ${candidates.length} batches reference input file ${attempt.inputFileId}: ${candidates
        .map((job) => job.id)
        .join(
          ', ',
        )}. Not guessing — inspect them in the provider console and fix task.json by hand.`,
    );
  } else {
    deps.err(
      `[batch] no batch references input file ${attempt.inputFileId}. The create likely never landed; ` +
        `the provider's batch list is the source of truth. If you confirm none exists, ` +
        `edit task.json to set this attempt's submitState back to "intent", then run \`qwen batch retry ${task.id}\`.`,
    );
  }
  return false;
}

interface CollectOptions {
  wait?: boolean;
  timeoutSeconds?: number;
}

/** Undefined when the line carries no usable usage — never a silent zero. */
const usageOfBody = (
  body: unknown,
): { promptTokens: number; completionTokens: number } | undefined => {
  const usage = (body as { usage?: Record<string, unknown> } | undefined)
    ?.usage;
  const prompt = Number(usage?.['prompt_tokens']);
  const completion = Number(usage?.['completion_tokens']);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) {
    return undefined;
  }
  return { promptTokens: prompt, completionTokens: completion };
};

/**
 * The provider's job-level errors, one line each. A batch rejected as a
 * whole (unsupported model, invalid file) has no per-line output, so these
 * are the only explanation of why every item failed.
 */
function jobErrorsOf(job: BatchJob): string[] {
  return (job.errors?.data ?? [])
    .slice(0, 5)
    .map((error) =>
      [
        error.code,
        error.message,
        typeof error.line === 'number' ? `(line ${error.line})` : undefined,
      ]
        .filter(Boolean)
        .join(' '),
    );
}

/** Poll until settled or the collect-wide `deadline` (epoch ms) passes —
 * one --timeout covers every open batch, not each of them in turn. */
async function waitForSettled(
  deps: WorkflowDeps,
  batchId: string,
  deadline: number,
): Promise<BatchJob> {
  const api = deps.api ?? liveApi;
  const sleep = deps.sleep ?? realSleep;
  let delay = 10_000;
  for (;;) {
    const job = await api.getBatch(deps.ep, batchId);
    if (SETTLED_STATUSES.has(job.status)) return job;
    if (Date.now() >= deadline) {
      throw new Error(
        `${batchId} is still ${job.status} after the --wait timeout; run collect again later.`,
      );
    }
    deps.out(`waiting: ${batchId} is ${job.status} …`);
    // Cap the nap at the remaining deadline: --timeout is a hard ceiling on
    // the whole collect, not a per-iteration suggestion.
    await sleep(Math.min(delay, deadline - Date.now()));
    delay = Math.min(delay * 2, 60_000);
  }
}

/** What one collect changed, for callers that report it (auto-collect). */
export interface CollectSummary {
  taskId: string;
  /** Batches that settled and were collected by this call. */
  settled: number;
  /** Items delivered by this call. */
  delivered: TaskItem[];
  /** Current held / failed items, and items still awaiting a batch. */
  held: TaskItem[];
  failed: TaskItem[];
  awaiting: number;
  /** Job-level provider errors of the batches settled by this call. */
  jobErrors: string[];
}

export async function collectTask(
  deps: WorkflowDeps,
  taskId: string,
  options: CollectOptions = {},
): Promise<CollectSummary> {
  const store = new BatchTaskStore(batchHomeDir(deps.env));
  if (options.wait) {
    // Wait without the task lock: a batch can take hours, and cancel, retry
    // and the session's auto-collector must stay usable meanwhile.
    const task = store.load(taskId);
    assertSameEndpoint(task, deps.ep);
    const deadline =
      options.timeoutSeconds === undefined
        ? Infinity
        : Date.now() + options.timeoutSeconds * 1000;
    for (const attempt of task.attempts) {
      if (
        attempt.submitState === 'created' &&
        attempt.batchId &&
        !attempt.collected
      ) {
        await waitForSettled(deps, attempt.batchId, deadline);
      }
    }
  }
  return store.withLock(taskId, () => collectLocked(deps, store, taskId), {
    waitMs: deps.lockWaitMs,
  });
}

async function collectLocked(
  deps: WorkflowDeps,
  store: BatchTaskStore,
  taskId: string,
): Promise<CollectSummary> {
  const api = deps.api ?? liveApi;
  const task = store.load(taskId);
  assertSameEndpoint(task, deps.ep);
  const deliveredBefore = new Set(
    task.items
      .filter((item) => item.state === 'delivered')
      .map((item) => item.id),
  );
  let settledNow = 0;
  const settledErrors: string[] = [];
  const itemById = new Map(task.items.map((item) => [item.id, item]));

  for (const attempt of task.attempts) {
    if (isAmbiguous(attempt)) {
      await reconcileUnknownAttempt(deps, task, attempt, store);
    }
  }
  const openAttempts = task.attempts.filter(
    (attempt) => attempt.submitState === 'created' && attempt.batchId,
  );
  if (
    openAttempts.length === 0 &&
    task.items.every((i) => i.state === 'pending')
  ) {
    throw new Error(
      `task ${taskId} has no submitted batch; nothing to collect.`,
    );
  }

  // One batch failing to collect (a download error, a provider hiccup) must
  // not hide what the others delivered: collect each, report all, then fail.
  const attemptFailures: string[] = [];
  const collectAttempt = async (attempt: TaskAttempt): Promise<void> => {
    const batchId = attempt.batchId as string;
    // A collected attempt is fully local: re-reading it re-tries held
    // deliveries without asking the provider about a batch it may have
    // forgotten by now.
    let job: BatchJob | undefined;
    // finalStatus is recorded at the first harvest; a later collect that
    // only retries remote cleanup must not re-announce the batch as newly
    // settled (auto-collect would repeat the notice every pass).
    const firstHarvest = attempt.finalStatus === undefined;
    if (!attempt.collected) {
      job = await api.getBatch(deps.ep, batchId);
      if (!SETTLED_STATUSES.has(job.status)) {
        deps.out(
          `${batchId} is ${job.status} (${job.request_counts?.completed ?? 0}/${job.request_counts?.total ?? attempt.itemIds.length}); ` +
            `re-run \`qwen batch collect ${taskId}\` later or add --wait.`,
        );
        return;
      }
    }

    // Settled but its result file not published yet: collecting now would
    // fail every item as "no result line" and invite a paid retry of
    // requests that were already billed. For `completed`, a provider that
    // omits request_counts is treated as "results expected" (fail closed); a
    // cancelled or expired batch defers only when it reports finished work.
    const finished = job?.request_counts?.completed;
    if (
      job &&
      !job.output_file_id &&
      !job.error_file_id &&
      (job.status === 'completed'
        ? finished !== 0
        : (job.status === 'cancelled' || job.status === 'expired') &&
          (finished ?? 0) > 0)
    ) {
      deps.out(
        `${batchId} is ${job.status} but its result file is not available yet; collect again shortly.`,
      );
      return;
    }

    if (job) {
      attempt.finalStatus = job.status;
      const errors = jobErrorsOf(job);
      if (errors.length > 0) attempt.jobErrors = errors;
      settledErrors.push(...errors);
    }

    const attemptDir = store.attemptDir(task.id, attempt.attempt);
    fs.mkdirSync(attemptDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (job?.output_file_id && !attempt.outputPath) {
      const target = path.join(attemptDir, 'output.jsonl');
      await api.downloadFile(deps.ep, job.output_file_id, target);
      attempt.outputPath = target;
      store.save(task);
    }
    if (job?.error_file_id && !attempt.errorPath) {
      const target = path.join(attemptDir, 'error.jsonl');
      await api.downloadFile(deps.ep, job.error_file_id, target);
      attempt.errorPath = target;
      store.save(task);
    }

    const seen = new Set<string>();
    const usage = {
      promptTokens: 0,
      completionTokens: 0,
      requests: 0,
      missing: 0,
    };
    const reportMalformed = (message: string) =>
      deps.err(`[batch] attempt ${attempt.attempt}: skipping ${message}`);
    // The item a result line belongs to, if it is one of this attempt's.
    const itemOf = (customId: string | undefined) => {
      const identity = customId ? parseCustomId(customId) : undefined;
      return identity?.attempt === attempt.attempt
        ? itemById.get(identity.itemId)
        : undefined;
    };
    if (attempt.outputPath && fs.existsSync(attempt.outputPath)) {
      for (const line of parseOutputJsonl(
        fs.readFileSync(attempt.outputPath, 'utf8'),
        reportMalformed,
      )) {
        const item = itemOf(line.custom_id);
        if (!item) {
          deps.err(
            `[batch] ignoring result with unknown custom_id "${line.custom_id ?? ''}"`,
          );
          continue;
        }
        if (seen.has(item.id)) {
          deps.err(`[batch] ignoring duplicate result for item "${item.id}"`);
          continue;
        }
        seen.add(item.id);
        // Billed whatever happens to the item next, so counted before any
        // skip; recomputed from the whole file each time, so re-collecting
        // neither double-counts nor erases it.
        if (line.response?.body !== undefined) {
          const perRequest = usageOfBody(line.response.body);
          usage.requests += 1;
          if (perRequest) {
            usage.promptTokens += perRequest.promptTokens;
            usage.completionTokens += perRequest.completionTokens;
          } else {
            usage.missing += 1;
          }
        }
        // Only the item's latest attempt may move it. Replaying an older
        // attempt's failure while a retry runs would otherwise re-open it
        // for another (billed) retry; a delivered item is terminal.
        if (item.state === 'delivered' || !ownedBy(item, attempt)) {
          continue;
        }
        const verdict = classifyResult(line);
        if (verdict.kind === 'failed') {
          item.state = 'failed';
          item.lastError = verdict.reason;
          item.heldReason = undefined;
          item.truncated = verdict.truncated || undefined;
          continue;
        }
        const outcome = deliverResult(
          item,
          verdict.content,
          task.projectRoot,
          item.sourceSha256,
        );
        if (outcome.kind === 'delivered') {
          item.state = 'delivered';
          item.deliveredSha256 = sha256(verdict.content);
          item.lastError = undefined;
          item.heldReason = undefined;
        } else {
          item.state = 'held';
          item.heldReason = outcome.reason;
          item.sourceChanged = outcome.sourceChanged;
          item.lastError = undefined;
        }
      }
    }
    if (attempt.errorPath && fs.existsSync(attempt.errorPath)) {
      for (const line of parseOutputJsonl(
        fs.readFileSync(attempt.errorPath, 'utf8'),
        reportMalformed,
      )) {
        const item = itemOf(line.custom_id);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        // Same rule as the output loop.
        if (item.state === 'delivered' || !ownedBy(item, attempt)) {
          continue;
        }
        item.state = 'failed';
        item.lastError = `provider reported failure: ${JSON.stringify(line.error ?? line).slice(0, 300)}`;
      }
    }
    // The provider reports finished requests, yet not one line of the result
    // files maps to this attempt: we could not read what was produced (a
    // corrupt download, a format we do not parse). Failing every item would
    // invite a paid retry and cleanup would delete the only good copy, so
    // keep the remote files, drop the local copies for a fresh download and
    // stop here.
    if (
      job &&
      (attempt.outputPath || attempt.errorPath) &&
      seen.size === 0 &&
      (job.request_counts?.completed ?? 0) > 0
    ) {
      attempt.outputPath = undefined;
      attempt.errorPath = undefined;
      store.save(task);
      throw new Error(
        `none of the result lines matched this attempt although the provider reports ` +
          `${job.request_counts?.completed} finished request(s); remote files were kept and ` +
          `nothing was marked failed — collect again, or inspect the batch in the provider console`,
      );
    }
    for (const itemId of attempt.itemIds) {
      const item = itemById.get(itemId);
      if (item && item.state === 'submitted' && ownedBy(item, attempt)) {
        item.state = 'failed';
        // A batch rejected as a whole leaves no per-line output: name the
        // provider's reason instead of a bare "no result line".
        item.lastError = attempt.jobErrors?.length
          ? `batch ${attempt.finalStatus ?? 'failed'}: ${attempt.jobErrors[0]}`
          : attempt.finalStatus && attempt.finalStatus !== 'completed'
            ? `batch ${attempt.finalStatus} before this request produced a result`
            : 'no result line for this request in the settled batch';
      }
    }
    attempt.usage = usage;
    refreshTaskStatus(task);
    store.save(task);

    if (job) {
      // Results are safely local now; uploaded files otherwise live on the
      // provider until somebody deletes them. A failed deletion leaves the
      // attempt uncollected, so the next collect re-fetches the settled batch
      // and retries instead of leaking the files; it never fails the collect.
      let failed = 0;
      for (const fileId of [
        job.input_file_id,
        job.output_file_id,
        job.error_file_id,
      ]) {
        if (!fileId) continue;
        try {
          await api.deleteFile(deps.ep, fileId);
        } catch (error) {
          // Already gone (deleted by an earlier pass, or expired): done.
          if ((error as BatchApiError).status === 404) continue;
          failed += 1;
          deps.err(
            `[batch] warning: could not delete remote file ${fileId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (firstHarvest) settledNow += 1;
      attempt.collected = failed === 0;
      store.save(task);
    }
  };
  for (const attempt of openAttempts) {
    try {
      await collectAttempt(attempt);
    } catch (error) {
      attemptFailures.push(
        `${attempt.batchId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const delivered = task.items.filter((item) => item.state === 'delivered');
  const held = task.items.filter((item) => item.state === 'held');
  const failed = task.items.filter((item) => item.state === 'failed');
  const running = task.items.filter(
    (item) => item.state === 'submitted' || item.state === 'pending',
  );
  deps.out(
    `task ${task.id}: ${delivered.length} delivered, ${held.length} held, ${failed.length} failed, ${running.length} awaiting a settled batch`,
  );
  for (const item of held) {
    deps.out(`  held: ${item.id} — ${item.heldReason}`);
  }
  for (const item of failed) {
    deps.out(`  failed: ${item.id} — ${item.lastError}`);
  }
  for (const error of settledErrors) {
    deps.out(`  provider error: ${error}`);
  }
  const total = {
    promptTokens: 0,
    completionTokens: 0,
    requests: 0,
    missing: 0,
  };
  for (const attempt of task.attempts) {
    if (!attempt.usage) continue;
    total.promptTokens += attempt.usage.promptTokens;
    total.completionTokens += attempt.usage.completionTokens;
    total.requests += attempt.usage.requests;
    total.missing += attempt.usage.missing ?? 0;
  }
  if (total.requests > 0) {
    deps.out(
      `Batch usage, all attempts: ${total.promptTokens.toLocaleString()} in / ${total.completionTokens.toLocaleString()} out tokens across ${total.requests} request(s)` +
        (total.missing > 0
          ? ` — INCOMPLETE: ${total.missing} request(s) reported no usage, so these totals are a lower bound`
          : '') +
        `. Kept out of the interactive session's cache statistics; preparation in the session is not included.`,
    );
  }
  if (failed.length > 0) {
    deps.out(`retry failed items with: qwen batch retry ${task.id}`);
  }
  if (held.length > 0) {
    deps.out(
      `resolve the held conflicts above, then re-run: qwen batch collect ${task.id}`,
    );
  }
  const summary: CollectSummary = {
    taskId: task.id,
    settled: settledNow,
    delivered: delivered.filter((item) => !deliveredBefore.has(item.id)),
    held,
    failed,
    awaiting: running.length,
    jobErrors: settledErrors,
  };
  if (attemptFailures.length > 0) {
    for (const failure of attemptFailures) {
      deps.out(`  could not collect ${failure}`);
    }
    // Callers that report progress (auto-collect) still get what changed.
    throw Object.assign(
      new Error(`collect incomplete: ${attemptFailures.join('; ')}`),
      { summary },
    );
  }
  return summary;
}

export interface RetryOptions {
  /** Output limit for the new attempt; required to resend truncated items. */
  maxOutputTokens?: number;
}

export async function retryTask(
  deps: WorkflowDeps,
  taskId: string,
  options: RetryOptions = {},
): Promise<void> {
  const store = new BatchTaskStore(batchHomeDir(deps.env));
  await store.withLock(
    taskId,
    () => retryLocked(deps, store, taskId, options),
    { waitMs: deps.lockWaitMs },
  );
}

async function retryLocked(
  deps: WorkflowDeps,
  store: BatchTaskStore,
  taskId: string,
  options: RetryOptions,
): Promise<void> {
  const task = store.load(taskId);
  assertSameEndpoint(task, deps.ep);

  if (task.attempts.some(isAmbiguous)) {
    throw new Error(
      `task ${taskId} has an ambiguous submission; run \`qwen batch collect ${taskId}\` to reconcile before retrying.`,
    );
  }
  // Failed items, plus items whose only submission provably never became a
  // batch (e.g. an unconfirmed create the user reset to "intent").
  const createdIds = new Set(
    task.attempts
      .filter((attempt) => attempt.submitState === 'created')
      .flatMap((attempt) => attempt.itemIds),
  );
  // Items held because their source changed since submission need a new
  // request against the new source; other held items need the user.
  const candidates = task.items.filter(
    (item) =>
      item.state === 'failed' ||
      (item.state === 'held' && item.sourceChanged) ||
      (item.state === 'pending' && !createdIds.has(item.id)),
  );
  // A truncated item resent with the same output limit fails the same way
  // and is billed again: it needs a larger limit, not another attempt.
  const truncated = candidates.filter((item) => item.truncated);
  const newLimit = options.maxOutputTokens;
  if (newLimit !== undefined) {
    for (const item of truncated) {
      const previous = outputLimitOf(
        task,
        task.attempts.find((a) => a.attempt === item.lastAttempt)
          ?.maxOutputTokens,
      );
      if (previous !== undefined && newLimit <= previous) {
        throw new Error(
          `item "${item.id}" was truncated at ${previous} output tokens; ` +
            `--max-output-tokens ${newLimit} would fail the same way. Pass a larger value.`,
        );
      }
    }
  } else if (truncated.length > 0) {
    deps.out(
      `skipping ${truncated.length} truncated item(s) (${truncated.map((item) => item.id).join(', ')}): ` +
        `resending with the same output limit would fail the same way and be billed again. ` +
        `Retry them with --max-output-tokens <larger limit>.`,
    );
  }
  const retryItems =
    newLimit === undefined
      ? candidates.filter((item) => !item.truncated)
      : candidates;
  if (retryItems.length === 0) {
    if (truncated.length > 0) return;
    deps.out(
      `task ${taskId}: nothing to retry — no failed items ` +
        `(held target conflicts need resolving; then run \`qwen batch collect ${taskId}\`).`,
    );
    return;
  }
  for (const attempt of task.attempts) {
    if (
      attempt.submitState === 'created' &&
      attempt.batchId &&
      !attempt.collected
    ) {
      // Running, or settled with results that may already hold what we are
      // about to pay for again: either way, collect (or cancel) comes first.
      throw new Error(
        `batch ${attempt.batchId} is not collected yet and may still be running; ` +
          `run \`qwen batch collect ${taskId}\` (or cancel it) before retrying.`,
      );
    }
  }
  const attemptNumber = task.attempts.length + 1;
  const attempt: TaskAttempt = {
    attempt: attemptNumber,
    itemIds: retryItems.map((item) => item.id),
    submitState: 'intent',
    ...(newLimit === undefined ? {} : { maxOutputTokens: newLimit }),
  };
  task.attempts.push(attempt);
  // The budget must bind what is actually submitted: assemble the real
  // retry requests (sources are re-read now) instead of extrapolating from
  // the original run's per-item average, which undercounts a retry whose
  // failed items are the large ones — or whose sources grew since `run`.
  const assembly = assembleAttempt(
    task,
    attemptNumber,
    attempt.itemIds,
    attempt.maxOutputTokens,
  );
  const cost = costLine(assembly.inputTokens, assembly.outputTokens, deps.env);
  // The plan's budget binds every submission, not just the first.
  enforceBudget(task.plan, cost);
  deps.out(
    `retrying ${retryItems.length} item(s) as attempt ${attemptNumber}` +
      `${newLimit === undefined ? '' : ` with max output ${newLimit} tokens`}: ${cost.text}`,
  );
  await submitAttempt(deps, task, attempt, store, assembly);
  deps.out(`collect later with: qwen batch collect ${task.id}`);
}

/**
 * Preflight for `/batch-api`: prove the credentials, endpoint and Batch
 * route work, and show what a run would freeze — before the agent spends
 * anything on preparation. Makes no billed request.
 */
export async function checkReadiness(deps: WorkflowDeps): Promise<void> {
  const api = deps.api ?? liveApi;
  await api.probe(deps.ep);
  const request = freezeRequest(deps.ep.generationConfig);
  const frozenLimit = request.params['max_tokens'];
  deps.out(
    `ready: ${new URL(deps.ep.baseUrl).host} accepts Batch requests with these credentials (nothing was billed)`,
  );
  deps.out(
    `model ${deps.ep.model}, ${describeThinking(request)}, max output ` +
      `${typeof frozenLimit === 'number' ? `${frozenLimit} tokens` : 'provider default'}`,
  );
  for (const note of request.notes) deps.out(`note: ${note}`);
  const priced =
    unitPrice(deps.env, ENV_PRICE_INPUT) !== undefined &&
    unitPrice(deps.env, ENV_PRICE_OUTPUT) !== undefined;
  deps.out(
    priced
      ? 'unit prices configured: runs show a dollar estimate and can apply a maxCostUsd gate'
      : `no unit prices (${ENV_PRICE_INPUT}, ${ENV_PRICE_OUTPUT}): estimates are token-only and a plan must not set maxCostUsd`,
  );
}

/** Local only: reads the task store; no endpoint or credentials needed. */
export async function listTasks(
  deps: Pick<WorkflowDeps, 'env' | 'out'>,
): Promise<void> {
  const store = new BatchTaskStore(batchHomeDir(deps.env));
  const tasks = store.list();
  if (tasks.length === 0) {
    deps.out(`no batch tasks under ${batchHomeDir(deps.env)}`);
    return;
  }
  for (const task of tasks) {
    // Derive rather than trust the stored rollup: a process that died
    // mid-create never got to record `submit-unknown`.
    refreshTaskStatus(task);
    const delivered = task.items.filter(
      (item) => item.state === 'delivered',
    ).length;
    const latest = task.attempts.at(-1);
    deps.out(
      `${task.id}\t${task.status}\t${delivered}/${task.items.length} delivered` +
        `${latest?.batchId ? `\tbatch ${latest.batchId}` : ''}\tupdated ${task.updatedAt}\t${task.projectRoot}`,
    );
  }
}

export interface CleanOptions {
  /** Delete even though a batch may still be running or uncollected. */
  force?: boolean;
}

/**
 * Delete a task's local record. Local only: nothing is cancelled and no
 * remote file is deleted, and the record is the only way to collect results
 * or reconcile an ambiguous submission — so refuse while either could still
 * be needed, unless forced.
 */
export async function cleanTask(
  deps: Pick<WorkflowDeps, 'env' | 'out' | 'err' | 'lockWaitMs'>,
  taskId: string,
  options: CleanOptions = {},
): Promise<void> {
  const store = new BatchTaskStore(batchHomeDir(deps.env));
  await store.withLock(
    taskId,
    async () => {
      const task = store.load(taskId);
      const open = task.attempts.filter(
        (attempt) =>
          isAmbiguous(attempt) ||
          (attempt.submitState === 'created' && !attempt.collected),
      );
      if (open.length > 0 && !options.force) {
        throw new Error(
          `task ${taskId} has ${open.length} batch submission(s) that may still be running, billing, or holding uncollected results ` +
            `(${open.map((attempt) => attempt.batchId ?? `attempt ${attempt.attempt}, unreconciled`).join(', ')}). ` +
            `Collect or cancel first — deleting the record loses the only way to do either — or pass --force.`,
        );
      }
      for (const attempt of open) {
        deps.err(
          `[batch] warning: ${attempt.batchId ?? `attempt ${attempt.attempt}`} was not cancelled; it may still run and bill.`,
        );
      }
      store.remove(taskId);
      deps.out(`removed local record of task ${taskId}`);
    },
    { waitMs: deps.lockWaitMs },
  );
}

export async function cancelTask(
  deps: WorkflowDeps,
  taskId: string,
): Promise<void> {
  const store = new BatchTaskStore(batchHomeDir(deps.env));
  await store.withLock(taskId, () => cancelLocked(deps, store, taskId), {
    waitMs: deps.lockWaitMs,
  });
}

async function cancelLocked(
  deps: WorkflowDeps,
  store: BatchTaskStore,
  taskId: string,
): Promise<void> {
  const api = deps.api ?? liveApi;
  const task = store.load(taskId);
  assertSameEndpoint(task, deps.ep);
  const attempt = [...task.attempts]
    .reverse()
    .find(
      (candidate) => candidate.submitState === 'created' && candidate.batchId,
    );
  if (!attempt) {
    const hint = task.attempts.some(isAmbiguous)
      ? ` A submission is marked ambiguous — run \`qwen batch collect ${taskId}\` to reconcile it first.`
      : '';
    throw new Error(
      `task ${taskId} has no submitted batch to cancel (nothing was billed for generation yet).${hint}`,
    );
  }
  const job = await api.getBatch(deps.ep, attempt.batchId as string);
  if (SETTLED_STATUSES.has(job.status)) {
    deps.out(
      `${attempt.batchId} already settled (${job.status}); run \`qwen batch collect ${taskId}\` to pick up results.`,
    );
    return;
  }
  const cancelled = await api.cancelBatch(deps.ep, attempt.batchId as string);
  deps.out(
    `${cancelled.id} is ${cancelled.status}; already-completed requests are still billed. ` +
      `Run \`qwen batch collect ${taskId}\` once it settles to harvest partial results.`,
  );
}
