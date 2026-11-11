/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import { defineDeclarativeTool } from '../tools/define-tool.js';
import { Kind, type ToolResult } from '../tools/tools.js';
import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import { WORKFLOW_TOOL_NAME } from '../tools/tool-names.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import { enqueuePendingNotification } from '../services/messageQueueManager.js';

import { runLogger } from '../utils/runLogger.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { invokeWorkflowAgent } from './workflow-agent-adapter.js';
import { WorkflowJournal } from './workflow-journal.js';
import { buildWorkflowTaskNotificationXml } from './workflow-notification.js';
import { createWorkflowRegistryFromConfig } from './workflow-registry.js';
import { normalizeWorkflowToolArgs } from './workflow-args.js';
import { parseWorkflowScript } from './workflow-parser.js';
import { WORKFLOW_INPUT_DESCRIPTIONS, WORKFLOW_TOOL_DESCRIPTION } from './workflow-prompts.js';
import { isWorkflowAuthoringAvailable } from './workflow-authoring.js';
import { summarizeWorkflowInputSchema } from './workflow-schema-summary.js';
import {
  runWorkflowScript,
  WorkflowAgentUserRetryError,
  type WorkflowRuntimeResult,
} from './workflow-runtime.js';
import {
  getWorkflowJournalPath,
  getWorkflowOutputPath,
  getWorkflowTranscriptDir,
  persistWorkflowScript,
  readWorkflowRunManifest,
  readWorkflowScriptFile,
  resolveWorkflowRunProjectRoot,
  writeWorkflowRunManifest,
  writeWorkflowRunSnapshot,
  writeWorkflowOutput,
} from './workflow-storage.js';
import {
  WORKFLOW_MAX_SCRIPT_BYTES,
  WORKFLOW_RUN_ID_PREFIX,
  type ResolvedWorkflowRuntimeScript,
  type ResolvedWorkflowScript,
  type WorkflowChildRequest,
  type WorkflowLaunchResult,
  type WorkflowProgressItem,
  type WorkflowRunAgentIndex,
  type WorkflowToolParams,
} from './workflow-types.js';
import type { WorkflowUnifiedTask } from '../tasks/unified-task.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import { snapshotCustomContext } from '../utils/sessionIdContext.js';

export const WORKFLOW_LAUNCH_DISPLAY =
  'Running in background · /workflows to monitor and save';

type WorkflowTerminalStatus = 'completed' | 'failed' | 'killed';

const WORKFLOW_RESUME_RUN_ID_PATTERN = new RegExp(
  `^${WORKFLOW_RUN_ID_PREFIX}[a-z0-9-]{6,}$`,
);

const WORKFLOW_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    script: {
      type: 'string' as const,
      description:
        'Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` as a pure literal followed by the script body using agent()/parallel()/pipeline()/phase().',
      maxLength: WORKFLOW_MAX_SCRIPT_BYTES,
    },
    name: {
      type: 'string' as const,
      description:
        'Name of a predefined workflow from the built-in, plugin, project, or user workflow registry. Resolves to a self-contained script.',
    },
    description: {
      type: 'string' as const,
      description:
        "Ignored - set the workflow description in the script's `meta` block.",
    },
    title: {
      type: 'string' as const,
      description:
        "Ignored - set the workflow title in the script's `meta` block.",
    },
    scriptPath: {
      type: 'string' as const,
      description:
        'Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns scriptPath. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same scriptPath instead of re-sending the full script. Takes precedence over script and name.',
    },
    args: {
      description:
        'Optional input value exposed to the workflow script as global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string: use `args: {"value":"ok"}` or `args: ["a.ts","b.ts"]`, not `args: "{\\"value\\":\\"ok\\"}"` or `args: "[\\"a.ts\\",\\"b.ts\\"]"`. A stringified object/list reaches the script as one string, so `args.value`, `args.filter`, and `args.map` will fail. Use this to parameterize named workflows directly.',
    },
    resumeFromRunId: {
      type: 'string' as const,
      description:
        'Run ID of a prior same-session Workflow invocation to resume from. Completed agent() calls with unchanged prompt/options return cached results instantly; only edited or new calls re-run. Stop the prior run before resuming.',
    },
  },
} as const;

const WORKFLOW_AUTHORING_INPUT_SCHEMA = {
  ...WORKFLOW_INPUT_SCHEMA,
  properties: Object.fromEntries(Object.entries(WORKFLOW_INPUT_SCHEMA.properties)
    .map(([name, property]) => [name, {
      ...property,
      description: WORKFLOW_INPUT_DESCRIPTIONS[name as keyof typeof WORKFLOW_INPUT_DESCRIPTIONS],
    }])),
};

