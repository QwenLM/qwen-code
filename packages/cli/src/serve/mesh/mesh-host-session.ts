/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  claimMeshHostSession,
  readMeshWorkspace,
  type MeshAgent,
  type MeshAgentLaunchResult,
} from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { beginKeepaliveSessionResume } from '../scheduled-task-keepalive.js';
import { MESH_HOST_SESSION_SOURCE_TYPE } from '../../runtime/mesh-session-source.js';

const DEFAULT_MESH_KEEPALIVE_INTERVAL_MS = 1_000;
const DEFAULT_MESH_RESUME_TIMEOUT_MS = 70_000;

interface MeshHostBridge {
  recordHeartbeat(sessionId: string): unknown;
  resumeSession(
    request: Parameters<AcpSessionBridge['resumeSession']>[0],
  ): Promise<unknown>;
  spawnOrAttach(
    request: Parameters<AcpSessionBridge['spawnOrAttach']>[0],
  ): Promise<{ sessionId: string }>;
  closeSession(sessionId: string): Promise<unknown>;
  launchMeshAgent: AcpSessionBridge['launchMeshAgent'];
  dispatchMeshRuns?: AcpSessionBridge['dispatchMeshRuns'];
}

export interface MeshHostSessionOwner {
  ensureResident(): Promise<string>;
  launch(agent: MeshAgent, prompt: string): Promise<MeshAgentLaunchResult>;
  dispatch(): ReturnType<AcpSessionBridge['dispatchMeshRuns']>;
  tick(): Promise<void>;
  stop(): void;
}

export function startMeshHostSessionOwner(options: {
  bridge: MeshHostBridge;
  workspaceCwd: string;
  intervalMs?: number;
  resumeTimeoutMs?: number;
}): MeshHostSessionOwner {
  const { bridge, workspaceCwd } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_MESH_KEEPALIVE_INTERVAL_MS;
  const resumeTimeoutMs =
    options.resumeTimeoutMs ?? DEFAULT_MESH_RESUME_TIMEOUT_MS;
  let ensuring: Promise<string> | undefined;
  let reviving:
    | { completion: Promise<unknown>; deadline: Promise<unknown> }
    | undefined;

  const ensure = async (): Promise<string> => {
    const workspace = await readMeshWorkspace(workspaceCwd);
    if (workspace.hostSessionId) {
      try {
        bridge.recordHeartbeat(workspace.hostSessionId);
      } catch {
        if (!reviving) {
          const started = beginKeepaliveSessionResume(
            bridge,
            {
              sessionId: workspace.hostSessionId,
              workspaceCwd,
              sourceType: MESH_HOST_SESSION_SOURCE_TYPE,
              sourceId: workspace.workspaceId,
            },
            resumeTimeoutMs,
          );
          reviving = started;
          void started.completion
            .finally(() => {
              if (reviving === started) reviving = undefined;
            })
            .catch(() => {});
        }
        await reviving.deadline;
      }
      return workspace.hostSessionId;
    }

    const spawned = await bridge.spawnOrAttach({
      workspaceCwd,
      sessionScope: 'thread',
      sourceType: MESH_HOST_SESSION_SOURCE_TYPE,
      sourceId: workspace.workspaceId,
    });
    let winner: string;
    try {
      winner = await claimMeshHostSession(workspaceCwd, spawned.sessionId);
    } catch (error) {
      await bridge.closeSession(spawned.sessionId).catch(() => {});
      throw error;
    }
    if (winner !== spawned.sessionId) {
      await bridge.closeSession(spawned.sessionId).catch(() => {});
      return ensure();
    }
    return winner;
  };

  const ensureResident = (): Promise<string> => {
    ensuring ??= ensure().finally(() => {
      ensuring = undefined;
    });
    return ensuring;
  };

  const tick = async (): Promise<void> => {
    const workspace = await readMeshWorkspace(workspaceCwd);
    if (!workspace.hostSessionId) return;
    const sessionId = await ensureResident();
    await bridge.dispatchMeshRuns?.(sessionId);
  };

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void tick()
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  let stopped = false;
  return {
    ensureResident,
    async launch(agent, prompt) {
      const sessionId = await ensureResident();
      return bridge.launchMeshAgent(sessionId, agent.id, prompt);
    },
    async dispatch() {
      if (!bridge.dispatchMeshRuns) {
        throw new Error('Mesh dispatch is unavailable in this runtime.');
      }
      return bridge.dispatchMeshRuns(await ensureResident());
    },
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
