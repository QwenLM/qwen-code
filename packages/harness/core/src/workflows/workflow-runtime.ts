/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import { normalizeAgentToolConstraints } from '../tools/agent-tool-constraints.js';
import type { Config } from '../config/config.js';
import type { QueryEvent } from '../core/query-event.js';

import { SchemaValidator } from '../utils/schemaValidator.js';
import type {
  WorkflowAgentRequest,
  WorkflowAgentResult,
  WorkflowAgentLiveProgress,
  WorkflowChildRequest,
  WorkflowJournalKeyInput,
  WorkflowProgressItem,
  ResolvedWorkflowRuntimeScript,
} from './workflow-types.js';
import {
  DEFAULT_WORKFLOW_SYNC_TIMEOUT_MS,
  compileWorkflowScript,
  createWorkflowVmContext,
} from './workflow-sandbox.js';

export interface WorkflowRuntimeOptions {
  config: Config;
  scriptBody: string;
  args?: unknown;
  signal?: AbortSignal;
  budget?: {
    total: number;
    spent?: () => number;
  };
  seedPhaseTitles?: string[];
  maxAgents?: number;
  maxConcurrency?: number;
  maxItems?: number;
  journal?: {
    nextCachedResult(
      input: WorkflowJournalKeyInput,
    ): Promise<{ key: string; result?: WorkflowAgentResult }>;
    appendStarted(key: string, agentId?: string): Promise<void>;
    appendResult(
      key: string,
      result: WorkflowAgentResult,
      agentId?: string,
    ): Promise<void>;
    appendEvent?(
      key: string,
      event: {
        kind: 'attempt_started' | 'retry' | 'skipped' | 'error';
        attempt?: number;
        maxAttempts?: number;
        reason?: 'stalled' | 'user-retry' | 'user-skip' | 'error';
        error?: string;
      },
      agentId?: string,
    ): Promise<void>;
  };
  onProgress?: (item: WorkflowProgressItem) => void;
  invokeAgent?: (request: {
    invocation: WorkflowAgentRequest & {
      index: number;
      label: string;
      attempt: number;
      phaseIndex?: number;
      phaseTitle?: string;
    };
    signal?: AbortSignal;
    onProgress?: (progress?: WorkflowAgentLiveProgress) => void;
    onQueryEvent?: (event: QueryEvent) => void;
  }) => Promise<WorkflowAgentResult | null>;
  resolveWorkflow?: (
    request: WorkflowChildRequest,
  ) => Promise<ResolvedWorkflowRuntimeScript>;
  nestedDepth?: number;
}

export interface WorkflowRuntimeResult {
  result: unknown;
  logs: string[];
  failures: string[];
  phaseCount: number;
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  durationMs: number;
  error?: string;
}

const MAX_WORKFLOW_LOGS = 1000;
export const DEFAULT_WORKFLOW_MAX_AGENTS = 1000;
export const DEFAULT_WORKFLOW_MAX_ITEMS = 4096;
export const DEFAULT_WORKFLOW_MAX_CONCURRENCY = Math.min(
  16,
  Math.max(2, os.cpus().length - 2),
);

