/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Binds the dispatcher's port to the real background-agent runtime.
 *
 * Kept apart from `dispatcher.ts` so the selection and outcome rules stay
 * provable without a runtime, and so the one place that knows how a Qwen Code
 * body is started is also the one place a future non-local runtime would be
 * substituted (§9.12).
 *
 * The mapping is deliberately narrow. Everything this file decides is
 * "which entry point", and every entry point's failure is translated into one
 * of the four outcomes the dispatcher already handles. Whether a completed
 * body still has a resident runtime is *not* decided here: the registry owns
 * that fact and reports its own fallback, so asking it is the only way to
 * avoid cold-reviving a body that was still live.
 */

import { stat } from 'node:fs/promises';

import type { Config } from '../../config/config.js';
import { isNodeError } from '../../utils/errors.js';
import {
  getAgentJsonlPath,
  getAgentMetaPath,
  patchAgentMeta,
  readAgentMeta,
} from '../agent-transcript.js';
import { launchMeshAgent } from './launcher.js';
import type { MeshRunContext } from './run-context.js';
import type {
  MeshBodyState,
  MeshDispatchPort,
  MeshStartResult,
} from './dispatcher.js';
import type { MeshAgent } from './types.js';

/** Deterministic per identity, so one agent has exactly one body. */
export function meshBackgroundAgentId(agent: Pick<MeshAgent, 'id'>): string {
  return `mesh-${agent.id}`;
}

