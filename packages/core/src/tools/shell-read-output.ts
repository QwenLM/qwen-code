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

export interface ShellReadOutputParams {
  pid: number;
}

const shellReadOutputToolSchemaData: FunctionDeclaration = {
  name: ToolNames.SHELL_READ_OUTPUT,
  description:
    'Reads the current output from a running shell process. Use this to check the output of a background command.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description:
          'The process ID of the shell session to read output from. This is the PID returned when starting a background command.',
      },
    },
    required: ['pid'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};

const shellReadOutputToolDescription = `
Reads the current output from a running shell process that was started with \`run_shell_command\` in background mode.

Use this tool when you need to:
- Check the output of a long-running background process
- Monitor the progress of a background task
- See what a background command has produced so far

**Usage notes**:
- The \`pid\` parameter is required and must match a running background shell session.
- This tool returns all output that has been produced so far.
- The \`exited\` field in the response indicates whether the process has finished.
- This tool only works with processes started via \`run_shell_command\` with \`is_background: true\`.

**Example**:
\`\`\`
// Start a long-running command in background
run_shell_command(command: "npm run build", is_background: true)
// Returns: Background command started. PID: 12345

// Check the output
shell_read_output(pid: 12345)
// Returns: { output: "Building...", exited: false }
\`\`\`
`;

class ShellReadOutputToolInvocation extends BaseToolInvocation<
  ShellReadOutputParams,
  ToolResult
> {
  constructor(params: ShellReadOutputParams) {
    super(params);
  }

  getDescription(): string {
    return `Read output from PID ${this.params.pid}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { pid } = this.params;

    // Read the output
    const outputResult = ShellExecutionService.readOutput(pid);

    if (!outputResult) {
      return {
        llmContent: `Error: No shell session found with PID ${pid}. The session may have exited and been cleaned up, or never existed.`,
        returnDisplay: `Error: No shell session found with PID ${pid}.`,
      };
    }

    const { output, exited } = outputResult;

    // Build the response
    const statusText = exited ? 'exited' : 'still running';
    const llmContent = `Output from shell session with PID ${pid} (${statusText}):\n\n${output || '(no output)'}`;

    return {
      llmContent,
      returnDisplay: output || '(no output)',
    };
  }
}

export class ShellReadOutputTool extends BaseDeclarativeTool<
  ShellReadOutputParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.SHELL_READ_OUTPUT;

  constructor() {
    super(
      ShellReadOutputTool.Name,
      ToolDisplayNames.SHELL_READ_OUTPUT,
      shellReadOutputToolDescription,
      Kind.Execute,
      shellReadOutputToolSchemaData.parametersJsonSchema as Record<
        string,
        unknown
      >,
    );
  }

  override validateToolParams(params: ShellReadOutputParams): string | null {
    if (typeof params.pid !== 'number' || !Number.isInteger(params.pid)) {
      return 'Parameter "pid" must be an integer number.';
    }

    if (params.pid <= 0) {
      return 'Parameter "pid" must be a positive number.';
    }

    return null;
  }

  protected createInvocation(params: ShellReadOutputParams) {
    return new ShellReadOutputToolInvocation(params);
  }
}
