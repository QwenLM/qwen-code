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
import { MESH_HOST_SESSION_SOURCE_TYPE } from './mesh-session-source.js';

const DEFAULT_MESH_KEEPALIVE_INTERVAL_MS = 30_000;
const DEFAULT_MESH_RESUME_TIMEOUT_MS = 70_000;

type MeshHostBridge = Pick<
  AcpSessionBridge,
  | 'recordHeartbeat'
  | 'resumeSession'
  | 'spawnOrAttach'
  | 'closeSession'
  | 'launchMeshAgent'
>;

export interface MeshHostSessionOwner {
  ensureResident(): Promise<string>;
  launch(agent: MeshAgent, prompt: string): Promise<MeshAgentLaunchResult>;
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
    const winner = await claimMeshHostSession(workspaceCwd, spawned.sessionId);
    if (winner !== spawned.sessionId) {
      await bridge.closeSession(spawned.sessionId);
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
    if (workspace.hostSessionId) await ensureResident();
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
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
