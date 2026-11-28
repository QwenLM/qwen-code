/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getSupportedReasoningEfforts,
  type ReasoningEffortLevel,
} from '@qwen-code/core';
import { figures } from './figures.js';

/**
 * Every effort level the CLI knows about, weakest first. The catalog does not
 * guarantee an order — `normalizeEffortValues` keeps the server's input order
 * and `getSupportedReasoningEfforts` appends `none` last — so a gauge built
 * straight from the model's list could show "fuller = cheaper". Sort against
 * this before rendering or stepping.
 */
export const ORDERED_EFFORT_LEVELS: readonly ReasoningEffortLevel[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** The model's supported efforts, weakest first. */
export function getOrderedModelEfforts(
  model: EffortCapableModelMetadata,
): ReasoningEffortLevel[] {
  const rank = new Map(
    ORDERED_EFFORT_LEVELS.map((effort, index) => [effort, index] as const),
  );
  return [...getModelEfforts(model)].sort(
    (a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99),
  );
}

/**
 * A fixed-width gauge for a model's reasoning effort, e.g. `■■■□□`.
 *
 * Width is fixed rather than per-model on purpose: models support anywhere
 * from 2 to 6 levels, and a gauge that changes width row to row would leave
 * every column after it ragged. Cells beyond the model's level count are
 * rendered as spaces so the columns stay flush.
 *
 * `none` fills zero cells — disabled thinking is the bottom of the scale — and
 * is excluded from the cell count for the same reason. Counting it would cost a
 * model with all six levels one cell of headroom against a five-wide gauge,
 * clamping `xhigh` and `max` to the same all-filled bar.
 */
export function formatEffortMeter(
  orderedEfforts: readonly ReasoningEffortLevel[],
  current: ReasoningEffortLevel | undefined,
  width: number,
): string {
  if (width <= 0) return '';
  // `none` reads as "off" rather than as the weakest setting, so it is not a
  // rung on the ladder: the scale runs from the weakest *thinking* level up.
  const scale = orderedEfforts.filter((effort) => effort !== 'none');
  if (scale.length === 0) return ' '.repeat(width);
  const cells = Math.min(scale.length, width);
  const index =
    current === undefined || current === 'none' ? -1 : scale.indexOf(current);
  const filled = index < 0 ? 0 : Math.min(cells, index + 1);
  let out = '';
  for (let i = 0; i < cells; i++) {
    out += i < filled ? figures.meterFilled : figures.meterEmpty;
  }
  return out + ' '.repeat(width - cells);
}

export interface EffortCapableModelMetadata {
  efforts?: readonly string[] | null;
  supports_disabled?: boolean | null;
  supportsDisabled?: boolean | null;
  default_effort?: string | null;
  defaultEffort?: string | null;
}

export function getModelEfforts(
  model: EffortCapableModelMetadata,
): ReasoningEffortLevel[] {
  return getSupportedReasoningEfforts(model);
}

export function formatEffortLabel(effort: ReasoningEffortLevel): string {
  if (effort === 'none') return 'Disabled';
  return effort;
}

export function getDefaultReasoningEffort(
  model: EffortCapableModelMetadata,
): ReasoningEffortLevel | undefined {
  const efforts = getModelEfforts(model);
  const raw = model.default_effort ?? model.defaultEffort;
  if (raw && efforts.includes(raw as ReasoningEffortLevel)) {
    return raw as ReasoningEffortLevel;
  }
  return efforts.find((effort) => effort !== 'none');
}

export function formatEffortInline(effort: ReasoningEffortLevel): string {
  return effort === 'none' ? 'disabled' : effort;
}

export function formatDefaultEffortInline(
  model: EffortCapableModelMetadata,
): string | undefined {
  const efforts = getModelEfforts(model);
  const enabledEfforts = efforts.filter((effort) => effort !== 'none');
  const supportsDisabled =
    model.supports_disabled === true || model.supportsDisabled === true;

  if (enabledEfforts.length > 0) {
    const defaultEffort = getDefaultReasoningEffort(model);
    if (defaultEffort === 'none') {
      return 'disabled effort';
    }
    return `${formatEffortInline(defaultEffort ?? enabledEfforts[0])} effort`;
  }

  if (supportsDisabled) {
    return 'enabled effort';
  }

  if (efforts.includes('none')) {
    return 'disabled effort';
  }

  return undefined;
}

export function formatEffortCommandSuffix(
  effort: ReasoningEffortLevel | undefined,
): string {
  if (effort === undefined) return '';
  return effort === 'none'
    ? ' with disabled thinking'
    : ` with ${effort} effort`;
}

export function supportsCurrentReasoningEffort(
  model: EffortCapableModelMetadata | undefined,
  effort: ReasoningEffortLevel | undefined,
): boolean {
  return (
    effort !== undefined && !!model && getModelEfforts(model).includes(effort)
  );
}
