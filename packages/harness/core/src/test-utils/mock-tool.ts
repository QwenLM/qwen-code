/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolLiveOutput,
  type ToolResult,
  type ExecuteOptions,
} from '../tools/tools.js';
interface MockToolOptions {
  name: string;
  displayName?: string;
  description?: string;
  canUpdateOutput?: boolean;
  isOutputMarkdown?: boolean;
  execute?: (
    params: { [key: string]: unknown },
    signal?: AbortSignal,
    updateOutput?: (output: string) => void,
    options?: ExecuteOptions,
  ) => Promise<ToolResult>;
  params?: object;
}

class MockToolInvocation extends BaseToolInvocation<
  { [key: string]: unknown },
  ToolResult
> {
  constructor(
    private readonly tool: MockTool,
    params: { [key: string]: unknown },
  ) {
    super(params, tool.name, tool.displayName);
  }

  execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: ExecuteOptions,
  ): Promise<ToolResult> {
    return this.tool.execute(
      this.params,
      signal,
      updateOutput as ((output: string) => void) | undefined,
      options,
    );
  }

  getDescription(): string {
    return `A mock tool invocation for ${this.tool.name}`;
  }
}

/**
 * A highly configurable mock tool for testing purposes.
 */
export class MockTool extends BaseDeclarativeTool<
  { [key: string]: unknown },
  ToolResult
> {
  readonly execute: (
    params: { [key: string]: unknown },
    signal?: AbortSignal,
    updateOutput?: (output: string) => void,
    options?: ExecuteOptions,
  ) => Promise<ToolResult>;

  constructor(options: MockToolOptions) {
    super(
      options.name,
      options.displayName ?? options.name,
      options.description ?? options.name,
      Kind.Other,
      options.params,
      options.isOutputMarkdown ?? false,
      options.canUpdateOutput ?? false,
    );

    if (options.execute) {
      this.execute = options.execute;
    } else {
      this.execute = () =>
        Promise.resolve({
          llmContent: `Tool ${this.name} executed successfully.`,
          returnDisplay: `Tool ${this.name} executed successfully.`,
        });
    }
  }

  protected createInvocation(
    params: { [key: string]: unknown },
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<{ [key: string]: unknown }, ToolResult> {
    return new MockToolInvocation(this, params);
  }
}
