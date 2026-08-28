/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpToolAnnotations } from './mcp-tool.js';

/**
 * Projection of an MCP tool call for the AUTO-mode classifier.
 *
 * MCP tools are served by third-party processes, so the classifier cannot
 * rely on the tool name alone: `mcp__slack__post_message` is harmless with
 * `{ text: "hi" }` and data exfiltration with the contents of `.env`. The
 * arguments are what the agent is about to send to that server, and the
 * classifier's data-exfiltration and external-system-write rules can only
 * be applied to them.
 *
 * The projection is bounded so a single call cannot overflow the fast
 * classifier's context window or burn its timeout: every string is capped,
 * nesting depth and entry counts are capped, and the whole payload shares
 * one character budget. Truncation is always visible to the classifier via
 * explicit markers and the `arguments_truncated` flag — omitted content is
 * never presented as absent.
 */

/** Max characters kept from any single string value. */
export const MCP_CLASSIFIER_MAX_STRING_CHARS = 2_000;
/** Shared character budget for the whole projected argument tree. */
export const MCP_CLASSIFIER_MAX_TOTAL_CHARS = 16_000;
/** Max nesting depth before a subtree is replaced by a marker. */
export const MCP_CLASSIFIER_MAX_DEPTH = 8;
/** Max entries kept per array / object. */
export const MCP_CLASSIFIER_MAX_ENTRIES = 64;

/** Rough budget charge for a scalar that is not a string. */
const SCALAR_COST = 8;

const ANNOTATION_KEYS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const satisfies ReadonlyArray<keyof McpToolAnnotations>;

export interface McpClassifierInput extends Record<string, unknown> {
  /** MCP server name as configured by the user. */
  server: string;
  /** Tool name as advertised by the server (before provider normalization). */
  tool: string;
  /**
   * Behaviour hints self-reported by the server. Only present when the
   * server declared at least one. Unverified — the classifier prompt tells
   * the model to treat them as untrusted context.
   */
  annotations?: Partial<Record<(typeof ANNOTATION_KEYS)[number], boolean>>;
  /** Bounded projection of the call arguments. */
  arguments: Record<string, unknown>;
  /** Present (and `true`) only when any part of `arguments` was cut. */
  arguments_truncated?: true;
}

interface ProjectionBudget {
  remaining: number;
  truncated: boolean;
}

export interface ProjectMcpArgumentsResult {
  value: Record<string, unknown>;
  truncated: boolean;
}

function truncateString(value: string, budget: ProjectionBudget): string {
  const limit = Math.max(
    0,
    Math.min(MCP_CLASSIFIER_MAX_STRING_CHARS, budget.remaining),
  );
  if (value.length <= limit) {
    budget.remaining -= value.length;
    return value;
  }
  budget.truncated = true;
  budget.remaining -= limit;
  const omitted = value.length - limit;
  return `${value.slice(0, limit)}…[truncated ${omitted} chars]`;
}

function projectValue(
  value: unknown,
  depth: number,
  budget: ProjectionBudget,
): unknown {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return '[omitted: argument budget exhausted]';
  }
  if (typeof value === 'string') {
    return truncateString(value, budget);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    budget.remaining -= SCALAR_COST;
    return value;
  }
  if (typeof value !== 'object') {
    // undefined / function / symbol / bigint: not JSON-serialisable as-is.
    budget.remaining -= SCALAR_COST;
    return value === undefined ? null : String(value);
  }
  if (depth >= MCP_CLASSIFIER_MAX_DEPTH) {
    budget.truncated = true;
    return '[omitted: nesting too deep]';
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MCP_CLASSIFIER_MAX_ENTRIES)
      .map((item) => projectValue(item, depth + 1, budget));
    if (value.length > MCP_CLASSIFIER_MAX_ENTRIES) {
      budget.truncated = true;
      kept.push(
        `…[${value.length - MCP_CLASSIFIER_MAX_ENTRIES} more entries omitted]`,
      );
    }
    return kept;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, MCP_CLASSIFIER_MAX_ENTRIES)) {
    budget.remaining -= key.length;
    out[key] = projectValue(item, depth + 1, budget);
  }
  if (entries.length > MCP_CLASSIFIER_MAX_ENTRIES) {
    budget.truncated = true;
    out['…'] =
      `[${entries.length - MCP_CLASSIFIER_MAX_ENTRIES} more keys omitted]`;
  }
  return out;
}

/**
 * Bound an MCP argument object for inclusion in the classifier prompt.
 * Non-object inputs project to `{}`.
 */
export function projectMcpArguments(args: unknown): ProjectMcpArgumentsResult {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { value: {}, truncated: false };
  }
  const budget: ProjectionBudget = {
    remaining: MCP_CLASSIFIER_MAX_TOTAL_CHARS,
    truncated: false,
  };
  const value = projectValue(args, 0, budget) as Record<string, unknown>;
  return { value, truncated: budget.truncated };
}

function projectAnnotations(
  annotations: McpToolAnnotations | undefined,
): McpClassifierInput['annotations'] | undefined {
  if (!annotations) return undefined;
  const out: NonNullable<McpClassifierInput['annotations']> = {};
  for (const key of ANNOTATION_KEYS) {
    if (typeof annotations[key] === 'boolean') out[key] = annotations[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface BuildMcpClassifierInputOptions {
  serverName: string;
  serverToolName: string;
  annotations?: McpToolAnnotations;
  params: unknown;
}

/**
 * Build the object the AUTO classifier sees for a pending MCP tool call.
 * `server` / `tool` are given explicitly because the registered
 * `mcp__server__tool` name may have been normalized for the provider.
 */
export function buildMcpClassifierInput(
  options: BuildMcpClassifierInputOptions,
): McpClassifierInput {
  const { value, truncated } = projectMcpArguments(options.params);
  const annotations = projectAnnotations(options.annotations);
  const input: McpClassifierInput = {
    server: options.serverName,
    tool: options.serverToolName,
    ...(annotations ? { annotations } : {}),
    arguments: value,
  };
  if (truncated) input.arguments_truncated = true;
  return input;
}
