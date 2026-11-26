/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Serialized UTF-8 size of one card's saved state. */
export const MAX_STATE_BYTES = 16 * 1024;

/** UTF-8 size of the text one click can copy or download. */
export const MAX_COPY_BYTES = 16 * 1024;
export const MAX_DOWNLOAD_BYTES = 64 * 1024;
export const MAX_FILENAME_LENGTH = 100;
/** Text types a card can download, with the extension the host gives each. */
export const DOWNLOAD_TYPES: Readonly<Record<string, string>> = {
  'text/csv': '.csv',
  'text/plain': '.txt',
  'application/json': '.json',
  'text/markdown': '.md',
};

/** What a click asks the host to do with the card's current values. */
export type UiEffect =
  | { kind: 'copy'; text: string }
  | { kind: 'download'; filename: string; mimeType: string; text: string };

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export function isUiEffect(value: unknown): value is UiEffect {
  if (!value || typeof value !== 'object') return false;
  const effect = value as Record<string, unknown>;
  const { text } = effect;
  if (typeof text !== 'string' || !text) return false;
  if (effect['kind'] === 'copy')
    return (
      Object.keys(effect).length === 2 && utf8Bytes(text) <= MAX_COPY_BYTES
    );
  const { filename, mimeType } = effect;
  return (
    effect['kind'] === 'download' &&
    Object.keys(effect).length === 4 &&
    typeof filename === 'string' &&
    filename.length > 0 &&
    filename.length <= MAX_FILENAME_LENGTH &&
    typeof mimeType === 'string' &&
    Object.hasOwn(DOWNLOAD_TYPES, mimeType) &&
    utf8Bytes(text) <= MAX_DOWNLOAD_BYTES
  );
}

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
      /** The copy or download the round's click handler asked for. */
      effect?: UiEffect;
    }
  | { sequence: number; error: string };
