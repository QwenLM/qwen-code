/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat } from 'node:fs/promises';
import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { EditTool } from '../tools/edit.js';
import { GlobTool } from '../tools/glob.js';
import { GrepTool } from '../tools/grep.js';
import { LSTool } from '../tools/ls.js';
import { isModifiableDeclarativeTool } from '../tools/modifiable-tool.js';
import { NotebookEditTool } from '../tools/notebook-edit.js';
import { ReadFileTool } from '../tools/read-file.js';
import { ShellTool } from '../tools/shell.js';
import { TaskStopTool } from '../tools/task-stop.js';
import {
  ToolConfirmationOutcome,
  type AnyDeclarativeTool,
  type AnyToolInvocation,
  type ToolCallConfirmationDetails,
  type ToolConfirmationPayload,
  type ToolResult,
  type ToolResultDisplay,
} from '../tools/tools.js';
import { WriteFileTool } from '../tools/write-file.js';
import type {
  ExecutionConfirmation,
  ExecutionEnvironment,
  ExecutionPreparation,
  PreparedExecution,
} from './execution-environment.js';

export function createExecutionTools(
  config: Config,
): Map<string, AnyDeclarativeTool> {
  const tools: AnyDeclarativeTool[] = [
    new ReadFileTool(config),
    new WriteFileTool(config),
    new EditTool(config),
    new NotebookEditTool(config),
    new GlobTool(config),
    new GrepTool(config),
    new LSTool(config),
    new ShellTool(config),
    new TaskStopTool(config),
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

interface PendingExecution {
  invocation: AnyToolInvocation;
  confirmation?: ToolCallConfirmationDetails;
  executing: boolean;
}

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  private readonly tools: Map<string, AnyDeclarativeTool>;
  private readonly invocations = new Map<string, PendingExecution>();
  private readonly controllers = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly config: Config) {
    this.tools = createExecutionTools(config);
  }

  private tool(name: string): AnyDeclarativeTool {
    if (this.disposed) throw new Error('Execution environment is disposed.');
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unsupported execution tool: ${name}`);
    return tool;
  }

  private pending(id: string): PendingExecution {
    if (this.disposed) throw new Error('Execution environment is disposed.');
    const pending = this.invocations.get(id);
    if (!pending) throw new Error(`Unknown execution invocation: ${id}`);
    if (pending.executing) throw new Error(`Invocation is executing: ${id}`);
    return pending;
  }

  async prepare(
    request: ExecutionPreparation,
    signal: AbortSignal,
  ): Promise<PreparedExecution> {
    signal.throwIfAborted();
    const tool = this.tool(request.toolName);
    if (this.invocations.has(request.id))
      throw new Error(`Duplicate invocation: ${request.id}`);
    if (this.invocations.size >= 256)
      throw new Error('Too many pending execution invocations.');
    let params: object = structuredClone(request.params);
    if (request.modification) {
      if (!isModifiableDeclarativeTool(tool))
        throw new Error('Tool does not support modification.');
      params = tool
        .getModifyContext(signal)
        .createUpdatedParams(
          request.modification.oldContent,
          request.modification.newContent,
          params,
        );
    }
    const invocation = tool.build(params);
    this.invocations.set(request.id, { invocation, executing: false });
    return {
      params: invocation.params as Record<string, unknown>,
      description: invocation.getDescription(),
      locations: invocation.toolLocations(),
    };
  }

  async permission(
    id: string,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    signal.throwIfAborted();
    return this.pending(id).invocation.getDefaultPermission(signal);
  }

  async confirmation(
    id: string,
    signal: AbortSignal,
  ): Promise<ExecutionConfirmation> {
    signal.throwIfAborted();
    const pending = this.pending(id);
    const details = await pending.invocation.getConfirmationDetails(signal);
    pending.confirmation = details;
    const { onConfirm: _onConfirm, ...serializable } = details;
    return serializable;
  }

  async confirm(
    id: string,
    outcome: ToolConfirmationOutcome,
    payload: ToolConfirmationPayload | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const pending = this.pending(id);
    await pending.confirmation?.onConfirm(outcome, payload);
    if (outcome === ToolConfirmationOutcome.Cancel) this.invocations.delete(id);
  }

  async execute(
    id: string,
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    signal.throwIfAborted();
    const pending = this.pending(id);
    pending.executing = true;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    try {
      return await pending.invocation.execute(controller.signal, updateOutput, {
        ...this.config.getShellExecutionConfig(),
        streamBufferedOutput: true,
      });
    } finally {
      signal.removeEventListener('abort', abort);
      this.controllers.delete(controller);
      this.invocations.delete(id);
    }
  }

  async modificationContent(
    toolName: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ current: string; proposed: string }> {
    signal.throwIfAborted();
    const tool = this.tool(toolName);
    if (!isModifiableDeclarativeTool(tool))
      throw new Error('Tool does not support modification.');
    const context = tool.getModifyContext(signal);
    const current = await context.getCurrentContent(params);
    const proposed = await context.getProposedContent(params);
    return { current, proposed };
  }

  async release(id: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.invocations.get(id)?.executing) this.invocations.delete(id);
  }

  async invalidateReadCache(paths?: readonly string[]): Promise<void> {
    const cache = this.config.getFileReadCache();
    if (!paths) {
      cache.clear();
      return;
    }
    await Promise.all(
      paths.map(async (filePath) => {
        const stats = await stat(filePath).catch(() => undefined);
        if (!stats || !cache.markReadEvictedFromHistory(stats))
          cache.invalidateByPath(filePath);
      }),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.config.getBackgroundShellRegistry().abortAll();
    this.invocations.clear();
    this.tools.clear();
  }
}