export async function runWorkflowScript(
  options: WorkflowRuntimeOptions,
): Promise<WorkflowRuntimeResult> {
  const start = Date.now();
  const logs: string[] = [];
  const failures: string[] = [];
  let phaseIndex = 0;
  let agentCount = 0;
  let currentPhaseIndex: number | undefined;
  let currentPhaseTitle: string | undefined;
  let totalTokens = 0;
  let totalToolCalls = 0;
  const agentTokens = new Map<number, number>();
  const agentToolCalls = new Map<number, number>();
  const phases = new Map<string, number>();
  const maxAgents = options.maxAgents ?? DEFAULT_WORKFLOW_MAX_AGENTS;
  const maxItems = options.maxItems ?? DEFAULT_WORKFLOW_MAX_ITEMS;
  const semaphore = new WorkflowSemaphore(
    options.maxConcurrency ?? DEFAULT_WORKFLOW_MAX_CONCURRENCY,
  );
  const budget = createWorkflowBudget(options.budget);
  const rootDepth = options.nestedDepth ?? 0;

  const emit = (item: WorkflowProgressItem) => {
    if (item.type === 'workflow_agent') {
      if (typeof item.tokens === 'number') {
        const prev = agentTokens.get(item.index) ?? 0;
        agentTokens.set(item.index, item.tokens);
        totalTokens += item.tokens - prev;
      }
      if (typeof item.toolCalls === 'number') {
        const prev = agentToolCalls.get(item.index) ?? 0;
        agentToolCalls.set(item.index, item.toolCalls);
        totalToolCalls += item.toolCalls - prev;
      }
    }
    options.onProgress?.(item);
  };
  const log = (value: unknown) => {
    const message = String(value);
    if (logs.length < MAX_WORKFLOW_LOGS) logs.push(message);
    emit({ type: 'workflow_log', message, timestamp: Date.now() });
  };
  const resolvePhase = (title: string, kind: 'root' | 'child' = 'root') => {
    const existing = phases.get(title);
    if (existing !== undefined) return existing;
    const index = ++phaseIndex;
    phases.set(title, index);
    emit({ type: 'workflow_phase', index, title, kind });
    return index;
  };

  const setPhase = (title: unknown) => {
    const phaseTitle = String(title);
    currentPhaseTitle = phaseTitle;
    currentPhaseIndex = resolvePhase(phaseTitle);
    return currentPhaseIndex;
  };

  for (const title of options.seedPhaseTitles ?? []) {
    resolvePhase(title);
  }

  const parallel = async (thunks: unknown[]) => {
    if (options.signal?.aborted) return suspendAbortedWorkflow();
    if (!Array.isArray(thunks)) {
      throw new TypeError('parallel() expects an array of functions');
    }
    if (thunks.length > maxItems) {
      throw new Error(`parallel() item limit exceeded (${maxItems})`);
    }
    const settled = await Promise.allSettled(
      thunks.map((thunk) => {
        if (typeof thunk !== 'function') {
          throw new TypeError(
            'parallel() expects an array of functions, not promises',
          );
        }
        return Promise.resolve().then(() => (thunk as () => unknown)());
      }),
    );
    return settled.map((entry, index) => {
      if (entry.status === 'fulfilled') return entry.value;
      const message = `parallel[${index}] failed: ${formatError(entry.reason)}`;
      failures.push(message);
      log(message);
      return null;
    });
  };

  const pipeline = async (items: unknown[], ...stages: unknown[]) => {
    if (options.signal?.aborted) return suspendAbortedWorkflow();
    if (!Array.isArray(items)) {
      throw new TypeError('pipeline() expects an array as the first argument');
    }
    if (items.length > maxItems) {
      throw new Error(`pipeline() item limit exceeded (${maxItems})`);
    }
    for (const stage of stages) {
      if (typeof stage !== 'function') {
        throw new TypeError('pipeline() stages must be functions');
      }
    }
    const settled = await Promise.allSettled(
      items.map(async (item, index) => {
        let current: unknown = item;
        for (const stage of stages) {
          if (current === null) break;
          current = await (stage as (prev: unknown, item: unknown, index: number) => unknown)(
            current,
            item,
            index,
          );
        }
        return current;
      }),
    );
    return settled.map((entry, index) => {
      if (entry.status === 'fulfilled') return entry.value;
      const message = `pipeline[${index}] failed: ${formatError(entry.reason)}`;
      failures.push(message);
      log(message);
      return null;
    });
  };

  const agent = async (input: unknown, opts?: unknown) => {
    const request = normalizeAgentRequest(input, opts);
    Object.assign(request, normalizeAgentToolConstraints(request));
    request.effort = normalizeWorkflowAgentEffort(request.effort);
    if (options.signal?.aborted) return suspendAbortedWorkflow();
    if (typeof request.prompt !== 'string' || request.prompt.length === 0) {
      throw new TypeError('agent() requires a non-empty prompt');
    }
    if (!options.invokeAgent) {
      throw new Error('workflow agent() is not available');
    }
    const invokeAgent = options.invokeAgent;
    if (budget.remaining() <= 0) {
      throw new WorkflowBudgetExceededError();
    }
    if (agentCount >= maxAgents) {
      throw new WorkflowAgentLimitExceededError(maxAgents);
    }
    const index = ++agentCount;
    const requestedAgentType = workflowAgentType(request);
    const label =
      request.label ??
      request.name ??
      request.description ??
      request.agentType ??
      requestedAgentType ??
      `agent-${index}`;
    const agentPhaseTitle =
      request.phase === undefined || request.phase === null
        ? currentPhaseTitle
        : String(request.phase);
    const agentPhaseIndex =
      agentPhaseTitle === undefined
        ? undefined
        : resolvePhase(agentPhaseTitle);
    const startedAt = Date.now();
    const retryPolicy = resolveAgentRetryPolicy(request);
    const maxAttempts = retryPolicy.maxAttempts;
    const initialDisplayMaxAttempts = workflowAgentDisplayMaxAttempts(
      retryPolicy,
      1,
    );
    const journalInput: WorkflowJournalKeyInput = {
      prompt: request.prompt,
      schema: request.schema,
      model: request.model,
      effort: request.effort,
      isolation: request.isolation,
      agentType: requestedAgentType,
      disallowedTools: request.disallowedTools,
      bashCommandClamp: request.bashCommandClamp,
    };
    const journalEntry = await options.journal?.nextCachedResult(journalInput);
    if (options.signal?.aborted) return suspendAbortedWorkflow();
    const journalKey = journalEntry?.key;
    const emitAgent = (
      partial: Omit<
        Extract<WorkflowProgressItem, { type: 'workflow_agent' }>,
        | 'type'
        | 'index'
        | 'label'
        | 'phaseIndex'
        | 'phaseTitle'
        | 'agentType'
        | 'model'
        | 'effort'
        | 'isolation'
        | 'prompt'
        | 'journalKey'
      > & { agentType?: string; agentId?: string },
    ) => {
      emit({
        type: 'workflow_agent',
        index,
        label,
        phaseIndex: agentPhaseIndex,
        phaseTitle: agentPhaseTitle,
        agentType: requestedAgentType,
        model: request.model,
        effort: request.effort,
        isolation: request.isolation,
        prompt: request.prompt,
        journalKey,
        ...partial,
      });
    };
    emitAgent({
      state: 'start',
      promptPreview: request.prompt.slice(0, 200),
      startedAt,
      attempt: 1,
      maxAttempts: initialDisplayMaxAttempts,
    });

    if (request.skip === true) {
      if (journalEntry?.key) {
        await options.journal?.appendEvent?.(journalEntry.key, {
          kind: 'skipped',
          attempt: 0,
          maxAttempts: initialDisplayMaxAttempts,
          reason: 'user-skip',
        });
      }
      emitAgent({
        state: 'skipped',
        skipped: true,
        resultPreview: request.skipReason ?? 'Skipped',
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
    if (journalEntry?.result) {
      const cachedResult = {
        ...validateStructuredAgentResult(journalEntry.result, request.schema),
        cached: true,
      };
      emitAgent({
        agentId: cachedResult.agentId,
        agentType: cachedResult.agentType ?? requestedAgentType,
        state: 'done',
        cached: true,
        resultPreview: resultPreview(cachedResult),
        outputPath: cachedResult.outputPath,
        transcriptPath: cachedResult.transcriptPath,
        attemptTranscriptPaths: cachedResult.transcriptPath
          ? [cachedResult.transcriptPath]
          : undefined,
        tokens: cachedResult.tokens,
        toolCalls: cachedResult.toolCalls,
        durationMs: Date.now() - startedAt,
      });
      return agentScriptReturnValue(cachedResult, request.schema);
    }

    if (options.signal?.aborted) return suspendAbortedWorkflow();
    let lastError: unknown;
    const attemptTranscriptPaths: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptController = new AbortController();
      const onWorkflowAbort = () =>
        attemptController.abort(options.signal?.reason ?? 'unknown');
      options.signal?.addEventListener('abort', onWorkflowAbort, { once: true });
      try {
        const result = await semaphore.run(async () => {
          if (options.signal?.aborted) {
            throw new Error('Workflow aborted');
          }
          if (journalEntry?.key) {
            await options.journal?.appendStarted(journalEntry.key, undefined);
            await options.journal?.appendEvent?.(journalEntry.key, {
              kind: 'attempt_started',
              attempt,
              maxAttempts,
            });
          }
          if (options.signal?.aborted) {
            throw new Error('Workflow aborted');
          }
          return invokeAgentWithStallTimeout({
            invokeAgent,
            request,
            index,
            label,
            attempt,
            phaseIndex: agentPhaseIndex,
            phaseTitle: agentPhaseTitle,
            attemptController,
            onProgress: (progress) => {
              emitAgent({
                state: 'progress',
                promptPreview: request.prompt.slice(0, 200),
                startedAt,
                durationMs: Date.now() - startedAt,
                attempt,
                maxAttempts: workflowAgentDisplayMaxAttempts(
                  retryPolicy,
                  attempt,
                ),
                ...progress,
                lastProgressAt: progress?.lastProgressAt ?? Date.now(),
              });
            },
          });
        });
        if (result === null) {
          if (journalEntry?.key) {
            await options.journal?.appendEvent?.(journalEntry.key, {
              kind: 'skipped',
              attempt,
              maxAttempts,
              reason: 'user-skip',
            });
          }
          emitAgent({
            state: 'skipped',
            skipped: true,
            resultPreview: 'Skipped',
            attemptTranscriptPaths:
              attemptTranscriptPaths.length > 0
                ? [...attemptTranscriptPaths]
                : undefined,
            durationMs: Date.now() - startedAt,
            attempt,
            maxAttempts: workflowAgentDisplayMaxAttempts(
              retryPolicy,
              attempt,
            ),
          });
          return null;
        }
        if (!result) {
          throw new Error('workflow agent() is not available');
        }
        if (result.transcriptPath) {
          appendUnique(attemptTranscriptPaths, result.transcriptPath);
        }
        if (result.state === 'error') {
          if (result.apiError) {
            throw new WorkflowAgentApiError(result.apiError);
          }
          throw new Error(result.content || 'workflow agent failed');
        }
        const validated = validateStructuredAgentResult(result, request.schema);
        validated.attempts = attempt;
        if (journalEntry?.key) {
          await options.journal?.appendResult(
            journalEntry.key,
            validated,
            validated.agentId,
          );
        }
        emitAgent({
          agentId: validated.agentId,
          agentType: validated.agentType ?? requestedAgentType,
          state: validated.state === 'backgrounded' ? 'progress' : 'done',
          resultPreview: resultPreview(validated),
          outputPath: validated.outputPath,
          transcriptPath: validated.transcriptPath,
          attemptTranscriptPaths:
            attemptTranscriptPaths.length > 0
              ? [...attemptTranscriptPaths]
              : undefined,
          tokens: validated.tokens,
          toolCalls: validated.toolCalls,
          durationMs: Date.now() - startedAt,
          attempt,
          maxAttempts: workflowAgentDisplayMaxAttempts(retryPolicy, attempt),
        });
        return agentScriptReturnValue(validated, request.schema);
      } catch (error) {
        lastError = error;
        const message = formatError(error);
        attemptController.abort();
        if (options.signal?.aborted) return await suspendAbortedWorkflow();
        if (shouldRetryAgentError(error, attempt, retryPolicy)) {
          const retryDisplayMaxAttempts = workflowAgentDisplayMaxAttempts(
            retryPolicy,
            attempt,
            error,
          );
          if (journalEntry?.key) {
            await options.journal?.appendEvent?.(journalEntry.key, {
              kind: 'retry',
              attempt,
              maxAttempts: retryDisplayMaxAttempts,
              reason: workflowAgentRetryReason(error),
              error: message,
            });
          }
          emitAgent({
            state: 'retry',
            error: message,
            attemptTranscriptPaths:
              attemptTranscriptPaths.length > 0
                ? [...attemptTranscriptPaths]
                : undefined,
            durationMs: Date.now() - startedAt,
            attempt,
            maxAttempts: retryDisplayMaxAttempts,
          });
          continue;
        }
        const failure = `agent[${index}] ${label} failed: ${message}`;
        failures.push(failure);
        if (journalEntry?.key) {
          await options.journal?.appendEvent?.(journalEntry.key, {
            kind: 'error',
            attempt,
            maxAttempts: workflowAgentDisplayMaxAttempts(
              retryPolicy,
              attempt,
              error,
            ),
            reason: workflowAgentRetryReason(error),
            error: message,
          });
        }
        emitAgent({
          state: 'error',
          error: message,
          attemptTranscriptPaths:
            attemptTranscriptPaths.length > 0
              ? [...attemptTranscriptPaths]
              : undefined,
          durationMs: Date.now() - startedAt,
          attempt,
          maxAttempts: workflowAgentDisplayMaxAttempts(
            retryPolicy,
            attempt,
            error,
          ),
        });
        if (isWorkflowAgentApiError(error)) {
          return null;
        }
        throw error instanceof Error ? error : new Error(message);
      } finally {
        options.signal?.removeEventListener('abort', onWorkflowAbort);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(formatError(lastError));
  };

  const executeScript = async (
    scriptBody: string,
    scriptArgs: unknown,
    depth: number,
    seedPhaseTitles?: string[],
  ): Promise<unknown> => {
    for (const title of seedPhaseTitles ?? []) {
      resolvePhase(title, depth > rootDepth ? 'child' : 'root');
    }

    const script = compileWorkflowScript(scriptBody);
    const vmContext = createWorkflowVmContext(
      {
        args: scriptArgs,
        budget,
        log,
        phase: setPhase,
        parallel,
        pipeline,
        agent,
        workflow: (input: unknown, args?: unknown) =>
          runChildWorkflow(input, args, depth),
        console: {
          log,
          info: log,
          debug: log,
          warn: (value: unknown) => log(`[warn] ${String(value)}`),
          error: (value: unknown) => log(`[error] ${String(value)}`),
        },
      },
      options.signal,
    );

    const signal = options.signal;
    let removeAbortListener: (() => void) | undefined;
    try {
      const runPromise = Promise.resolve(
        script.runInContext(vmContext.context, {
          timeout: DEFAULT_WORKFLOW_SYNC_TIMEOUT_MS,
        }) as unknown,
      );
      if (!signal) return await runPromise;
      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error('Workflow aborted'));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () =>
          signal.removeEventListener('abort', onAbort);
      });
      return await Promise.race([runPromise, abortPromise]);
    } finally {
      removeAbortListener?.();
      vmContext.cleanup();
    }
  };

  const runChildWorkflow = async (
    input: unknown,
    args: unknown,
    depth: number,
  ): Promise<unknown> => {
    if (options.signal?.aborted) return suspendAbortedWorkflow();
    if (depth > rootDepth) {
      throw new WorkflowNestedInvalidError();
    }
    if (!options.resolveWorkflow) {
      throw new Error('workflow() is not available');
    }
    const request = normalizeWorkflowRequest(input, args);
    const child = await options.resolveWorkflow(request);
    if (options.signal?.aborted) return suspendAbortedWorkflow();
    const childPhaseTitle = child.meta.title ?? child.meta.name;
    const previousPhaseIndex = currentPhaseIndex;
    const previousPhaseTitle = currentPhaseTitle;
    currentPhaseTitle = childPhaseTitle;
    currentPhaseIndex = resolvePhase(childPhaseTitle, 'child');
    try {
      return await executeScript(
        child.scriptBody,
        request.args,
        depth + 1,
        child.meta.phases?.map((phase) => phase.title),
      );
    } finally {
      currentPhaseIndex = previousPhaseIndex;
      currentPhaseTitle = previousPhaseTitle;
    }
  };

  try {
    const result = await executeScript(
      options.scriptBody,
      options.args,
      rootDepth,
      options.seedPhaseTitles,
    );
    return {
      result,
      logs,
      failures,
      phaseCount: phaseIndex,
      agentCount,
      totalTokens,
      totalToolCalls,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      result: null,
      logs,
      failures,
      phaseCount: phaseIndex,
      agentCount,
      totalTokens,
      totalToolCalls,
      durationMs: Date.now() - start,
      error: formatError(error),
    };
  }
}

/**
 * The outer runner can stop awaiting a VM script, but it cannot cancel the
 * script's Promise. Leaving an aborted primitive pending prevents user code
 * from catching the abort and continuing to schedule workflow work.
 */
function suspendAbortedWorkflow(): Promise<never> {
  return new Promise<never>(() => {});
}

function createWorkflowBudget(
  budget: WorkflowRuntimeOptions['budget'],
): Readonly<{
  total: number | null;
  spent: () => number;
  remaining: () => number;
}> {
  if (!budget) {
    return Object.freeze({
      total: null,
      spent: () => 0,
      remaining: () => Infinity,
    });
  }
  return Object.freeze({
    total: budget.total,
    spent: () => Math.max(0, budget.spent?.() ?? 0),
    remaining: () =>
      Math.max(0, budget.total - Math.max(0, budget.spent?.() ?? 0)),
  });
}

function normalizeAgentRequest(
  input: unknown,
  opts?: unknown,
): WorkflowAgentRequest {
  if (typeof input === 'string') {
    if (opts === undefined) {
      return { prompt: input };
    }
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError('agent(prompt, opts) opts must be an object');
    }
    return { ...(opts as Omit<WorkflowAgentRequest, 'prompt'>), prompt: input };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('agent() expects an object or prompt string');
  }
  if (opts !== undefined) {
    throw new TypeError('agent({ ... }) does not accept a second argument');
  }
  return { ...(input as WorkflowAgentRequest) };
}

