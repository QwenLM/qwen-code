/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { Part } from '@google/genai';
import type { CodeModeDisplay, ToolResult } from '../tools/tools.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import { CODE_MODE_TOOL_NAME } from '../tools/tool-names.js';
import { MAX_READ_TOKENS } from '../utils/constants.js';
import { saveTruncatedToolOutput } from '../utils/fileUtils.js';
import { runLogger } from '../utils/runLogger.js';
import { sessionLogger } from '../utils/sessionLogger.js';
import type { CellSlice, CodeModeCell } from './cells.js';
import type { CodeModeSummary } from './host.js';
import { firstMcpSuccessFields } from '../tools/discovery-stats.js';
import { bucketMcpListResultCount } from '../tools/mcp-lazy/result-buckets.js';
import {
  classifyCodeModeError,
  fitRenderedCodeModeReport,
  isFailedCall,
  limitOutput,
  renderCodeModeReport,
  renderCodeModeReportParts,
  type CodeModeReport,
} from './report.js';
import {
  CODE_MODE_RESULT_TYPE,
  SCRIPT_LIMITS,
  isFailedScriptStatus,
  type ScriptImage,
} from './types.js';

/** Scales each image to the same token budget as MCP and Read images before it reaches the model. */
async function imageParts(images: readonly ScriptImage[]): Promise<Part[]> {
  const { decodeBase64ImageData, processImageBufferWithTokenBudget } =
    await import('../utils/imageReader.js');
  return Promise.all(
    images.map(async (image, index): Promise<Part> => {
      try {
        const processed = await processImageBufferWithTokenBudget(
          decodeBase64ImageData(image.data),
          { maxTokens: MAX_READ_TOKENS, originalMediaType: image.mimeType },
        );
        return {
          inlineData: { mimeType: processed.mediaType, data: processed.base64 },
        };
      } catch (error) {
        return {
          text: `[image ${index + 1} (${image.mimeType}) could not be processed: ${error instanceof Error ? error.message : String(error)}]`,
        };
      }
    }),
  );
}

/**
 * The tool result for one exec/wait/cancel response: the model report within
 * its token budget, the semantic transcript record, the TUI display, all
 * from the same poll slice.
 */
