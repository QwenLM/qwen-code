/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import {
  WorkflowEngine,
  parseWorkflowScript,
  WorkflowScriptError,
} from '@qwen-code/qwen-code-core';
import type { AgentRegistry } from '../agents/agentRegistry.js';
import type { OwnerEventBus, WorkflowEventPayload } from '../ownerEvents.js';
import type { AuditRecorder } from '../auditLog.js';
import type { AgentNotifySink } from '../agents/agentLifecycle.js';
import { SessionSpawner } from '../workflows/sessionSpawner.js';
import type {
  WorkflowRun,
  WorkflowRunRegistry,
} from '../workflows/workflowRegistry.js';

export interface WorkflowRoutesDeps {
  daemon: DaemonClient;
  agentRegistry: AgentRegistry;
  runRegistry: WorkflowRunRegistry;
  ownerEvents: OwnerEventBus;
  audit?: AuditRecorder;
  notifier?: AgentNotifySink;
  runsDir?: string;
  /** Resolve a named workflow to source (project/user .qwen/workflows). */
  resolveNamed?: (name: string) => Promise<string | undefined>;
}

function payloadOf(run: WorkflowRun): WorkflowEventPayload {
  return {
    runId: run.runId,
    name: run.name,
    scriptHash: run.scriptHash,
    status: run.status,
    agentCount: run.agents.length,
    tokensSpent: run.tokensSpent,
  };
}

/** POST /rc/workflows — start a run (WRITE scope at the mount). */
export function createStartWorkflowRoute(
  deps: WorkflowRoutesDeps,
): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as {
      script?: unknown;
      name?: unknown;
      args?: unknown;
      resumeFromRunId?: unknown;
    };

    // Resolve source: inline script or named workflow.
    let source: string | undefined;
    if (typeof body.script === 'string') source = body.script;
    else if (typeof body.name === 'string' && deps.resolveNamed) {
      source = await deps.resolveNamed(body.name);
    }
    if (source === undefined) {
      res.status(400).json({
        error: 'Provide script or a known name',
        code: 'invalid_workflow_script',
      });
      return;
    }

    // Parse + pure-literal meta check BEFORE any spawn.
    let parsed;
    try {
      parsed = parseWorkflowScript(source);
    } catch (e) {
      const message = e instanceof WorkflowScriptError ? e.message : String(e);
      res.status(400).json({ error: message, code: 'invalid_workflow_script' });
      return;
    }

    // Register the run and respond 202 immediately.
    const run = deps.runRegistry.create({
      runId: randomUUID(),
      name: parsed.meta.name,
      scriptHash: parsed.scriptHash,
    });
    const spawner = new SessionSpawner({
      daemon: deps.daemon,
      registry: deps.agentRegistry,
      runId: run.runId,
      spawnedByTokenId: req.rcClient?.id ?? '',
      onAgentSpawned: (agentId, sessionId) =>
        deps.runRegistry.addAgent(run.runId, agentId, sessionId),
    });
    const runEngine = new WorkflowEngine(spawner, { runsDir: deps.runsDir });

    deps.ownerEvents.publish({
      type: 'workflow_started',
      workflow: payloadOf(run),
    });
    void deps.audit?.record({
      action: 'workflow_started',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: run.runId,
      // name + hash only — NEVER the script source.
      detail: { name: parsed.meta.name, scriptHash: parsed.scriptHash },
    });

    // Fire the engine in the background; drive frames off its callbacks.
    void (async () => {
      try {
        const result = await runEngine.run(source, {
          runId: run.runId,
          args: body.args,
          resumeFromRunId:
            typeof body.resumeFromRunId === 'string'
              ? body.resumeFromRunId
              : undefined,
          signal: run.controller.signal,
          onPhase: (phase, phaseIndex) => {
            deps.runRegistry.setPhase(run.runId, phase, phaseIndex);
            deps.ownerEvents.publish({
              type: 'workflow_phase',
              runId: run.runId,
              phase,
              phaseIndex,
            });
          },
        });
        deps.runRegistry.setTokens(run.runId, result.tokensSpent);
        if (result.status === 'cancelled') {
          finish(deps, run, 'cancelled', 'workflow_cancelled');
        } else {
          finish(deps, run, 'completed', 'workflow_completed');
        }
      } catch {
        finish(deps, run, 'failed', 'workflow_failed');
      }
    })();

    res.status(202).json({ runId: run.runId });
  };
}

function finish(
  deps: WorkflowRoutesDeps,
  run: WorkflowRun,
  status: WorkflowRun['status'],
  eventType: 'workflow_completed' | 'workflow_failed' | 'workflow_cancelled',
): void {
  if (!deps.runRegistry.setStatus(run.runId, status)) return;
  const payload = payloadOf(deps.runRegistry.get(run.runId)!);
  deps.ownerEvents.publish({ type: eventType, workflow: payload });
  if (eventType !== 'workflow_cancelled') {
    void deps.notifier
      ?.notify(
        { type: eventType, data: payload },
        { sessionId: run.runId, sessionName: run.name },
      )
      .catch(() => {});
  }
}

/** GET /rc/workflows — list (SESSION_READ scope). */
export function createListWorkflowsRoute(
  deps: WorkflowRoutesDeps,
): RequestHandler {
  return (_req, res) => {
    const workflows = deps.runRegistry.list().map((run) => ({
      runId: run.runId,
      name: run.name,
      status: run.status,
      phase: run.phase,
      agentCount: run.agents.length,
      tokensSpent: run.tokensSpent,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    }));
    res.status(200).json({ workflows });
  };
}

/** GET /rc/workflows/:runId — detail incl. the per-agent session map. */
export function createGetWorkflowRoute(
  deps: WorkflowRoutesDeps,
): RequestHandler {
  return (req, res) => {
    const run = deps.runRegistry.get(req.params.runId);
    if (!run) {
      res
        .status(404)
        .json({ error: 'Unknown run', code: 'workflow_not_found' });
      return;
    }
    res.status(200).json({
      runId: run.runId,
      name: run.name,
      scriptHash: run.scriptHash,
      status: run.status,
      phase: run.phase,
      phaseIndex: run.phaseIndex,
      agents: run.agents,
      tokensSpent: run.tokensSpent,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });
  };
}

/** POST /rc/workflows/:runId/cancel — abort (WRITE scope). */
export function createCancelWorkflowRoute(
  deps: WorkflowRoutesDeps,
): RequestHandler {
  return (req, res) => {
    const run = deps.runRegistry.get(req.params.runId);
    // Atomic terminal-guarded transition: two concurrent cancels (or a cancel
    // repeated within the drain window before the background finish() runs)
    // can both pass a plain isTerminal() pre-check. beginCancel is the single
    // source of truth for "who won" — only the caller whose running->cancelling
    // CAS actually landed aborts/audits/emits; every other caller (already
    // cancelling, already terminal, or unknown run) gets 409, matching the
    // agentRegistry.setStatus CAS pattern used for agent cancel.
    const won = run ? deps.runRegistry.beginCancel(run.runId) : false;
    if (!run || !won) {
      res
        .status(409)
        .json({ error: 'Workflow not running', code: 'workflow_not_running' });
      return;
    }
    // Abort fans to every in-flight spawn (SessionSpawner ends their sessions);
    // the engine resolves `cancelled` and the background runner's finish()
    // performs the actual 'cancelling' -> 'cancelled' transition + SSE frame.
    run.controller.abort();
    void deps.audit?.record({
      action: 'workflow_cancelled',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: run.runId,
      detail: { name: run.name },
    });
    res.status(202).json({ runId: run.runId, status: 'cancelling' });
  };
}
