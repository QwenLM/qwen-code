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

export interface ShellSendInputParams {
  pid: number;
  input: string;
}

const shellSendInputToolSchemaData: FunctionDeclaration = {
  name: ToolNames.SHELL_SEND_INPUT,
  description:
    'Sends input to a running shell process. Use this to interact with interactive programs running in a background shell session.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description:
          'The process ID of the shell session to send input to. This is the PID returned when starting a background command.',
      },
      input: {
        type: 'string',
        description:
          'The input string to send to the process. For newlines, use "\\n".',
      },
    },
    required: ['pid', 'input'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};

const shellSendInputToolDescription = `
Sends input to a running shell process that was started with \`run_shell_command\` in background mode.

Use this tool when you need to interact with an interactive program running in a background shell session, such as:
- Responding to prompts from interactive CLI tools
- Providing input to long-running processes
- Sending commands to REPLs or shells running in the background

**Usage notes**:
- The \`pid\` parameter is required and must match a running background shell session.
- The \`input\` parameter is the string to send to the process.
- Use \`\\n\` for newlines (e.g., to submit a command or answer a prompt).
- This tool only works with processes started via \`run_shell_command\` with \`is_background: true\`.
- If the process has already exited, this tool will return an error.

**Example**:
\`\`\`
// Start an interactive program in background
run_shell_command(command: "python3 -i", is_background: true)
// Returns: Background command started. PID: 12345

// Send input to the Python REPL
shell_send_input(pid: 12345, input: "print('Hello, World!')\\n")
\`\`\`
`;

class ShellSendInputToolInvocation extends BaseToolInvocation<
  ShellSendInputParams,
  ToolResult
> {
  constructor(params: ShellSendInputParams) {
    super(params);
  }

  getDescription(): string {
    return `Send input to PID ${this.params.pid}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { pid, input } = this.params;

    // Check if the session exists
    const sessionInfo = ShellExecutionService.getSessionInfo(pid);
    if (!sessionInfo) {
      return {
        llmContent: `Error: No shell session found with PID ${pid}. The session may have exited or never existed.`,
        returnDisplay: `Error: No shell session found with PID ${pid}.`,
      };
    }

    // Check if the session has exited
    if (sessionInfo.exited) {
      return {
        llmContent: `Error: Shell session with PID ${pid} has already exited. Cannot send input to a terminated process.`,
        returnDisplay: `Error: Shell session with PID ${pid} has already exited.`,
      };
    }

    // Send the input
    try {
      ShellExecutionService.writeToPty(pid, input);
      return {
        llmContent: `Successfully sent input to shell session with PID ${pid}.`,
        returnDisplay: `Input sent to PID ${pid}.`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error sending input to shell session with PID ${pid}: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }
}

export class ShellSendInputTool extends BaseDeclarativeTool<
  ShellSendInputParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.SHELL_SEND_INPUT;

  constructor() {
    super(
      ShellSendInputTool.Name,
      ToolDisplayNames.SHELL_SEND_INPUT,
      shellSendInputToolDescription,
      Kind.Execute,
      shellSendInputToolSchemaData.parametersJsonSchema as Record<
        string,
        unknown
      >,
    );
  }

  override validateToolParams(params: ShellSendInputParams): string | null {
    if (typeof params.pid !== 'number' || !Number.isInteger(params.pid)) {
      return 'Parameter "pid" must be an integer number.';
    }

    if (params.pid <= 0) {
      return 'Parameter "pid" must be a positive number.';
    }

    if (typeof params.input !== 'string') {
      return 'Parameter "input" must be a string.';
    }

    return null;
  }

  protected createInvocation(params: ShellSendInputParams) {
    return new ShellSendInputToolInvocation(params);
  }
}
