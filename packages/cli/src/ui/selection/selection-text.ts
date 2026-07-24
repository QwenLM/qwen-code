/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FrameBoundary, ReadonlyFrame } from 'ink';
import type { NormalizedSelection } from './selection-state.js';

/**
 * Extracts the visual text of a selection from a composited frame.
 *
 * Wide-character spacer cells carry an empty value and contribute nothing, so
 * a wide glyph appears once. Non-selectable layout cells are skipped. An
 * unambiguous soft boundary contributes its source joiner instead of a visual
 * newline; hard or ambiguous boundaries retain the newline.
 */
export function getSelectedText(
  frame: ReadonlyFrame | null,
  selection: NormalizedSelection,
): string {
  if (!frame) {
    return '';
  }
  const { sx, sy, ex, ey } = selection;
  let text = '';
  for (let y = sy; y <= ey; y++) {
    const row = frame.cells[y];
    if (!row) {
      if (y < ey) {
        text += '\n';
      }
      continue;
    }
    const startX = y === sy ? sx : 0;
    const endX = y === ey ? ex : row.length - 1;
    for (let x = Math.max(0, startX); x <= endX && x < row.length; x++) {
      if (row[x].selectable) {
        text += row[x].value;
      }
    }
    if (y < ey) {
      text += boundaryJoiner(frame, selection, y);
    }
  }
  return text;
}

function selectedFlows(
  frame: ReadonlyFrame,
  selection: NormalizedSelection,
  y: number,
): Set<number> {
  const row = frame.cells[y] ?? [];
  const startX = y === selection.sy ? selection.sx : 0;
  const endX = y === selection.ey ? selection.ex : row.length - 1;
  const flows = new Set<number>();
  for (let x = Math.max(0, startX); x <= endX && x < row.length; x++) {
    const cell = row[x];
    if (cell.selectable && cell.flowId !== null) {
      flows.add(cell.flowId);
    }
  }
  if (flows.size > 0) {
    return flows;
  }
  for (const boundaryY of [y - 1, y]) {
    const boundaryRow = frame.boundaries[boundaryY] ?? [];
    for (
      let x = Math.max(0, startX);
      x <= endX && x < boundaryRow.length;
      x++
    ) {
      const claim = boundaryRow[x];
      if (claim?.selectable) {
        flows.add(claim.flowId);
      }
    }
  }
  return flows;
}

function boundaryJoiner(
  frame: ReadonlyFrame,
  selection: NormalizedSelection,
  y: number,
): string {
  const currentFlows = selectedFlows(frame, selection, y);
  const nextFlows = selectedFlows(frame, selection, y + 1);
  const [currentFlow] = currentFlows;
  const [nextFlow] = nextFlows;
  if (
    currentFlows.size !== 1 ||
    nextFlows.size !== 1 ||
    currentFlow !== nextFlow
  ) {
    return '\n';
  }

  const flowId = currentFlow!;
  const claims = (frame.boundaries[y] ?? []).filter(
    (claim): claim is FrameBoundary =>
      claim !== null && claim.selectable && claim.flowId === flowId,
  );
  if (claims.length === 0) {
    return '\n';
  }
  const first = claims[0];
  if (
    claims.some(
      (claim) => claim.kind !== first.kind || claim.joiner !== first.joiner,
    )
  ) {
    return '\n';
  }
  return first.kind === 'soft' ? first.joiner : '\n';
}
