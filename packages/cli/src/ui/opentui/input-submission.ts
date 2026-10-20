/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OpenTuiInputSubmission {
  text: string;
  imagePaths?: readonly string[];
  submittedPrompt?: string;
  deferUntilIdle?: boolean;
}

export type OpenTuiCancelSettled = (input: {
  queued: OpenTuiInputSubmission | null;
  prompt: OpenTuiInputSubmission | null;
}) => void;

export interface OpenTuiComposerHandle {
  getText(): string;
  setText(text: string): void;
  cancelTurn?(): void;
}
