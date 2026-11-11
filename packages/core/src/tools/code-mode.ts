/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CODE_MODE_DESCRIPTION,
  CODE_MODE_WAIT_DESCRIPTION,
} from '../codemode/description.js';
import { createCodeModeCell, getCodeModeCell } from '../codemode/session.js';
import {
  MODEL_ONLY_HINTS,
  SCRIPT_LIMITS,
  type ScriptResult,
} from '../codemode/types.js';
import { buildCodeModeResult } from '../codemode/result.js';
import type { CodeModeCell } from '../codemode/cells.js';
import type { CodeModeHost, CodeModeSummary } from '../codemode/host.js';
import { getErrorMessage } from '../utils/errors.js';
import { runLogger } from '../utils/runLogger.js';
import { defineDeclarativeTool } from './define-tool.js';
import { Kind, type ToolResult } from './tools.js';
import type { ToolUseContext } from './tool-types.js';
import type { Config } from '../config/config.js';
import { CODE_MODE_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from './tool-names.js';

interface CodeModeParams {
  code: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
}

interface CodeModeWaitParams {
  cell_id: string;
  cancel?: boolean;
  yield_time_ms?: number;
  max_output_tokens?: number;
}

const yieldTime = {
  type: 'integer',
  minimum: 0,
  description: `Milliseconds to wait before returning the current status; default ${SCRIPT_LIMITS.defaultYieldMs}, capped at ${SCRIPT_LIMITS.maxYieldMs}. Does not change the script's execution budget.`,
};
const maxOutputTokens = {
  type: 'integer',
  minimum: 1,
  description: `Token budget for each response, clamped to ${SCRIPT_LIMITS.minOutputTokens}-${SCRIPT_LIMITS.maxOutputTokens}; default ${SCRIPT_LIMITS.defaultOutputTokens}. Oversized output keeps head and tail, favouring the return value; the full-report path is included when saving succeeds.`,
};

const CODE_MODE_PARAMETER_PROPERTIES = {
  code: {
    type: 'string',
    description:
      'JavaScript async function body, without an enclosing function or Markdown fences. Supports top-level await and return.',
  },
  yield_time_ms: yieldTime,
  max_output_tokens: maxOutputTokens,
} satisfies Record<keyof CodeModeParams, unknown>;

const CODE_MODE_WAIT_PARAMETER_PROPERTIES = {
  cell_id: {
    type: 'string',
    description: 'The cell_id CodeMode returned for the running script.',
  },
  cancel: {
    type: 'boolean',
    description: 'Stop the script and its child calls instead of waiting.',
  },
  yield_time_ms: yieldTime,
  max_output_tokens: maxOutputTokens,
} satisfies Record<keyof CodeModeWaitParams, unknown>;

const CODE_MODE_PARAM_NAMES = Object.keys(CODE_MODE_PARAMETER_PROPERTIES);

const errorResult = (message: string): ToolResult => ({
  llmContent: message,
  returnDisplay: message,
  isError: true,
});

/** Undefined when the caller has no agent loop context to own the cell. */
function identity(ctx: ToolUseContext) {
  const loop = ctx.agentLoopContext;
  if (!loop) return undefined;
  return {
    config: loop.config,
    sessionId: ctx.sessionId ?? loop.config.getSessionId(),
    agentId: ctx.agentId ?? loop.agentId,
  };
}

const NO_CONTEXT =
  'CodeMode requires an agent loop context that owns permissions and hooks.';

/** One poll of a cell, shared by exec, wait and cancel. */
async function pollCell(
  ctx: ToolUseContext,
  cell: CodeModeCell,
  params: { yield_time_ms?: number; max_output_tokens?: number },
  cancel: boolean,
): Promise<ToolResult> {
  const yieldMs = Math.min(
    params.yield_time_ms ?? SCRIPT_LIMITS.defaultYieldMs,
    SCRIPT_LIMITS.maxYieldMs,
  );
  const slice = await cell.poll({
    yieldMs,
    signal: ctx.signal,
    onUpdate: ctx.updateOutput,
    cancel,
  });
  cell.deliverHooks(ctx);
  if (slice.completion) await cell.retire();
  const result = await buildCodeModeResult(
    ctx,
    cell,
    slice,
    params.max_output_tokens,
  );
  // A zero-yield spin on a silent cell must still trip the doom-loop guard.
  const progressed =
    yieldMs >= SCRIPT_LIMITS.defaultYieldMs ||
    slice.output.length > 0 ||
    slice.images.length > 0;
  if (!slice.completion && !cancel && progressed) result.repeatNeutral = true;
  return result;
}

/**
 * A failed close must not erase the call receipt: child side effects have landed
 * and the report's `changes:` list is how a retry knows which steps to skip.
 */
async function closeScope(
  host: CodeModeHost,
  result: ScriptResult,
): Promise<CodeModeSummary> {
  try {
    return await host.close(result.status, result.storeWrites);
  } catch (error) {
    runLogger.warn('[CodeMode] Scope close failed', error);
    return {
      ...host.progress(),
      endsTurn: true,
      newMessages: [],
      stopReason: `CodeMode could not finalize its tool scope: ${getErrorMessage(error)}`,
    };
  }
}

export const CodeModeTool = defineDeclarativeTool<
  CodeModeParams,
  ToolResult,
  Config
>({
  name: CODE_MODE_TOOL_NAME,
  displayName: CODE_MODE_TOOL_NAME,
  description: CODE_MODE_DESCRIPTION,
  kind: Kind.Other,
  canUpdateOutput: true,
  // CodeMode applies its own token budget and persists the complete report.
  maxResultSizeChars: Infinity,
  isConcurrencySafe: () => false,
  exposureHints: MODEL_ONLY_HINTS,
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['code'],
    properties: CODE_MODE_PARAMETER_PROPERTIES,
  },
  formatParameterValidationError: (error, params) => {
    if (params === null || typeof params !== 'object' || Array.isArray(params))
      return error;
    // Derive correction from the declared schema, independent of validator wording.
    const unexpected = Object.keys(params).filter(
      (name) => !CODE_MODE_PARAM_NAMES.includes(name),
    );
    if (!unexpected.length) return error;
    return (
      `Unexpected CodeMode top-level field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}. ` +
      `Only ${CODE_MODE_PARAM_NAMES.join(', ')} are accepted. ` +
      (unexpected.includes('cell_id')
        ? `Continue or cancel a running script with ${CODE_MODE_WAIT_TOOL_NAME}.`
        : 'Put child tool arguments such as file_path, old_string and new_string inside the tools.<name>(...) call in code.')
    );
  },
  validateParams: (params) =>
    Buffer.byteLength(params.code) > SCRIPT_LIMITS.codeBytes
      ? `Code exceeds ${SCRIPT_LIMITS.codeBytes / 1024} KiB`
      : null,
  getDescription: () => 'exec CodeMode script',
  execute: async (params, ctx) => {
    const identified = identity(ctx);
    if (!identified) return errorResult(NO_CONTEXT);
    const { config, sessionId, agentId } = identified;
    const existing = getCodeModeCell(config, sessionId, agentId);
    if (existing)
      return errorResult(
        `CodeMode cell ${existing.id} is still running. Call ${CODE_MODE_WAIT_TOOL_NAME} with this cell_id to wait for it, or with cancel: true to stop it, before starting another script.`,
      );
    if (!ctx.queryLifecycle)
      return errorResult(
        'CodeMode requires a query lifecycle to cancel and retire its cells.',
      );
    const cell = createCodeModeCell(
      config,
      sessionId,
      agentId,
      ctx.queryLifecycle,
    );
    cell.rootToolUseId = ctx.callId;
    cell.start(async (running) => {
      const [
        { ScriptRuntime },
        { ToolExecutionScope },
        { CodeModeHost, waitForScriptMcpServers },
      ] = await Promise.all([
        import('../codemode/runtime.js'),
        import('../codemode/scope.js'),
        import('../codemode/host.js'),
      ]);
      // The scope binds the callable tools when it is created.
      await waitForScriptMcpServers(
        config,
        params.code,
        running.controller.signal,
      );
      const host = new CodeModeHost(
        ctx,
        new ToolExecutionScope(
          {
            ...ctx,
            signal: running.controller.signal,
            pendingHookOutputs: running.hookOutputs,
            pendingHookAttachments: running.hookAttachments,
            updateOutput: (output) => running.publish(output),
          },
          running.toolCallScopeId,
        ),
        sessionId,
        agentId,
      );
      running.getProgress = () => host.progress();
      let result: ScriptResult;
      try {
        result = await ScriptRuntime.shared().execute(
          {
            code: params.code,
            ...host.describeTools(),
            signal: host.signal,
            timeoutMs: SCRIPT_LIMITS.cellTimeoutMs,
            onOutput: (text) => running.output.push(text),
            onImage: (image) => running.images.push(image),
          },
          host,
        );
      } catch (error) {
        result = {
          status: 'error',
          output: running.output,
          errorKind: 'runtime_transport',
          error:
            error instanceof Error
              ? error.message.slice(0, 4000)
              : 'Script runtime failed',
        };
      }
      return {
        result,
        summary: await closeScope(host, result),
      };
    });
    return pollCell(ctx, cell, params, false);
  },
});