export async function buildCodeModeResult(
  ctx: ToolUseContext,
  cell: CodeModeCell,
  slice: CellSlice,
  maxOutputTokens: number | undefined,
): Promise<ToolResult> {
  const completion = slice.completion;
  const summary: CodeModeSummary = completion?.summary ?? {
    calls: [],
    ...cell.getProgress?.(),
    endsTurn: false,
    newMessages: [],
  };
  const result = completion?.result;
  const children = summary.children ?? [];
  const receipt = cell.callReceipt(summary.calls, children);
  const budget = Math.max(
    SCRIPT_LIMITS.minOutputTokens,
    Math.min(
      maxOutputTokens ?? SCRIPT_LIMITS.defaultOutputTokens,
      SCRIPT_LIMITS.maxOutputTokens,
    ),
  );
  // Delivered with the completion, so a poll boundary cannot detach it.
  const returnValue = result?.returnValue;
  const printed = slice.output.join('\n');
  // The semantic output keeps the return value last, where callers have always
  // seen it, while the report keeps the two apart so truncation can favour it.
  const output = limitOutput(
    returnValue === undefined
      ? printed
      : printed
        ? `${printed}\n${returnValue}`
        : returnValue,
    budget,
  );
  const shownImages = cell.images.length;
  const returnedImages = summary.calls.reduce(
    (sum, call) => sum + (call.images ?? 0),
    0,
  );
  const status = !result
    ? 'running'
    : result.status === 'completed' && summary.stopReason
      ? 'incomplete'
      : result.status;
  const error = result?.error ?? summary.stopReason;
  const silent =
    !cell.output.length && !cell.images.length && returnValue === undefined;
  const report: CodeModeReport = {
    status,
    error,
    errorKind: result?.errorKind,
    limitKind: result?.limitKind,
    cellId: cell.id,
    calls: summary.calls,
    changedCalls: receipt.calls,
    storeError: summary.storeError,
    storeWrites: summary.storeWrites,
    output: printed,
    ...(returnValue === undefined ? {} : { returnValue }),
    ...(result && returnedImages > shownImages
      ? { unshownImages: returnedImages - shownImages }
      : {}),
    ...(result && silent ? { noOutput: true } : {}),
    durationMs: performance.now() - cell.started,
    pendingCalls: result?.pendingCalls,
    fence: randomBytes(8).toString('hex'),
  };
  const rendered = renderCodeModeReportParts(report);
  let outputFile: string | undefined;
  let modelOutput = limitOutput(rendered.text, budget);
  if (modelOutput.truncated) {
    // Persist through the existing host output mechanism; no extra VM capability.
    try {
      ({ outputFile } = await saveTruncatedToolOutput(
        renderCodeModeReport({ ...report, output: cell.output.join('\n') }, true),
        CODE_MODE_TOOL_NAME,
        ctx.callId!,
        ctx.agentLoopContext!.config.storage.getProjectTempDir(),
        ctx.promptId,
      ));
    } catch (error) {
      runLogger.warn('[CodeMode] Unable to persist truncated output', error);
    }
    modelOutput = fitRenderedCodeModeReport(rendered, budget, outputFile);
  }
  const diagnosticErrorKind = classifyCodeModeError(report);
  const semantic = {
    type: CODE_MODE_RESULT_TYPE,
    status,
    output: output.text,
    truncated: modelOutput.truncated,
    error,
    errorKind: result?.errorKind,
    cellId: cell.id,
    calls: receipt.calls,
    callsMode: 'delta',
    rootToolUseId: cell.rootToolUseId,
    totalCalls: summary.calls.length,
    ...(summary.storeError ? { storeError: summary.storeError } : {}),
    ...(result?.pendingCalls?.length
      ? { pendingCalls: result.pendingCalls }
      : {}),
    ...(summary.storeWrites ? { storeWrites: summary.storeWrites } : {}),
    ...(slice.images.length ? { images: slice.images.length } : {}),
    outputFile,
  };
  sessionLogger.event({
    level: 'info',
    kind: 'tool',
    type: status === 'running' ? 'codemode.yielded' : 'codemode.completed',
    ids: {
      session_id: ctx.sessionId,
      turn_id: ctx.promptId,
      tool_call_id: ctx.callId,
    },
    data: {
      status,
      ...(diagnosticErrorKind ? { error_kind: diagnosticErrorKind } : {}),
      duration_ms: Math.round(report.durationMs),
      calls: summary.calls.length,
      failed_calls: summary.calls.filter(isFailedCall).length,
      pending_calls: result?.pendingCalls?.length ?? 0,
      output_bytes: Buffer.byteLength(output.text),
      truncated: modelOutput.truncated,
      ...(summary.search
        ? {
            search_calls: summary.search.calls,
            search_empty: summary.search.resultBuckets.filter(
              (bucket) => bucket === bucketMcpListResultCount(0),
            ).length,
            search_result_buckets: summary.search.resultBuckets,
            search_namespace_calls: summary.search.namespaceCalls,
            search_called_ranks: summary.search.calledRanks,
            ...firstMcpSuccessFields(summary.search.firstMcpSuccess),
          }
        : {}),
      ...(report.unshownImages ? { unshown_images: report.unshownImages } : {}),
    },
  });
  const returnDisplay: CodeModeDisplay = {
    isCodeModeDisplay: true,
    status,
    children: receipt.children,
    totalCalls: children.length,
    summary: [
      error,
      summary.storeError
        ? `Store unavailable: ${summary.storeError}`
        : undefined,
      output.text,
    ]
      .filter(Boolean)
      .join('\n'),
  };
  receipt.commit();
  return {
    llmContent: slice.images.length
      ? [{ text: modelOutput.text }, ...(await imageParts(slice.images))]
      : modelOutput.text,
    returnDisplay,
    toolUseResult: semantic,
    isError: isFailedScriptStatus(status),
    endsTurn: summary.endsTurn,
    newMessages: summary.newMessages,
    ...(outputFile ? { data: { outputFile } } : {}),
  };
}
