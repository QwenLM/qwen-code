/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AssistantTextProjectionState {
  committedTextInRequest: boolean;
  streamedTextInRequest: boolean;
}

export function createAssistantTextProjectionState(): AssistantTextProjectionState {
  return {
    committedTextInRequest: false,
    streamedTextInRequest: false,
  };
}

export function resetAssistantTextProjection(
  state: AssistantTextProjectionState,
): void {
  state.committedTextInRequest = false;
  state.streamedTextInRequest = false;
}

export function markAssistantTextStreamed(
  state: AssistantTextProjectionState,
): void {
  state.streamedTextInRequest = true;
}

export function markAssistantTextCommitted(
  state: AssistantTextProjectionState,
): void {
  state.committedTextInRequest = true;
}

export function shouldProjectFinalAssistantText(
  state: AssistantTextProjectionState,
): boolean {
  return !state.committedTextInRequest;
}
