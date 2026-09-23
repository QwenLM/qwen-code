/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Orchestration for the agent-prepared Batch workflow (`qwen batch
// run|collect|list|retry|cancel --task`). The agent owns understanding the
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
  assertValidWindow,
  uploadBatchJsonl,
  createBatchJob,
  getBatchJob,
  cancelBatchJob,
  listBatchJobs,
  downloadRemoteFile,
  deleteRemoteFile,
} from './batch-client.js';
import type { BatchApiError } from './batch-client.js';
import type { BatchEndpoint, BatchJob } from './batch.js';
import {
  loadPlanFile,
  BatchTaskStore,
  batchHomeDir,
  refreshTaskStatus,
  parseCustomId,
  customIdOf,
  isAmbiguous,
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
} from './batch-docs.js';

// Product-level cap for one assembled request line. The provider accepts
// 6 MB; the workflow keeps 1 MB because a document transform bigger than
// that belongs in the raw `qwen batch submit` path with hand-checked input,
// not in an unattended agent-prepared job.
const WORKFLOW_MAX_LINE_BYTES = 1 * 1024 * 1024;

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
}

const liveApi: WorkflowApi = {
  uploadJsonl: uploadBatchJsonl,
  createBatch: createBatchJob,
  getBatch: getBatchJob,
  listBatches: listBatchJobs,
  downloadFile: downloadRemoteFile,
  deleteFile: deleteRemoteFile,
  cancelBatch: cancelBatchJob,
};

export interface WorkflowDeps {
  ep: BatchEndpoint;
  /** Project root: sources/targets resolve against it, the ledger lives in
   * its `.qwen/batch` (overridable with QWEN_BATCH_HOME, mostly for tests). */
  cwd: string;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  api?: WorkflowApi;
  sleep?: (ms: number) => Promise<void>;
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
): AttemptAssembly {
  const items = task.items.filter((item) => itemIds.includes(item.id));
  const assembled = assembleRequests(
    task.plan,
    items,
    attemptNumber,
    task.projectRoot,
    task.model,
  );
  let jsonl = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (const request of assembled) {
    const encoded = JSON.stringify(request.line) + '\n';
    const bytes = Buffer.byteLength(encoded);
    if (bytes > WORKFLOW_MAX_LINE_BYTES) {
      throw new Error(
        `item "${request.itemId}": assembled request is ${bytes} bytes, over the ` +
          `${WORKFLOW_MAX_LINE_BYTES}-byte workflow line limit. For larger documents ` +
          `use \`qwen batch submit\` with a hand-built file instead.`,
      );
    }
    jsonl += encoded;
    inputTokens += request.inputTokens;
    outputTokens +=
      task.plan.expectedOutputTokensPerItem ?? request.inputTokens;
    const item = task.items.find(
      (candidate) => candidate.id === request.itemId,
    );
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
    text: `${tokens}; estimated Batch cost ≈ $${costUsd.toFixed(4)} (estimate only — the provider bill is authoritative)`,
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

/** The attempt now owns these items: only its result lines count. */
function markSubmitted(task: BatchTask, attempt: TaskAttempt): void {
  for (const item of task.items) {
    if (attempt.itemIds.includes(item.id)) {
      item.state = 'submitted';
      item.lastAttempt = attempt.attempt;
      item.lastError = undefined;
      item.heldReason = undefined;
    }
  }
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
    preassembled ?? assembleAttempt(task, attempt.attempt, attempt.itemIds);
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(path.join(attemptDir, 'input.jsonl'), assembly.jsonl);

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

export async function runPlan(
  deps: WorkflowDeps,
  planFile: string,
): Promise<void> {
  const plan = loadPlanFile(planFile);
  const window = plan.completionWindow ?? '24h';
  assertValidWindow(window);
  const store = new BatchTaskStore(batchHomeDir(deps.cwd, deps.env));
  const task = store.create(plan, deps.cwd, deps.ep.model);

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
    assembly = assembleAttempt(task, attemptNumber, attempt.itemIds);
    cost = costLine(assembly.inputTokens, assembly.outputTokens, deps.env);
    enforceBudget(plan, cost);
  } catch (error) {
    // Nothing reached the provider: leave no empty task behind in `list`.
    store.remove(task.id);
    throw error;
  }
  task.estimate = {
    inputTokens: assembly.inputTokens,
    outputTokens: assembly.outputTokens,
    inputPricePer1MUsd: unitPrice(deps.env, ENV_PRICE_INPUT),
    outputPricePer1MUsd: unitPrice(deps.env, ENV_PRICE_OUTPUT),
  };
  store.save(task);

  deps.out(
    `task ${task.id}: ${task.items.length} item(s), window ${task.completionWindow}`,
  );
  deps.out(cost.text);
  await store.withLock(task.id, () =>
    submitAttempt(deps, task, attempt, store, assembly),
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
        )}. Not guessing — inspect them with \`qwen batch status <id>\` and fix task.json by hand.`,
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
  keepRemote?: boolean;
}

const usageOfBody = (
  body: unknown,
): { promptTokens: number; completionTokens: number } => {
  const usage = (body as { usage?: Record<string, unknown> } | undefined)
    ?.usage;
  const prompt = Number(usage?.['prompt_tokens'] ?? 0);
  const completion = Number(usage?.['completion_tokens'] ?? 0);
  return {
    promptTokens: Number.isFinite(prompt) ? prompt : 0,
    completionTokens: Number.isFinite(completion) ? completion : 0,
  };
};

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
    await sleep(delay);
    delay = Math.min(delay * 2, 60_000);
  }
}

