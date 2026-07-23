/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';
import type { ToolResult } from '../../tools/tools.js';
import { ToolErrorType } from '../../tools/tool-error.js';
import type { CostEstimate, Modality } from './types.js';

/**
 * P0 · Result / error contract (C10) shared by every media tool.
 *
 * This is A-class (必备基建): the *shape* of a media delivery does not change
 * when the reader behind it changes. Two invariants it enforces:
 *
 *  1. **No silent quality loss (零静默降质).** Every delivery must declare what
 *     was delivered this turn (`scope`), at what fidelity (`precision` — e.g.
 *     "downscaled to 768px"), and how to obtain more (`readMore`). A reader that
 *     compresses or samples MUST say so here; logging it is not enough.
 *  2. **Fail-closed errors.** A media read never returns a bare-empty or
 *     silently-degraded result. On failure it returns an error result carrying a
 *     concrete `remedy` (a conversion command, a cheaper alternative, or a path
 *     fix) so the model can recover.
 */

/** Self-describing metadata attached to every successful media delivery. */
export interface MediaDeliveryMeta {
  /** Absolute source path. */
  path: string;
  /** Content-addressed identity (sha256 hex). */
  hash: string;
  modality: Modality;
  /**
   * What was delivered this turn, e.g. "full image (native)" or
   * "frames 0–30s @1fps". The model uses this to know the boundary of what it
   * can currently see.
   */
  scope: string;
  /**
   * Fidelity of this delivery. MUST be non-empty and MUST state any lossy step
   * (downscale/compress/sample). Use "original fidelity" when nothing was lost.
   */
  precision: string;
  /** Estimated cost of this delivery. */
  cost?: CostEstimate;
  /**
   * How to obtain more detail (a finer read, another range, the original
   * bytes). Omit only when the full file was delivered at original fidelity.
   */
  readMore?: string;
  /** Optional extra note, e.g. "recalled from media memory (no re-read)". */
  notes?: string;
}

/** Fail-closed error categories. Each maps to a required remedy. */
export type MediaErrorKind =
  /** Format the active model/reader cannot ingest. */
  | 'unsupported-format'
  /** Delivering this would exceed the token/byte budget. */
  | 'over-budget'
  /** Path missing / not a file / outside the allowlist. */
  | 'path-problem'
  /** No reader is available for this modality (capability gate, fail-closed). */
  | 'no-capability';

export interface MediaErrorInfo {
  kind: MediaErrorKind;
  /** What went wrong, in one sentence. */
  message: string;
  /**
   * Concrete recovery path. Never empty — a media error without a remedy is a
   * silent failure, which this contract forbids.
   */
  remedy: string;
}

const ERROR_TYPE_BY_KIND: Record<MediaErrorKind, ToolErrorType> = {
  'unsupported-format': ToolErrorType.READ_CONTENT_FAILURE,
  'over-budget': ToolErrorType.FILE_TOO_LARGE,
  'path-problem': ToolErrorType.FILE_NOT_FOUND,
  'no-capability': ToolErrorType.EXECUTION_FAILED,
};

/** Render the self-describing `<media_delivery>` note that rides with every result. */
export function formatDeliveryNote(meta: MediaDeliveryMeta): string {
  const lines = [
    `<media_delivery path="${meta.path}" hash="${meta.hash.slice(0, 12)}" modality="${meta.modality}">`,
    `scope: ${meta.scope}`,
    `precision: ${meta.precision}`,
  ];
  if (meta.cost) {
    lines.push(`cost: ${meta.cost.note}`);
  }
  lines.push(`source: ${meta.path}`);
  if (meta.readMore) {
    lines.push(`read_more: ${meta.readMore}`);
  }
  if (meta.notes) {
    lines.push(`notes: ${meta.notes}`);
  }
  lines.push('</media_delivery>');
  return lines.join('\n');
}

/**
 * Wrap reader output (native media parts and/or delegated notes) into a
 * self-describing ToolResult. The delivery note is appended as a trailing text
 * part so the model always sees the scope/precision boundary alongside the media.
 */
export function buildMediaDelivery(
  content: PartListUnion,
  meta: MediaDeliveryMeta,
): ToolResult {
  const parts: Part[] = Array.isArray(content)
    ? content.map((p) => (typeof p === 'string' ? { text: p } : p))
    : typeof content === 'string'
      ? [{ text: content }]
      : [content];
  parts.push({ text: formatDeliveryNote(meta) });

  const displayCost = meta.cost ? `, ${meta.cost.note}` : '';
  return {
    llmContent: parts,
    returnDisplay: `${meta.modality}: ${meta.scope}${displayCost}`,
    resultFilePaths: [meta.path],
  };
}

/**
 * Build a fail-closed error result. The remedy is surfaced to the model in
 * `llmContent` (so it can recover) and the display string.
 */
export function buildMediaError(info: MediaErrorInfo): ToolResult {
  const llmContent =
    `Media read failed (${info.kind}): ${info.message}\n` +
    `To recover: ${info.remedy}`;
  return {
    llmContent,
    returnDisplay: `Media error (${info.kind}): ${info.message}`,
    error: {
      message: info.message,
      type: ERROR_TYPE_BY_KIND[info.kind],
    },
  };
}
