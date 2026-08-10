/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../../config/config.js';
import type {
  AgentRuntime,
  AgentSessionDescriptor,
  AgentSpec,
} from '../../fleet/runtime.js';
import type { AgentSession, ApprovalDecision } from '../../fleet/session.js';
import type { AgentSpawnConfig } from '../../backends/types.js';
import { isTerminalStatus } from '../agent-types.js';
import { InProcessAgentHost } from './in-process-agent-host.js';
import { InProcessSession } from './in-process-session.js';
import { createReadOnlyTeammateToolConfig } from '../subagent-plan-tool-policy.js';

interface SessionState {
  session: InProcessSession;
  spec: AgentSpec;
  lastActivityAt: string;
  waitingFor?: AgentSessionDescriptor['waitingFor'];
}

export class InProcessRuntime implements AgentRuntime {
  readonly kind = 'in-process' as const;

  private readonly host: InProcessAgentHost;
  private readonly sessions = new Map<string, SessionState>();

  constructor(config: Config) {
    this.host = new InProcessAgentHost(config);
  }

  async start(spec: AgentSpec): Promise<AgentSession> {
    let session: InProcessSession | undefined;
    const spawnConfig: AgentSpawnConfig = {
      agentId: spec.agentId,
      command: '',
      args: [],
      cwd: spec.cwd,
      inProcess: {
        agentName: spec.name,
        initialTask: spec.initialTask,
        completeOnIdle: false,
        approvalMode: spec.approvalMode,
        teammateIdentity: spec.identity,
        runtimeConfig: {
          promptConfig: { systemPrompt: spec.systemPrompt },
          modelConfig: spec.modelConfig ?? {},
          runConfig: spec.runConfig ?? {},
          toolConfig: spec.readOnly
            ? createReadOnlyTeammateToolConfig()
            : spec.toolConfig,
        },
      },
    };

    const interactive = await this.host.start(spawnConfig, (created) => {
      session = new InProcessSession(spec.agentId, spec.teamId, created);
      const state: SessionState = {
        session,
        spec,
        lastActivityAt: new Date().toISOString(),
      };
      session.on('status', () => {
        state.lastActivityAt = new Date().toISOString();
      });
      session.on('toolActivity', (event) => {
        state.lastActivityAt = new Date().toISOString();
        if (
          event.phase === 'result' &&
          state.waitingFor?.callId === event.callId
        ) {
          state.waitingFor = undefined;
        }
      });
      session.on('approvalRequest', (event) => {
        state.lastActivityAt = new Date().toISOString();
        state.waitingFor = {
          callId: event.callId,
          toolName: event.toolName,
          summary: event.details.title,
        };
      });
      this.sessions.set(spec.agentId, state);
    });
    if (!interactive || !session) {
      session?.dispose();
      this.sessions.delete(spec.agentId);
      throw new Error(`Failed to start in-process agent "${spec.agentId}".`);
    }
    return session;
  }

  async reattach(agentId: string): Promise<AgentSession | undefined> {
    return this.sessions.get(agentId)?.session;
  }

  async list(teamId?: string): Promise<AgentSessionDescriptor[]> {
    return [...this.sessions.values()]
      .filter((state) => !teamId || state.spec.teamId === teamId)
      .map(({ session, spec, lastActivityAt, waitingFor }) => ({
        agentId: spec.agentId,
        teamId: spec.teamId,
        name: spec.name,
        status: session.getStatus(),
        processState: isTerminalStatus(session.getStatus())
          ? 'exited'
          : 'alive',
        cwd: spec.cwd,
        worktreePath: spec.worktreePath,
        lastActivityAt,
        waitingFor,
      }));
  }

  async stop(agentId: string, _opts?: { graceMs?: number }): Promise<void> {
    this.host.stop(agentId);
  }

  async kill(agentId: string): Promise<void> {
    this.host.stop(agentId);
  }

  async answer(agentId: string, decision: ApprovalDecision): Promise<void> {
    await this.sessions.get(agentId)?.session.answer(decision);
  }

  async dispose(): Promise<void> {
    for (const state of this.sessions.values()) state.session.dispose();
    await this.host.dispose();
    this.sessions.clear();
  }
}
