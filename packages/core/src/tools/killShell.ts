/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ShellProcessRegistry } from '../services/shellProcessRegistry.js';

export interface KillShellToolParams {
  shell_id: string;
}

export class KillShellToolInvocation extends BaseToolInvocation<
  KillShellToolParams,
  ToolResult
> {
  constructor(params: KillShellToolParams) {
    super(params);
  }

  getDescription(): string {
    return `Kill background shell process: ${this.params.shell_id}`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    // Kill operations require confirmation
    return 'ask';
  }

  async execute(): Promise<ToolResult> {
    const registry = ShellProcessRegistry.getInstance();
    const shellProcess = registry.getProcess(this.params.shell_id);

    if (!shellProcess) {
      return {
        llmContent: `No shell process found with ID: ${this.params.shell_id}`,
        returnDisplay: `Error: Shell '${this.params.shell_id}' not found. Use /shells to list all shells.`,
      };
    }

    if (shellProcess.status !== 'running') {
      return {
        llmContent: `Shell ${this.params.shell_id} is already ${shellProcess.status}. Command: ${shellProcess.command}`,
        returnDisplay: `Shell '${this.params.shell_id}' is already ${shellProcess.status}.`,
      };
    }

    const success = await registry.killProcess(this.params.shell_id);

    if (success) {
      const runtime = registry.formatRuntime(this.params.shell_id);
      return {
        llmContent: `Shell ${this.params.shell_id} has been killed. Command: ${shellProcess.command}. Runtime: ${runtime}`,
        returnDisplay: `✓ Shell '${this.params.shell_id}' killed successfully. (Ran for ${runtime})`,
      };
    } else {
      return {
        llmContent: `Failed to kill shell ${this.params.shell_id}. The process may have already exited or an error occurred.`,
        returnDisplay: `✗ Failed to kill shell '${this.params.shell_id}'. It may have already exited.`,
      };
    }
  }
}

export class KillShellTool extends BaseDeclarativeTool<
  KillShellToolParams,
  ToolResult
> {
  constructor() {
    super(
      ToolNames.KILL_SHELL,
      ToolDisplayNames.KILL_SHELL,
      'Kill a background shell process by ID',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          shell_id: {
            type: 'string',
            description:
              'The ID of the shell process to kill (e.g., "shell_1")',
          },
        },
        required: ['shell_id'],
      },
    );
  }

  protected createInvocation(
    params: KillShellToolParams,
  ): ToolInvocation<KillShellToolParams, ToolResult> {
    return new KillShellToolInvocation(params);
  }
}
