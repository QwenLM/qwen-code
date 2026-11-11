/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getFileStateResult,
  markFileStateResultPartial,
  isSameFileContent,
} from '../utils/fileStateCache.js';
import { readFileWithMetadata } from '../utils/fileWriteUtils.js';
import { statSync } from 'node:fs';

import {
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  EDIT_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../tools/tool-names.js';
import {
  HookEventName,
  truncateHookOutput,
  formatBlockingAttribution,
  type McpToolContext,
} from '../hooks/types.js';
import type { Config } from '../config/config.js';
import type {
  ToolResult,
  AnyDeclarativeTool,
  AnyToolInvocation,
} from '../tools/tools.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { DiscoveredMCPToolInvocation } from '../mcp/tools/mcp-tool.js';
import { runLogger } from '../utils/runLogger.js';
import { partToString } from '../utils/partUtils.js';
import { isCancelledError } from '../tools/abort-utils.js';
import {
  HookBlockingErrorAttachment,
  HookStoppedContinuationAttachment,
} from '../attachments/types.js';
import {
  appendHookNotice,
  appendToLlmContent,
  isToolResultFailure,
} from '../tools/tool-result-utils.js';


import { projectToolOutputReplacementToLlmContent } from '../tools/tool-output-replacement.js';
import { removeFileWriteFeedback } from '../tools/file-write-feedback.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function applyHookToolOutputReplacement(
  toolResult: ToolResult,
  replacement: unknown,
): void {
  const llmContent = projectToolOutputReplacementToLlmContent(replacement);
  removeFileWriteFeedback(toolResult);
  toolResult.llmContent = llmContent;
  toolResult.toolUseResult = replacement;
  // CodeMode must consume the replacement, never the original protocol payload.
  delete toolResult.mcpResult;
  toolResult.data = isRecord(replacement) ? replacement : undefined;
  // Display must follow the replacement too, otherwise the live view keeps the
  // pre-replacement text while a resumed session projects the new result.
  // Verbose keeps non-text parts visible as placeholders instead of collapsing
  // an image-only replacement to an empty display.
  toolResult.returnDisplay = partToString(llmContent, { verbose: true });
}

function createStopContinuationAttachment(
  message: string,
  hookEvent: string,
  toolName: string,
  toolUseID: string,
): HookStoppedContinuationAttachment {
  return new HookStoppedContinuationAttachment({
    type: 'hook_stopped_continuation',
    message,
    hookName: `${hookEvent}:${toolName}`,
    toolUseID,
    hookEvent,
  });
}

/**
 * Blocking feedback carrier for post-execution hooks.
 *
 * `hookResultsToAttachments()` deliberately skips exit-code-2 results
 * ("handled upstream (blockingError path)"), so the blocking path owns the
 * hook_blocking_error attachment. The attachment is normalized into a
 * model-visible <system-reminder> and rendered in the TUI, which lets the
 * block travel alongside the tool result instead of replacing it.
 */
function createBlockingErrorAttachment(
  message: string,
  hookEvent: string,
  toolName: string,
  toolUseID: string,
  hookCommand?: string,
): HookBlockingErrorAttachment {
  return new HookBlockingErrorAttachment({
    type: 'hook_blocking_error',
    blockingError: {
      blockingError: message,
      command: hookCommand ?? '',
    },
    hookName: `${hookEvent}:${toolName}`,
    toolUseID,
    hookEvent,
  });
}

/**
 * Best-effort firing of PostToolUseFailure hook. Swallows errors so callers
 * don't need duplicated try/catch blocks.
 */
async function firePostToolUseFailureSafe(
  hookSystem: NonNullable<ReturnType<Config['getHookSystem']>>,
  toolName: string,
  toolInput: Record<string, unknown>,
  errorMessage: string,
  toolUseId: string,
  errorType: ToolErrorType | undefined,
  mcpContext: McpToolContext | undefined,
  originalRequestName: string | undefined,
  signal?: AbortSignal,
  model?: string,
): Promise<
  | {
      additionalContext?: string;
      systemMessage?: string;
      shouldStop?: boolean;
      blocked?: boolean;
      blockReason?: string;
      pendingAttachments?: Array<
        import('../attachments/types.js').HookAttachment
      >;
    }
  | undefined
