/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type {
  ServerGeminiStreamEvent,
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';

export interface DualOutputBridgeLike {
  readonly isConnected: boolean;
  processEvent(event: ServerGeminiStreamEvent): void;
  startAssistantMessage(): void;
  finalizeAssistantMessage(): void;
  emitUserMessage(parts: Part[]): void;
  emitToolResult(
    request: ToolCallRequestInfo,
    response: ToolCallResponseInfo,
  ): void;
  emitPermissionRequest(
    requestId: string,
    toolName: string,
    toolUseId: string,
    input: unknown,
    blockedPath?: string | null,
  ): void;
  emitControlResponse(requestId: string, allowed: boolean): void;
  emitControlError(requestId: string, message: string): void;
  emitSystemMessage(subtype: string, data?: unknown): void;
}

/**
 * React context for the dual output bridge.
 * Provides access to the sidecar JSON event emitter throughout the
 * interactive UI component tree.
 */
export const DualOutputContext = createContext<DualOutputBridgeLike | null>(
  null,
);

/**
 * Hook to access the dual output bridge from any component or hook
 * within the interactive UI.
 *
 * Returns null when dual output is not enabled (no --json-fd or --json-file).
 */
export function useDualOutput(): DualOutputBridgeLike | null {
  return useContext(DualOutputContext);
}
