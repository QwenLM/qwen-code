/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentRuntime,
  AgentRuntimeFactory,
  AgentSession,
  AgentSessionDescriptor,
  AgentSpec,
  ApprovalDecision,
} from '@qwen-code/qwen-code-core';
import type { AgentViewSessionSnapshot } from './protocol.js';
import { RemoteSession } from './remote-session.js';
import {
  ensureAgentViewSupervisor,
  type AgentViewSupervisorClientHandle,
} from './supervisor-runner.js';
import { getAgentViewSessionPaths } from './supervisor-store.js';
import { fleetDebug } from './fleet-debug.js';

export function createSupervisedRuntimeFactory(): AgentRuntimeFactory {
  return () => new SupervisedRuntime();
}

class SupervisedRuntime implements AgentRuntime {
  readonly kind = 'supervised' as const;

  private readonly sessions = new Map<
    string,
    { session: RemoteSession; spec: AgentSpec }
  >();
  private supervisorPromise?: Promise<AgentViewSupervisorClientHandle>;

  async start(spec: AgentSpec): Promise<AgentSession> {
    if (this.sessions.has(spec.agentId)) {
      throw new Error(`Agent "${spec.agentId}" already exists.`);
    }
    const supervisor = await this.supervisor();
    const session = new RemoteSession(
      spec.agentId,
      spec.teamId,
      supervisor,
      spec.cwd,
      spec.modelConfig?.model ?? '',
      spec.approvalMode,
    );
    try {
      await session.waitUntilSubscribed();
    } catch (error) {
      session.dispose();
      throw error;
    }
    const tmpDir = getAgentViewSessionPaths(spec.agentId).tmpDir;
    const specPath = path.join(tmpDir, `launch-${randomUUID()}.json`);
    await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(specPath, JSON.stringify(spec), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });

    let dispatched = false;
    try {
      await supervisor.dispatch({
        sessionId: spec.agentId,
        specPath,
        projectCwd: spec.cwd,
        activeCwd: spec.worktreePath ?? spec.cwd,
        displayName: spec.name,
      });
      dispatched = true;
      fleetDebug('runtime', 'dispatched, awaiting handshake', {
        sessionId: spec.agentId,
      });
      await session.waitUntilReady();
      fleetDebug('runtime', 'teammate ready', { sessionId: spec.agentId });
      this.sessions.set(spec.agentId, { session, spec });
      return session;
    } catch (error) {
      fleetDebug('runtime', 'teammate start failed', {
        sessionId: spec.agentId,
        error,
      });
      if (dispatched) {
        await supervisor.kill(spec.agentId).catch(() => {});
        await supervisor.remove(spec.agentId).catch(() => {});
      }
      session.dispose();
      throw error;
    } finally {
      await fs.unlink(specPath).catch(() => {});
    }
  }

  async reattach(agentId: string): Promise<AgentSession | undefined> {
    return this.sessions.get(agentId)?.session;
  }

  async list(teamId?: string): Promise<AgentSessionDescriptor[]> {
    const supervisor = await this.supervisor();
    const snapshots = (await supervisor.list()) as AgentViewSessionSnapshot[];
    return snapshots.flatMap((snapshot) => {
      const local = this.sessions.get(snapshot.sessionId);
      if (!local || (teamId && local.spec.teamId !== teamId)) return [];
      return [
        {
          agentId: local.spec.agentId,
          teamId: local.spec.teamId,
          name: local.spec.name,
          status: local.session.getStatus(),
          processState: descriptorProcessState(snapshot.state.processState),
          cwd: snapshot.state.activeCwd,
          worktreePath: local.spec.worktreePath,
          lastActivityAt:
            snapshot.activity?.lastActivityAt ?? snapshot.state.updatedAt,
        },
      ];
    });
  }

  async stop(agentId: string, _opts?: { graceMs?: number }): Promise<void> {
    await (await this.supervisor()).stop(agentId);
  }

  async kill(agentId: string): Promise<void> {
    await (await this.supervisor()).kill(agentId);
  }

  async answer(agentId: string, decision: ApprovalDecision): Promise<void> {
    await (
      await this.supervisor()
    ).answer(agentId, decision.callId, decision.outcome, decision.payload);
  }

  async dispose(): Promise<void> {
    if (this.sessions.size === 0) return;
    const supervisor = await this.supervisor();
    await Promise.allSettled(
      [...this.sessions.keys()].map((agentId) => supervisor.stop(agentId)),
    );
    for (const { session } of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private supervisor(): Promise<AgentViewSupervisorClientHandle> {
    return (this.supervisorPromise ??= ensureAgentViewSupervisor());
  }
}

function descriptorProcessState(
  state: AgentViewSessionSnapshot['state']['processState'],
): AgentSessionDescriptor['processState'] {
  return state === 'hibernating' ? 'alive' : state;
}
