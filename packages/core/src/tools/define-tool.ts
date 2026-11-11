/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Declares a tool from a plain config and returns its constructor.
 * Uses SimpleInvocation under the hood; `execute` returns the tool result.
 */

import type { FunctionDeclaration } from '@google/genai';
import {
  type Kind,
  BaseDeclarativeTool,
  type ToolInvocation,
  type ToolResult,
  type ToolLocation,
} from './tools.js';
import type { InterruptBehavior, ToolUseContext } from './tool-types.js';
import { SimpleInvocation } from './simple-invocation.js';
import type {
  ProgrammaticContract,
  ToolExposureHints,
} from '../codemode/types.js';

/**
 * Configuration for defineDeclarativeTool().
 *
 * @typeParam TParams - Validated parameter type
 * @typeParam TResult - Result type (defaults to ToolResult)
 * @typeParam TDeps - Dependencies injected at construction (e.g., Config)
 */
export interface DefineDeclarativeToolConfig<
  TParams extends object,
  TResult extends ToolResult = ToolResult,
  TDeps = unknown,
> {
  name: string;
  displayName: string;
  description: string;
  kind: Kind;
  parameterSchema: unknown;
  programmatic?: ProgrammaticContract;
  exposureHints?: ToolExposureHints;

  isOutputMarkdown?: boolean;
  canUpdateOutput?: boolean;

  isConcurrencySafe?: (input: TParams | undefined, deps: TDeps) => boolean;
  isDestructive?: (input: TParams | undefined, deps: TDeps) => boolean;
  interruptBehavior?: () => InterruptBehavior;
  /** What auto mode's classifier is shown for this call. */
  toClassifierInput?: (input: TParams, deps: TDeps) => unknown;
  maxResultSizeChars?: number;

  validateParams?: (
    params: TParams,
    deps: TDeps,
    context?: ToolUseContext,
  ) => string | null;
  /** Add tool-specific recovery guidance without weakening schema validation. */
  formatParameterValidationError?: (
    message: string,
    params: TParams,
    deps: TDeps,
  ) => string;

  execute: (
    params: TParams,
    ctx: ToolUseContext,
    deps: TDeps,
  ) => Promise<TResult>;
  getDescription?: (params: TParams, deps: TDeps) => string;
  getDisplayTitle?: (params: TParams, deps: TDeps) => string;
  getExplanation?: (params: TParams, deps: TDeps) => string;
  toolLocations?: (params: TParams, deps: TDeps) => ToolLocation[];
  /** Override for model-specific schema resolution. */
  getSchema?: (modelId: string | undefined, deps: TDeps) => FunctionDeclaration;
}

/**
 * Creates a DeclarativeTool subclass from a plain configuration object.
 * Returns a constructor accepting `(deps: TDeps)`.
 */
export function defineDeclarativeTool<
  TParams extends object,
  TResult extends ToolResult = ToolResult,
  TDeps = unknown,
>(
  config: DefineDeclarativeToolConfig<TParams, TResult, TDeps>,
): new (deps: TDeps) => BaseDeclarativeTool<TParams, TResult> {
  const DefinedTool = class extends BaseDeclarativeTool<TParams, TResult> {
    static readonly Name = config.name;

    override get programmatic(): ProgrammaticContract {
      return config.programmatic ?? super.programmatic;
    }

    override get exposureHints(): ToolExposureHints {
      return config.exposureHints ?? super.exposureHints;
    }

    private readonly deps: TDeps;

    constructor(deps: TDeps) {
      super(
        config.name,
        config.displayName,
        config.description,
        config.kind,
        config.parameterSchema,
        config.isOutputMarkdown ?? true,
        config.canUpdateOutput ?? false,
      );
      this.deps = deps;
    }

    override isConcurrencySafe(input?: TParams): boolean {
      return config.isConcurrencySafe
        ? config.isConcurrencySafe(input, this.deps)
        : super.isConcurrencySafe(input);
    }

    override isDestructive(input?: TParams): boolean {
      return config.isDestructive
        ? config.isDestructive(input, this.deps)
        : super.isDestructive(input);
    }

    override interruptBehavior(): InterruptBehavior {
      return config.interruptBehavior
        ? config.interruptBehavior()
        : super.interruptBehavior();
    }

    override toClassifierInput(input: TParams): unknown {
      return config.toClassifierInput
        ? config.toClassifierInput(input, this.deps)
        : super.toClassifierInput(input);
    }

    override get maxResultSizeChars(): number {
      return config.maxResultSizeChars ?? super.maxResultSizeChars;
    }

    override getSchema(modelId?: string): FunctionDeclaration {
      return config.getSchema
        ? config.getSchema(modelId, this.deps)
        : super.getSchema(modelId);
    }

    protected override validateToolParamValues(
      params: TParams,
      context?: ToolUseContext,
    ): string | null {
      return config.validateParams
        ? config.validateParams(params, this.deps, context)
        : null;
    }

    override validateToolParams(
      params: TParams,
      context?: ToolUseContext,
    ): string | null {
      const error = super.validateToolParams(params, context);
      return error && config.formatParameterValidationError
        ? config.formatParameterValidationError(error, params, this.deps)
        : error;
    }

    protected createInvocation(
      params: TParams,
      toolName?: string,
      toolDisplayName?: string,
    ): ToolInvocation<TParams, TResult> {
      const deps = this.deps;
      return new SimpleInvocation<TParams, TResult>(
        params,
        {
          execute: (p, ctx) => config.execute(p, ctx, deps),
          getDescription: config.getDescription
            ? (p) => config.getDescription!(p, deps)
            : undefined,
          getDisplayTitle: config.getDisplayTitle
            ? (p) => config.getDisplayTitle!(p, deps)
            : undefined,
          getExplanation: config.getExplanation
            ? (p) => config.getExplanation!(p, deps)
            : undefined,
          toolLocations: config.toolLocations
            ? (p) => config.toolLocations!(p, deps)
            : undefined,
        },
        toolName,
        toolDisplayName,
      );
    }
  };

  // Meaningful class name for stack traces
  Object.defineProperty(DefinedTool, 'name', {
    value: `${config.displayName}Tool`,
    writable: false,
  });

  return DefinedTool;
}
