/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
    }
  | { type: 'event'; sequence: number; event: UiEvent; inputs: InputValues };

export type UiWorkerResponse =
  | { sequence: number; patches: UiPatch[] }
  | { sequence: number; error: string };
