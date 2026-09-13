/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
  ToolLocation,
  ToolResult,
  ToolResultDisplay,
} from '../tools/tools.js';
import { ToolNames } from '../tools/tool-names.js';

export const EXECUTION_TOOL_NAMES = new Set<string>([
  ToolNames.READ_FILE,
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.NOTEBOOK_EDIT,
  ToolNames.GLOB,
  ToolNames.GREP,
  ToolNames.LS,
  ToolNames.SHELL,
  ToolNames.TASK_STOP,
]);

export class ExecutionCleanupError extends Error {}

export interface ExecutionModification {
  oldContent: string;
  newContent: string;
}

export interface ExecutionPreparation {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  modification?: ExecutionModification;
}

export interface PreparedExecution {
  params: Record<string, unknown>;
  description: string;
  locations: ToolLocation[];
}

type WithoutCallback<T> = T extends unknown ? Omit<T, 'onConfirm'> : never;
export type ExecutionConfirmation =
  WithoutCallback<ToolCallConfirmationDetails>;

/** One tool session; the owner must dispose it before releasing its workspace. */
export interface ExecutionEnvironment {
  /** Temporary output store shared with the harness and owned by this session. */
  readonly outputDirectory?: string;
  prepare(
    request: ExecutionPreparation,
    signal: AbortSignal,
  ): Promise<PreparedExecution>;
  permission(id: string, signal: AbortSignal): Promise<PermissionDecision>;
  confirmation(id: string, signal: AbortSignal): Promise<ExecutionConfirmation>;
  confirm(
    id: string,
    outcome: ToolConfirmationOutcome,
    payload: ToolConfirmationPayload | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  execute(
    id: string,
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult>;
  modificationContent(
    toolName: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ current: string; proposed: string }>;
  release(id: string, signal: AbortSignal): Promise<void>;
  invalidateReadCache(paths?: readonly string[]): Promise<void>;
  dispose(): Promise<void>;
}

export type ExecutionEnvironmentFactory = (
  config: Config,
  signal: AbortSignal,
) => Promise<ExecutionEnvironment>;

export type ExecutionWorkerRequest =
  | { method: 'prepare'; request: ExecutionPreparation }
  | {
      method: 'permission' | 'confirmation' | 'execute' | 'release';
      invocationId: string;
    }
  | {
      method: 'confirm';
      invocationId: string;
      outcome: ToolConfirmationOutcome;
      payload?: ToolConfirmationPayload;
    }
  | {
      method: 'modificationContent';
      toolName: string;
      params: Record<string, unknown>;
    }
  | { method: 'invalidateReadCache'; paths?: readonly string[] }
  | { method: 'dispose' };

export interface ExecutionWorkerOptions {
  workspace: string;
  outputDirectory?: string;
  sessionId: string;
  truncateToolOutputLines: number;
  truncateToolOutputThreshold?: number;
  fileReadCacheDisabled: boolean;
  fileFiltering?: ReturnType<Config['getFileFilteringOptions']>;
  defaultFileEncoding?: ReturnType<Config['getDefaultFileEncoding']>;
  shellDefaultTimeoutMs?: number;
  shellHeartbeatIntervalMs?: number;
  maxBufferedOutputBytes?: number;
}

export type ExecutionWorkerMessage =
  | { id: string; request: ExecutionWorkerRequest }
  | { cancel: string };

export type ExecutionWorkerReply =
  | { id: string; result: unknown }
  | { id: string; error: string }
  | { id: string; update: ToolResultDisplay };
