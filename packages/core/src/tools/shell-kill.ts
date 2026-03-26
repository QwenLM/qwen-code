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

export interface ShellKillParams {
  pid: number;
  signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT';
}

const shellKillToolSchemaData: FunctionDeclaration = {
  name: ToolNames.SHELL_KILL,
  description:
    'Terminates a running shell process. Use this to stop a background command that is no longer needed.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description:
          'The process ID of the shell session to terminate. This is the PID returned when starting a background command.',
      },
      signal: {
        type: 'string',
        enum: ['SIGTERM', 'SIGKILL', 'SIGINT'],
        description:
          'The signal to send to the process. Default is SIGTERM. Use SIGKILL for force termination.',
      },
    },
    required: ['pid'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};

const shellKillToolDescription = `
Terminates a running shell process that was started with \`run_shell_command\` in background mode.

Use this tool when you need to:
- Stop a background process that is no longer needed
- Terminate a runaway process
- Cancel a long-running operation

**Usage notes**:
- The \`pid\` parameter is required and must match a running background shell session.
- The \`signal\` parameter is optional:
  - \`SIGTERM\` (default): Request graceful termination
  - \`SIGKILL\`: Force immediate termination (cannot be caught by the process)
  - \`SIGINT\`: Interrupt signal (like Ctrl+C)
- On Unix systems, this kills the entire process group, terminating all child processes.
- On Windows, this terminates the process tree.
- This tool only works with processes started via \`run_shell_command\` with \`is_background: true\`.
- If the process has already exited, this tool will return an error.

**Example**:
\`\`\`
// Start a long-running server in background
run_shell_command(command: "npm run dev", is_background: true)
// Returns: Background command started. PID: 12345

// Later, stop the server
shell_kill(pid: 12345)
// Returns: Successfully terminated process with PID 12345

// Or force kill if it doesn't respond
shell_kill(pid: 12345, signal: "SIGKILL")
\`\`\`
`;

class ShellKillToolInvocation extends BaseToolInvocation<
  ShellKillParams,
  ToolResult
> {
  constructor(params: ShellKillParams) {
    super(params);
  }

  getDescription(): string {
    const signal = this.params.signal || 'SIGTERM';
    return `Kill PID ${this.params.pid} with ${signal}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { pid, signal = 'SIGTERM' } = this.params;

    // Check if the session exists
    const sessionInfo = ShellExecutionService.getSessionInfo(pid);
    if (!sessionInfo) {
      return {
        llmContent: `Error: No shell session found with PID ${pid}. The session may have exited and been cleaned up, or never existed.`,
        returnDisplay: `Error: No shell session found with PID ${pid}.`,
      };
    }

    // Check if the session has already exited
    if (sessionInfo.exited) {
      return {
        llmContent: `Error: Shell session with PID ${pid} has already exited. Exit code: ${sessionInfo.exitCode}.`,
        returnDisplay: `Error: Shell session with PID ${pid} has already exited.`,
      };
    }

    // Kill the session
    const success = ShellExecutionService.killSession(pid, signal);

    if (success) {
      return {
        llmContent: `Successfully sent ${signal} signal to shell session with PID ${pid}. The process should terminate shortly.`,
        returnDisplay: `Sent ${signal} to PID ${pid}.`,
      };
    } else {
      return {
        llmContent: `Failed to terminate shell session with PID ${pid}. The process may have already exited or there was an error sending the signal.`,
        returnDisplay: `Failed to kill PID ${pid}.`,
      };
    }
  }
}

export class ShellKillTool extends BaseDeclarativeTool<
  ShellKillParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.SHELL_KILL;

  constructor() {
    super(
      ShellKillTool.Name,
      ToolDisplayNames.SHELL_KILL,
      shellKillToolDescription,
      Kind.Execute,
      shellKillToolSchemaData.parametersJsonSchema as Record<string, unknown>,
    );
  }

  override validateToolParams(params: ShellKillParams): string | null {
    if (typeof params.pid !== 'number' || !Number.isInteger(params.pid)) {
      return 'Parameter "pid" must be an integer number.';
    }

    if (params.pid <= 0) {
      return 'Parameter "pid" must be a positive number.';
    }

    if (
      params.signal !== undefined &&
      !['SIGTERM', 'SIGKILL', 'SIGINT'].includes(params.signal)
    ) {
      return 'Parameter "signal" must be one of: SIGTERM, SIGKILL, SIGINT.';
    }

    return null;
  }

  protected createInvocation(params: ShellKillParams) {
    return new ShellKillToolInvocation(params);
  }
}
