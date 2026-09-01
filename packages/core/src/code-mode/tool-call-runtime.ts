/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { FunctionResponsePart, Part } from '@google/genai';

export interface CodeModeImageContent {
  type: 'image';
  mimeType: string;
  data: string;
}

export interface CodeModeToolResult {
  callId: string;
  name: string;
  status: 'success';
  output: string;
  content?: CodeModeImageContent[];
}

export function extractCodeModeImageContent(
  parts: Part[],
): CodeModeImageContent[] | undefined {
  const content: CodeModeImageContent[] = [];
  const appendImage = (part: Part | FunctionResponsePart): void => {
    const inlineData = part.inlineData;
    if (
      inlineData?.mimeType?.toLowerCase().startsWith('image/') &&
      inlineData.data
    ) {
      content.push({
        type: 'image',
        mimeType: inlineData.mimeType,
        data: inlineData.data,
      });
    }
  };

  for (const part of parts) {
    appendImage(part);
    for (const nested of part.functionResponse?.parts ?? []) {
      appendImage(nested);
    }
  }
  return content.length > 0 ? content : undefined;
}

export interface ToolCallRuntimeContext {
  parentCallId: string;
  allowedToolNames?: readonly string[];
  dispatch(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CodeModeToolResult>;
}

const context = new AsyncLocalStorage<ToolCallRuntimeContext>();

export function runWithToolCallRuntime<T>(
  runtime: ToolCallRuntimeContext,
  fn: () => T,
): T {
  return context.run(runtime, fn);
}

export function runWithoutToolCallRuntime<T>(fn: () => T): T {
  return context.exit(fn);
}

export function getToolCallRuntime(): ToolCallRuntimeContext | undefined {
  return context.getStore();
}
