/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Collects injection sources for one tool_use and emits ordered
 * ToolResultMessage[].
 *
 * Order: pre-hook context → tool_result → post-hook context →
 * supplementary messages → stop. Callers must invoke methods in this order;
 * the builder does not re-sort.
 */

import type {
  ToolResultMessage,
  ContextModifierEntry,
  ToolResultContent,
  ToolResultContentPart,
} from './tool-result-message.js';
import type { NewToolMessage } from './tools.js';
import type {
  PreToolUseHookResult,
  PostToolUseHookResult,
} from './hook-types.js';
import type { ToolUseContext } from './tool-types.js';
import {
  isSupportedImageMediaType,
  normalizeImageMediaType,
  unsupportedImagePlaceholder,
} from '../utils/supportedImageTypes.js';

/**
 * 将工具返回的 inlineData 转为工具域图片或不支持格式的文本占位。
 * Reads fields via property access to avoid unsafe type assertions.
 */
export function inlineDataToImagePart(inlineData: {
  data?: string;
  mimeType?: string;
}): ToolResultContentPart {
  const mediaType = inlineData.mimeType ?? 'image/png';
  if (!isSupportedImageMediaType(mediaType)) {
    return { type: 'text', text: unsupportedImagePlaceholder(mediaType) };
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      mediaType: normalizeImageMediaType(mediaType),
      data: inlineData.data ?? '',
    },
  };
}

export function fileDataToImagePart(fileData: {
  fileUri?: string;
  mimeType?: string;
}): ToolResultContentPart | null {
  if (!fileData.fileUri || !fileData.mimeType) {
    return null;
  }
  if (!isSupportedImageMediaType(fileData.mimeType)) {
    return fileData.mimeType.toLowerCase().startsWith('image/')
      ? {
          type: 'text',
          text: unsupportedImagePlaceholder(fileData.mimeType),
        }
      : null;
  }
  return {
    type: 'image',
    source: {
      type: 'url',
      url: fileData.fileUri,
    },
  };
}

/**
 * Convert PartListUnion (from @google/genai) to the ToolResultContentPart
 * format used in ToolConversationMessage.
 *
 * Handles: string, Part[], single Part object.
 *
 * Exported for use by StreamingToolExecutor and other consumers that
 * need to produce ToolResultMessage content from raw tool output.
 */
export function partListUnionToContent(
  plu: import('@google/genai').PartListUnion,
): ToolResultContent {
  if (typeof plu === 'string') return plu;

  if (Array.isArray(plu)) {
    const parts: ToolResultContentPart[] = [];
    for (const p of plu) {
      if (typeof p === 'string') {
        parts.push({ type: 'text', text: p });
      } else if ('text' in p && typeof p.text === 'string') {
        parts.push({ type: 'text', text: p.text });
      } else if ('inlineData' in p && p.inlineData?.data) {
        parts.push(inlineDataToImagePart(p.inlineData));
      } else if ('fileData' in p && p.fileData) {
        const imagePart = fileDataToImagePart(p.fileData);
        if (imagePart) {
          parts.push(imagePart);
        }
      }
    }
    return parts.length > 0 ? parts : '(no content)';
  }

  // Single Part object
  if (typeof plu === 'object' && plu !== null) {
    if ('text' in plu && typeof plu.text === 'string') return plu.text;
    if ('inlineData' in plu && plu.inlineData?.data) {
      return [inlineDataToImagePart(plu.inlineData)];
    }
    if ('fileData' in plu && plu.fileData) {
      const imagePart = fileDataToImagePart(plu.fileData);
      if (imagePart) {
        return [imagePart];
      }
    }
    return JSON.stringify(plu);
  }

  return String(plu);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class ToolUseResultBuilder {
  private readonly messages: ToolResultMessage[] = [];
  private contextModifierFn:
    | ((ctx: ToolUseContext) => ToolUseContext)
    | undefined;

  constructor(
    private readonly toolCallId: string,
    private readonly toolName: string,
  ) {}

  // -- [1] Pre-hook context (P2 — collected for future system-reminder) --

  /**
   * Inject pre-hook additional context as a hook_context message.
   * Position: before tool_result.
   */
  addPreHookContext(hookResult: PreToolUseHookResult | undefined): this {
    if (!hookResult?.additionalContext) return this;
    this.messages.push({
      message: {
        type: 'hook_context',
        source: `PreToolUse:${this.toolName}`,
        text: hookResult.additionalContext,
      },
    });
    return this;
  }

  // -- [2] Tool result (core) --

  /**
   * Set the primary tool_result message.
   * Position: after pre-hook context, before post-hook context.
   *
   * @param content  - The tool result content (text or structured parts).
   * @param isError  - Whether this result represents an error.
   * @param contextModifier - Optional modifier for the ToolUseContext.
   */
  addToolResult(
    content: ToolResultContent,
    isError: boolean,
    contextModifier?: (ctx: ToolUseContext) => ToolUseContext,
  ): this {
    this.contextModifierFn = contextModifier;

    const modifierEntry: ContextModifierEntry | undefined = contextModifier
      ? { toolCallId: this.toolCallId, modifyContext: contextModifier }
      : undefined;

    this.messages.push({
      message: {
        type: 'tool_result',
        toolCallId: this.toolCallId,
        content,
        isError,
      },
      contextModifier: modifierEntry,
    });
    return this;
  }

  // -- [3] Post-hook context (P2 — collected for future system-reminder) --

  /**
   * Inject post-hook additional contexts as hook_context messages.
   * Position: after tool_result, before newMessages.
   */
  addPostHookContext(hookResult: PostToolUseHookResult | undefined): this {
    return this.pushHookContextMessages(
      'PostToolUse',
      hookResult?.additionalContexts,
    );
  }

  addPostFailureHookContext(additionalContexts: string[] | undefined): this {
    return this.pushHookContextMessages(
      'PostToolUseFailure',
      additionalContexts,
    );
  }

  private pushHookContextMessages(
    sourcePrefix: string,
    additionalContexts: string[] | undefined,
  ): this {
    if (!additionalContexts) return this;
    for (const ctx of additionalContexts) {
      this.messages.push({
        message: {
          type: 'hook_context',
          source: `${sourcePrefix}:${this.toolName}`,
          text: ctx,
        },
      });
    }
    return this;
  }

  // -- [4] Supplementary (newMessages) --

  /**
   * Append supplementary messages from ToolResult.newMessages.
   * Position: after all hook contexts, before stop.
   *
   * These produce independent messages in conversation history. Tool images
   * must already be present in the primary tool_result content.
   */
  addNewMessages(newMessages: NewToolMessage[] | undefined): this {
    if (!newMessages?.length) return this;
    for (const msg of newMessages) {
      const content = partListUnionToContent(msg.content);
      this.messages.push({
        message: {
          type: 'supplementary',
          content,
        },
      });
    }
    return this;
  }

  // -- [5] Stop --

  /**
   * Append a stop message requesting the agent loop to cease inference.
   * Position: last.
   */
  addStop(reason: string): this {
    this.messages.push({
      message: { type: 'stop', reason },
    });
    return this;
  }

  // -- Output --

  /**
   * Produce the final ordered ToolResultMessage[].
   * Returns a defensive copy so the builder can be discarded.
   */
  build(): ToolResultMessage[] {
    return [...this.messages];
  }

  /**
   * Retrieve the context modifier function (if any tool_result carried one).
   * Used by the STE to apply serial context modification without
   * iterating over all messages.
   */
  getContextModifier(): ((ctx: ToolUseContext) => ToolUseContext) | undefined {
    return this.contextModifierFn;
  }
}
