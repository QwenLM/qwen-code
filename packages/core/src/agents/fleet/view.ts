/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ApprovalMode } from '../../config/config.js';
import type { SerializableConfirmationDetails } from '../../confirmation-bus/types.js';
import type { ToolResultDisplay } from '../../tools/tools.js';
import type { AgentMessage, AgentStatus } from '../runtime/agent-types.js';

export interface AgentSessionView {
  getStatus(): AgentStatus;
  getMessages(): readonly AgentMessage[];
  getPendingApprovals(): ReadonlyMap<string, SerializableConfirmationDetails>;
  getLiveOutputs(): ReadonlyMap<string, ToolResultDisplay>;
  getShellPids(): ReadonlyMap<string, number>;
  getExecutionStartTimes(): ReadonlyMap<string, number>;
  readonly workingDir: string;
  readonly modelId: string;
  onChange(cb: () => void): () => void;

  getLastPromptTokenCount?(): number;
  getLastRoundError?(): string | undefined;
  getApprovalMode?(): ApprovalMode;
  setApprovalMode?(mode: ApprovalMode): void;
}