function workflowAgentType(
  request: WorkflowAgentRequest,
): string | undefined {
  return request.agentType ?? request.type ?? request.subagent_type;
}

export function normalizeWorkflowAgentEffort(
  effort: unknown,
): import('./workflow-types.js').WorkflowAgentEffort | undefined {
  if (typeof effort !== 'string') return undefined;
  switch (effort.toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort.toLowerCase() as import('./workflow-types.js').WorkflowAgentEffort;
    default:
      return undefined;
  }
}

function normalizeWorkflowRequest(
  input: unknown,
  args?: unknown,
): WorkflowChildRequest {
  if (typeof input === 'string') {
    if (!input.trim()) {
      throw new TypeError('workflow() requires a non-empty workflow name');
    }
    return { name: input, args };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('workflow() expects a workflow name or { scriptPath }');
  }
  const request = input as WorkflowChildRequest;
  if (args !== undefined && request.args !== undefined) {
    throw new TypeError(
      'workflow({ ... }) cannot combine object args with a second args parameter',
    );
  }
  if (!request.name && !request.scriptPath) {
    throw new TypeError('workflow() requires name or scriptPath');
  }
  if (request.name && request.scriptPath) {
    throw new TypeError('workflow() accepts name or scriptPath, not both');
  }
  return {
    ...request,
    args: request.args === undefined ? args : request.args,
  };
}