async function transcriptSize(config: Config, agent: MeshAgent): Promise<number> {
  try {
    return (
      await stat(
        getAgentJsonlPath(
          config.storage.getProjectDir(),
          config.getSessionId(),
          meshBackgroundAgentId(agent),
        ),
      )
    ).size;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
}

function withTranscriptStart(
  result: MeshStartResult,
  transcriptStartOffset: number,
): MeshStartResult {
  return result.status === 'started'
    ? { ...result, transcriptStartOffset }
    : result;
}

/**
 * What the background-task registry currently holds for this identity.
 *
 * `paused` covers the entry a process restart recovers, which the resume
 * engine accepts and the revive path rejects — getting this branch wrong is a
 * run that can never start again.
 */
export function inspectBody(config: Config, agent: MeshAgent): MeshBodyState {
  const entry = config
    .getBackgroundTaskRegistry()
    .get(meshBackgroundAgentId(agent));
  if (!entry) return { kind: 'absent' };
  switch (entry.status) {
    case 'running': {
      const meshRun = readAgentMeta(
        getAgentMetaPath(
          config.storage.getProjectDir(),
          config.getSessionId(),
          meshBackgroundAgentId(agent),
        ),
      )?.meshRun;
      return {
        kind: 'running',
        ...(meshRun
          ? {
              threadId: meshRun.threadId,
              runId: meshRun.runId,
              attempt: meshRun.attempt,
            }
          : {}),
      };
    }
    case 'paused':
      return { kind: 'paused' };
    case 'completed':
      return { kind: 'completed' };
    default:
      // Cancelled or failed: the identity has no usable body, so the next turn
      // builds one. Treating it as absent is safe because the launcher is
      // keyed on the same deterministic id.
      return { kind: 'absent' };
  }
}

function failure(error: unknown, stage: string): MeshStartResult {
  return {
    status: 'launch_failed',
    error: error instanceof Error ? error.message : String(error),
    failureStage: stage,
  };
}

/**
 * Continues a completed body, hot if the registry still has its runtime.
 *
 * `capacity_wait` is returned before any mutation, so a saturated registry
 * costs the run nothing. A `fallback` means the resident runtime is gone and
 * the transcript is the way back in; `not_completed` means the entry moved
 * under us, which the next pass re-reads rather than forcing.
 */
async function continueCompleted(
  config: Config,
  agent: MeshAgent,
  prompt: string,
  deliveryId: string,
): Promise<MeshStartResult> {
  const registry = config.getBackgroundTaskRegistry();
  const agentId = meshBackgroundAgentId(agent);
  const outcome = registry.continueResidentAgent(
    agentId,
    prompt,
    deliveryId,
  );
  if (outcome === 'continued') {
    return {
      status: 'started',
      sessionId: config.getSessionId(),
      consumedOnStart: false,
    };
  }
  if (outcome === 'capacity_wait') return { status: 'capacity_wait' };
  if (outcome === 'not_completed') {
    return {
      status: 'launch_failed',
      error: 'Background agent entry changed state during dispatch.',
      failureStage: 'continue',
    };
  }
  const revived = await config.reviveCompletedBackgroundAgent(agentId, prompt);
  if (!revived) {
    return {
      status: 'launch_failed',
      error: `Could not revive background agent "${agentId}" from its transcript.`,
      failureStage: 'revive',
    };
  }
  return {
    status: 'started',
    sessionId: config.getSessionId(),
    consumedOnStart: true,
  };
}

function bindNextTurn(
  config: Config,
  agent: MeshAgent,
  binding: MeshRunContext,
): void {
  const metaPath = getAgentMetaPath(
    config.storage.getProjectDir(),
    config.getSessionId(),
    meshBackgroundAgentId(agent),
  );
  patchAgentMeta(metaPath, { meshRun: binding });
  const stored = readAgentMeta(metaPath)?.meshRun;
  if (
    stored?.workspaceId !== binding.workspaceId ||
    stored.threadId !== binding.threadId ||
    stored.runId !== binding.runId ||
    stored.attempt !== binding.attempt
  ) {
    throw new Error(`Could not bind mesh run "${binding.runId}" to its body.`);
  }
}

/**
 * The production port.
 *
 * `Config` is the workspace's hidden host session, so every mesh body is owned
 * by one registry and one transcript root. Passing a different config per call
 * would give an agent more than one body and silently break decision 5.
 */
export function createMeshDispatchPort(config: Config): MeshDispatchPort {
  return {
    async inspect(agent) {
      return inspectBody(config, agent);
    },
    async deliver({ agent, prompt, deliveryId, threadId, runId, attempt }) {
      const metaPath = getAgentMetaPath(
        config.storage.getProjectDir(),
        config.getSessionId(),
        meshBackgroundAgentId(agent),
      );
      const binding = readAgentMeta(metaPath)?.meshRun;
      if (
        binding?.threadId !== threadId ||
        binding.runId !== runId ||
        binding.attempt !== attempt
      ) {
        return false;
      }
      return config.getBackgroundTaskRegistry().queueExternalInput(
        meshBackgroundAgentId(agent),
        { kind: 'message', text: prompt, deliveryId },
      );
    },
    async start({
      action,
      agent,
      prompt,
      workspaceId,
      threadId,
      rootThreadId,
      runId,
      attempt,
      contextThroughSequence,
    }) {
      try {
        const transcriptStartOffset = await transcriptSize(config, agent);
        const binding: MeshRunContext = {
          workspaceId,
          agentId: agent.id,
          runId,
          threadId,
          rootThreadId,
          attempt,
          contextThroughSequence,
        };
        if (action !== 'launch') bindNextTurn(config, agent, binding);
        switch (action) {
          case 'launch': {
            const result = await launchMeshAgent(
              config,
              agent,
              prompt,
              binding,
            );
            if (result.status === 'started') {
              return {
                status: 'started',
                sessionId: result.sessionId,
                consumedOnStart: true,
                transcriptStartOffset,
              };
            }
            if (result.status === 'capacity_wait') {
              return { status: 'capacity_wait' };
            }
            if (result.status === 'agent_unavailable') {
              return { status: 'agent_unavailable', error: result.error };
            }
            return {
              status: 'launch_failed',
              error: result.error,
              failureStage: 'launch',
            };
          }
          case 'resume': {
            const resumed = await config.resumeBackgroundAgent(
              meshBackgroundAgentId(agent),
              prompt,
            );
            if (!resumed) {
              return {
                status: 'launch_failed',
                error: `Could not resume background agent "${meshBackgroundAgentId(agent)}".`,
                failureStage: 'resume',
              };
            }
            return {
              status: 'started',
              sessionId: config.getSessionId(),
              consumedOnStart: true,
              transcriptStartOffset,
            };
          }
          case 'continue_completed':
            return withTranscriptStart(
              await continueCompleted(config, agent, prompt, runId),
              transcriptStartOffset,
            );
          default: {
            const exhaustive: never = action;
            return failure(
              new Error(`Unknown start action ${String(exhaustive)}`),
              'launch',
            );
          }
        }
      } catch (error) {
        return failure(error, action === 'launch' ? 'launch' : 'resume');
      }
    },
  };
}