> {
  try {
    const result = await hookSystem.firePostToolUseFailureEvent(
      toolName,
      toolInput,
      errorMessage,
      toolUseId,
      errorType,
      mcpContext,
      originalRequestName,
      signal,
      model,
    );
    const finalOutput = result?.finalOutput;
    const additionalContext = finalOutput?.getAdditionalContext();
    const systemMessage = finalOutput?.systemMessage;
    const shouldStop = finalOutput?.shouldStopExecution() || false;
    const blockingError = finalOutput?.getBlockingError();
    const blocked = blockingError?.blocked || false;
    const blockReason = blockingError?.reason;
    const pendingAttachments = result?.pendingAttachments;

    if (
      additionalContext ||
      systemMessage ||
      shouldStop ||
      blocked ||
      pendingAttachments?.length
    ) {
      return {
        additionalContext,
        systemMessage,
        shouldStop,
        blocked,
        blockReason,
        pendingAttachments,
      };
    }
    return undefined;
  } catch (hookError) {
    runLogger.debug(`PostToolUseFailure hook error: ${hookError}`);
    return undefined;
  }
}

/**
 * Extracts MCP context from a tool invocation if it's an MCP tool.
 *
 * @param invocation The tool invocation
 * @param config Config to look up server details
 * @returns MCP context if this is an MCP tool, undefined otherwise
 */
export function extractMcpContext(
  invocation: AnyToolInvocation,
  config: Config,
): McpToolContext | undefined {
  if (!(invocation instanceof DiscoveredMCPToolInvocation)) {
    return undefined;
  }

  // Get the server config
  const mcpServers =
    config.getMcpClientManager()?.getMcpServers() ??
    config.getMcpServers() ??
    {};
  const serverConfig = mcpServers[invocation.serverName];
  if (!serverConfig) {
    return undefined;
  }

  return {
    server_name: invocation.serverName,
    tool_name: invocation.serverToolName,
    // Non-sensitive connection details only
    command: serverConfig.command,
    args: serverConfig.args,
    cwd: serverConfig.cwd,
    url: serverConfig.url ?? serverConfig.httpUrl,
    tcp: serverConfig.tcp,
  };
}

/**
 * Execute a tool with PostToolUse / PostToolUseFailure hooks.
 *
 * PreToolUse hooks are NOT fired here — they are evaluated earlier by
 * the STE's preExecutionGate (see evaluatePreToolUseHook in
 * hooks/preToolUseEvaluation.ts and createSTEPreExecutionGate in
 * ste-bridge.ts). This function only handles the execution and
 * post-execution hook lifecycle.
 *
 * @param invocation The tool invocation to execute
 * @param toolName The name of the tool
 * @param ctx Unified execution context (signal, updateOutput, options, config, etc.)
 * @param tool The declarative tool definition
 * @param config Config to look up MCP server details for hook context
 * @param originalRequestName Original tool name before aliasing
 * @param toolUseId Unique identifier for this tool use
 * @returns The tool result
 */
