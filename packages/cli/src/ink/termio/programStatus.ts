/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * OSC 7501 Program Status Protocol encoder.
 *
 * Wire format: ESC ] 7501 ; key=value(:key=value)* ST
 * Free text (title, msg) is base64(UTF-8) so `:` and `;` never break pairs.
 * Always terminated with ST (ESC \) — the clear sequences included — so every
 * report uses the same terminator regardless of terminal.
 */

import { BRAND_CLI_BIN } from '@qwen-code/core';
import { OSC, OSC_PREFIX, ST } from './osc.js';

export type ProgramState = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export type BlockedKind = 'permission' | 'question' | 'auth';

export interface ProgramStatus {
  state: ProgramState;
  /** Child record id. Omitted for the root record. */
  id?: string;
  /** Only sent with `blocked`. */
  kind?: BlockedKind;
  /** 0..100, only sent with `working` / `blocked`. */
  progress?: number;
  title?: string;
  msg?: string;
}

export const PROGRAM_STATUS_APP = BRAND_CLI_BIN;

/** Decoded byte limits from the spec (encoded: 256 / 2732). */
export const PROGRAM_STATUS_TITLE_MAX_BYTES = 192;
export const PROGRAM_STATUS_MSG_MAX_BYTES = 2048;
const ID_MAX_LENGTH = 32;

function sequence(body: string): string {
  return `${OSC_PREFIX}${OSC.PROGRAM_STATUS};${body}${ST}`;
}

/** Feature probe. A supporting terminal replies `OSC 7501 ; ? ... ST`. */
export const PROGRAM_STATUS_QUERY = sequence('?');

/** Remove every record this program reported. */
export const CLEAR_PROGRAM_STATUS = sequence('state=clear');

/**
 * Normalizes an id segment to `[A-Za-z0-9_.+-]{1,32}`. Returns undefined when
 * nothing usable is left.
 */
export function sanitizeProgramStatusId(id: string): string | undefined {
  const cleaned = id.replace(/[^A-Za-z0-9_.+-]/g, '-').slice(0, ID_MAX_LENGTH);
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : undefined;
}

/** Remove one child record (and its descendants). */
export function clearProgramStatusRecord(id: string): string {
  return sequence(`state=clear:id=${id}`);
}

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) to a code point boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * Prepares free text for the wire: control characters (C0, DEL, C1) become
 * spaces, whitespace collapses to one line, then it is cut to `maxBytes`.
 * Returns undefined for text that ends up empty.
 */
export function encodeProgramStatusText(
  text: string,
  maxBytes: number,
): string | undefined {
  const oneLine = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!oneLine) return undefined;
  return Buffer.from(truncateUtf8(oneLine, maxBytes), 'utf8').toString(
    'base64',
  );
}

/** Encodes a full report. Every report replaces its record entirely. */
export function formatProgramStatus(status: ProgramStatus): string {
  const pairs = [`state=${status.state}`];
  if (status.id !== undefined) pairs.push(`id=${status.id}`);
  if (status.state === 'blocked' && status.kind) {
    pairs.push(`kind=${status.kind}`);
  }
  if (
    (status.state === 'working' || status.state === 'blocked') &&
    status.progress !== undefined &&
    Number.isFinite(status.progress)
  ) {
    const progress = Math.min(100, Math.max(0, Math.round(status.progress)));
    pairs.push(`progress=${progress}`);
  }
  pairs.push(`app=${PROGRAM_STATUS_APP}`);
  const title =
    status.title !== undefined
      ? encodeProgramStatusText(status.title, PROGRAM_STATUS_TITLE_MAX_BYTES)
      : undefined;
  if (title) pairs.push(`title=${title}`);
  const msg =
    status.msg !== undefined
      ? encodeProgramStatusText(status.msg, PROGRAM_STATUS_MSG_MAX_BYTES)
      : undefined;
  if (msg) pairs.push(`msg=${msg}`);
  return sequence(pairs.join(':'));
}
