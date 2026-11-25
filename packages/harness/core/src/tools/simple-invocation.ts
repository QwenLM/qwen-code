/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SimpleInvocation — lightweight ToolInvocation for stateless tools.
 *
 * Wraps plain callback functions into the ToolInvocation protocol, eliminating
 * boilerplate invocation classes for tools with zero per-call state (Glob, Grep,
 * WebSearch, etc.). For tools with load-bearing state (Shell, Edit), use
 * BaseToolInvocation subclasses instead.
 */

import {
  BaseToolInvocation,
  type ExecuteOptions,
  type ToolLiveOutput,
  type ToolLocation,
  type ToolResult,
} from './tools.js';
import type { ToolUseContext } from './tool-types.js';

export type SimpleExecuteFn<
  TParams extends object,
  TResult extends ToolResult,
> = (params: TParams, ctx: ToolUseContext) => Promise<TResult>;

export interface SimpleInvocationConfig<
  TParams extends object,
  TResult extends ToolResult,
> {
  execute: SimpleExecuteFn<TParams, TResult>;
  getDescription?: (params: TParams) => string;
  getDisplayTitle?: (params: TParams) => string;
  getExplanation?: (params: TParams) => string;
  toolLocations?: (params: TParams) => ToolLocation[];
}

/**
 * Adapts a set of callbacks into the ToolInvocation protocol.
 * Not meant to be subclassed — it's a final wrapper.
 */
export class SimpleInvocation<
  TParams extends object,
  TResult extends ToolResult,
> extends BaseToolInvocation<TParams, TResult> {
  private readonly config: SimpleInvocationConfig<TParams, TResult>;

  constructor(
    params: TParams,
    config: SimpleInvocationConfig<TParams, TResult>,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, toolName, toolDisplayName);
    this.config = config;
  }

  getDescription(): string {
    return this.config.getDescription
      ? this.config.getDescription(this.params)
      : `${this._toolDisplayName || this._toolName || 'Tool'} execution`;
  }

  override getDisplayTitle(): string {
    return this.config.getDisplayTitle
      ? this.config.getDisplayTitle(this.params)
      : this.getDescription();
  }

  override getExplanation(): string {
    return this.config.getExplanation
      ? this.config.getExplanation(this.params)
      : '';
  }

  override toolLocations(): ToolLocation[] {
    return this.config.toolLocations
      ? this.config.toolLocations(this.params)
      : [];
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: ExecuteOptions,
  ): Promise<TResult> {
    const ctx: ToolUseContext = { signal, updateOutput, options };
    return this.config.execute(this.params, ctx);
  }

  /**
   * Override executeWithContext to pass the full upstream ctx directly to the
   * callback, preserving all fields (callId, toolCallScopeId, config, etc.)
   * without the lossy decompose-then-recompose round-trip through execute().
   */
  override executeWithContext(ctx: ToolUseContext): Promise<TResult> {
    return this.config.execute(this.params, ctx);
  }
}