export const WorkflowTool = defineDeclarativeTool<
  WorkflowToolParams,
  ToolResult,
  Config
>({
  name: WORKFLOW_TOOL_NAME,
  displayName: WORKFLOW_TOOL_NAME,
  description: WORKFLOW_TOOL_DESCRIPTION,
  kind: Kind.Workflow,
  exposureHints: MODEL_ONLY_HINTS,
  parameterSchema: WORKFLOW_AUTHORING_INPUT_SCHEMA,
  isOutputMarkdown: true,
  maxResultSizeChars: 100_000,
  validateParams: (params, config, ctx) => {
    if (
      !params.script &&
      !params.scriptPath &&
      !params.name &&
      !params.resumeFromRunId
    ) {
      return 'One of script, scriptPath, name, or resumeFromRunId is required.';
    }
    if (
      params.resumeFromRunId &&
      !WORKFLOW_RESUME_RUN_ID_PATTERN.test(params.resumeFromRunId)
    ) {
      return 'resumeFromRunId must look like wf_<id>.';
    }
    try {
      if (params.script && !params.scriptPath) {
        parseWorkflowScriptForTool(params.script, config, params, ctx);
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  },
  toClassifierInput: (input) => ({
    scriptPath: input.scriptPath,
    name: input.name,
    script: input.script,
  }),
  getDescription: (params) => describeWorkflowInput(params),
  getDisplayTitle: (params) => describeWorkflowInput(params),
  execute: async (params, ctx, config) => {
    const artifactProjectRoot = config.getSessionArtifactProjectRoot();
    const sessionId = config.getSessionId();
    const projectRoot = params.resumeFromRunId
      ? await resolveWorkflowRunProjectRoot(
          artifactProjectRoot,
          sessionId,
          params.resumeFromRunId,
          config.getActiveSessionTranscriptPath(),
        )
      : artifactProjectRoot;
    const resolved = await resolveScript(params, config, projectRoot);
    const parsed = parseWorkflowScriptForTool(
      resolved.script,
      config,
      params,
      ctx,
    );
    const runId =
      params.resumeFromRunId ??
      `${WORKFLOW_RUN_ID_PREFIX}${randomUUID().slice(0, 12)}`;
    const taskId = `wf-${randomUUID().slice(0, 12)}`;
    const transcriptDir = getWorkflowTranscriptDir(projectRoot, sessionId, runId);
    const outputPath = getWorkflowOutputPath(projectRoot, sessionId, runId);
    const scriptPath =
      resolved.scriptPath ??
      (await persistWorkflowScript({
        projectRoot,
        sessionId,
        workflowName: parsed.meta.name,
        runId,
        script: resolved.script,
      }));
    let args = normalizeWorkflowToolArgs(
      params.args === undefined ? resolved.args : params.args,
    );
    if (parsed.meta.inputSchema && args === undefined) {
      args = {};
    }
    validateWorkflowArgs(parsed.meta, args);
    const now = new Date().toISOString();
    await writeWorkflowRunManifest(projectRoot, sessionId, {
      runId,
      resumedFromRunId: params.resumeFromRunId,
      workflowName: parsed.meta.name,
      scriptPath,
      source: resolved.source,
      args,
      meta: parsed.meta,
      createdAt: now,
      updatedAt: now,
      status: 'running',
    });

    const abortController = new AbortController();
    const execution = ExecutionLifecycleService.createExecution(
      `Workflow "${parsed.meta.name}" launched\n`,
      (reason) => abortController.abort(reason ?? 'unknown'),
      'none',
      undefined,
      parsed.meta.title ?? parsed.meta.name,
      'notify',
      {
        taskId,
        sessionId,
        toolUseId: ctx.callId,
        customContext: snapshotCustomContext(ctx.customContext),
      },
    );
    const executionId = execution.pid;
    if (executionId === undefined) {
      throw new Error('Failed to allocate workflow execution id');
    }

    const task: WorkflowUnifiedTask = {
      id: taskId,
      publicId: taskId,
      sessionId,
      ownerAgentId: ctx.agentId,
      type: 'local_workflow',
      status: 'running',
      description: parsed.meta.description,
      startTime: Date.now(),
      notified: false,
      executionId,
      toolUseId: ctx.callId,
      outputPath,
      completionBehavior: 'notify',
      workflowRunId: runId,
      workflowName: parsed.meta.name,
      title: parsed.meta.title,
      scriptPath,
      transcriptDir,
      args,
      phases: parsed.meta.phases,
      progress: [],
      logs: [],
      agentCount: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      abortController,
      agentControllers: {},
    };
    if (params.resumeFromRunId) {
      for (const existing of config.taskRegistry?.all() ?? []) {
        if (
          existing.type === 'local_workflow' &&
          existing.workflowRunId === runId &&
          existing.status !== 'running'
        ) {
          config.taskRegistry?.remove(existing.id);
        }
      }
    }
    config.taskRegistry?.register(task);



    void runWorkflowInBackground({
      config,
      projectRoot,
      ctx,
      taskId,
      executionId,
      runId,
      scriptPath,
      transcriptDir,
      scriptBody: parsed.scriptBody,
      args,
      workflowName: parsed.meta.name,
      source: resolved.source,
      abortController,
      summary: parsed.meta.description,
      seedPhaseTitles: parsed.meta.phases?.map((phase) => phase.title),
      resumedFromRunId: params.resumeFromRunId,
    });

    const launchResult: WorkflowLaunchResult = {
      status: 'async_launched',
      taskId,
      runId,
      resumedFromRunId: params.resumeFromRunId,
      summary: parsed.meta.description,
      transcriptDir,
      scriptPath,
    };

    return {
      llmContent: [
        `Workflow launched in background. Task ID: ${taskId}`,
        `Summary: ${parsed.meta.description}`,
        `Transcript dir: ${transcriptDir}`,
        `Script file: ${scriptPath}`,
        `(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "${scriptPath}"} to iterate without resending the script.)`,
        `Run ID: ${runId}`,
        `To resume after editing the script: Workflow({scriptPath: "${scriptPath}", resumeFromRunId: "${runId}"}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).`,
        '',
        'You will be notified when it completes. Use /workflows to watch live progress.',
      ].join('\n'),
      returnDisplay: WORKFLOW_LAUNCH_DISPLAY,
      data: { ...launchResult, workflow_source: resolved.source },
      toolUseResult: {
        summary: launchResult.summary,
        payload: JSON.stringify(launchResult, null, 2),
      },
    };
  },
});

async function resolveScript(
  params: WorkflowToolParams,
  config: Config,
  projectRoot: string,
): Promise<ResolvedWorkflowScript & { args?: unknown }> {
  if (params.resumeFromRunId) {
    const matchingLiveTask = config.taskRegistry
      ?.all()
      .find(
        (task) =>
          task.type === 'local_workflow' &&
          task.workflowRunId === params.resumeFromRunId &&
          task.status === 'running',
      );
    if (matchingLiveTask) {
      throw new Error(
        `Cannot resume workflow run ${params.resumeFromRunId} because task ${matchingLiveTask.id} is still running.`,
      );
    }
  }
  if (
    params.resumeFromRunId &&
    !params.script &&
    !params.scriptPath &&
    !params.name
  ) {
    const manifest = await readWorkflowRunManifest(
      projectRoot,
      config.getSessionId(),
      params.resumeFromRunId,
    );
    const resolved = await readWorkflowScriptFile(
      manifest.scriptPath,
      config.getProjectRoot(),
    );
    return {
      ...resolved,
      source: manifest.source,
      args: manifest.args,
    };
  }
  if (params.scriptPath) {
    const resolved = await readWorkflowScriptFile(
      params.scriptPath,
      config.getProjectRoot(),
    );
    return { ...resolved, source: 'path' };
  }
  if (params.script) {
    return { script: params.script, source: 'inline' };
  }
  if (params.name) {
    return createWorkflowRegistryFromConfig(config).resolve(params.name);
  }
  throw new Error(
    'Workflow requires one of script, scriptPath, name, or resumeFromRunId.',
  );
}

async function runWorkflowInBackground(params: {
  config: Config;
  projectRoot: string;
  ctx: ToolUseContext;
  taskId: string;
  executionId: number;
  runId: string;
  scriptPath: string;
  transcriptDir: string;
  scriptBody: string;
  args: unknown;
  workflowName: string;
  source: ResolvedWorkflowScript['source'];
  abortController: AbortController;
  summary: string;
  seedPhaseTitles?: string[];
  resumedFromRunId?: string;
}): Promise<void> {
  const projectRoot = params.projectRoot;
  const sessionId = params.config.getSessionId();
  const taskRegistry = params.config.taskRegistry;
  const currentJournalPath = getWorkflowJournalPath(
    projectRoot,
    sessionId,
    params.runId,
  );
  const sourceJournalPath = params.resumedFromRunId
    ? getWorkflowJournalPath(projectRoot, sessionId, params.resumedFromRunId)
    : currentJournalPath;
  let result: WorkflowRuntimeResult;
  try {
    const journal = await WorkflowJournal.load(
      sourceJournalPath,
      currentJournalPath,
    );
    result = await runWorkflowScript({
      config: params.config,
      scriptBody: params.scriptBody,
      args: params.args,
      signal: params.abortController.signal,
      seedPhaseTitles: params.seedPhaseTitles,
      journal,
      onProgress: (item) =>
        taskRegistry?.updateWorkflowProgress(params.taskId, [item]),
      invokeAgent: async ({
        invocation,
        signal,
        onProgress,
        onQueryEvent,
      }) => {
        const childAbortController = new AbortController();
        const agentKey = String(invocation.index);
        const onWorkflowAbort = () =>
          childAbortController.abort(
            params.abortController.signal.reason ?? 'unknown',
          );
        const onAttemptAbort = () =>
          childAbortController.abort(signal?.reason ?? 'workflow-attempt-abort');
        params.abortController.signal.addEventListener(
          'abort',
          onWorkflowAbort,
          { once: true },
        );
        signal?.addEventListener('abort', onAttemptAbort, { once: true });
        if (params.abortController.signal.aborted) onWorkflowAbort();
        if (signal?.aborted) onAttemptAbort();
        taskRegistry?.setWorkflowAgentController(
          params.taskId,
          agentKey,
          childAbortController,
        );
        try {
          if (childAbortController.signal.aborted) {
            throw new Error('Workflow aborted');
          }
          return await invokeWorkflowAgent({
            config: params.config,
            ctx: {
              ...params.ctx,
              signal: childAbortController.signal,
              abortController: childAbortController,
            },
            invocation,
            workflowRunId: params.runId,
            workflowExecutionId: params.taskId,
            onProgress,
            onQueryEvent,
          });
        } catch (error) {
          const reason = childAbortController.signal.reason;
          if (reason === 'user-skip') return null;
          if (reason === 'user-retry') throw new WorkflowAgentUserRetryError();
          throw error;
        } finally {
          params.abortController.signal.removeEventListener(
            'abort',
            onWorkflowAbort,
          );
          signal?.removeEventListener('abort', onAttemptAbort);
          taskRegistry?.setWorkflowAgentController(
            params.taskId,
            agentKey,
            undefined,
          );
        }
      },
      resolveWorkflow: (request) =>
        resolveChildWorkflowScript(request, params.config),
    });
  } catch (error) {
    result = {
      result: null,
      logs: [],
      failures: [],
      phaseCount: 0,
      agentCount: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      durationMs: 0,
      error: formatWorkflowError(error),
    };
  }

  const currentTask = taskRegistry?.get?.(params.taskId);
  const wasPaused =
    params.abortController.signal.reason === 'workflow-pause' ||
    (currentTask?.type === 'local_workflow' &&
      currentTask.status === 'paused');
  const wasKilled =
    !wasPaused &&
    (params.abortController.signal.aborted ||
      (currentTask?.type === 'local_workflow' &&
        currentTask.status === 'killed'));
  const terminalAt = Date.now();
  let status: WorkflowTerminalStatus;
  let naturalTerminalClaimed = false;
  if (wasPaused || wasKilled) {
    status = 'killed';
    if (wasKilled && currentTask?.type === 'local_workflow') {
      taskRegistry?.update(params.taskId, {
        result: result.result,
        error: result.error,
        agentCount: result.agentCount,
        abortController: undefined,
        agentControllers: undefined,
      } as Partial<WorkflowUnifiedTask>);
    }
  } else if (
    currentTask === undefined ||
    (currentTask.type === 'local_workflow' &&
      currentTask.status === 'running')
  ) {
    status = workflowStatus(params.abortController.signal, result);
    taskRegistry?.update(params.taskId, {
      status,
      endTime: terminalAt,
      notified: false,
      result: result.result,
      error: result.error,
      agentCount: result.agentCount,
      abortController: undefined,
      agentControllers: undefined,
    } as Partial<WorkflowUnifiedTask>);
    naturalTerminalClaimed = true;
  } else {
    status =
      currentTask.type === 'local_workflow' &&
      (currentTask.status === 'completed' || currentTask.status === 'failed')
        ? currentTask.status
        : workflowStatus(params.abortController.signal, result);
  }

  let outputPath = '';
  if (!wasPaused) {
    try {
      outputPath = await writeWorkflowOutput({
        projectRoot,
        sessionId,
        runId: params.runId,
        value: buildWorkflowOutputJson({
          result,
          status,
          runId: params.runId,
          taskId: params.taskId,
          workflowName: params.workflowName,
          scriptPath: params.scriptPath,
          transcriptDir: params.transcriptDir,
          resumedFromRunId: params.resumedFromRunId,
        }),
      });
    } catch (error) {
      runLogger.warn(
        `[Workflow] Failed to write output for ${params.taskId}: ${formatWorkflowError(error)}`,
      );
    }
  }
  const workflowTask = taskRegistry?.get?.(params.taskId);
  const agentIndex =
    workflowTask?.type === 'local_workflow'
      ? buildWorkflowRunAgentIndex(workflowTask.progress)
      : [];
  try {
    const previousManifest = await readWorkflowRunManifest(
      projectRoot,
      sessionId,
      params.runId,
    );
    await writeWorkflowRunManifest(
      projectRoot,
      sessionId,
      {
        ...previousManifest,
        updatedAt: new Date().toISOString(),
        status,
        ...(outputPath ? { outputPath } : {}),
        agents: agentIndex,
      },
    );
  } catch (error) {
    runLogger.warn(
      `[Workflow] Failed to update manifest for ${params.taskId}: ${formatWorkflowError(error)}`,
    );
  }
  ExecutionLifecycleService.appendOutput(
    params.executionId,
    wasPaused
      ? `Paused\n`
      : result.error
        ? `Failed: ${result.error}\n`
        : `Completed\n`,
  );
  ExecutionLifecycleService.completeExecution(params.executionId, {
    exitCode: status === 'completed' ? 0 : 1,
    error: !wasPaused && result.error ? new Error(result.error) : null,
    aborted: status === 'killed',
  });
  if (wasPaused) return;
  const terminalTask = params.config.taskRegistry?.get?.(params.taskId);
  if (terminalTask?.type === 'local_workflow') {
    try {
      await writeWorkflowRunSnapshot(projectRoot, sessionId, {
        version: 1,
        sessionId,
        runId: params.runId,
        taskId: params.taskId,
        workflowName: params.workflowName,
        title: terminalTask.title,
        summary: params.summary,
        status,
        startTime: terminalTask.startTime,
        endTime: terminalTask.endTime ?? Date.now(),
        scriptPath: params.scriptPath,
        transcriptDir: params.transcriptDir,
        ...(outputPath ? { outputPath } : {}),
        args: params.args,
        phases: terminalTask.phases,
        progress: terminalTask.progress,
        agentCount: result.agentCount,
        totalTokens: terminalTask.totalTokens,
        totalToolCalls: terminalTask.totalToolCalls,
        logs: result.logs,
        result: result.result,
        error: result.error,
      });
    } catch (error) {
      runLogger.warn(
        `Failed to write workflow snapshot ${params.runId}: ${formatWorkflowError(error)}`,
      );
    }
  }
  if (status === 'killed' || !naturalTerminalClaimed) return;
  enqueuePendingNotification({
    prompt: buildWorkflowTaskNotificationXml({
      taskId: params.taskId,
      outputPath,
      status,
      summary: params.summary,
      toolUseId: params.ctx.callId,
      scriptPath: params.scriptPath,
      transcriptDir: params.transcriptDir,
      runId: params.runId,
      args: params.args,
      result,
      workflowProgress:
        workflowTask?.type === 'local_workflow'
          ? workflowTask.progress
          : undefined,
    }),
    commandMode: 'task-notification',
    priority: 'next',
    ...(params.ctx.customContext !== undefined
      ? { customContext: snapshotCustomContext(params.ctx.customContext) }
      : {}),
  });
  taskRegistry?.markNotified?.(params.taskId);
}

function buildWorkflowRunAgentIndex(
  progress: WorkflowProgressItem[],
): WorkflowRunAgentIndex[] {
  const updatedAt = new Date().toISOString();
  return progress
    .filter(
      (item): item is Extract<WorkflowProgressItem, { type: 'workflow_agent' }> =>
        item.type === 'workflow_agent',
    )
    .sort((a, b) => a.index - b.index)
    .map((item) => ({
      index: item.index,
      label: item.label,
      phaseIndex: item.phaseIndex,
      phaseTitle: item.phaseTitle,
      journalKey: item.journalKey,
      agentId: item.agentId,
      agentType: item.agentType,
      model: item.model,
      effort: item.effort,
      state: item.state,
      cached: item.cached,
      skipped: item.skipped,
      attempts: item.attempt,
      outputPath: item.outputPath,
      transcriptPath: item.transcriptPath,
      attemptTranscriptPaths: item.attemptTranscriptPaths,
      updatedAt,
    }));
}

function buildWorkflowOutputJson(params: {
  result: WorkflowRuntimeResult;
  status: WorkflowTerminalStatus;
  runId: string;
  taskId: string;
  workflowName: string;
  scriptPath: string;
  transcriptDir: string;
  resumedFromRunId?: string;
}): Omit<WorkflowRuntimeResult, 'phaseCount' | 'totalTokens'> & {
  runId: string;
  taskId: string;
  workflowName: string;
  status: WorkflowTerminalStatus;
  usage: {
    agents: number;
    toolCalls: number;
    durationMs: number;
  };
  transcriptDir: string;
  scriptPath: string;
  resumeFromRunId?: string;
} {
  return {
    runId: params.runId,
    taskId: params.taskId,
    workflowName: params.workflowName,
    status: params.status,
    result: params.result.result,
    logs: params.result.logs,
    failures: params.result.failures,
    agentCount: params.result.agentCount,
    totalToolCalls: params.result.totalToolCalls,
    durationMs: params.result.durationMs,
    usage: {
      agents: params.result.agentCount,
      toolCalls: params.result.totalToolCalls,
      durationMs: params.result.durationMs,
    },
    transcriptDir: params.transcriptDir,
    scriptPath: params.scriptPath,
    ...(params.resumedFromRunId
      ? { resumeFromRunId: params.resumedFromRunId }
      : {}),
    ...(params.result.error ? { error: params.result.error } : {}),
  };
}

async function resolveChildWorkflowScript(
  request: WorkflowChildRequest,
  config: Config,
): Promise<ResolvedWorkflowRuntimeScript> {
  const resolved = request.scriptPath
    ? await readWorkflowScriptFile(request.scriptPath, config.getProjectRoot())
    : await createWorkflowRegistryFromConfig(config).resolve(request.name ?? '');
  const parsed = parseWorkflowScript(resolved.script);
  return {
    meta: parsed.meta,
    scriptBody: parsed.scriptBody,
    scriptPath: resolved.scriptPath,
    source: 'source' in resolved ? resolved.source : 'path',
  };
}

function parseWorkflowScriptForTool(
  script: string,
  config: Config,
  params: WorkflowToolParams,
  ctx?: ToolUseContext,
): ReturnType<typeof parseWorkflowScript> {
  try {
    return parseWorkflowScript(script, { includeSourceContext: true });
  } catch (error) {
    if (
      params.name !== undefined ||
      (!params.script && !params.scriptPath)
    ) {
      throw error;
    }
    const toolNames = ctx?.agentLoopContext?.getParentToolSchemas?.()
      .map((tool) => tool.name);
    if (
      !toolNames ||
      !isWorkflowAuthoringAvailable(config, toolNames)
    ) {
      throw error;
    }
    throw new Error(
      `${formatWorkflowError(error)}\nLoad the \`workflow-authoring\` skill for the script reference if you have not, fix the script, and retry.`,
      { cause: error },
    );
  }
}

function validateWorkflowArgs(
  meta: { name?: string; inputSchema?: unknown },
  args: unknown,
): void {
  if (!meta.inputSchema) return;
  const error = SchemaValidator.validate(meta.inputSchema, args);
  if (error) {
    throw new Error(
      [
        `Workflow args do not match ${meta.name ? `${meta.name} ` : ''}meta.inputSchema.`,
        `Reason: ${error}`,
        `Expected args: ${summarizeWorkflowInputSchema(meta.inputSchema)}`,
      ].join(' '),
    );
  }
}

function workflowStatus(
  signal: AbortSignal,
  result: WorkflowRuntimeResult,
): WorkflowTerminalStatus {
  if (signal.aborted) return 'killed';
  return result.error ? 'failed' : 'completed';
}

function formatWorkflowError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeWorkflowInput(params: WorkflowToolParams): string {
  if (params.scriptPath) return `Workflow script ${params.scriptPath}`;
  if (params.script) return 'Inline workflow script';
  if (params.name) return `Workflow ${params.name}`;
  return 'Inline workflow script';
}
