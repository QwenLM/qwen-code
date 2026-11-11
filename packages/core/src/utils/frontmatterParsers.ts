/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared frontmatter parsing utilities.
 *
 * These stateless functions are used by both agent and skill loaders
 * to parse common frontmatter field types (tools, effort, numbers, etc.).
 */

import {
  parseReasoningEffortLevel,
  reasoningEffortFromThinkingBudget,
  type ReasoningEffortLevel,
} from '../config/model-values.js';

export const FRONTMATTER_REGEX =
  /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/;

// ---------------------------------------------------------------------------
// Effort types
// ---------------------------------------------------------------------------

/**
 * Named effort levels. Aliased to the canonical `ReasoningEffortLevel` from
 * the model-transport layer so the frontmatter parser and the transport
 * stay automatically in sync.
 */
export type EffortLevel = ReasoningEffortLevel;

/** Effort value: either a named level or a positive integer (thinkingBudget). */
export type EffortValue = EffortLevel | number;

// ---------------------------------------------------------------------------
// parseToolListFromCLI
// ---------------------------------------------------------------------------

/**
 * Splits a tool list string by comma AND space, keeping parenthesized
 * expressions intact (e.g. `Agent(worker, researcher)` stays as one item).
 */
export function parseToolListFromCLI(tools: string[]): string[] {
  const result: string[] = [];

  for (const tool of tools) {
    let current = '';
    let depth = 0;

    for (const ch of tool) {
      if (ch === '(') {
        depth++;
        current += ch;
      } else if (ch === ')') {
        depth = Math.max(0, depth - 1);
        current += ch;
      } else if ((ch === ',' || ch === ' ') && depth === 0) {
        const trimmed = current.trim();
        if (trimmed) result.push(trimmed);
        current = '';
      } else {
        current += ch;
      }
    }

    const trimmed = current.trim();
    if (trimmed) result.push(trimmed);
  }

  return result;
}

// ---------------------------------------------------------------------------
// parseToolListString
// ---------------------------------------------------------------------------

/**
 * Unified handler for `string | string[]` tool list inputs.
 * Delegates to `parseToolListFromCLI` for splitting.
 * Handles wildcard `*`.
 *
 * Returns `null` when the input is `undefined/null` (let the caller decide
 * the default), or an array of tool names otherwise.
 */
export function parseToolListString(toolsValue: unknown): string[] | null {
  if (toolsValue === undefined || toolsValue === null) {
    return null;
  }

  if (typeof toolsValue === 'string') {
    if (toolsValue.trim() === '*') return ['*'];
    return parseToolListFromCLI([toolsValue]);
  }

  if (Array.isArray(toolsValue)) {
    const stringItems = toolsValue.filter(
      (item): item is string => typeof item === 'string',
    );
    if (stringItems.length === 0) return null;
    return parseToolListFromCLI(stringItems);
  }

  return null;
}

// ---------------------------------------------------------------------------
// parseAgentToolsFromFrontmatter
// ---------------------------------------------------------------------------

/**
 * Parses the `tools` field from agent frontmatter.
 *
 * Agent semantics: `null/undefined` input → `undefined` (inherit all parent tools).
 */
export function parseAgentToolsFromFrontmatter(
  toolsValue: unknown,
): string[] | undefined {
  const parsed = parseToolListString(toolsValue);
  return parsed ?? undefined;
}

// ---------------------------------------------------------------------------
// parseSlashCommandToolsFromFrontmatter
// ---------------------------------------------------------------------------

/**
 * Parses the `allowed-tools` / `tools` field from skill/slash-command frontmatter.
 *
 * Skill semantics: `null/undefined` input → `[]` (no tools).
 */
export function parseSlashCommandToolsFromFrontmatter(
  toolsValue: unknown,
): string[] {
  return parseToolListString(toolsValue) ?? [];
}

// ---------------------------------------------------------------------------
// parseEffortValue
// ---------------------------------------------------------------------------