const MAX_WORKFLOW_AGENT_RETRIES = 5;
const DEFAULT_WORKFLOW_AGENT_STALL_MS = 180_000;

interface WorkflowAgentRetryPolicy {
  explicitRetries: number;
  stallRetries: number;
  maxAttempts: number;
  configuredMaxAttempts?: number;
}

class WorkflowAgentStallError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`workflow agent stalled after ${timeoutMs}ms without completing`);
    this.name = 'WorkflowAgentStallError';
  }
}

class WorkflowAgentApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowAgentApiError';
  }
}

class WorkflowBudgetExceededError extends Error {
  constructor() {
    super('Workflow budget exceeded');
    this.name = 'WorkflowBudgetExceededError';
  }
}

class WorkflowAgentLimitExceededError extends Error {
  constructor(limit: number) {
    super(`Workflow agent limit exceeded (${limit})`);
    this.name = 'WorkflowAgentLimitExceededError';
  }
}

class WorkflowNestedInvalidError extends Error {
  constructor() {
    super('workflow() nesting is limited to one child level');
    this.name = 'WorkflowNestedInvalidError';
  }
}

class WorkflowStructuredOutputInvalidError extends Error {
  constructor(validationError: string) {
    super(
      `agent structured output does not match schema: ${validationError}`,
    );
    this.name = 'WorkflowStructuredOutputInvalidError';
  }
}

