/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  claimMeshHostSession,
  readMeshWorkspace,
  releaseMeshHostSession,
  type MeshAgent,
  type MeshAgentLaunchResult,
} from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { beginKeepaliveSessionResume } from '../scheduled-task-keepalive.js';
import type { WorkspaceGenerationGuard } from '../workspace-registry.js';
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
  generationGuard?: WorkspaceGenerationGuard;
  intervalMs?: number;
  resumeTimeoutMs?: number;
}): MeshHostSessionOwner {
  const { bridge, workspaceCwd } = options;
  const assertGenerationOpen = () => options.generationGuard?.assertOpen();
  const intervalMs = options.intervalMs ?? DEFAULT_MESH_KEEPALIVE_INTERVAL_MS;
  const resumeTimeoutMs =
    options.resumeTimeoutMs ?? DEFAULT_MESH_RESUME_TIMEOUT_MS;
  let ensuring: Promise<string> | undefined;
  let reviving:
    | {
        completion: Promise<unknown>;
        deadline: Promise<unknown>;
        definitivelyFailed: boolean;
      }
    | undefined;

  const ensure = async (): Promise<string> => {
    assertGenerationOpen();
    const workspace = await readMeshWorkspace(workspaceCwd);
    assertGenerationOpen();
    if (workspace.hostSessionId) {
      try {
        bridge.recordHeartbeat(workspace.hostSessionId);
      } catch {
        assertGenerationOpen();
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
          const current = {
            ...started,
            definitivelyFailed: false,
          };
          reviving = current;
          void started.completion
            .catch((error: unknown) => {
              current.definitivelyFailed = true;
              throw error;
            })
            .finally(() => {
              if (reviving === current) reviving = undefined;
            })
            .catch(() => {});
        }
        const current = reviving;
        try {
          await current.deadline;
          assertGenerationOpen();
        } catch (error) {
          await Promise.resolve();
          if (!current.definitivelyFailed) throw error;
          assertGenerationOpen();
          await releaseMeshHostSession(
            workspaceCwd,
            workspace.hostSessionId,
          );
          return ensure();
        }
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
      assertGenerationOpen();
      winner = await claimMeshHostSession(workspaceCwd, spawned.sessionId);
      assertGenerationOpen();
    } catch (error) {
      await releaseMeshHostSession(workspaceCwd, spawned.sessionId).catch(
        () => false,
      );
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
    assertGenerationOpen();
    const workspace = await readMeshWorkspace(workspaceCwd);
    assertGenerationOpen();
    if (!workspace.hostSessionId) return;
    const sessionId = await ensureResident();
    assertGenerationOpen();
    await bridge.dispatchMeshRuns?.(sessionId);
  };

  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
  };
  timer = setInterval(() => {
    if (options.generationGuard?.closed) {
      stop();
      return;
    }
    if (running) return;
    running = true;
    void tick()
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    ensureResident,
    async launch(agent, prompt) {
      const sessionId = await ensureResident();
      assertGenerationOpen();
      return bridge.launchMeshAgent(sessionId, agent.id, prompt);
    },
    async dispatch() {
      if (!bridge.dispatchMeshRuns) {
        throw new Error('Mesh dispatch is unavailable in this runtime.');
      }
      const sessionId = await ensureResident();
      assertGenerationOpen();
      return bridge.dispatchMeshRuns(sessionId);
    },
    tick,
    stop,
  };
}