export async function executeToolWithHooks(
  invocation: AnyToolInvocation,
  toolName: string,
  ctx: ToolUseContext,
  tool: AnyDeclarativeTool,
  config?: Config,
  originalRequestName?: string,
  toolUseId?: string,
): Promise<ToolResult> {
  const toolInput = (invocation.params || {}) as Record<string, unknown>;

  // Extract MCP context if this is an MCP tool (only if config is provided)
  const isMcpInvocation = invocation instanceof DiscoveredMCPToolInvocation;
  const mcpContext = config ? extractMcpContext(invocation, config) : undefined;
  const hookSystem = config?.getHookSystem();
  // Execute the actual tool via the unified context entry point.
  // BaseToolInvocation.executeWithContext() defaults to delegating to
  // execute(signal, updateOutput, options) for unmigrated tools.
  // Fall back to execute() for invocations that don't implement executeWithContext.
  let toolResult: ToolResult;
  try {
    toolResult =
      typeof invocation.executeWithContext === 'function'
        ? await invocation.executeWithContext(ctx)
        : await invocation.execute(ctx.signal, ctx.updateOutput, ctx.options);
  } catch (executionError) {
    const cancelled = isCancelledError(executionError, ctx.signal);
    // A cancelled tool is not a "failure" that hooks should react to.
    if (hookSystem && !cancelled) {
      const errorMessage =
        executionError instanceof Error
          ? executionError.message
          : String(executionError);
      const failureResult = await firePostToolUseFailureSafe(
        hookSystem,
        toolName,
        toolInput,
        errorMessage,
        toolUseId || '',
        undefined,
        mcpContext,
        originalRequestName,
        ctx.signal,
        ctx.modelKey,
      );
      if (failureResult?.additionalContext && ctx.pendingHookOutputs) {

        ctx.pendingHookOutputs.push({
          hookEventName: HookEventName.PostToolUseFailure,
          output: truncateHookOutput(failureResult.additionalContext),
          sourceType: 'additionalContext',
          toolName,
        });
      }
      if (
        failureResult?.pendingAttachments?.length &&
        ctx.pendingHookAttachments
      ) {
        ctx.pendingHookAttachments.push(...failureResult.pendingAttachments);
      }
    }
    throw executionError;
  }

  const isFailureResult = isToolResultFailure(toolResult);

  // Semantic tool errors are failures too: preserve their model-facing content,
  // but run the same hook lifecycle as thrown/hard failures.
  if (isFailureResult && hookSystem && !ctx.signal.aborted) {
    // Semantic failures carry the whole model-facing output, which can be tens
    // of KB; hook stdin gets the same cap as every other hook payload here.
    const failureMessage = truncateHookOutput(
      toolResult.error?.message ||
        partToString(toolResult.llmContent, { verbose: true }) ||
        `${toolName} reported a failure`,
    );
    const failureHookResult = await firePostToolUseFailureSafe(
      hookSystem,
      toolName,
      toolInput,
      failureMessage,
      toolUseId || '',
      toolResult.error?.type,
      mcpContext,
      originalRequestName,
      ctx.signal,
      ctx.modelKey,
    );

    // Check stop/block decisions first — these return fresh results,
    // so appending context beforehand would be wasted work.
    if (failureHookResult?.shouldStop) {
      const reason =
        failureHookResult.blockReason ||
        'PostToolUseFailure hook requested stop';
      if (ctx.pendingHookAttachments) {
        ctx.pendingHookAttachments.push(
          createStopContinuationAttachment(
            reason,
            'PostToolUseFailure',
            toolName,
            toolUseId || '',
          ),
        );
      }
    }

    if (failureHookResult?.blocked) {
      const reason =
        failureHookResult.blockReason || 'PostToolUseFailure hook blocked';
      return {
        llmContent: `Tool failure result blocked: ${reason}`,
        returnDisplay: `Tool failure result blocked: ${reason}`,
        error: {
          type: ToolErrorType.EXECUTION_FAILED,
          message: reason,
        },
      };
    }

    if (failureHookResult?.additionalContext && ctx.pendingHookOutputs) {

      ctx.pendingHookOutputs.push({
        hookEventName: HookEventName.PostToolUseFailure,
        output: truncateHookOutput(failureHookResult.additionalContext),
        sourceType: 'additionalContext',
        toolName,
      });
    }
    if (
      failureHookResult?.pendingAttachments?.length &&
      ctx.pendingHookAttachments
    ) {
      ctx.pendingHookAttachments.push(...failureHookResult.pendingAttachments);
    }
  }

  // Only fire PostToolUse for successful tool calls;
  // failed calls already triggered PostToolUseFailure above.
  if (hookSystem && !isFailureResult) {
    const fileWrite = toolResult.fileWrite;
    const postToolFileWrite = fileWrite
      ? {
          file_path: fileWrite.filePath,
          workspace_path: fileWrite.workspacePath,
          original_content: fileWrite.originalContent,
          proposed_content: fileWrite.proposedContent,
          written_content: fileWrite.writtenContent,
          ...(ctx.parentBusinessInfo?.id
            ? { business_id: ctx.parentBusinessInfo.id }
            : {}),
          ...(ctx.parentRequestSetId
            ? { request_set_id: ctx.parentRequestSetId }
            : {}),
          ...(ctx.parentBusinessInfo?.orphan !== undefined
            ? { orphan: ctx.parentBusinessInfo.orphan }
            : {}),
          ...(ctx.parentBusinessInfo?.product
            ? { product: String(ctx.parentBusinessInfo.product).toLowerCase() }
            : {}),
          ...(ctx.parentBusinessInfo?.type
            ? { scenario: String(ctx.parentBusinessInfo.type).toLowerCase() }
            : {}),
        }
      : undefined;
    const postResult = await hookSystem.firePostToolUseEvent(
      toolName,
      toolInput,
      toolResult.toolUseResult ?? toolResult.data ?? {},
      toolUseId || '',
      mcpContext,
      originalRequestName,
      ctx.signal,
      ctx.modelKey,
      postToolFileWrite,
    );

    const afterOutput = postResult?.finalOutput;
    const changedByHook =
      toolName === EDIT_TOOL_NAME || toolName === WRITE_FILE_TOOL_NAME
        ? synchronizeHookFileState(
            toolResult,
            postResult?.hooksSkipped === true,
          )
        : undefined;

    // Push hook attachments (errors, system messages) for TUI display
    if (postResult?.pendingAttachments?.length && ctx.pendingHookAttachments) {
      ctx.pendingHookAttachments.push(...postResult.pendingAttachments);
    }

    // Check if hook requested to stop agent continuation.
    // Do NOT replace the tool result — let the original output pass through
    // so conversation history stays accurate. Signal stop via attachment.
    if (afterOutput?.shouldStopExecution()) {
      const reason = afterOutput.getEffectiveReason();
      if (ctx.pendingHookAttachments) {
        ctx.pendingHookAttachments.push(
          createStopContinuationAttachment(
            reason,
            'PostToolUse',
            toolName,
            toolUseId || '',
          ),
        );
      }
    }

    // Check if hook blocked the tool result.
    // Do NOT replace the tool result — the tool already ran and its side
    // effects already happened, so the model needs the real output to reason
    // about what changed. The block travels through the hook_blocking_error
    // attachment (same channel as the shouldStop path above, model-visible
    // <system-reminder> + TUI row) and the result passes through untouched.
    const blockingError = afterOutput?.getBlockingError();
    let inlineBlockingFallback: string | undefined;
    if (blockingError?.blocked) {
      const attribution = formatBlockingAttribution(
        blockingError,
        'Tool result blocked',
      );
      const msg = `${attribution}: ${blockingError.reason}`;
      if (ctx.pendingHookAttachments) {
        ctx.pendingHookAttachments.push(
          createBlockingErrorAttachment(
            msg,
            'PostToolUse',
            toolName,
            toolUseId || '',
            blockingError.hookCommand,
          ),
        );
      } else {
        // Keep a last-resort carrier for query entry points that cannot provide
        // an attachment channel. Apply it after output replacement below so a
        // valid updatedToolOutput cannot erase the blocking feedback.
        inlineBlockingFallback = `\n\n[System] ${msg}`;
      }
    }

    // Check if the hook provided a replacement tool output.
    // updatedToolOutput works for all tools; updatedMCPToolOutput is MCP-only (legacy).
    const updatedToolOutput = afterOutput?.getUpdatedToolOutput();
    const updatedMCPToolOutput = afterOutput?.getUpdatedMCPToolOutput();
    const replacement =
      updatedToolOutput !== undefined
        ? updatedToolOutput
        : isMcpInvocation && updatedMCPToolOutput !== undefined
          ? updatedMCPToolOutput
          : undefined;
    if (replacement !== undefined) {
      // Do not infer an output schema from this particular runtime result.
      // Hook transports expose JSON values (which cannot retain object fields
      // set to undefined), and built-in tools do not yet declare a common
      // output schema against which a replacement could be validated.
      if (toolName === READ_FILE_TOOL_NAME || toolName === SHELL_TOOL_NAME)
        markFileStateResultPartial(toolResult, toolName === READ_FILE_TOOL_NAME);
      if (toolName === READ_FILE_TOOL_NAME) {
        const read = getFileStateResult(toolResult);
        if (read) toolResult.readOutputReplacement = read.path;
      }
      applyHookToolOutputReplacement(toolResult, replacement);
    }

    // Check if hook requested to suppress output display
    if (afterOutput?.suppressOutput) {
      toolResult.returnDisplay = '[Output suppressed by hook]';
    }

    const postAdditionalContext = afterOutput?.getAdditionalContext();
    if (postAdditionalContext && ctx.pendingHookOutputs) {

      ctx.pendingHookOutputs.push({
        hookEventName: HookEventName.PostToolUse,
        output: truncateHookOutput(postAdditionalContext),
        sourceType: 'additionalContext',
        toolName,
      });
    }

    if (changedByHook)
      appendHookNotice(toolResult, changedByHook.trim(), changedByHook);
    if (inlineBlockingFallback) {
      toolResult.llmContent = appendToLlmContent(toolResult.llmContent, inlineBlockingFallback);
    }
  }

  return toolResult;
}

