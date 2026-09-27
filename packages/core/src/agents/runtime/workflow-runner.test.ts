/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import { TurnBudget } from '../../core/turn-budget.js';
import {
  getWorkflowTaskMutationKey,
  isTerminalWorkflowStatus,
  tryWithWorkflowTaskMutation,
  WorkflowRunRegistry,
  type WorkflowTask,
} from '../workflow-run-registry.js';
import { AgentEventEmitter } from './agent-events.js';
import {
  deriveAgentKey,
  deriveArgsSeed,
  WorkflowJournal,
  type JournalLoadResult,
} from './workflow-journal.js';
import {
  WorkflowRunner,
  WorkflowScriptNotLaunchedError,
  WorkflowJournalUnavailableError,
  WorkflowStartCancelledError,
} from './workflow-runner.js';
import { claimInterruptedWorkflowRuns } from '../workflow-checkpoint.js';
import { compileWorkflowScript } from './workflow-sandbox.js';
import {
  WORKFLOW_SIZE_GUIDELINE_AGENTS,
  WORKFLOW_SIZE_WARNING_AGENTS_ENV,
} from './workflow-size.js';

const {
  createProductionDispatchMock,
  journalWrites,
  logWorkflowRunMock,
  logWorkflowSizeWarningMock,
  persistInlineWorkflowScriptMock,
  resolveSavedWorkflowScriptMock,
  readWorkflowSnapshotMock,
  writeLineMock,
  writeWorkflowCheckpointMock,
  writeWorkflowSnapshotMock,
} = vi.hoisted(() => ({
  createProductionDispatchMock: vi.fn(),
  journalWrites: [] as Array<() => void>,
  logWorkflowRunMock: vi.fn(),
  logWorkflowSizeWarningMock: vi.fn(),
  persistInlineWorkflowScriptMock: vi.fn(),
  resolveSavedWorkflowScriptMock: vi.fn(),
  readWorkflowSnapshotMock: vi.fn().mockResolvedValue(undefined),
  writeLineMock: vi.fn(),
  writeWorkflowCheckpointMock: vi.fn(),
  writeWorkflowSnapshotMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../telemetry/loggers.js', () => ({
  logWorkflowRun: logWorkflowRunMock,
  logWorkflowSizeWarning: logWorkflowSizeWarningMock,
}));

vi.mock('../workflow-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workflow-snapshot.js')>()),
  readWorkflowSnapshot: readWorkflowSnapshotMock,
  writeWorkflowSnapshot: writeWorkflowSnapshotMock,
}));

vi.mock('../workflow-checkpoint.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../workflow-checkpoint.js')>();
  writeWorkflowCheckpointMock.mockImplementation(
    actual.writeWorkflowCheckpoint,
  );
  return { ...actual, writeWorkflowCheckpoint: writeWorkflowCheckpointMock };
});

vi.mock('../../utils/jsonl-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/jsonl-utils.js')>();
  return { ...actual, writeLine: writeLineMock };
});

vi.mock('./workflow-orchestrator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./workflow-orchestrator.js')>();
  return {
    ...actual,
    createProductionDispatch: createProductionDispatchMock,
  };
});

vi.mock('./workflow-saved.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workflow-saved.js')>();
  persistInlineWorkflowScriptMock.mockImplementation(
    actual.persistInlineWorkflowScript,
  );
  return {
    ...actual,
    persistInlineWorkflowScript: persistInlineWorkflowScriptMock,
    resolveSavedWorkflowScript: resolveSavedWorkflowScriptMock,
  };
});

function configWithRegistry(): {
  config: Config;
  registry: WorkflowRunRegistry;
} {
  const registry = new WorkflowRunRegistry();
  const config = {
    getWorkflowRunRegistry: () => registry,
  } as unknown as Config;
  return { config, registry };
}

const storageRoots: string[] = [];

/** A fresh runtime dir for one test; removed after it. */
async function makeStorageRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-workflow-runner-'),
  );
  storageRoots.push(root);
  return root;
}

/**
 * Storage stub over a real temp dir. The persisted-script path is a real
 * location on purpose: this is the surface that writes a file, and a mocked
 * `fs` would prove nothing about where the bytes land or what mode they get.
 */
function stubStorage(config: Config, root: string): void {
  Object.assign(config, {
    storage: {
      getWorkflowRunJournalPath: (runId: string) =>
        path.join(root, runId, 'journal.jsonl'),
      getWorkflowRunsDir: () => root,
      getGeneratedWorkflowsDir: () => path.join(root, 'generated'),
      getInlineWorkflowScriptPath: (runId: string) =>
        path.join(root, 'generated', 'inline', `${runId}.js`),
    },
  });
}

function observeSettlement(registry: WorkflowRunRegistry): {
  abortCount: () => number;
  terminalStatuses: string[];
} {
  let aborts = 0;
  const terminalStatuses: string[] = [];
  registry.setRegisterCallback((entry) => {
    entry.abortController.signal.addEventListener(
      'abort',
      () => {
        aborts += 1;
      },
      { once: true },
    );
  });
  registry.setStatusChangeCallback((entry) => {
    if (entry && isTerminalWorkflowStatus(entry.status)) {
      terminalStatuses.push(entry.status);
    }
  });
  return { abortCount: () => aborts, terminalStatuses };
}

const EMPTY_LOADED_JOURNAL: JournalLoadResult = {
  kind: 'loaded',
  replay: { results: new Map(), started: new Map(), failed: new Set() },
};

