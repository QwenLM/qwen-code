/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Serialized UTF-8 size of one card's saved state. */
export const MAX_STATE_BYTES = 16 * 1024;

export type InputValues = Record<string, { value: string; checked: boolean }>;

export interface UiEvent {
  id: string;
  type: 'input' | 'change' | 'click';
  value: string;
  checked: boolean;
}

export interface UiPatch {
  kind: 'text' | 'html' | 'value';
  id: string;
  value: string;
}

export type UiWorkerRequest =
  | {
      type: 'init';
      sequence: number;
      javascript: string;
      inputs: InputValues;
      /** The card's saved state as JSON text, or null when none is saved. */
      state: string | null;
    }
  | { type: 'event'; sequence: number; event: UiEvent; inputs: InputValues };

export type UiWorkerResponse =
  | {
      sequence: number;
      patches: UiPatch[];
      execution: 'initialized' | 'handled' | 'unhandled';
      /** JSON text of the state the round set, when it called ui.state.set. */
      state?: string;
    }
  | { sequence: number; error: string };