function synchronizeHookFileState(
  result: ToolResult,
  hooksSkipped: boolean,
): string | undefined {
  const effect = getFileStateResult(result);
  if (!effect || effect.cache.get(effect.path) !== effect.state) {
    removeFileWriteFeedback(result);
    return;
  }
  // No hooks ran: retain the write's baseline without an extra content read.
  if (hooksSkipped) return;
  try {
    const timestamp = Math.floor(statSync(effect.path).mtimeMs);
    // Hooks can change content within the same millisecond or restore mtime.
    const { content } = readFileWithMetadata(effect.path);
    const changed = !isSameFileContent(effect.state, content);
    effect.cache.set(effect.path, {
      ...effect.state,
      content,
      // Reuse verified fingerprints when content is unchanged.
      contentHash: changed ? undefined : effect.state.contentHash,
      contentLength: changed ? undefined : effect.state.contentLength,
      timestamp,
      contentNotInModelContext:
        changed || effect.state.contentNotInModelContext,
    });
    effect.state = effect.cache.get(effect.path)!;
    if (changed) {
      removeFileWriteFeedback(result);
      return '\nA PostToolUse hook changed the file after your edit. The current file baseline was refreshed; read it before relying on surrounding contents.';
    }
  } catch {
    effect.cache.delete(effect.path);
    removeFileWriteFeedback(result);
  }
  return undefined;
}