/**
 * Parses an effort value from frontmatter.
 *
 * Accepts:
 * - String effort levels: `'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`
 * - Aliases `'off' | 'disabled'` → `'none'`
 * - Positive integers (as number or numeric string) — used directly as thinkingBudget
 *
 * Returns `undefined` for invalid or missing input.
 */
export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'string') {
    const named = parseReasoningEffortLevel(value);
    if (named) return named;
    // Numeric string fallback (e.g. "1024") — produces a thinkingBudget.
    const num = Number(value.trim());
    if (Number.isInteger(num) && num > 0) return num;
    return undefined;
  }

  if (typeof value === 'number') {
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
    return undefined;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// parsePositiveIntFromFrontmatter
// ---------------------------------------------------------------------------

/**
 * Robustly parses a positive integer from frontmatter (handles string numbers).
 */
export function parsePositiveIntFromFrontmatter(
  value: unknown,
): number | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }

  if (typeof value === 'string') {
    const num = Number(value.trim());
    return Number.isInteger(num) && num > 0 ? num : undefined;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// coerceDescriptionToString
// ---------------------------------------------------------------------------

/**
 * Coerces a frontmatter description to a string, tolerating number/boolean values.
 *
 * Returns `null` for `undefined/null` or non-coercible types.
 */
export function coerceDescriptionToString(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return null;
}

// ---------------------------------------------------------------------------
// parseBooleanFrontmatter
// ---------------------------------------------------------------------------

/**
 * Strict boolean parsing: only `true` or `"true"` returns `true`.
 */
export function parseBooleanFrontmatter(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string' && value.toLowerCase().trim() === 'true') {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Effort → ThinkingBudget mapping
// ---------------------------------------------------------------------------

/** Named effort level → thinkingBudget mapping. */
const EFFORT_LEVEL_TO_THINKING_BUDGET: Record<EffortLevel, number> = {
  none: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 49152,
  max: 65536,
};

/**
 * Converts an EffortValue to a thinkingBudget number.
 *
 * - Named levels are mapped via EFFORT_LEVEL_TO_THINKING_BUDGET.
 * - Numeric values are used directly as the thinkingBudget.
 *
 * Returns `undefined` if the input is `undefined`.
 */
export function effortToThinkingBudget(
  effort: EffortValue | undefined,
): number | undefined {
  if (effort === undefined) return undefined;

  if (typeof effort === 'number') {
    return effort;
  }

  return EFFORT_LEVEL_TO_THINKING_BUDGET[effort];
}

/** Final, internally consistent reasoning settings used by an agent run. */
export interface ResolvedAgentReasoning {
  thinkingBudget: number;
  reasoningEffort?: ReasoningEffortLevel;
}

/**
 * Resolves agent reasoning configuration after settings/modelConfig merging.
 * A configured thinking budget takes precedence over the frontmatter effort.
 */
export function resolveAgentReasoning(
  frontmatterEffort: EffortValue | undefined,
  configuredThinkingBudget: number | undefined,
): ResolvedAgentReasoning | undefined {
  if (configuredThinkingBudget !== undefined) {
    const reasoningEffort =
      Number.isFinite(configuredThinkingBudget) && configuredThinkingBudget >= 0
        ? reasoningEffortFromThinkingBudget(configuredThinkingBudget)
        : undefined;
    return {
      thinkingBudget: configuredThinkingBudget,
      ...(reasoningEffort !== undefined && { reasoningEffort }),
    };
  }

  if (frontmatterEffort === undefined) {
    return undefined;
  }

  const thinkingBudget = effortToThinkingBudget(frontmatterEffort);
  if (thinkingBudget === undefined) {
    return undefined;
  }

  const reasoningEffort =
    typeof frontmatterEffort === 'number'
      ? reasoningEffortFromThinkingBudget(frontmatterEffort)
      : frontmatterEffort;

  return {
    thinkingBudget,
    ...(reasoningEffort !== undefined && { reasoningEffort }),
  };
}