describe('WorkflowRunner', () => {
  beforeEach(() => {
    createProductionDispatchMock.mockReset();
    journalWrites.length = 0;
    logWorkflowRunMock.mockClear();
    persistInlineWorkflowScriptMock.mockClear();
    writeWorkflowCheckpointMock.mockClear();
    resolveSavedWorkflowScriptMock.mockReset();
    writeLineMock.mockReset();
    writeLineMock.mockResolvedValue(undefined);
    writeWorkflowSnapshotMock.mockClear();
    writeWorkflowSnapshotMock.mockResolvedValue(undefined);
    readWorkflowSnapshotMock.mockReset();
    readWorkflowSnapshotMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(
      storageRoots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  // The only path from the Workflow tool's authoring hint to a backgrounded
  // run's notification goes through the runner's registration. A backgrounded
  // run has no trailer; without this the hint would never reach it.
  it('carries the authoring hint into a failed background run notification', async () => {
    const { config, registry } = configWithRegistry();
    const completion = vi.fn();
    registry.setCompletionCallback(completion);
    const hint =
      'hint: Load the `workflow-authoring` skill for the script reference if you have not, fix the script, and retry.';

    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'throw new Error("boom")',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
      authoringHint: hint,
    });
    await handle.completion;
    await vi.waitFor(() => expect(completion).toHaveBeenCalled());

    const modelText = completion.mock.calls[0][1] as string;
    const recovery = modelText.slice(
      modelText.indexOf('<recovery>'),
      modelText.indexOf('</recovery>'),
    );
    expect(recovery).toContain(hint);
  });

  // The Workflow tool shows the user the file a `scriptPath` or `name` call
  // loads, then hands that same read to the runner. Reading the path again
  // here would run whatever the file holds by then, not what was approved.
  it('runs the script a caller already loaded instead of reading scriptPath again', async () => {
    const { config, registry } = configWithRegistry();
    stubStorage(config, await makeStorageRoot());
    resolveSavedWorkflowScriptMock.mockClear();

    const handle = await WorkflowRunner.start({
      config,
      scriptPath: '/saved/audit.js',
      loadScript: async () => ({
        name: 'audit',
        scriptPath: '/saved/audit.js',
        script: "return 'approved';",
        savedWorkflowName: 'audit',
      }),
      args: undefined,
      signal: new AbortController().signal,
    });
    const settlement = await handle.completion;

    expect(settlement.ok && settlement.outcome.result).toBe('approved');
    expect(resolveSavedWorkflowScriptMock).not.toHaveBeenCalled();
    expect(handle.scriptPath).toBe('/saved/audit.js');
    expect(registry.get(handle.runId)?.workflowName).toBe('audit');
  });

  // A model call in a name-only session refuses nesting by path; the Workflow
  // tool asks for that per call, so a host's own run — same session, no flag —
  // nests freely. Any other malformed ref reaches the resolver untouched.
  it('refuses a nested workflow({scriptPath}) only for a call that asks it to', async () => {
    const nested = {
      name: 'audit',
      scriptPath: '/saved/audit.js',
      script: "return 'nested';",
      savedWorkflowName: 'audit',
    };
    for (const restrict of [true, false]) {
      const { config, registry } = configWithRegistry();
      // Locked either way: the flag, not the session, decides.
      Object.assign(config, { isWorkflowNameOnly: () => true });
      stubStorage(config, await makeStorageRoot());
      resolveSavedWorkflowScriptMock.mockReset();
      resolveSavedWorkflowScriptMock.mockResolvedValue(nested);

      const byPath = await WorkflowRunner.start({
        config,
        script: "return await workflow({ scriptPath: '/saved/audit.js' });",
        args: undefined,
        signal: new AbortController().signal,
        dispatch: async () => 'unused',
        ...(restrict ? { restrictNestedScriptPaths: true } : {}),
      });
      const pathSettlement = await byPath.completion;
      if (restrict) {
        expect(pathSettlement.ok).toBe(false);
        expect(!pathSettlement.ok && pathSettlement.message).toContain(
          "workflow({scriptPath}): this session restricts workflows to named workflows (tools.workflowNameOnly) — nest with workflow('<name>') instead.",
        );
        expect(resolveSavedWorkflowScriptMock).not.toHaveBeenCalled();
      } else {
        expect(pathSettlement.ok && pathSettlement.outcome.result).toBe(
          'nested',
        );
      }
      expect(registry.get(byPath.runId)).not.toHaveProperty('resumeName');

      const byName = await WorkflowRunner.start({
        config,
        script: "return await workflow('audit');",
        args: undefined,
        signal: new AbortController().signal,
        dispatch: async () => 'unused',
        ...(restrict ? { restrictNestedScriptPaths: true } : {}),
      });
      const nameSettlement = await byName.completion;
      expect(nameSettlement.ok && nameSettlement.outcome.result).toBe('nested');
      expect(resolveSavedWorkflowScriptMock).toHaveBeenCalledWith(
        'audit',
        config,
      );
    }
  });

  it('leaves a malformed nested ref to the resolver under the restriction', async () => {
    const { config } = configWithRegistry();
    stubStorage(config, await makeStorageRoot());
    resolveSavedWorkflowScriptMock.mockReset();
    resolveSavedWorkflowScriptMock.mockRejectedValue(
      new Error(
        'workflow() expects a workflow name (string) or {scriptPath: string}.',
      ),
    );

    const handle = await WorkflowRunner.start({
      config,
      script: 'return await workflow(42);',
      args: undefined,
      signal: new AbortController().signal,
      dispatch: async () => 'unused',
      restrictNestedScriptPaths: true,
    });
    const settlement = await handle.completion;

    expect(resolveSavedWorkflowScriptMock).toHaveBeenCalledWith(42, config);
    expect(!settlement.ok && settlement.message).toContain(
      'workflow() expects a workflow name',
    );
    expect(!settlement.ok && settlement.message).not.toContain(
      'tools.workflowNameOnly',
    );
  });

  // The name a locked session resumes by must lead back to the script that
  // ran. The runner checks once, as the run starts.
  it('records a resume name only when the name resolves to the script that ran', async () => {
    const root = await makeStorageRoot();
    const ran = path.join(root, 'audit.js');
    const other = path.join(root, 'other-audit.js');
    await fs.writeFile(ran, "return 'ran';", 'utf8');
    await fs.writeFile(other, "return 'other';", 'utf8');

    const start = async (nameOnly: boolean, resolvesTo: string) => {
      const { config, registry } = configWithRegistry();
      Object.assign(config, { isWorkflowNameOnly: () => nameOnly });
      stubStorage(config, root);
      resolveSavedWorkflowScriptMock.mockReset();
      resolveSavedWorkflowScriptMock.mockResolvedValue({
        name: 'audit',
        scriptPath: resolvesTo,
        script: "return 'ran';",
        savedWorkflowName: 'audit',
      });
      const handle = await WorkflowRunner.start({
        config,
        scriptPath: ran,
        loadScript: async () => ({
          name: 'audit',
          scriptPath: ran,
          script: "return 'ran';",
          savedWorkflowName: 'audit',
        }),
        args: undefined,
        signal: new AbortController().signal,
        dispatch: async () => 'unused',
      });
      await handle.completion;
      return registry.get(handle.runId);
    };

    expect((await start(true, ran))?.resumeName).toBe('audit');
    expect(resolveSavedWorkflowScriptMock).toHaveBeenCalledWith(
      'audit',
      expect.anything(),
    );
    expect((await start(true, other))?.resumeName).toBeUndefined();
    const unlocked = await start(false, ran);
    expect(unlocked?.resumeName).toBeUndefined();
    expect(resolveSavedWorkflowScriptMock).not.toHaveBeenCalled();
  });

  async function generatedReview(script: string) {
    const { config, registry } = configWithRegistry();
    const root = await makeStorageRoot();
    stubStorage(config, root);
    const scriptPath = path.join(
      root,
      'generated',
      'review',
      'session',
      `qwen-review-0123456789-${createHash('sha256').update(script).digest('hex')}.js`,
    );
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, script);
    resolveSavedWorkflowScriptMock.mockResolvedValue({ scriptPath, script });
    return { config, registry, scriptPath };
  }

  it('dispatches a generated review through a ten-agent window before any result returns', async () => {
    vi.stubEnv('QWEN_CODE_MAX_WORKFLOW_CONCURRENCY', undefined);
    vi.stubEnv('QWEN_CODE_MAX_TOOL_CONCURRENCY', undefined);
    vi.stubEnv('QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS', undefined);
    vi.stubEnv('QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES', undefined);
    vi.stubEnv('QWEN_REVIEW_DEADLINE_EPOCH', undefined);
    const { config, scriptPath } = await generatedReview(
      'return await parallel(args.map((p) => () => agent(p)));',
    );
    const started: string[] = [];
    const releases: Array<() => void> = [];
    createProductionDispatchMock.mockReturnValue(async (prompt: string) => {
      started.push(prompt);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return prompt;
    });
    const controller = new AbortController();
    try {
      const handle = await WorkflowRunner.start({
        config,
        scriptPath,
        args: Array.from({ length: 11 }, (_, i) => String(i)),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(started).toHaveLength(10));
      expect(started).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
      expect(createProductionDispatchMock.mock.calls[0]?.[4]).toEqual({
        max_turns: 500,
        max_time_minutes: 100,
      });
      releases[0]!();
      await vi.waitFor(() => expect(started).toHaveLength(11));
      releases.forEach((release) => release());
      expect((await handle.completion).ok).toBe(true);
    } finally {
      controller.abort();
      releases.forEach((release) => release());
      vi.unstubAllEnvs();
    }
  });

  it('keeps an ordinary workflow on generic dispatch bounds despite review metadata', async () => {
    const { config } = configWithRegistry();
    createProductionDispatchMock.mockReturnValue(async () => 'done');
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script:
        "export const meta = { name: 'review-step-3a', description: 'review' }; return await agent('read');",
      args: undefined,
    });
    expect((await handle.completion).ok).toBe(true);
    expect(createProductionDispatchMock.mock.calls[0]?.[4]).toBeUndefined();
  });

  it('runs beyond the generic thirty-minute limit and aborts at the review limit', async () => {
    vi.stubEnv('QWEN_CODE_MAX_WORKFLOW_SECONDS', undefined);
    vi.stubEnv('QWEN_REVIEW_DEADLINE_EPOCH', undefined);
    const { config, registry, scriptPath } = await generatedReview(
      'await new Promise(() => {})',
    );
    vi.useFakeTimers();
    try {
      const handle = await WorkflowRunner.start({
        config,
        scriptPath,
        signal: new AbortController().signal,
        args: undefined,
        dispatch: async () => 'unused',
      });
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(registry.get(handle.runId)?.status).toBe('running');
      await vi.advanceTimersByTimeAsync((6 * 60 - 30) * 60 * 1000);
      expect((await handle.completion).ok).toBe(false);
      expect(registry.get(handle.runId)?.status).toBe('failed');
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('passes the registry approval bridge only to production dispatch', async () => {
    const production = configWithRegistry();
    const productionBridge = vi.spyOn(
      production.registry,
      'bridgeApprovalEvents',
    );
    createProductionDispatchMock.mockReturnValue(async () => 'done');

    const productionHandle = await WorkflowRunner.start({
      config: production.config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
    });
    await expect(productionHandle.completion).resolves.toMatchObject({
      ok: true,
    });

    const bridgeApprovalEvents = createProductionDispatchMock.mock
      .calls[0]?.[3] as
      | ((emitter: AgentEventEmitter, dispatchId?: string) => () => void)
      | undefined;
    expect(bridgeApprovalEvents).toEqual(expect.any(Function));
    const emitter = new AgentEventEmitter();
    const cleanup = vi.fn();
    productionBridge.mockReturnValue(cleanup);
    expect(bridgeApprovalEvents?.(emitter, 'dispatch-1')).toBe(cleanup);
    expect(productionBridge).toHaveBeenCalledWith(
      productionHandle.runId,
      emitter,
      'dispatch-1',
      production.registry.get(productionHandle.runId),
    );

    const injected = configWithRegistry();
    const injectedBridge = vi.spyOn(injected.registry, 'bridgeApprovalEvents');
    const injectedHandle = await WorkflowRunner.start({
      config: injected.config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: async () => 'injected',
    });
    await expect(injectedHandle.completion).resolves.toMatchObject({
      ok: true,
    });
    expect(createProductionDispatchMock).toHaveBeenCalledOnce();
    expect(injectedBridge).not.toHaveBeenCalled();
  });

  it('retains the original args needed to retry a failed run from its journal', async () => {
    const { config, registry } = configWithRegistry();
    const args = { target: 'web-shell', checks: ['correctness'] };
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return args.target',
      args,
      runInBackground: true,
      dispatch: async () => 'unused',
    });

    await handle.completion;

    expect(registry.get(handle.runId)?.args).toEqual(args);
  });

  it('retains a saved workflow name when resuming with an inline script', async () => {
    const { config, registry } = configWithRegistry();
    resolveSavedWorkflowScriptMock.mockResolvedValueOnce({
      name: 'review',
      savedWorkflowName: 'review',
      scriptPath: '/tmp/review.js',
      script: 'return "done"',
    });
    const initial = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      scriptPath: '/tmp/review.js',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
    });
    await initial.completion;

    const resumed = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "resumed"',
      args: undefined,
      resumeFromRunId: initial.runId,
      runInBackground: true,
      dispatch: async () => 'unused',
    });
    await resumed.completion;

    expect(registry.get(initial.runId)?.workflowName).toBe('review');
  });

  it('records sandbox logs in the replay event ledger', async () => {
    const { config, registry } = configWithRegistry();
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'log("repository loaded"); return "done";',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
    });

    await handle.completion;

    expect(registry.get(handle.runId)?.events).toEqual([
      expect.objectContaining({
        type: 'log',
        message: 'repository loaded',
      }),
      expect.objectContaining({ type: 'workflow-completed' }),
    ]);
  });

  it('keeps a respawn diagnostic through final log replacement and telemetry', async () => {
    const { config, registry } = configWithRegistry();
    stubStorage(config, await makeStorageRoot());
    const runId = 'wf_respawned';
    const key = deriveAgentKey(deriveArgsSeed(undefined), 'work', {
      label: 'scout',
    });
    vi.spyOn(WorkflowJournal.prototype, 'load').mockResolvedValueOnce({
      kind: 'loaded',
      replay: {
        results: new Map(),
        started: new Map([
          [key, [{ type: 'started', key, agentId: 'agent-1' }]],
        ]),
        failed: new Set(),
      },
    });

    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: `return await agent('work', { label: 'scout' });`,
      args: undefined,
      resumeFromRunId: runId,
      dispatch: async () => {
        throw new Error('provider failed before classification');
      },
    });

    await expect(handle.completion).resolves.toMatchObject({
      ok: true,
      outcome: { result: null },
    });
    const line =
      '[resume] respawning "scout": interrupted in a previous run (1 prior attempt)';
    expect(registry.get(runId)).toMatchObject({
      status: 'completed',
      agentsRespawned: 1,
      recentLogs: [line],
    });
    expect(
      registry
        .get(runId)
        ?.events.filter(
          (event) => event.type === 'log' && event.message === line,
        ),
    ).toHaveLength(1);
    expect(logWorkflowRunMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        agents_completed: 1,
        agents_failed: 1,
        agents_cached: 0,
        agents_respawned: 1,
      }),
    );
  });

  it('keeps sandbox and registry phase projections equal for normalization-colliding titles', async () => {
    const { config, registry } = configWithRegistry();
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script:
        'phase("\\u001b[1mBuild\\u001b[0m");' +
        'phase("Build");' +
        'await agent("x", { phase: "\\u001b[1mBuild\\u001b[0m" });' +
        'return 1;',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
    });

    const settlement = await handle.completion;

    expect(settlement.ok).toBe(true);
    const outcomePhases = settlement.ok ? settlement.outcome.phases : [];
    expect(registry.get(handle.runId)?.phases).toEqual(['Build']);
    expect(outcomePhases).toEqual(registry.get(handle.runId)?.phases);
  });

  it('records a journal retry as sourced from the same run', async () => {
    const { config, registry } = configWithRegistry();
    const runId = 'wf_1234abcd';
    const attempt = await tryWithWorkflowTaskMutation(
      getWorkflowTaskMutationKey(config, runId),
      () =>
        WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: 'return "retried"',
          args: undefined,
          resumeFromRunId: runId,
          runInBackground: true,
          dispatch: async () => 'unused',
        }),
    );
    expect(attempt.acquired).toBe(true);
    if (!attempt.acquired) return;
    const handle = attempt.value;

    await handle.completion;

    expect(registry.get(runId)).toMatchObject({
      runId,
      sourceRunId: runId,
      startMode: 'retry',
    });
  });

  it('replays a readable journal when its advertised path cannot be created', async () => {
    const { config, registry } = configWithRegistry();
    stubStorage(config, await makeStorageRoot());
    const runId = 'wf_1234abcd';
    const key = deriveAgentKey(deriveArgsSeed(undefined), 'work', {});
    vi.spyOn(WorkflowJournal.prototype, 'load').mockResolvedValueOnce({
      kind: 'loaded',
      replay: {
        results: new Map([
          [key, { type: 'result', key, agentId: 'agent-1', result: 'cached' }],
        ]),
        started: new Map(),
        failed: new Set(),
      },
    });
    vi.spyOn(WorkflowJournal.prototype, 'ensureExists').mockResolvedValueOnce(
      false,
    );
    const dispatch = vi.fn(async () => 'live');

    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      resumeFromRunId: runId,
      dispatch,
    });

    await expect(handle.completion).resolves.toMatchObject({
      ok: true,
      outcome: { result: 'cached' },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(handle.journalPath).toBeUndefined();
    expect(registry.get(runId)?.journalPath).toBeUndefined();
    expect(logWorkflowRunMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        agents_completed: 1,
        agents_failed: 0,
        agents_cached: 1,
        agents_respawned: 0,
      }),
    );
  });

  it('cancels a pending background resume before registration', async () => {
    const { config, registry } = configWithRegistry();
    const runId = 'wf_1234abcd';
    const root = await makeStorageRoot();
    stubStorage(config, root);
    let resolveLoad: ((loaded: JournalLoadResult) => void) | undefined;
    const loadSpy = vi
      .spyOn(WorkflowJournal.prototype, 'load')
      .mockImplementationOnce(
        () =>
          new Promise<JournalLoadResult>((resolve) => {
            resolveLoad = resolve;
          }),
      );
    const start = WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "retried"',
      args: undefined,
      resumeFromRunId: runId,
      runInBackground: true,
      dispatch: async () => 'unused',
    });

    try {
      await vi.waitFor(() => expect(registry.isStarting(runId)).toBe(true));
      expect(registry.get(runId)).toBeUndefined();

      await vi.waitFor(() => expect(resolveLoad).toBeDefined());
      registry.abortAll();
      resolveLoad!(EMPTY_LOADED_JOURNAL);

      await expect(start).rejects.toThrow('Workflow start was cancelled.');
      expect(registry.isStarting(runId)).toBe(false);
      expect(registry.get(runId)).toBeUndefined();
      await expect(
        fs.readdir(path.join(root, 'generated', 'inline')),
      ).rejects.toThrow();
    } finally {
      resolveLoad?.(EMPTY_LOADED_JOURNAL);
      await start.catch(() => undefined);
      loadSpy.mockRestore();
    }
  });

  // A fresh run's `launched` record is queued without being awaited. A start
  // cancelled while it is still in flight fails on the next synchronous check
  // and removes the journal; the removal has to wait for that append, or the
  // append lands afterwards and leaves a run id that never registered with a
  // non-empty journal, which a later resume would accept.
  it('leaves no journal behind when a start is cancelled with its launch record in flight', async () => {
    const { config, registry } = configWithRegistry();
    const root = await makeStorageRoot();
    stubStorage(config, root);
    resolveSavedWorkflowScriptMock.mockResolvedValueOnce({
      name: 'audit',
      savedWorkflowName: 'audit',
      scriptPath: '/tmp/audit.js',
      script: 'return await agent("work")',
    });
    // The real append, a beat late, so it is still in flight when the start
    // fails and cleans up.
    const { writeLine } = await vi.importActual<
      typeof import('../../utils/jsonl-utils.js')
    >('../../utils/jsonl-utils.js');
    let appendSettled!: () => void;
    const appended = new Promise<void>((resolve) => {
      appendSettled = resolve;
    });
    writeLineMock.mockImplementation(async (file: string, entry: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        await writeLine(file, entry);
      } finally {
        appendSettled();
      }
    });
    // The cancel lands while the journal is being created, so the launch
    // record is queued and the very next check fails the start.
    const ensureExists = WorkflowJournal.prototype.ensureExists;
    vi.spyOn(WorkflowJournal.prototype, 'ensureExists').mockImplementationOnce(
      async function (this: WorkflowJournal) {
        const created = await ensureExists.call(this);
        registry.abortAll();
        return created;
      },
    );
    const dispatch = vi.fn(async () => 'live');

    await expect(
      WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        scriptPath: '/tmp/audit.js',
        args: undefined,
        runInBackground: true,
        dispatch,
      }),
    ).rejects.toThrow('Workflow start was cancelled.');
    await appended;

    // The launch record was really written; it just must not outlive the
    // cleanup.
    expect(writeLineMock).toHaveBeenCalledTimes(1);
    expect(writeLineMock.mock.calls[0][1]).toEqual({
      type: 'launched',
      version: 1,
    });
    expect(dispatch).not.toHaveBeenCalled();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it('rejects a cancellation that lands while the inline script is persisted', async () => {
    const { config, registry } = configWithRegistry();
    const root = await makeStorageRoot();
    stubStorage(config, root);
    let releasePersist: (() => void) | undefined;
    persistInlineWorkflowScriptMock.mockImplementationOnce(
      async (_config: Config, runId: string, script: string) => {
        await new Promise<void>((resolve) => {
          releasePersist = resolve;
        });
        const file = path.join(root, 'generated', 'inline', `${runId}.js`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, script, 'utf8');
        return file;
      },
    );
    const start = WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "done"',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
    });

    await vi.waitFor(() =>
      expect(registry.listStartingRunIds()).toHaveLength(1),
    );
    const runId = registry.listStartingRunIds()[0]!;
    await vi.waitFor(() => expect(releasePersist).toBeDefined());
    expect(registry.cancelStarting(runId)).toBe(true);
    releasePersist!();

    await expect(start).rejects.toBeInstanceOf(WorkflowStartCancelledError);
    expect(registry.get(runId)).toBeUndefined();
    await expect(
      fs.access(path.join(root, 'generated', 'inline', `${runId}.js`)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(root, runId, 'journal.jsonl')),
    ).rejects.toThrow();
  });

  it('restores resume artifacts when cancellation lands before registration', async () => {
    const { config, registry } = configWithRegistry();
    const root = await makeStorageRoot();
    stubStorage(config, root);
    const initial = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "original"',
      args: undefined,
      dispatch: async () => 'unused',
    });
    await initial.completion;
    const journalPath = initial.journalPath!;
    const scriptPath = initial.scriptPath!;
    const journalBefore = await fs.readFile(journalPath, 'utf8');
    let releasePersist: (() => void) | undefined;
    persistInlineWorkflowScriptMock.mockImplementationOnce(
      async (_config: Config, runId: string, script: string) => {
        await new Promise<void>((resolve) => {
          releasePersist = resolve;
        });
        const file = path.join(root, 'generated', 'inline', `${runId}.js`);
        await fs.writeFile(file, script, 'utf8');
        return file;
      },
    );

    const resume = WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "never ran"',
      args: undefined,
      resumeFromRunId: initial.runId,
      runInBackground: true,
      dispatch: async () => 'unused',
    });
    await vi.waitFor(() => expect(releasePersist).toBeDefined());
    expect(registry.cancelStarting(initial.runId)).toBe(true);
    releasePersist!();

    await expect(resume).rejects.toBeInstanceOf(WorkflowStartCancelledError);
    await expect(fs.readFile(scriptPath, 'utf8')).resolves.toBe(
      'return "original"',
    );
    await expect(fs.readFile(journalPath, 'utf8')).resolves.toBe(journalBefore);
  });

  // After a restart there is no registry entry to restore the script from;
  // the run's snapshot is what still holds it. Without reading it, a resume
  // that failed to start left the original run's copy overwritten by the
  // script of the attempt that never ran.
  it('restores the original inline script from its snapshot when a resume fails to start after a restart', async () => {
    const root = await makeStorageRoot();
    const first = configWithRegistry();
    stubStorage(first.config, root);
    const initial = await WorkflowRunner.start({
      config: first.config,
      signal: new AbortController().signal,
      script: 'return "original"',
      args: undefined,
      dispatch: async () => 'unused',
    });
    await initial.completion;
    const scriptPath = initial.scriptPath!;

    // A second process: fresh registry, same storage, the run in a snapshot.
    const { config, registry } = configWithRegistry();
    stubStorage(config, root);
    readWorkflowSnapshotMock.mockResolvedValueOnce({
      runId: initial.runId,
      script: 'return "original"',
    });
    let releasePersist: (() => void) | undefined;
    persistInlineWorkflowScriptMock.mockImplementationOnce(
      async (_config: Config, runId: string, script: string) => {
        await new Promise<void>((resolve) => {
          releasePersist = resolve;
        });
        const file = path.join(root, 'generated', 'inline', `${runId}.js`);
        await fs.writeFile(file, script, 'utf8');
        return file;
      },
    );

    const resume = WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "never ran"',
      args: undefined,
      resumeFromRunId: initial.runId,
      runInBackground: true,
      dispatch: async () => 'unused',
    });
    await vi.waitFor(() => expect(releasePersist).toBeDefined());
    expect(registry.cancelStarting(initial.runId)).toBe(true);
    releasePersist!();

    await expect(resume).rejects.toBeInstanceOf(WorkflowStartCancelledError);
    expect(readWorkflowSnapshotMock).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(scriptPath, 'utf8')).resolves.toBe(
      'return "original"',
    );
  });

  it.each([
    [true, true, false, true],
    [true, false, false, false],
    [true, true, true, false],
    [false, true, false, false],
  ])(
    'records resumeInBackground for background=%s interactive=%s zed=%s',
    async (background, interactive, zed, expected) => {
      const { config, registry } = configWithRegistry();
      Object.assign(config, {
        isInteractive: () => interactive,
        getExperimentalZedIntegration: () => zed,
      });

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "done"',
        args: undefined,
        runInBackground: background,
        dispatch: async () => 'unused',
      });
      await handle.completion;

      expect(registry.get(handle.runId)?.resumeInBackground).toBe(expected);
    },
  );

  it('cancels a pending background script load before registration', async () => {
    const { config, registry } = configWithRegistry();
    stubStorage(config, await makeStorageRoot());
    let finishLoad:
      | ((saved: { name: string; script: string; scriptPath: string }) => void)
      | undefined;
    resolveSavedWorkflowScriptMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
    );
    const start = WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      scriptPath: '/tmp/review.js',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
    });
    const saved = {
      name: 'review',
      script: 'return "done"',
      scriptPath: '/tmp/review.js',
    };

    try {
      await vi.waitFor(() =>
        expect(resolveSavedWorkflowScriptMock).toHaveBeenCalledOnce(),
      );
      expect(registry.hasRunningEntries()).toBe(true);
      expect(registry.list()).toEqual([]);

      registry.abortAll();
      finishLoad?.(saved);

      await expect(start).rejects.toThrow('Workflow start was cancelled.');
      // Typed, not a bare Error: the tool maps this to its "cancelled
      // before it could start" result even when the caller's own signal
      // is still live.
      await expect(start).rejects.toBeInstanceOf(WorkflowStartCancelledError);
      expect(registry.hasRunningEntries()).toBe(false);
      expect(registry.list()).toEqual([]);
    } finally {
      finishLoad?.(saved);
      await start.catch(() => undefined);
    }
  });

  it('rejects a direct resume while history mutation owns the run', async () => {
    const { config, registry } = configWithRegistry();
    const runId = 'wf_1234abcd';
    let releaseClaim: (() => void) | undefined;
    let claimReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      claimReady = resolve;
    });
    const claim = tryWithWorkflowTaskMutation(
      getWorkflowTaskMutationKey(config, runId),
      async () => {
        claimReady?.();
        await new Promise<void>((resolve) => {
          releaseClaim = resolve;
        });
      },
    );
    await ready;
    const loadSpy = vi.spyOn(WorkflowJournal.prototype, 'load');

    try {
      await expect(
        WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: 'return "retried"',
          args: undefined,
          resumeFromRunId: runId,
          runInBackground: true,
          dispatch: async () => 'unused',
        }),
      ).rejects.toThrow(`Workflow run ${runId} is already being modified.`);
      expect(loadSpy).not.toHaveBeenCalled();
      expect(registry.isStarting(runId)).toBe(false);
      expect(registry.get(runId)).toBeUndefined();
    } finally {
      releaseClaim?.();
      await claim;
      loadSpy.mockRestore();
    }
  });

  it('keeps one registry-owned handle through exactly-once completion', async () => {
    const { config, registry } = configWithRegistry();
    const observed = observeSettlement(registry);
    let resolveDispatch: ((value: string) => void) | undefined;
    const caller = new AbortController();
    const handle = await WorkflowRunner.start({
      config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    });

    expect(registry.getHandle(handle.runId)).toBe(handle);
    expect(registry.get(handle.runId)?.status).toBe('running');

    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());
    resolveDispatch?.('done');

    const first = await handle.completion;
    const second = await handle.completion;
    expect(first).toBe(second);
    expect(first.ok).toBe(true);
    expect(registry.get(handle.runId)?.status).toBe('completed');
    expect(registry.getHandle(handle.runId)).toBeUndefined();
    expect(writeWorkflowSnapshotMock).toHaveBeenCalledOnce();
    expect(logWorkflowRunMock).toHaveBeenCalledOnce();
    expect(observed.terminalStatuses).toEqual(['completed']);
    expect(observed.abortCount()).toBe(1);

    caller.abort();
    registry.cancel(handle.runId, Date.now());
    expect(registry.get(handle.runId)?.status).toBe('completed');
    expect(writeWorkflowSnapshotMock).toHaveBeenCalledOnce();
    expect(logWorkflowRunMock).toHaveBeenCalledOnce();
    expect(observed.terminalStatuses).toEqual(['completed']);
    expect(observed.abortCount()).toBe(1);
  });

  it('notifies the registry when the terminal snapshot is persisted', async () => {
    const { config, registry } = configWithRegistry();
    writeWorkflowSnapshotMock.mockResolvedValue(true);
    const notify = vi.spyOn(registry, 'notifySnapshotPersisted');
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: async () => 'done',
    });
    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    expect(writeWorkflowSnapshotMock).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(handle.runId);
  });

  it('does not notify when the snapshot write fails', async () => {
    const { config, registry } = configWithRegistry();
    writeWorkflowSnapshotMock.mockResolvedValue(false);
    const notify = vi.spyOn(registry, 'notifySnapshotPersisted');
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: async () => 'done',
    });
    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    expect(writeWorkflowSnapshotMock).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it('settles failure and caller cancellation through the same owner', async () => {
    const failed = configWithRegistry();
    const failedObserved = observeSettlement(failed.registry);
    const failedHandle = await WorkflowRunner.start({
      config: failed.config,
      signal: new AbortController().signal,
      script: 'throw new Error("boom")',
      args: undefined,
      dispatch: async () => 'unused',
    });
    const failedResult = await failedHandle.completion;
    expect(failedResult.ok).toBe(false);
    expect(failed.registry.get(failedHandle.runId)?.status).toBe('failed');
    expect(failedObserved.terminalStatuses).toEqual(['failed']);
    expect(failedObserved.abortCount()).toBe(1);

    const cancelled = configWithRegistry();
    const cancelledObserved = observeSettlement(cancelled.registry);
    const caller = new AbortController();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const cancelledHandle = await WorkflowRunner.start({
      config: cancelled.config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());
    caller.abort();
    rejectDispatch?.(new Error('aborted'));
    const cancelledResult = await cancelledHandle.completion;
    expect(cancelledResult.ok).toBe(false);
    expect(cancelled.registry.get(cancelledHandle.runId)?.status).toBe(
      'cancelled',
    );
    expect(cancelledObserved.terminalStatuses).toEqual(['cancelled']);
    expect(cancelledObserved.abortCount()).toBe(1);

    expect(writeWorkflowSnapshotMock).toHaveBeenCalledTimes(2);
    expect(logWorkflowRunMock).toHaveBeenCalledTimes(2);
  });

  it('records caller-aborted dispatches as cancelled', async () => {
    const { config, registry } = configWithRegistry();
    const caller = new AbortController();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());

    caller.abort();
    rejectDispatch?.(new Error('Request was aborted'));
    await handle.completion;

    expect(registry.get(handle.runId)?.dispatches).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
    expect(registry.get(handle.runId)?.dispatches[0]).not.toHaveProperty(
      'error',
    );
    expect(registry.get(handle.runId)?.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'dispatch-failed' }),
      ]),
    );
  });

  it('keeps background runs alive after the caller turn ends', async () => {
    const { config, registry } = configWithRegistry();
    const observed = observeSettlement(registry);
    const caller = new AbortController();
    let resolveDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());

    caller.abort();
    expect(observed.abortCount()).toBe(0);
    expect(registry.get(handle.runId)?.status).toBe('running');

    resolveDispatch?.('done');
    await expect(handle.completion).resolves.toMatchObject({ ok: true });
    expect(registry.get(handle.runId)?.status).toBe('completed');
    expect(observed.terminalStatuses).toEqual(['completed']);
    expect(observed.abortCount()).toBe(1);
  });

  it('persists terminal runs without live fire-and-forget dispatches', async () => {
    const { config, registry } = configWithRegistry();
    let snapshotDispatchStatuses: string[] | undefined;
    writeWorkflowSnapshotMock.mockImplementation(
      (_config, snapshotEntry: WorkflowTask) => {
        snapshotDispatchStatuses = snapshotEntry.dispatches.map(
          (dispatch) => dispatch.status,
        );
        return Promise.resolve();
      },
    );
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'agent("fire and forget"); return "done"',
      args: undefined,
      runInBackground: true,
      dispatch: () => new Promise<string>(() => undefined),
    });

    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    expect(registry.get(handle.runId)).toMatchObject({ status: 'completed' });
    expect(snapshotDispatchStatuses).toEqual(['cancelled']);
    expect(registry.get(handle.runId)?.dispatches).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
  });

  it('freezes snapshot and telemetry before late dispatches drain', async () => {
    const { config, registry } = configWithRegistry();
    stubStorage(config, await makeStorageRoot());
    // The run's `launched` record is let through; every write after it is
    // held, so the one held write is the agent's `started` line.
    writeLineMock.mockResolvedValueOnce(undefined);
    writeLineMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          journalWrites.push(resolve);
        }),
    );
    let snapshotAgentsCompleted: number | undefined;
    writeWorkflowSnapshotMock.mockImplementation((_config, entry) => {
      snapshotAgentsCompleted = entry.agentsCompleted;
      return Promise.resolve();
    });
    let finishDispatch: ((result: string) => void) | undefined;

    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'agent("fire and forget"); return "done"',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });

    await vi.waitFor(() => {
      expect(registry.get(handle.runId)?.status).toBe('completed');
      expect(journalWrites).toHaveLength(1);
    });
    finishDispatch?.('late result');
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.agentsCompleted).toBe(1),
    );
    let settled = false;
    void handle.completion.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    journalWrites[0]?.();
    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    const telemetry = logWorkflowRunMock.mock.calls[0]?.[1] as
      | { agents_completed: number }
      | undefined;
    expect(telemetry?.agents_completed).toBe(0);
    expect(snapshotAgentsCompleted).toBe(0);
    for (const resolve of journalWrites) resolve();
  });

  it('holds an in-flight agent result until a paused run resumes', async () => {
    const { config, registry } = configWithRegistry();
    let resolveDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());

    expect(registry.pause(handle.runId)).toBe(true);
    expect(registry.get(handle.runId)?.status).toBe('pausing');
    resolveDispatch?.('done');
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.status).toBe('paused'),
    );
    let settled = false;
    void handle.completion.then(() => {
      settled = true;
    });
    // Flush all microtasks + a timer tick so the negative check
    // distinguishes the pause gate from a gate-less resolve
    // (which settles in a few microtasks without one).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    expect(registry.resume(handle.runId)).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ ok: true });
    expect(registry.get(handle.runId)?.status).toBe('completed');
  });

  it('holds an in-flight agent rejection until a paused run resumes', async () => {
    const { config, registry } = configWithRegistry();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());

    registry.pause(handle.runId);
    rejectDispatch?.(new Error('agent failed'));
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.status).toBe('paused'),
    );
    let settled = false;
    void handle.completion.then(() => {
      settled = true;
    });
    // Flush all microtasks + a timer tick so the negative check
    // distinguishes the pause gate from a gate-less resolve
    // (which settles in a few microtasks without one).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    registry.resume(handle.runId);
    await expect(handle.completion).resolves.toMatchObject({
      ok: true,
      outcome: { result: null },
    });
    expect(registry.get(handle.runId)?.status).toBe('completed');
  });

  it('keeps queued agents stopped while pausing and starts them after resume', async () => {
    const originalConcurrency =
      process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
    process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = '1';
    try {
      const { config, registry } = configWithRegistry();
      const started: string[] = [];
      const finishes = new Map<string, (value: string) => void>();
      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: `return await parallel([
          async () => {
            await agent("first");
            // Chain a follow-up dispatch off the first result: if the pause
            // gate ever delivered that result early, the chained agent is
            // issued during the pause and bumps the dispatched counter below.
            return await agent("first-follow-up");
          },
          () => agent("second"),
        ])`,
        args: undefined,
        runInBackground: true,
        dispatch: (prompt) =>
          new Promise<string>((resolve) => {
            started.push(prompt);
            finishes.set(prompt, resolve);
          }),
      });
      await vi.waitFor(() => expect(started).toEqual(['first']));

      expect(registry.pause(handle.runId)).toBe(true);
      finishes.get('first')?.('first done');
      await vi.waitFor(() =>
        expect(registry.get(handle.runId)?.status).toBe('paused'),
      );
      expect(started).toEqual(['first']);
      expect(registry.get(handle.runId)).toMatchObject({
        agentsDispatched: 2,
        agentsCompleted: 1,
      });
      let settled = false;
      void handle.completion.then(() => {
        settled = true;
      });
      // Flush all microtasks + a timer tick so the negative check
      // distinguishes the pause gate from a gate-less resolve
      // (which settles in a few microtasks without one).
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      expect(registry.resume(handle.runId)).toBe(true);
      await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
      finishes.get('second')?.('second done');
      await vi.waitFor(() =>
        expect(started).toEqual(['first', 'second', 'first-follow-up']),
      );
      finishes.get('first-follow-up')?.('follow-up done');
      await expect(handle.completion).resolves.toMatchObject({ ok: true });
    } finally {
      if (originalConcurrency === undefined) {
        delete process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
      } else {
        process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = originalConcurrency;
      }
    }
  });

  it('cancels a paused run without starting queued agents or deadlocking', async () => {
    const originalConcurrency =
      process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
    process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = '1';
    try {
      const { config, registry } = configWithRegistry();
      const started: string[] = [];
      let finishFirst: ((value: string) => void) | undefined;
      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: `return await parallel([
          () => agent("first"),
          () => agent("second"),
        ])`,
        args: undefined,
        runInBackground: true,
        dispatch: (prompt) =>
          new Promise<string>((resolve) => {
            started.push(prompt);
            if (prompt === 'first') finishFirst = resolve;
          }),
      });
      await vi.waitFor(() => expect(started).toEqual(['first']));
      registry.pause(handle.runId);
      finishFirst?.('first done');
      await vi.waitFor(() =>
        expect(registry.get(handle.runId)?.status).toBe('paused'),
      );

      registry.cancel(handle.runId, Date.now());

      await expect(handle.completion).resolves.toMatchObject({ ok: false });
      expect(registry.get(handle.runId)).toMatchObject({
        status: 'cancelled',
        agentsDispatched: 2,
        agentsCompleted: 2,
      });
      expect(started).toEqual(['first']);
    } finally {
      if (originalConcurrency === undefined) {
        delete process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
      } else {
        process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = originalConcurrency;
      }
    }
  });

  it('settles a cancelled paused run as cancelled even if its awaited dispatch succeeded', async () => {
    // The success arm resolves held successful dispatches on abort, so a
    // cancelled run's script can still finish normally. The settlement
    // must report the cancellation, not a success that contradicts the
    // registry entry, telemetry, and snapshot.
    const { config, registry } = configWithRegistry();
    const observed = observeSettlement(registry);
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    registry.pause(handle.runId);
    finishDispatch?.('done');
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.status).toBe('paused'),
    );

    registry.cancel(handle.runId, Date.now());

    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: 'Workflow run cancelled.',
    });
    expect(registry.get(handle.runId)?.status).toBe('cancelled');
    // cancel() fires the terminal statusChange; setRecentLogs then
    // mirrors the final logs onto the already-cancelled entry and
    // re-emits it — both fires are 'cancelled', never a success state.
    expect(observed.terminalStatuses).toEqual(['cancelled', 'cancelled']);
  });

  it('settles a cancelled running run as cancelled when its script absorbs the abort', async () => {
    // The cancelled-settlement guard must cover cancel-from-running too,
    // not only cancel-from-paused: a never-paused run whose script
    // absorbs the abort and still returns normally must not settle ok
    // while the registry entry, telemetry, and snapshot say cancelled.
    const { config, registry } = configWithRegistry();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script:
        'try { return await agent("work"); } catch { return "fallback"; }',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());
    expect(registry.get(handle.runId)?.status).toBe('running');

    registry.cancel(handle.runId, Date.now());
    rejectDispatch?.(new Error('aborted'));

    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: 'Workflow run cancelled.',
    });
    expect(registry.get(handle.runId)?.status).toBe('cancelled');
  });

  it('settles an externally failed run as failed even if its script still completes', async () => {
    // The settlement guard must cover every terminal status, not only
    // 'cancelled': resolvePendingApproval's contingency fails the entry
    // and aborts the handle, and the success arm still delivers held
    // successful dispatches on abort — so the script can finish
    // normally while the registry entry, snapshot, and telemetry say
    // 'failed'. The handle must not report ok: true.
    const { config, registry } = configWithRegistry();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    registry.fail(
      handle.runId,
      'Failed to resolve workflow approval: wfap_1',
      Date.now(),
    );
    handle.abort();
    finishDispatch?.('done');

    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: 'Failed to resolve workflow approval: wfap_1',
    });
    expect(registry.get(handle.runId)?.status).toBe('failed');
  });

  describe('resuming across a restart', () => {
    const resumeOptions = (config: Config, runId: string) => ({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      resumeFromRunId: runId,
    });

    // A resume replays a journal. With none on disk it used to dispatch every
    // agent again under the old id while reading as a continuation.
    it('refuses a resume whose journal is not on disk, before anything is spent or written', async () => {
      const { config, registry } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      const dispatch = vi.fn(async () => 'live');

      const start = WorkflowRunner.start({
        ...resumeOptions(config, 'wf_1234abcd'),
        dispatch,
      });
      await expect(start).rejects.toThrow(
        'No journal found for workflow run wf_1234abcd, so there is nothing to resume. To run the workflow from the start, call Workflow again without resumeFromRunId.',
      );
      // Typed, so a host resuming on a caller's behalf can answer it as the
      // run's state rather than as its own fault.
      await expect(start).rejects.toBeInstanceOf(
        WorkflowJournalUnavailableError,
      );
      await expect(start).rejects.toMatchObject({
        runId: 'wf_1234abcd',
        reason: 'missing',
      });

      expect(dispatch).not.toHaveBeenCalled();
      expect(registry.get('wf_1234abcd')).toBeUndefined();
      expect(registry.isStarting('wf_1234abcd')).toBe(false);
      expect(writeWorkflowSnapshotMock).not.toHaveBeenCalled();
      expect(persistInlineWorkflowScriptMock).not.toHaveBeenCalled();
      // The refusal must not leave behind the journal it found missing.
      await expect(fs.readdir(root)).resolves.toEqual([]);
    });

    it('refuses a resume whose journal cannot be read, and says why', async () => {
      const { config, registry } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      // A directory where the journal file should be.
      await fs.mkdir(path.join(root, 'wf_1234abcd', 'journal.jsonl'), {
        recursive: true,
      });
      const dispatch = vi.fn(async () => 'live');

      const start = WorkflowRunner.start({
        ...resumeOptions(config, 'wf_1234abcd'),
        dispatch,
      });
      await expect(start).rejects.toThrow(
        /^Could not read the journal for workflow run wf_1234abcd: \S/,
      );
      await expect(start).rejects.toMatchObject({
        name: 'WorkflowJournalUnavailableError',
        runId: 'wf_1234abcd',
        reason: 'unreadable',
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(registry.get('wf_1234abcd')).toBeUndefined();
    });

    // Journals written before the `launched` record exist as empty files for
    // runs that had cached nothing yet; those run ids must stay resumable.
    it('resumes a run whose journal exists and holds nothing', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      await fs.mkdir(path.join(root, 'wf_1234abcd'), { recursive: true });
      await fs.writeFile(path.join(root, 'wf_1234abcd', 'journal.jsonl'), '');
      const dispatch = vi.fn(async () => 'live');

      const handle = await WorkflowRunner.start({
        ...resumeOptions(config, 'wf_1234abcd'),
        dispatch,
      });

      await expect(handle.completion).resolves.toMatchObject({
        ok: true,
        outcome: { result: 'live' },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('opens a fresh journal with a launched record, and never a resumed one', async () => {
      const { config } = configWithRegistry();
      stubStorage(config, await makeStorageRoot());
      const types = () =>
        writeLineMock.mock.calls.map(
          ([, entry]) => (entry as { type: string }).type,
        );

      const first = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return await agent("work")',
        args: undefined,
        dispatch: async () => 'live',
      });
      await first.completion;
      expect(types()).toEqual(['launched', 'started', 'result']);
      expect(writeLineMock.mock.calls[0][1]).toEqual({
        type: 'launched',
        version: 1,
      });

      writeLineMock.mockClear();
      const resumed = await WorkflowRunner.start({
        ...resumeOptions(config, first.runId),
        dispatch: async () => 'live',
      });
      await resumed.completion;
      expect(types()).not.toContain('launched');
    });

    it('does not mark a launch when the journal could not be created', async () => {
      const { config } = configWithRegistry();
      stubStorage(config, await makeStorageRoot());
      vi.spyOn(WorkflowJournal.prototype, 'ensureExists').mockResolvedValueOnce(
        false,
      );

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "done"',
        args: undefined,
        dispatch: async () => 'unused',
      });
      await handle.completion;

      expect(handle.journalPath).toBeUndefined();
      expect(writeLineMock).not.toHaveBeenCalled();
    });

    // The registry does not outlive the process. After a restart the snapshot
    // is what still says the run carried a reference; without reading it the
    // resumed run would settle unattributed and overwrite that snapshot.
    it('refuses a resume whose snapshot carries a source reference its journal lacks', async () => {
      const { config, registry } = configWithRegistry();
      stubStorage(config, await makeStorageRoot());
      vi.spyOn(WorkflowJournal.prototype, 'load').mockResolvedValueOnce(
        EMPTY_LOADED_JOURNAL,
      );
      readWorkflowSnapshotMock.mockResolvedValueOnce({
        runId: 'wf_1234abcd',
        sourceRef: { id: 'definition-7', revision: 'rev-3' },
      });
      const dispatch = vi.fn(async () => 'live');

      await expect(
        WorkflowRunner.start({
          ...resumeOptions(config, 'wf_1234abcd'),
          dispatch,
        }),
      ).rejects.toThrow(
        'Workflow source metadata is missing from its journal.',
      );

      expect(readWorkflowSnapshotMock).toHaveBeenCalledWith(
        config,
        'wf_1234abcd',
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(registry.get('wf_1234abcd')).toBeUndefined();
      expect(writeWorkflowSnapshotMock).not.toHaveBeenCalled();
    });

    it('resumes when neither the snapshot nor the journal carries a source reference', async () => {
      const { config } = configWithRegistry();
      stubStorage(config, await makeStorageRoot());
      vi.spyOn(WorkflowJournal.prototype, 'load').mockResolvedValueOnce(
        EMPTY_LOADED_JOURNAL,
      );
      readWorkflowSnapshotMock.mockResolvedValueOnce({ runId: 'wf_1234abcd' });

      const handle = await WorkflowRunner.start({
        ...resumeOptions(config, 'wf_1234abcd'),
        dispatch: async () => 'live',
      });

      await expect(handle.completion).resolves.toMatchObject({ ok: true });
    });

    it('asks the live registry entry, not the snapshot, while the process still has one', async () => {
      const { config } = configWithRegistry();
      stubStorage(config, await makeStorageRoot());
      const first = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return await agent("work")',
        args: undefined,
        dispatch: async () => 'live',
      });
      await first.completion;
      // A stale snapshot must not overrule the entry the process still holds.
      readWorkflowSnapshotMock.mockResolvedValue({
        runId: first.runId,
        sourceRef: { id: 'definition-7', revision: 'rev-3' },
      });

      const resumed = await WorkflowRunner.start({
        ...resumeOptions(config, first.runId),
        dispatch: async () => 'live',
      });

      await expect(resumed.completion).resolves.toMatchObject({ ok: true });
      expect(readWorkflowSnapshotMock).not.toHaveBeenCalled();
    });
  });

  describe('the run checkpoint', () => {
    it('is on disk while the run is live, and gone once it settles', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      let release: ((value: string) => void) | undefined;
      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script:
          'export const meta = { name: "audit", description: "Audit" };\nreturn await agent("work")',
        args: { files: ['a.csv'] },
        dispatch: () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      });
      const file = path.join(root, handle.runId, 'checkpoint.json');

      await vi.waitFor(async () =>
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({
          runId: handle.runId,
          pid: process.pid,
          meta: { name: 'audit', description: 'Audit' },
          description: 'audit',
          args: { files: ['a.csv'] },
        }),
      );
      // This process still has the run, whatever the pid check would say.
      await expect(
        claimInterruptedWorkflowRuns(config, { isProcessRunning: () => false }),
      ).resolves.toEqual([]);

      await vi.waitFor(() => expect(release).toBeDefined());
      release!('done');
      await expect(handle.completion).resolves.toMatchObject({ ok: true });
      await expect(fs.access(file)).rejects.toThrow();
    });

    // The write is not awaited at start; settlement must wait for it, or a run
    // that ends before the write lands removes nothing and leaves the file.
    it('does not outlive a run that settles before its write lands', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      const { writeWorkflowCheckpoint } = await vi.importActual<
        typeof import('../workflow-checkpoint.js')
      >('../workflow-checkpoint.js');
      writeWorkflowCheckpointMock.mockImplementationOnce(
        async (...args: Parameters<typeof writeWorkflowCheckpoint>) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return writeWorkflowCheckpoint(...args);
        },
      );

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "done"',
        args: undefined,
        dispatch: async () => 'unused',
      });
      await handle.completion;

      expect(writeWorkflowCheckpointMock).toHaveBeenCalledTimes(1);
      await expect(
        fs.access(path.join(root, handle.runId, 'checkpoint.json')),
      ).rejects.toThrow();
    });

    // A history retry reads a surviving checkpoint as a process that has not
    // been seen to exit, and refuses. So a resume that registers before its
    // own checkpoint lands leaves another process free to start a second
    // runner on the same journal -- the one thing the refusal exists to stop.
    describe('a resume waits for its own', () => {
      const settledRun = async (config: Config) => {
        const first = await WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: 'return await agent("work")',
          args: undefined,
          dispatch: async () => 'live',
        });
        await first.completion;
        writeWorkflowCheckpointMock.mockClear();
        return first;
      };
      const resumeOf = (config: Config, runId: string) => ({
        config,
        signal: new AbortController().signal,
        script: 'return await agent("work")',
        args: undefined,
        resumeFromRunId: runId,
      });

      it('does not register until the checkpoint is on disk', async () => {
        const { config, registry } = configWithRegistry();
        stubStorage(config, await makeStorageRoot());
        const first = await settledRun(config);
        const actual = await vi.importActual<
          typeof import('../workflow-checkpoint.js')
        >('../workflow-checkpoint.js');
        let release: (() => void) | undefined;
        writeWorkflowCheckpointMock.mockImplementationOnce(
          async (
            ...args: Parameters<typeof actual.writeWorkflowCheckpoint>
          ) => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return actual.writeWorkflowCheckpoint(...args);
          },
        );

        const resume = WorkflowRunner.start({
          ...resumeOf(config, first.runId),
          dispatch: async () => 'live',
        });
        await vi.waitFor(() => expect(release).toBeDefined());

        // Still the settled run, not this one: nothing has replaced it.
        expect(registry.get(first.runId)?.status).toBe('completed');
        expect(registry.get(first.runId)?.startMode).toBeUndefined();

        release!();
        await expect((await resume).completion).resolves.toMatchObject({
          ok: true,
        });
        expect(registry.get(first.runId)?.startMode).toBe('retry');
      });

      it('refuses the start when the checkpoint cannot be written', async () => {
        const { config, registry } = configWithRegistry();
        const root = await makeStorageRoot();
        stubStorage(config, root);
        const first = await settledRun(config);
        const settled = registry.get(first.runId);
        const journal = await fs.readFile(first.journalPath!, 'utf8');
        const dispatch = vi.fn(async () => 'live');
        writeWorkflowCheckpointMock.mockResolvedValueOnce('failed');

        await expect(
          WorkflowRunner.start({ ...resumeOf(config, first.runId), dispatch }),
        ).rejects.toThrow(
          `Could not record that workflow run ${first.runId} is running again, so another process could start it a second time. Nothing was started; try again.`,
        );

        expect(dispatch).not.toHaveBeenCalled();
        // The very entry the settled run left, not a replacement: the run is
        // exactly as resumable as it was before this start was attempted.
        expect(registry.get(first.runId)).toBe(settled);
        expect(registry.get(first.runId)?.status).toBe('completed');
        await expect(fs.readFile(first.journalPath!, 'utf8')).resolves.toBe(
          journal,
        );
        await expect(fs.readFile(first.scriptPath!, 'utf8')).resolves.toBe(
          'return await agent("work")',
        );
      });

      it('starts when there is nowhere to keep a checkpoint', async () => {
        const { config } = configWithRegistry();
        stubStorage(config, await makeStorageRoot());
        const first = await settledRun(config);
        writeWorkflowCheckpointMock.mockResolvedValueOnce('unavailable');

        const handle = await WorkflowRunner.start({
          ...resumeOf(config, first.runId),
          dispatch: async () => 'live',
        });

        await expect(handle.completion).resolves.toMatchObject({ ok: true });
      });

      // The write is the only await between the last cancellation check and
      // `register`, and `register` does not read the controller. Without a
      // second check the run registers anyway and settles `failed`, under a
      // caller that was handed `{cancelled: true}`.
      it('reports a cancellation that lands while the checkpoint is being written', async () => {
        const { config, registry } = configWithRegistry();
        const root = await makeStorageRoot();
        stubStorage(config, root);
        const first = await settledRun(config);
        const settled = registry.get(first.runId);
        const actual = await vi.importActual<
          typeof import('../workflow-checkpoint.js')
        >('../workflow-checkpoint.js');
        let wrote = false;
        writeWorkflowCheckpointMock.mockImplementationOnce(
          async (
            ...args: Parameters<typeof actual.writeWorkflowCheckpoint>
          ) => {
            const outcome = await actual.writeWorkflowCheckpoint(...args);
            // The file is on disk; the cancel arrives before `register`.
            expect(registry.cancelStarting(first.runId)).toBe(true);
            wrote = true;
            return outcome;
          },
        );
        const dispatch = vi.fn(async () => 'live');

        await expect(
          WorkflowRunner.start({
            ...resumeOf(config, first.runId),
            runInBackground: true,
            dispatch,
          }),
        ).rejects.toBeInstanceOf(WorkflowStartCancelledError);

        expect(wrote).toBe(true);
        expect(dispatch).not.toHaveBeenCalled();
        // Not replaced by a run that never started, and no record left
        // claiming a process still has it.
        expect(registry.get(first.runId)).toBe(settled);
        expect(registry.get(first.runId)?.status).toBe('completed');
        await expect(
          fs.access(path.join(root, first.runId, 'checkpoint.json')),
        ).rejects.toThrow();
      });

      it('takes back the checkpoint when the start it recorded then fails', async () => {
        const { config, registry } = configWithRegistry();
        const root = await makeStorageRoot();
        stubStorage(config, root);
        const first = await settledRun(config);
        const file = path.join(root, first.runId, 'checkpoint.json');
        vi.spyOn(registry, 'register').mockImplementationOnce(() => {
          throw new Error('registry said no');
        });

        await expect(
          WorkflowRunner.start({
            ...resumeOf(config, first.runId),
            dispatch: async () => 'live',
          }),
        ).rejects.toThrow('registry said no');

        // Left behind, it would read as a live run in another process and
        // refuse every later retry until that pid is gone.
        await expect(fs.access(file)).rejects.toThrow();
      });

      it('does not hold a fresh start for a write nothing depends on', async () => {
        const { config } = configWithRegistry();
        stubStorage(config, await makeStorageRoot());
        const actual = await vi.importActual<
          typeof import('../workflow-checkpoint.js')
        >('../workflow-checkpoint.js');
        let release: (() => void) | undefined;
        let landed = false;
        writeWorkflowCheckpointMock.mockImplementationOnce(
          async (
            ...args: Parameters<typeof actual.writeWorkflowCheckpoint>
          ) => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            landed = true;
            return actual.writeWorkflowCheckpoint(...args);
          },
        );

        const handle = await WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: 'return "done"',
          args: undefined,
          dispatch: async () => 'unused',
        });

        // A fresh run has no history entry for anyone to retry, so its
        // checkpoint only matters if this process dies first.
        expect(landed).toBe(false);
        release!();
        await expect(handle.completion).resolves.toMatchObject({ ok: true });
      });

      it('starts a fresh run whose checkpoint could not be written', async () => {
        const { config } = configWithRegistry();
        stubStorage(config, await makeStorageRoot());
        writeWorkflowCheckpointMock.mockResolvedValueOnce('failed');

        const handle = await WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: 'return "done"',
          args: undefined,
          dispatch: async () => 'unused',
        });

        await expect(handle.completion).resolves.toMatchObject({ ok: true });
      });
    });
  });

  it('rejects a concurrent resume while the original run is active', async () => {
    const { config, registry } = configWithRegistry();
    const runId = 'wf_1234abcd';
    let resolveDispatch: ((value: string) => void) | undefined;
    const original = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("original")',
      args: undefined,
      resumeFromRunId: runId,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());
    const replacementCaller = new AbortController();
    const replacementDispatch = vi.fn(async () => 'replacement');

    try {
      await expect(
        WorkflowRunner.start({
          config,
          signal: replacementCaller.signal,
          script: 'return await agent("replacement")',
          args: undefined,
          resumeFromRunId: runId,
          dispatch: replacementDispatch,
        }),
      ).rejects.toThrow(/is still running/);
      expect(registry.getHandle(runId)).toBe(original);
      expect(replacementDispatch).not.toHaveBeenCalled();
      expect(getEventListeners(replacementCaller.signal, 'abort')).toHaveLength(
        0,
      );
    } finally {
      resolveDispatch?.('original');
      await original.completion;
    }

    expect(registry.get(runId)?.result).toBe('original');
  });

  it('ignores late dispatch callbacks from a prior retry entry', async () => {
    const { config, registry } = configWithRegistry();
    const runId = 'wf_1234abcd';
    let rejectOriginal: ((error: Error) => void) | undefined;
    const original = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'agent("original"); throw new Error("original failed")',
      args: undefined,
      resumeFromRunId: runId,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectOriginal = reject;
        }),
    });
    await expect(original.completion).resolves.toMatchObject({ ok: false });

    let resolveRetry: ((value: string) => void) | undefined;
    const retry = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("retry")',
      args: undefined,
      resumeFromRunId: runId,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveRetry = resolve;
        }),
    });
    await vi.waitFor(() => expect(resolveRetry).toBeDefined());

    rejectOriginal?.(new Error('aborted by old controller'));
    resolveRetry?.('done');
    await expect(retry.completion).resolves.toMatchObject({ ok: true });

    expect(registry.get(runId)?.dispatches).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(registry.get(runId)?.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'dispatch-failed',
          error: 'aborted by old controller',
        }),
      ]),
    );
  });

  it('settles a background agent failure to null after caller abort', async () => {
    const { config, registry } = configWithRegistry();
    const caller = new AbortController();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());

    caller.abort();
    rejectDispatch?.(new Error('background boom'));

    await expect(handle.completion).resolves.toMatchObject({
      ok: true,
      outcome: { result: null },
    });
    expect(registry.get(handle.runId)?.status).toBe('completed');
  });

  it('routes registry cancellation through each live handle', async () => {
    const cancelCases: Array<{
      cancel: (registry: WorkflowRunRegistry, runId: string) => void;
    }> = [
      {
        cancel: (registry, runId) => registry.cancel(runId, Date.now()),
      },
      {
        cancel: (registry) => registry.abortAll(),
      },
    ];

    for (const { cancel } of cancelCases) {
      const { config, registry } = configWithRegistry();
      const observed = observeSettlement(registry);
      let rejectDispatch: ((error: Error) => void) | undefined;
      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return await agent("work")',
        args: undefined,
        runInBackground: true,
        dispatch: () =>
          new Promise<string>((_resolve, reject) => {
            rejectDispatch = reject;
          }),
      });
      const abortSpy = vi.spyOn(handle, 'abort');
      await vi.waitFor(() => expect(rejectDispatch).toBeDefined());

      cancel(registry, handle.runId);

      expect(abortSpy).toHaveBeenCalledOnce();
      expect(observed.abortCount()).toBe(1);
      expect(registry.get(handle.runId)?.status).toBe('cancelled');
      expect(registry.getHandle(handle.runId)).toBe(handle);

      rejectDispatch?.(new Error('aborted'));
      const result = await handle.completion;
      expect(result.ok).toBe(false);
      expect(registry.get(handle.runId)?.status).toBe('cancelled');
      expect(registry.getHandle(handle.runId)).toBeUndefined();
    }

    expect(writeWorkflowSnapshotMock).toHaveBeenCalledTimes(2);
    expect(logWorkflowRunMock).toHaveBeenCalledTimes(2);
  });

  it('does not journal a failed agent when the run handle aborts it', async () => {
    const { config } = configWithRegistry();
    stubStorage(config, await makeStorageRoot());
    let rejectDispatch: ((error: Error) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: `return await agent('work');`,
      args: undefined,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());

    handle.abort();
    rejectDispatch?.(new Error('cancelled by run handle'));
    await handle.completion;

    const journalEntries = writeLineMock.mock.calls.map(
      (call) => call[1] as { type: string },
    );
    expect(journalEntries.some((entry) => entry.type === 'started')).toBe(true);
    expect(journalEntries.some((entry) => entry.type === 'failed')).toBe(false);
  });

  it('classifies the internal wall-clock timeout as failed', async () => {
    vi.useFakeTimers();
    const originalTimeout = process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'];
    process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'] = '1';
    try {
      const timedOut = configWithRegistry();
      const observed = observeSettlement(timedOut.registry);
      const handle = await WorkflowRunner.start({
        config: timedOut.config,
        signal: new AbortController().signal,
        script: 'await new Promise(() => {})',
        args: undefined,
        runInBackground: true,
        dispatch: async () => 'unused',
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await handle.completion;
      expect(result.ok).toBe(false);
      expect(timedOut.registry.get(handle.runId)?.status).toBe('failed');
      expect(observed.terminalStatuses).toEqual(['failed']);
      expect(observed.abortCount()).toBe(1);
      expect(writeWorkflowSnapshotMock).toHaveBeenCalledOnce();
      expect(logWorkflowRunMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      if (originalTimeout === undefined) {
        delete process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'];
      } else {
        process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'] = originalTimeout;
      }
    }
  });

  // ── Pre-launch compile gate ──────────────────────────────────────────
  //
  // `start()` used to mint a runId, open a journal and register the run
  // before a byte was parsed, so one TypeScript annotation produced a
  // registered, failed run: a phantom row in `/workflows`, a snapshot on
  // disk, and a telemetry event, for a workflow that never began.
  describe('pre-launch compile gate', () => {
    const TS_ANNOTATION = "const target: string = 'x';\nawait agent(target);";

    it('refuses a script that cannot compile', async () => {
      const { config } = configWithRegistry();
      await expect(
        WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: TS_ANNOTATION,
          args: undefined,
        }),
      ).rejects.toThrow(/was not launched/);
    });

    // The point of the gate is not the message, it is that nothing survives
    // the refusal. Each of these is a side effect the old ordering produced
    // for a script that never ran.
    it('leaves no run, no snapshot, no journal and no telemetry behind', async () => {
      const { config, registry } = configWithRegistry();
      logWorkflowRunMock.mockClear();
      writeWorkflowSnapshotMock.mockClear();
      writeLineMock.mockClear();

      await expect(
        WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: TS_ANNOTATION,
          args: undefined,
        }),
      ).rejects.toThrow();

      expect(registry.list()).toHaveLength(0);
      expect(writeWorkflowSnapshotMock).not.toHaveBeenCalled();
      expect(logWorkflowRunMock).not.toHaveBeenCalled();
      expect(writeLineMock).not.toHaveBeenCalled();
    });

    it('names the offending line and explains the usual cause', async () => {
      const { config } = configWithRegistry();
      const error = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: `await agent('one');\n${TS_ANNOTATION}`,
        args: undefined,
      }).then(
        () => {
          throw new Error('expected the script to be refused');
        },
        (e: unknown) => e as Error,
      );

      // Line 2 of the script, not line 3 of the wrapped source the vm sees.
      expect(error.message).toContain('line 2');
      expect(error.message).toContain('^');
      expect(error.message).toContain('plain JavaScript');
      expect(error.message).toContain('TypeScript syntax');
    });

    it.each([
      ['CRLF', '\r\n'],
      ['U+2028', '\u2028'],
      ['lone CR', '\r'],
    ])(
      'attributes the author line with %s separators',
      async (_name, separator) => {
        const { config } = configWithRegistry();
        const error = await WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: `await agent('one');${separator}const x: string = 1;`,
          args: undefined,
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(WorkflowScriptNotLaunchedError);
        expect((error as Error).message).toContain('line 2');
        expect((error as Error).message).toContain('const x: string = 1;');
      },
    );

    // A malformed `export const meta` cannot start a run either, and it
    // reaches the same refusal rather than becoming a registered failure.
    it.each([
      [
        'export const meta = { name: someIdentifier }\nawait x();',
        'extractAndStripMeta',
      ],
      ["export const meta = { name: 'x'", 'stripExportMeta'],
    ])(
      'refuses a malformed meta literal without leaking internal names',
      async (script, internalName) => {
        const { config, registry } = configWithRegistry();
        const error = await WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script,
          args: undefined,
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(WorkflowScriptNotLaunchedError);
        expect((error as Error).message).toMatch(
          /invalid meta object literal|unbalanced braces/,
        );
        expect((error as Error).message).not.toContain(internalName);
        expect((error as Error).message).not.toContain('has a syntax error');
        expect(registry.list()).toHaveLength(0);
      },
    );

    // The equivalence that makes the gate trustworthy: the gate and the run
    // compile through one exported function, so a script cannot pass the gate
    // and then fail to compile inside the run. Drive both sides from one
    // fixture list — if they ever diverge, one of these rows flips.
    it('accepts exactly what the shared compile step accepts', async () => {
      const fixtures = [
        "await agent('plain');",
        "export const meta = { name: 'n', description: 'd' }\nawait agent('x');",
        '',
        "const s = 'a: string = 1';\nawait agent(s);", // looks like TS, is a string
        TS_ANNOTATION,
        'await agent(',
        'export const meta = { name: someIdentifier }',
      ];

      for (const source of fixtures) {
        let compileThrew = false;
        try {
          compileWorkflowScript(source);
        } catch {
          compileThrew = true;
        }

        const { config } = configWithRegistry();
        const started = await WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: source,
          args: undefined,
          dispatch: async () => 'ok',
        }).then(
          (handle) => {
            void handle.completion.catch(() => undefined);
            return true;
          },
          () => false,
        );

        expect(
          started,
          `fixture disagreed between gate and compile: ${JSON.stringify(source)}`,
        ).toBe(!compileThrew);
      }
    });
  });
  // ── Persisted inline script ─────────────────────────────────────────
  //
  // An inline script used to exist only in memory and in the terminal
  // snapshot: a model that wanted to resume had to re-send the whole source,
  // and a user had no file to read. The runner now writes it under the
  // generated root — the same root `{scriptPath}` already trusts — so the
  // path it hands back is one the loader will take back.
  describe('persisted inline script', () => {
    it('writes the inline script under the generated root and hands back both paths', async () => {
      const { config, registry } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      const script = 'return "done"';

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script,
        args: undefined,
        dispatch: async () => 'unused',
      });
      await expect(handle.completion).resolves.toMatchObject({ ok: true });

      const expected = path.join(
        root,
        'generated',
        'inline',
        `${handle.runId}.js`,
      );
      expect(handle.scriptPath).toBe(expected);
      expect(handle.journalPath).toBe(
        path.join(root, handle.runId, 'journal.jsonl'),
      );
      await expect(fs.readFile(expected, 'utf8')).resolves.toBe(script);
      if (process.platform !== 'win32') {
        const stat = await fs.stat(expected);
        expect(stat.mode & 0o777).toBe(0o600);
      }
      // The registry entry carries both too: the terminal notification is
      // built from the entry, long after the handle is out of scope.
      const entry = registry.get(handle.runId);
      expect(entry?.scriptPath).toBe(expected);
      expect(entry?.journalPath).toBe(handle.journalPath);
    });

    it('writes nothing for a scriptPath launch and reports the loaded path', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      resolveSavedWorkflowScriptMock.mockResolvedValueOnce({
        name: 'review',
        savedWorkflowName: 'review',
        scriptPath: '/tmp/review.js',
        script: 'return "loaded"',
      });

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        scriptPath: '/tmp/review.js',
        args: undefined,
        dispatch: async () => 'unused',
      });
      await expect(handle.completion).resolves.toMatchObject({ ok: true });

      expect(handle.scriptPath).toBe('/tmp/review.js');
      await expect(
        fs.readdir(path.join(root, 'generated', 'inline')),
      ).rejects.toThrow();
    });

    it('does not replace an existing script path with a generated copy', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "loaded"',
        scriptPath: '/tmp/review.js',
        args: undefined,
        dispatch: async () => 'unused',
      });
      await expect(handle.completion).resolves.toMatchObject({ ok: true });

      expect(handle.scriptPath).toBe('/tmp/review.js');
      await expect(
        fs.readdir(path.join(root, 'generated', 'inline')),
      ).rejects.toThrow();
    });

    it('leaves no file behind when the script does not compile', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);

      await expect(
        WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: "const target: string = 'x';\nawait agent(target);",
          args: undefined,
        }),
      ).rejects.toThrow(/was not launched/);

      await expect(
        fs.readdir(path.join(root, 'generated', 'inline')),
      ).rejects.toThrow();
    });

    // A symlinked generated root is refused by the loader, so writing through
    // it would persist a script nothing can read back — and it is the shape a
    // planted link would use to place model-authored source outside the
    // runtime dir. Degrade, never fail the run over it.
    it('refuses a symlinked generated root without failing the run', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside, { recursive: true });
      await fs.symlink(outside, path.join(root, 'generated'), 'dir');

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "done"',
        args: undefined,
        dispatch: async () => 'unused',
      });
      await expect(handle.completion).resolves.toMatchObject({ ok: true });

      expect(handle.scriptPath).toBeUndefined();
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    });

    // The resume contract the description states: edit that file, pass the
    // path back. The second run must land on the same file rather than
    // accumulating a copy per attempt.
    it('overwrites the same file when an inline run is resumed', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);

      const first = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "first"',
        args: undefined,
        dispatch: async () => 'unused',
      });
      await expect(first.completion).resolves.toMatchObject({ ok: true });

      const second = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "second"',
        args: undefined,
        resumeFromRunId: first.runId,
        dispatch: async () => 'unused',
      });
      await expect(second.completion).resolves.toMatchObject({ ok: true });

      expect(second.scriptPath).toBe(first.scriptPath);
      await expect(fs.readFile(first.scriptPath!, 'utf8')).resolves.toBe(
        'return "second"',
      );
      await expect(
        fs.readdir(path.join(root, 'generated', 'inline')),
      ).resolves.toEqual([`${first.runId}.js`]);
    });
  });
  // A `+250k` turn target belongs to the turn, not to this run: the run's
  // budget measures the turn, while the registry — what `/workflows` and the
  // snapshot show — keeps this run's own figures and records no cap for it.
  it('builds a directive budget from the turn and registers no per-run cap', async () => {
    const { config, registry } = configWithRegistry();
    const turns = new TurnBudget();
    turns.beginTurn({
      promptId: 'turn',
      sessionId: 'runner-turn',
      budget: 250_000,
      directiveText: '+250k',
      outputTokensAtTurnStart: 0,
    });
    Object.assign(config, {
      getSessionId: () => 'runner-turn',
      getTurnBudget: () => turns,
    });

    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return budget.total',
      args: undefined,
      dispatch: async () => 'unused',
    });

    await expect(handle.completion).resolves.toMatchObject({
      ok: true,
      outcome: { result: 250_000 },
    });
    expect(handle.budget.source).toBe('directive');
    expect(handle.budget.total).toBe(250_000);
    expect(registry.get(handle.runId)?.tokenBudgetTotal).toBeNull();
  });
});

