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

export interface ShellOutputToolParams {
  shell_id: string;
  lines?: number;
  filter?: string;
}

export class ShellOutputToolInvocation extends BaseToolInvocation<
  ShellOutputToolParams,
  ToolResult
> {
  constructor(params: ShellOutputToolParams) {
    super(params);
  }

  getDescription(): string {
    return `View output from background shell: ${this.params.shell_id}`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'allow';
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

    let output: string;

    if (this.params.filter) {
      // Filter output by pattern
      const filteredLines = registry.filterOutput(
        this.params.shell_id,
        this.params.filter,
      );
      output = filteredLines.join('\n');
    } else {
      // Get recent output
      const lines = this.params.lines ?? 50;
      output = registry.getRecentOutput(this.params.shell_id, lines);
    }

    const runtime = registry.formatRuntime(this.params.shell_id);
    const status = shellProcess.status;

    const header = [
      `Shell: ${this.params.shell_id}`,
      `Command: ${shellProcess.command}`,
      `Status: ${status}`,
      `Runtime: ${runtime ?? 'N/A'}`,
      `Working Directory: ${shellProcess.workingDirectory}`,
      '',
      '--- Output ---',
    ].join('\n');

    const fullOutput = output.trim()
      ? `${header}\n${output}`
      : `${header}\n(No output yet)`;

    return {
      llmContent: fullOutput,
      returnDisplay: fullOutput,
    };
  }
}

export class ShellOutputTool extends BaseDeclarativeTool<
  ShellOutputToolParams,
  ToolResult
> {
  constructor() {
    super(
      ToolNames.SHELL_OUTPUT,
      ToolDisplayNames.SHELL_OUTPUT,
      'View output from a background shell process',
      Kind.Read,
      {
        type: 'object',
        properties: {
          shell_id: {
            type: 'string',
            description: 'The ID of the shell process (e.g., "shell_1")',
          },
          lines: {
            type: 'number',
            description: 'Number of recent lines to retrieve (default: 50)',
          },
          filter: {
            type: 'string',
            description: 'Optional regex pattern to filter output lines',
          },
        },
        required: ['shell_id'],
      },
    );
  }

  protected createInvocation(
    params: ShellOutputToolParams,
  ): ToolInvocation<ShellOutputToolParams, ToolResult> {
    return new ShellOutputToolInvocation(params);
  }
}
