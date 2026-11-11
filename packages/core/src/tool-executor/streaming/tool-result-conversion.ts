/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { ToolResultBlock } from '../../core/tool-result.js';
import type {
  ToolResultContent,
  ToolResultContentPart,
} from '../../tools/tool-result-message.js';
import type { CompletedToolCall } from '../types.js';
import { CoreToolCallStatus } from '../types.js';
import { isRecord } from '../../utils/markdownUtils.js';
import { isAgentToolCompletionResult } from '../../agents/agent-tool-result.js';
import {
  REJECT_MESSAGE,
  formatUserRejection,
} from '../../protocol/transcript/message-utils.js';
import {
  attachIsHardFailure,
  isHardToolFailure,
} from '../../tools/tool-result-hard-failure.js';
import {
  POWERSHELL_TOOL_NAME,
  resolveToolName,
} from '../../tools/tool-names.js';
import { isMcpToolName } from '../../mcp/tools/mcp-tool.js';
import {
  inlineDataToImagePart,
  fileDataToImagePart,
} from '../../tools/tool-use-result-builder.js';

export function completedToolCallToResult(
  tc: CompletedToolCall,
): ToolResultBlock {
  const toolUseId = tc.request.callId;

  switch (tc.status) {
    case CoreToolCallStatus.Success: {
      // MCP's toolUseResult is the untruncated semantic result; only
      // llmContent went through the token budget, so take model content
      // from responseParts.
      // PowerShell's semantic text includes stderr, background identity and
      // status. Its stdout field alone cannot represent the model result.
      const contentFromData =
        isMcpToolName(tc.request.name) ||
        tc.response.isError === true ||
        resolveToolName(tc.request.name) === POWERSHELL_TOOL_NAME
          ? undefined
          : extractContentFromStructuredToolData(
              tc.response.toolUseResult ?? tc.response.data,
              tc.response.outputFile,
            );
      const rawContent =
        contentFromData ??
        getImageBearingResultMessageContent(tc) ??
        extractResponseContent(tc.response.responseParts ?? []);
      const toolName = tc.request.name;
      const content = isToolResultContentEmpty(rawContent)
        ? `(${toolName} completed with no output)`
        : rawContent;

      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: tc.response.isError === true,
        toolUseResult: tc.response.toolUseResult,
        mcpMeta: tc.response.mcpMeta,
        readOutputReplacement: tc.response.readOutputReplacement,
        toolDenialKind: tc.response.toolDenialKind,
        userFeedback: tc.response.userFeedback,
        diffStat: tc.response.diffStat,
      };
    }

    case CoreToolCallStatus.Error: {
      const errorMsg =
        tc.response.error?.message ?? 'Unknown tool execution error';
      const content =
        tc.response.toolDenialKind === 'user-rejected'
          ? formatUserRejection(tc.response.userFeedback)
          : `Error: ${errorMsg}`;
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: true,
        toolUseResult: withDefaultIsHardFailure(
          tc.response.toolUseResult ?? tc.response.data,
          isHardToolFailure(tc.response.errorType, errorMsg),
        ),
        mcpMeta: tc.response.mcpMeta,
        readOutputReplacement: tc.response.readOutputReplacement,
        toolDenialKind: tc.response.toolDenialKind,
        userFeedback: tc.response.userFeedback,
      };
    }

    case CoreToolCallStatus.Cancelled: {
      const fallbackMsg = REJECT_MESSAGE;
      const parts = tc.response.responseParts ?? [];
      if (parts.length > 0) {
        const extractedContent = extractResponseContent(parts);
        const cancelContent =
          typeof extractedContent === 'string' && extractedContent.trim()
            ? extractedContent
            : fallbackMsg;
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: cancelContent,
          is_error: true,
          toolUseResult: withDefaultIsHardFailure(
            tc.response.toolUseResult ?? tc.response.data,
            false,
          ),
          mcpMeta: tc.response.mcpMeta,
          readOutputReplacement: tc.response.readOutputReplacement,
          toolDenialKind: tc.response.toolDenialKind ?? 'cancelled',
          userFeedback: tc.response.userFeedback,
        };
      }
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: fallbackMsg,
        is_error: true,
        toolUseResult: withDefaultIsHardFailure(
          tc.response.toolUseResult ?? tc.response.data,
          false,
        ),
        mcpMeta: tc.response.mcpMeta,
        readOutputReplacement: tc.response.readOutputReplacement,
        toolDenialKind: tc.response.toolDenialKind ?? 'cancelled',
        userFeedback: tc.response.userFeedback,
      };
    }

    default:
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'Error: unexpected tool completion status',
        is_error: true,
        toolUseResult: attachIsHardFailure(undefined, true),
      };
  }
}