export class WorkflowAgentUserRetryError extends Error {
  constructor() {
    super('workflow agent retry requested by user');
    this.name = 'WorkflowAgentUserRetryError';
  }
}

function resolveAgentRetryPolicy(
  request: WorkflowAgentRequest,
): WorkflowAgentRetryPolicy {
  const explicitRetries = normalizeRetryCount(request.retries);
  return {
    explicitRetries,
    stallRetries: MAX_WORKFLOW_AGENT_RETRIES,
    maxAttempts: 1 + Math.max(explicitRetries, MAX_WORKFLOW_AGENT_RETRIES),
    configuredMaxAttempts:
      explicitRetries > 0 ? 1 + explicitRetries : undefined,
  };
}

function workflowAgentDisplayMaxAttempts(
  policy: WorkflowAgentRetryPolicy,
  attempt: number,
  error?: unknown,
): number | undefined {
  if (isWorkflowAgentUserRetryError(error)) {
    return policy.maxAttempts;
  }
  if (
    policy.configuredMaxAttempts !== undefined &&
    attempt <= policy.configuredMaxAttempts
  ) {
    return policy.configuredMaxAttempts;
  }
  if (attempt > 1) {
    return policy.maxAttempts;
  }
  return undefined;
}

function normalizeRetryCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(MAX_WORKFLOW_AGENT_RETRIES, Math.max(0, Math.floor(value)));
}