// ── Workflow size ─────────────────────────────────────────────────────
//
// The runner is the one place a run's size is evaluated: it reads the
// guideline once, checks on every scheduled agent and every spend update, and
// hands the first warning to the registry. The thresholds themselves are
// covered in workflow-size.test.ts; these pin the wiring.
describe('WorkflowRunner — workflow size', () => {
  beforeEach(() => {
    logWorkflowSizeWarningMock.mockClear();
  });

  function fanOut(count: number): string {
    return `return await parallel(Array.from({ length: ${count} }, (_, i) => () => agent('item ' + i)))`;
  }

  it('flags a run that schedules more agents than the default guideline, once', async () => {
    const { config, registry } = configWithRegistry();
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: fanOut(WORKFLOW_SIZE_GUIDELINE_AGENTS.medium + 5),
      args: undefined,
      dispatch: async () => 'ok',
    });
    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    expect(registry.get(handle.runId)?.sizeWarning).toMatchObject({
      axis: 'agents',
      scheduledAgents: WORKFLOW_SIZE_GUIDELINE_AGENTS.medium + 1,
      agentCap: WORKFLOW_SIZE_GUIDELINE_AGENTS.medium,
      capFromGuideline: true,
    });
    expect(logWorkflowSizeWarningMock).toHaveBeenCalledTimes(1);
  });

  it('takes the agent threshold from a configured guideline', async () => {
    const { config, registry } = configWithRegistry();
    Object.assign(config, {
      getWorkflowSizeGuideline: () => ({ size: 'small', isDefault: false }),
    });
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: fanOut(WORKFLOW_SIZE_GUIDELINE_AGENTS.small + 1),
      args: undefined,
      dispatch: async () => 'ok',
    });
    await handle.completion;

    expect(registry.get(handle.runId)?.sizeWarning).toMatchObject({
      axis: 'agents',
      agentCap: WORKFLOW_SIZE_GUIDELINE_AGENTS.small,
    });
  });

  it('stays quiet within bounds, and lets the env raise the threshold', async () => {
    vi.stubEnv(WORKFLOW_SIZE_WARNING_AGENTS_ENV, '100');
    try {
      const { config, registry } = configWithRegistry();
      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        // Past the default guideline, under the env threshold, and under the
        // token projection (20 × 70k < 1.5M).
        script: fanOut(20),
        args: undefined,
        dispatch: async () => 'ok',
      });
      await handle.completion;

      expect(registry.get(handle.runId)?.sizeWarning).toBeUndefined();
      expect(logWorkflowSizeWarningMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A resume replays agents by call sequence; a clock or a random draw changes
  // the sequence. Refused before launch, with its own cause rather than the
  // syntax hint a compile failure carries.
  it('refuses a script that reads the clock before any agent runs', async () => {
    const { config } = configWithRegistry();
    const dispatch = vi.fn(async () => 'ok');
    const start = WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: "await agent('first')\nreturn await agent('stamp ' + Date.now())",
      args: undefined,
      dispatch,
    });

    await expect(start).rejects.toBeInstanceOf(WorkflowScriptNotLaunchedError);
    await expect(start).rejects.toThrow(/Date\.now\(\) on line 2/);
    await expect(start).rejects.not.toThrow(/TypeScript syntax/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps the syntax hint on a compile failure', async () => {
    const { config } = configWithRegistry();
    await expect(
      WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: "const target: string = 'x'\nawait agent(target)",
        args: undefined,
        dispatch: async () => 'ok',
      }),
    ).rejects.toThrow(/TypeScript syntax/);
  });
});