function extractResponseContent(parts: Part[]): ToolResultContent {
  const contentParts: ToolResultContentPart[] = [];
  let hasImages = false;

  for (const part of parts) {
    if (part.inlineData?.data) {
      hasImages = true;
      contentParts.push(inlineDataToImagePart(part.inlineData));
      continue;
    }
    const fileImagePart = part.fileData
      ? fileDataToImagePart(part.fileData)
      : null;
    if (fileImagePart) {
      hasImages = true;
      contentParts.push(fileImagePart);
      continue;
    }
    if (part.functionResponse) {
      const resp = part.functionResponse.response;
      if (typeof resp === 'string') {
        if (resp) contentParts.push({ type: 'text', text: resp });
      } else if (resp) {
        const output = getStringProperty(resp, 'output');
        contentParts.push({
          type: 'text',
          text: output ?? JSON.stringify(resp),
        });
      }
    } else if (part.text !== undefined && part.text !== '') {
      contentParts.push({ type: 'text', text: part.text });
    }
  }

  if (contentParts.length === 0) return '';
  if (!hasImages) {
    return contentParts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
  }
  return contentParts;
}

function getImageBearingResultMessageContent(
  toolCall: CompletedToolCall,
): readonly ToolResultContentPart[] | undefined {
  for (const resultMessage of toolCall.resultMessages ?? []) {
    const message = resultMessage.message;
    if (
      message.type === 'tool_result' &&
      message.toolCallId === toolCall.request.callId &&
      typeof message.content !== 'string' &&
      message.content.some((part) => part.type === 'image')
    ) {
      return message.content;
    }
  }
  return undefined;
}

function extractContentFromStructuredToolData(
  data: unknown,
  outputFile: string | undefined,
): string | undefined {
  if (outputFile) {
    return undefined;
  }

  if (hasStructuredToolFailure(data)) {
    return undefined;
  }

  // Agent tool results carry content directly — prefer it over the
  // lossy responseParts round-trip (llmContent → Part[] → string).
  if (isAgentToolCompletionResult(data)) {
    return data.content;
  }

  if (getStringProperty(data, 'kind') === 'bash_pty') {
    const modelOutput = getStringProperty(data, 'model_output');
    if (modelOutput?.trim()) {
      return modelOutput;
    }
    const stdout = getStringProperty(data, 'stdout');
    return stdout?.trim() ? stdout : undefined;
  }

  // Ordinary shell stdout is only raw data. The finalized response also
  // carries persisted-output paths, execution status and other tool feedback.
  return undefined;
}

function getStringProperty(
  value: unknown,
  property: string,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const propertyValue = value[property];
  return isString(propertyValue) ? propertyValue : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function getNumberProperty(
  value: unknown,
  property: string,
): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const propertyValue = value[property];
  return isNumber(propertyValue) ? propertyValue : undefined;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function getBooleanProperty(
  value: unknown,
  property: string,
): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const propertyValue = value[property];
  return isBoolean(propertyValue) ? propertyValue : undefined;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Whether the raw-output shortcut would drop information. Shell-family tools
 * declare `isError` themselves; the `exitCode`/`signal` reads cover payloads
 * (subagents, workflows) that only carry a raw status. `signal` is read
 * untyped because those payloads are not required to agree on a number or a
 * name — only on whether one is present.
 */
function hasStructuredToolFailure(data: unknown): boolean {
  const kind = getStringProperty(data, 'kind');
  const isError = getBooleanProperty(data, 'isError') === true;
  const interrupted = getBooleanProperty(data, 'interrupted') === true;
  const exitCode = getNumberProperty(data, 'exitCode');
  const signal = isRecord(data) ? data['signal'] : undefined;
  return (
    kind === 'cancelled' ||
    isError ||
    interrupted ||
    (signal !== undefined && signal !== null) ||
    (exitCode ?? 0) !== 0
  );
}

function withDefaultIsHardFailure(
  toolUseResult: unknown,
  defaultValue: boolean,
): unknown {
  if (isRecord(toolUseResult) && isBoolean(toolUseResult['isHardFailure'])) {
    return toolUseResult;
  }
  return attachIsHardFailure(toolUseResult, defaultValue);
}

/**
 * Returns true when tool_result content is empty or effectively empty.
 * Covers: undefined/null, empty string, whitespace-only strings, empty arrays,
 * and arrays whose only blocks are text blocks with empty/whitespace text.
 * Non-text blocks (images) are treated as non-empty.
 */
function isToolResultContentEmpty(
  content: ToolResultContent | undefined,
): boolean {
  if (!content) return true;
  if (typeof content === 'string') return content.trim() === '';
  if (content.length === 0) return true;
  return content.every(
    (part) => part.type === 'text' && part.text.trim() === '',
  );
}