function shouldRetryAgentError(
  error: unknown,
  attempt: number,
  policy: WorkflowAgentRetryPolicy,
): boolean {
  if (isWorkflowAgentStallError(error)) {
    return attempt <= policy.stallRetries;
  }
  if (isWorkflowAgentUserRetryError(error)) {
    return attempt <= MAX_WORKFLOW_AGENT_RETRIES;
  }
  return attempt <= policy.explicitRetries;
}

function isWorkflowAgentStallError(
  error: unknown,
): error is WorkflowAgentStallError {
  return error instanceof WorkflowAgentStallError;
}

function isWorkflowAgentUserRetryError(
  error: unknown,
): error is WorkflowAgentUserRetryError {
  return error instanceof WorkflowAgentUserRetryError;
}

function isWorkflowAgentApiError(
  error: unknown,
): error is WorkflowAgentApiError {
  return error instanceof WorkflowAgentApiError;
}

function workflowAgentRetryReason(
  error: unknown,
): 'stalled' | 'user-retry' | 'error' {
  if (isWorkflowAgentStallError(error)) return 'stalled';
  if (isWorkflowAgentUserRetryError(error)) return 'user-retry';
  return 'error';
}

function normalizeStallMs(
  request: WorkflowAgentRequest,
): number | undefined {
  const value = request.stallMs;
  if (value === undefined || value === null) {
    return DEFAULT_WORKFLOW_AGENT_STALL_MS;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const timeout = Math.floor(value);
  return timeout > 0 ? timeout : undefined;
}

function workflowAssistantBlockToolUseIds(
  event: Extract<QueryEvent, { type: 'assistant_block' }>,
): string[] {
  return event.message.blocks.flatMap((block) =>
    block.type === 'tool_use' ? [block.id] : [],
  );
}

function workflowToolResultIds(
  event: Extract<QueryEvent, { type: 'user' }>,
): string[] {
  const content = event.message.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string'
    ) {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
}

async function invokeAgentWithStallTimeout(params: {
  invokeAgent: NonNullable<WorkflowRuntimeOptions['invokeAgent']>;
  request: WorkflowAgentRequest;
  index: number;
  label: string;
  attempt: number;
  phaseIndex?: number;
  phaseTitle?: string;
  attemptController: AbortController;
  onProgress?: (progress?: WorkflowAgentLiveProgress) => void;
}): Promise<WorkflowAgentResult | null> {
  const invocation = {
    ...params.request,
    index: params.index,
    label: params.label,
    attempt: params.attempt,
    phaseIndex: params.phaseIndex,
    phaseTitle: params.phaseTitle,
  };
  const timeoutMs = normalizeStallMs(params.request);
  if (!timeoutMs) {
    return params.invokeAgent({
      invocation,
      signal: params.attemptController.signal,
      onProgress: params.onProgress,
    });
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let rejectStall: ((error: Error) => void) | undefined;
  let lastQueryProgressAt = 0;
  const inFlightToolUseIds = new Set<string>();
  const refreshIntervalMs = Math.min(timeoutMs * 0.1, 1000);
  const clearStallTimer = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  };
  const scheduleStallTimer = () => {
    if (settled || inFlightToolUseIds.size > 0) return;
    clearStallTimer();
    timeout = setTimeout(() => {
      if (settled) return;
      rejectStall?.(new WorkflowAgentStallError(timeoutMs));
      params.attemptController.abort('stalled');
    }, timeoutMs);
  };
  const markQueryProgress = () => {
    if (settled || inFlightToolUseIds.size > 0) return;
    const now = Date.now();
    if (now - lastQueryProgressAt < refreshIntervalMs) return;
    lastQueryProgressAt = now;
    scheduleStallTimer();
  };
  const handleQueryEvent = (event: QueryEvent) => {
    if (settled) return;
    markQueryProgress();

    if (event.type === 'assistant_block') {
      const ids = workflowAssistantBlockToolUseIds(event);
      if (ids.length > 0) {
        for (const id of ids) inFlightToolUseIds.add(id);
        clearStallTimer();
      }
      return;
    }

    if (event.type === 'user') {
      const ids = workflowToolResultIds(event);
      for (const id of ids) inFlightToolUseIds.delete(id);
      if (
        ids.length > 0 &&
        inFlightToolUseIds.size === 0 &&
        timeout === undefined
      ) {
        scheduleStallTimer();
      }
    }
  };
  const stallPromise = new Promise<never>((_, reject) => {
    rejectStall = reject;
    scheduleStallTimer();
  });
  try {
    return await Promise.race([
      params.invokeAgent({
        invocation,
        signal: params.attemptController.signal,
        onProgress: params.onProgress,
        onQueryEvent: handleQueryEvent,
      }),
      stallPromise,
    ]);
  } finally {
    settled = true;
    clearStallTimer();
  }
}

function validateStructuredAgentResult(
  result: WorkflowAgentResult,
  schema: unknown,
): WorkflowAgentResult {
  if (!schema) return result;
  const structured = result.structured;
  const validationError = SchemaValidator.validate(schema, structured);
  if (validationError) {
    throw new WorkflowStructuredOutputInvalidError(validationError);
  }
  return {
    ...result,
    structured,
  };
}

function resultPreview(result: WorkflowAgentResult): string {
  if (result.structured !== undefined) {
    try {
      return JSON.stringify(result.structured).slice(0, 500);
    } catch {
      return String(result.structured).slice(0, 500);
    }
  }
  return result.content.slice(0, 500);
}

function agentScriptReturnValue(
  result: WorkflowAgentResult,
  schema: unknown,
): WorkflowAgentResult | unknown {
  if (!schema) return result.content;
  return result.structured;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

class WorkflowSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}
