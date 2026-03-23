/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { FunctionDeclaration } from '@google/genai';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';

export interface ShellProcessStatusParams {
  pid: number;
}

const shellProcessStatusToolSchemaData: FunctionDeclaration = {
  name: ToolNames.SHELL_PROCESS_STATUS,
  description:
    'Gets the status of a shell process. Use this to check if a background command is still running or has exited.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description:
          'The process ID of the shell session to check. This is the PID returned when starting a background command.',
      },
    },
    required: ['pid'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};

const shellProcessStatusToolDescription = `
Gets the status of a shell process that was started with \`run_shell_command\` in background mode.

Use this tool when you need to:
- Check if a background process is still running
- Get the exit code of a completed process
- Determine if a process was terminated by a signal

**Usage notes**:
- The \`pid\` parameter is required and must match a background shell session.
- The response includes:
  - \`running\`: Whether the process is still running
  - \`exitCode\`: The exit code (if the process has exited)
  - \`signal\`: The signal that terminated the process (if applicable)
- This tool only works with processes started via \`run_shell_command\` with \`is_background: true\`.

**Example**:
\`\`\`
// Start a command in background
run_shell_command(command: "npm test", is_background: true)
// Returns: Background command started. PID: 12345

// Check the status
shell_process_status(pid: 12345)
// Returns: { running: false, exitCode: 0, signal: null }
\`\`\`
`;

class ShellProcessStatusToolInvocation extends BaseToolInvocation<
  ShellProcessStatusParams,
  ToolResult
> {
  constructor(params: ShellProcessStatusParams) {
    super(params);
  }

  getDescription(): string {
    return `Check status of PID ${this.params.pid}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { pid } = this.params;

    // Get the process status
    const statusResult = ShellExecutionService.getProcessStatus(pid);

    if (!statusResult) {
      return {
        llmContent: `Error: No shell session found with PID ${pid}. The session may have exited and been cleaned up, or never existed.`,
        returnDisplay: `Error: No shell session found with PID ${pid}.`,
      };
    }

    const { running, exitCode, signal } = statusResult;

    // Build the response
    let statusText: string;
    if (running) {
      statusText = 'still running';
    } else if (signal !== null) {
      statusText = `terminated by signal ${signal}`;
    } else if (exitCode !== null) {
      statusText = `exited with code ${exitCode}`;
    } else {
      statusText = 'status unknown';
    }

    const llmContent = `Shell session with PID ${pid} is ${statusText}.`;

    return {
      llmContent,
      returnDisplay: JSON.stringify(statusResult, null, 2),
    };
  }
}

export class ShellProcessStatusTool extends BaseDeclarativeTool<
  ShellProcessStatusParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.SHELL_PROCESS_STATUS;

  constructor() {
    super(
      ShellProcessStatusTool.Name,
      ToolDisplayNames.SHELL_PROCESS_STATUS,
      shellProcessStatusToolDescription,
      Kind.Execute,
      shellProcessStatusToolSchemaData.parametersJsonSchema as Record<
        string,
        unknown
      >,
    );
  }

  override validateToolParams(params: ShellProcessStatusParams): string | null {
    if (typeof params.pid !== 'number' || !Number.isInteger(params.pid)) {
      return 'Parameter "pid" must be an integer number.';
    }

    if (params.pid <= 0) {
      return 'Parameter "pid" must be a positive number.';
    }

    return null;
  }

  protected createInvocation(params: ShellProcessStatusParams) {
    return new ShellProcessStatusToolInvocation(params);
  }
}
