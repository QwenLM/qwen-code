/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HumanPromptInput } from '@qwen-code/qwen-code-core/core/workflow-intent.js';
import { restorePasteDraft } from '../utils/paste-placeholders.js';

export interface OpenTuiRestoredDraft {
  readonly modelText: string;
  readonly displayText: string;
  readonly submittedPrompt: string;
  readonly humanInput?: HumanPromptInput;
  readonly hasUnknownInput: boolean;
  readonly pasteExpansions?: ReadonlyMap<string, string>;
}

export interface OpenTuiInputSubmission {
  text: string;
  imagePaths?: readonly string[];
  submittedPrompt?: string;
  deferUntilIdle?: boolean;
  displayText?: string;
  humanInput?: HumanPromptInput;
  hasUnknownInput?: boolean;
  pasteExpansions?: ReadonlyMap<string, string>;
  restoredDraft?: OpenTuiRestoredDraft;
}

/** Restore queue entries and a successor draft without losing their source. */
export function restoreInputSubmissions(
  entries: readonly OpenTuiInputSubmission[],
  separator = '\n\n',
  pendingPastes: ReadonlyMap<string, string> = new Map(),
): OpenTuiInputSubmission {
  let pasteExpansions = new Map(pendingPastes);
  const drafts = entries.map((entry) =>
    entry.restoredDraft &&
    (entry.displayText ?? entry.text) === entry.restoredDraft.displayText
      ? entry.restoredDraft
      : {
          modelText: entry.text,
          displayText: entry.displayText ?? entry.text,
          submittedPrompt: entry.submittedPrompt ?? entry.text,
          humanInput: entry.humanInput,
          hasUnknownInput: entry.hasUnknownInput ?? !entry.humanInput,
          pasteExpansions: entry.pasteExpansions,
        },
  );
  const displayText = drafts
    .map((draft) => {
      const restored = restorePasteDraft(
        draft.displayText,
        draft.pasteExpansions ?? new Map(),
        pasteExpansions,
      );
      pasteExpansions = restored.pasteExpansions;
      return restored.text;
    })
    .join(separator);
  const humanTexts = drafts.flatMap((draft) =>
    draft.humanInput ? [draft.humanInput.text] : [],
  );
  const submittedPrompt = drafts
    .map((draft) => draft.submittedPrompt)
    .join(separator);
  return {
    text: displayText,
    imagePaths: entries.flatMap((entry) => entry.imagePaths ?? []),
    submittedPrompt,
    deferUntilIdle: entries.every((entry) => entry.deferUntilIdle),
    restoredDraft: {
      displayText,
      modelText: drafts.map((draft) => draft.modelText).join(separator),
      submittedPrompt,
      hasUnknownInput: drafts.some((draft) => draft.hasUnknownInput),
      ...(humanTexts.length
        ? { humanInput: { text: humanTexts.join(separator) } }
        : {}),
      ...(pasteExpansions.size ? { pasteExpansions } : {}),
    },
  };
}

export type OpenTuiCancelSettled = (
  input:
    | {
        kind: 'cancelled';
        queued: OpenTuiInputSubmission | null;
        prompt: OpenTuiInputSubmission | null;
      }
    | { kind: 'reset' },
) => void;

export interface OpenTuiComposerHandle {
  getText(): string;
  setText(text: string): void;
  cancelTurn?(): void;
  submitDraft?(text: string): Promise<void>;
  invalidateImportedInput?(): void;
}
