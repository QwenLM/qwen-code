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
import { createQwenAcpAdapter, type QwenAcpAdapterBridge } from './qwen-acp.js';

export interface AgentAdapterContext {
  workspaceCwd: string;
  bridge: QwenAcpAdapterBridge;
  agentId: string;
  /** See `QwenAcpAdapterOptions.permissionVoteContext`. */
  permissionVoteContext?: (
    requestId: string,
  ) => BridgeClientRequestContext | undefined;
}

/**
 * Placeholder for programs whose adapter has not landed yet.
 * TODO(multi-agent): replace with `createClaudeCliAdapter` from
 * `./claude-cli.ts` and `createCodexAppServerAdapter` from
 * `./codex-app-server.ts` (being written in parallel, same `AgentAdapter`
 * interface).
 */
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
      });
    case 'claude':
    case 'codex':
      return unavailableAdapter(program);
    default: {
      const exhaustive: never = program;
      return unavailableAdapter(exhaustive);
    }
  }
}
