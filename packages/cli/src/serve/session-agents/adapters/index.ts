/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Program → adapter registry for session agents.
 *
 * Every adapter implements the contract's `AgentAdapter`; the orchestrator
 * (and, for remote turns, the Host) picks one by program. Construction takes
 * an {@link AgentAdapterContext} because the `qwen` adapter drives this
 * daemon's own bridge and must know which agent's hidden session it owns.
 */

import type {
  AgentAdapter,
  AgentAdapterTurnResult,
  SessionAgentProgram,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import type { BridgeClientRequestContext } from '../../acp-session-bridge.js';
import { agentProgramExecutable } from '../program-probe.js';
import { createClaudeCliAdapter } from './claude-cli.js';
import { createCodexAppServerAdapter } from './codex-app-server.js';
import {
  createQwenAcpAdapter,
  type QwenAcpAdapterBridge,
  type QwenSessionSendBinding,
} from './qwen-acp.js';

export type { QwenSessionSendBinding } from './qwen-acp.js';

export interface AgentAdapterContext {
  workspaceCwd: string;
  bridge: QwenAcpAdapterBridge;
  agentId: string;
  /** See `QwenAcpAdapterOptions.permissionVoteContext`. */
  permissionVoteContext?: (
    requestId: string,
  ) => BridgeClientRequestContext | undefined;
  /** See `QwenAcpAdapterOptions.sessionSend` (used by the `qwen` adapter). */
  sessionSend?: QwenSessionSendBinding;
}

/** Fallback for a program this build does not know. */
function unavailableAdapter(program: SessionAgentProgram): AgentAdapter {
  return {
    program,
    async runTurn(): Promise<AgentAdapterTurnResult> {
      return {
        status: 'failed',
        outputText: '',
        error: `The ${program} agent program is not yet available.`,
      };
    },
  };
}

export function getAdapter(
  program: SessionAgentProgram,
  context: AgentAdapterContext,
): AgentAdapter {
  switch (program) {
    case 'qwen':
      return createQwenAcpAdapter({
        bridge: context.bridge,
        workspaceCwd: context.workspaceCwd,
        agentId: context.agentId,
        ...(context.permissionVoteContext
          ? { permissionVoteContext: context.permissionVoteContext }
          : {}),
        ...(context.sessionSend ? { sessionSend: context.sessionSend } : {}),
      });
    // The executable is the env override (QWEN_AGENT_CLAUDE_PATH /
    // QWEN_AGENT_CODEX_PATH), else the name resolved on PATH.
    case 'claude': {
      const executable = agentProgramExecutable('claude');
      return createClaudeCliAdapter(executable ? { executable } : {});
    }
    case 'codex': {
      const executable = agentProgramExecutable('codex');
      return createCodexAppServerAdapter(executable ? { executable } : {});
    }
    default: {
      const exhaustive: never = program;
      return unavailableAdapter(exhaustive);
    }
  }
}
