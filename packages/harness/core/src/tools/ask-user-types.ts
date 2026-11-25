/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types for the ask_user tool's question/answer schema.
 */

export interface QuestionOption {
  label: string;
  description: string;
  /** Optional preview content rendered when this option is focused. */
  preview?: string;
}

export interface QuestionAnnotation {
  /** The preview content of the selected option, if the question used previews. */
  preview?: string;
  /** Free-text notes the user added to their selection. */
  notes?: string;
}

/** A permission host may return multiple selections before normalization. */
export type QuestionAnswer = string | string[];

/**
 * Answer value submitted when the user provides notes without selecting an
 * option. Shared so the dialog and tool agree on this wire contract.
 */
export const NOTES_ONLY_ANSWER = '(notes only)';

export interface Question {
  question: string;
  header: string;
  /** The available choices for this question. Must have 2-4 options. */
  options: QuestionOption[];
  /** Set to true to allow the user to select multiple options instead of just one. */
  multiSelect?: boolean;
}