export async function collectTask(
  deps: WorkflowDeps,
  taskId: string,
  options: CollectOptions = {},
): Promise<void> {
  const store = new BatchTaskStore(batchHomeDir(deps.cwd, deps.env));
  await store.withLock(taskId, () =>
    collectLocked(deps, store, taskId, options),
  );
}

async function collectLocked(
  deps: WorkflowDeps,
  store: BatchTaskStore,
  taskId: string,
  options: CollectOptions,
): Promise<void> {
  const api = deps.api ?? liveApi;
  const task = store.load(taskId);
  const deadline = Date.now() + (options.timeoutSeconds ?? 3600) * 1000;

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

  for (const attempt of openAttempts) {
    const batchId = attempt.batchId as string;
    // A collected attempt is fully local: re-reading it re-tries held
    // deliveries without asking the provider about a batch it may have
    // forgotten by now.
    let job: BatchJob | undefined;
    if (!attempt.collected) {
      job = await api.getBatch(deps.ep, batchId);
      if (!SETTLED_STATUSES.has(job.status)) {
        if (!options.wait) {
          deps.out(
            `${batchId} is ${job.status} (${job.request_counts?.completed ?? 0}/${job.request_counts?.total ?? attempt.itemIds.length}); ` +
              `re-run \`qwen batch collect ${taskId}\` later or add --wait.`,
          );
          continue;
        }
        job = await waitForSettled(deps, batchId, deadline);
      }
    }

    const attemptDir = store.attemptDir(task.id, attempt.attempt);
    fs.mkdirSync(attemptDir, { recursive: true });
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
    const usage = { promptTokens: 0, completionTokens: 0, requests: 0 };
    const reportMalformed = (message: string) =>
      deps.err(`[batch] attempt ${attempt.attempt}: skipping ${message}`);
    if (attempt.outputPath && fs.existsSync(attempt.outputPath)) {
      for (const line of parseOutputJsonl(
        fs.readFileSync(attempt.outputPath, 'utf8'),
        reportMalformed,
      )) {
        const identity = line.custom_id
          ? parseCustomId(line.custom_id)
          : undefined;
        const item = identity
          ? task.items.find((candidate) => candidate.id === identity.itemId)
          : undefined;
        if (!identity || !item || identity.attempt !== attempt.attempt) {
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
          usage.promptTokens += perRequest.promptTokens;
          usage.completionTokens += perRequest.completionTokens;
          usage.requests += 1;
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
          item.lastError = undefined;
        }
      }
    }
    if (attempt.errorPath && fs.existsSync(attempt.errorPath)) {
      for (const line of parseOutputJsonl(
        fs.readFileSync(attempt.errorPath, 'utf8'),
        reportMalformed,
      )) {
        const identity = line.custom_id
          ? parseCustomId(line.custom_id)
          : undefined;
        const item = identity
          ? task.items.find((candidate) => candidate.id === identity.itemId)
          : undefined;
        if (!item || identity?.attempt !== attempt.attempt) continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        // Same rule as the output loop.
        if (item.state === 'delivered' || !ownedBy(item, attempt)) {
          continue;
        }
        item.state = 'failed';
        item.lastError = `provider reported failure: ${JSON.stringify(line.error ?? line).slice(0, 300)}`;
      }
    }
    for (const itemId of attempt.itemIds) {
      const item = task.items.find((candidate) => candidate.id === itemId);
      if (item && item.state === 'submitted' && ownedBy(item, attempt)) {
        item.state = 'failed';
        item.lastError = 'no result line for this request in the settled batch';
      }
    }
    attempt.usage = usage;
    refreshTaskStatus(task);
    store.save(task);

    if (job && !options.keepRemote && !attempt.remoteCleaned) {
      // Results are safely local now; uploaded files otherwise live on the
      // provider until somebody deletes them. Failure here must not fail
      // the collection — the report below stays truthful either way.
      for (const fileId of [
        job.input_file_id,
        job.output_file_id,
        job.error_file_id,
      ]) {
        if (!fileId) continue;
        try {
          await api.deleteFile(deps.ep, fileId);
        } catch (error) {
          deps.err(
            `[batch] warning: could not delete remote file ${fileId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      attempt.remoteCleaned = true;
    }
    if (job) {
      attempt.collected = true;
      store.save(task);
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
  const usage = task.attempts.at(-1)?.usage;
  if (usage && usage.requests > 0) {
    deps.out(
      `latest attempt usage: ${usage.promptTokens.toLocaleString()} in / ${usage.completionTokens.toLocaleString()} out tokens across ${usage.requests} request(s) ` +
        `(Batch billing; kept out of the interactive session's cache statistics)`,
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
}

export async function retryTask(
  deps: WorkflowDeps,
  taskId: string,
): Promise<void> {
  const store = new BatchTaskStore(batchHomeDir(deps.cwd, deps.env));
  await store.withLock(taskId, () => retryLocked(deps, store, taskId));
}

async function retryLocked(
  deps: WorkflowDeps,
  store: BatchTaskStore,
  taskId: string,
): Promise<void> {
  const task = store.load(taskId);
  const api = deps.api ?? liveApi;

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
  const retryItems = task.items.filter(
    (item) =>
      item.state === 'failed' ||
      (item.state === 'pending' && !createdIds.has(item.id)),
  );
  if (retryItems.length === 0) {
    deps.out(
      `task ${taskId}: nothing to retry — no failed items ` +
        `(held items need their conflicts resolved; then run \`qwen batch collect ${taskId}\`).`,
    );
    return;
  }
  for (const attempt of task.attempts) {
    if (
      attempt.submitState === 'created' &&
      attempt.batchId &&
      !attempt.collected
    ) {
      const job = await api.getBatch(deps.ep, attempt.batchId);
      if (!SETTLED_STATUSES.has(job.status)) {
        throw new Error(
          `batch ${attempt.batchId} is still ${job.status}; wait for it to settle (or cancel it) before retrying.`,
        );
      }
      // Its results may already contain what we are about to pay for again.
      throw new Error(
        `batch ${attempt.batchId} has settled but is not collected yet; run \`qwen batch collect ${taskId}\` first.`,
      );
    }
  }
  const attemptNumber = task.attempts.length + 1;
  const attempt: TaskAttempt = {
    attempt: attemptNumber,
    itemIds: retryItems.map((item) => item.id),
    submitState: 'intent',
  };
  task.attempts.push(attempt);
  const perItem = task.estimate
    ? {
        input: task.estimate.inputTokens / task.items.length,
        output: task.estimate.outputTokens / task.items.length,
      }
    : { input: 0, output: 0 };
  const cost = costLine(
    Math.round(perItem.input * retryItems.length),
    Math.round(perItem.output * retryItems.length),
    deps.env,
  );
  // The plan's budget binds every submission, not just the first.
  enforceBudget(task.plan, cost);
  deps.out(
    `retrying ${retryItems.length} item(s) as attempt ${attemptNumber}: ${cost.text}`,
  );
  await submitAttempt(deps, task, attempt, store);
  deps.out(`collect later with: qwen batch collect ${task.id}`);
}

export async function listTasks(deps: WorkflowDeps): Promise<void> {
  const store = new BatchTaskStore(batchHomeDir(deps.cwd, deps.env));
  const tasks = store.list();
  if (tasks.length === 0) {
    deps.out(`no batch tasks under ${batchHomeDir(deps.cwd, deps.env)}`);
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
        `${latest?.batchId ? `\tbatch ${latest.batchId}` : ''}\tupdated ${task.updatedAt}`,
    );
  }
}

export async function cancelTask(
  deps: WorkflowDeps,
  taskId: string,
): Promise<void> {
  const store = new BatchTaskStore(batchHomeDir(deps.cwd, deps.env));
  await store.withLock(taskId, () => cancelLocked(deps, store, taskId));
}

async function cancelLocked(
  deps: WorkflowDeps,
  store: BatchTaskStore,
  taskId: string,
): Promise<void> {
  const api = deps.api ?? liveApi;
  const task = store.load(taskId);
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

export { customIdOf };