/** Always registered, removed and declared together with CodeMode. */
export const CodeModeWaitTool = defineDeclarativeTool<
  CodeModeWaitParams,
  ToolResult,
  Config
>({
  name: CODE_MODE_WAIT_TOOL_NAME,
  displayName: CODE_MODE_WAIT_TOOL_NAME,
  description: CODE_MODE_WAIT_DESCRIPTION,
  kind: Kind.Other,
  canUpdateOutput: true,
  maxResultSizeChars: Infinity,
  isConcurrencySafe: () => false,
  exposureHints: { companionOf: CODE_MODE_TOOL_NAME, modelOnly: true },
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['cell_id'],
    properties: CODE_MODE_WAIT_PARAMETER_PROPERTIES,
  },
  validateParams: (params) =>
    params.cell_id ? null : 'cell_id must be the cell_id CodeMode returned',
  getDescription: (params) =>
    `${params.cancel ? 'cancel' : 'wait'} CodeMode script`,
  execute: async (params, ctx) => {
    const identified = identity(ctx);
    if (!identified) return errorResult(NO_CONTEXT);
    const { config, sessionId, agentId } = identified;
    const cell = getCodeModeCell(config, sessionId, agentId);
    if (cell?.id !== params.cell_id)
      return errorResult(
        cell
          ? `Unknown CodeMode cell. This session/agent has cell ${cell.id}; pass that cell_id instead.`
          : 'Unknown CodeMode cell for this session/agent. Cells do not survive a completed query, session reset or process restart.',
      );
    return pollCell(ctx, cell, params, params.cancel === true);
  },
});
