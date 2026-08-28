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
 * classifier's context window or burn its timeout. The bound is on the
 * *serialized* size: every emitted string (values, keys, markers) is
 * charged at its JSON-encoded length plus the per-line overhead of the
 * pretty-printed form the classifier receives, and container iteration
 * stops as soon as the shared budget is exhausted. Pretty-printed output
 * therefore stays within {@link MCP_CLASSIFIER_MAX_TOTAL_CHARS} plus at most
 * one marker per nesting level.
 *
 * Truncation is always visible to the classifier: every cut leaves an
 * in-place marker of the form `…[truncated N chars]` or `[omitted: …]`, and
 * the top-level `arguments_truncated` / `name_truncated` flags are set.
 * Omitted content is never presented as absent.
 */

/** Max characters kept from any single string value or key. */
export const MCP_CLASSIFIER_MAX_STRING_CHARS = 2_000;
/** Shared character budget for the whole projected payload. */
export const MCP_CLASSIFIER_MAX_TOTAL_CHARS = 16_000;
/** Max nesting depth before a subtree is replaced by a marker. */
export const MCP_CLASSIFIER_MAX_DEPTH = 8;
/** Max entries kept per array / object. */
export const MCP_CLASSIFIER_MAX_ENTRIES = 64;
/**
 * Max characters kept from the server / tool name. The MCP SDK validates
 * tool names only as `string`; a hostile server can advertise a name of
 * any length or content, and the registered name is normalized but the
 * raw server-side name is what the projection reports.
 */
export const MCP_CLASSIFIER_MAX_NAME_CHARS = 200;

/**
 * Per-entry serialization overhead charged against the budget: the
 * indentation of the deepest allowed line, quotes, colon, comma and
 * newline of `JSON.stringify(value, null, 2)`.
 */
const ENTRY_OVERHEAD = 2 * MCP_CLASSIFIER_MAX_DEPTH + 8;
/** Opening bracket, newline, closing indentation and bracket. */
const CONTAINER_OVERHEAD = 2 * MCP_CLASSIFIER_MAX_DEPTH + 4;

const ANNOTATION_KEYS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const satisfies ReadonlyArray<keyof McpToolAnnotations>;

export interface McpClassifierInput extends Record<string, unknown> {
  /** MCP server name as configured by the user (capped). */
  server: string;
  /** Tool name as advertised by the server (capped, control chars removed). */
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
  /** Present (and `true`) only when `server` or `tool` was cut. */
  name_truncated?: true;
}

interface ProjectionBudget {
  remaining: number;
  truncated: boolean;
}

export interface ProjectMcpArgumentsResult {
  value: Record<string, unknown>;
  truncated: boolean;
}

function charge(budget: ProjectionBudget, chars: number): void {
  budget.remaining -= chars;
}

function marker(budget: ProjectionBudget, text: string): string {
  budget.truncated = true;
  charge(budget, text.length);
  return text;
}

/**
 * Cut `value` so its JSON-encoded form fits `limit` characters, charging
 * the encoded size (escapes included) rather than the raw length. Returns
 * the kept prefix plus an in-place marker when anything was removed.
 */
function fitString(
  value: string,
  limit: number,
  budget: ProjectionBudget,
): string {
  let encoded = JSON.stringify(value);
  if (encoded.length - 2 <= limit) {
    charge(budget, encoded.length);
    return value;
  }
  budget.truncated = true;
  let keep = Math.min(value.length, Math.max(0, limit));
  let cut = value.slice(0, keep);
  encoded = JSON.stringify(cut);
  while (keep > 0 && encoded.length - 2 > limit) {
    // Escapes inflated the encoded form; shrink proportionally. Strictly
    // decreasing while over the limit, so this terminates.
    keep = Math.min(
      keep - 1,
      Math.floor((keep * limit) / (encoded.length - 2)),
    );
    cut = value.slice(0, Math.max(0, keep));
    encoded = JSON.stringify(cut);
  }
  const note = `…[truncated ${value.length - cut.length} chars]`;
  charge(budget, encoded.length + note.length);
  return cut + note;
}

function stringLimit(budget: ProjectionBudget): number {
  return Math.max(
    0,
    Math.min(MCP_CLASSIFIER_MAX_STRING_CHARS, budget.remaining),
  );
}

function uniqueKey(out: Record<string, unknown>, wanted: string): string {
  let key = wanted;
  while (key in out) key += '…';
  return key;
}

function projectValue(
  value: unknown,
  depth: number,
  budget: ProjectionBudget,
): unknown {
  if (budget.remaining <= 0) {
    return marker(budget, '[omitted: argument budget exhausted]');
  }
  if (typeof value === 'string') {
    return fitString(value, stringLimit(budget), budget);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    charge(budget, String(value).length);
    return value;
  }
  if (typeof value !== 'object') {
    // undefined / function / symbol / bigint: not JSON-serialisable as-is.
    if (value === undefined) {
      charge(budget, 4);
      return null;
    }
    return fitString(String(value), stringLimit(budget), budget);
  }
  if (depth >= MCP_CLASSIFIER_MAX_DEPTH) {
    return marker(budget, '[omitted: nesting too deep]');
  }
  charge(budget, CONTAINER_OVERHEAD);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const left = value.length - i;
      if (i >= MCP_CLASSIFIER_MAX_ENTRIES) {
        out.push(marker(budget, `[omitted: ${left} more entries]`));
        break;
      }
      if (budget.remaining <= 0) {
        out.push(
          marker(
            budget,
            `[omitted: ${left} more entries, argument budget exhausted]`,
          ),
        );
        break;
      }
      charge(budget, ENTRY_OVERHEAD);
      out.push(projectValue(value[i], depth + 1, budget));
    }
    return out;
  }

  // Null prototype: a key literally named `__proto__` must become an own
  // property (and stay visible to the classifier) instead of invoking the
  // Object.prototype setter and vanishing from the projection.
  const out: Record<string, unknown> = Object.create(null);
  const entries = Object.entries(value as Record<string, unknown>);
  for (let i = 0; i < entries.length; i++) {
    const left = entries.length - i;
    if (i >= MCP_CLASSIFIER_MAX_ENTRIES) {
      out[uniqueKey(out, '…')] = marker(budget, `[omitted: ${left} more keys]`);
      break;
    }
    if (budget.remaining <= 0) {
      out[uniqueKey(out, '…')] = marker(
        budget,
        `[omitted: ${left} more keys, argument budget exhausted]`,
      );
      break;
    }
    const [key, item] = entries[i];
    charge(budget, ENTRY_OVERHEAD);
    const projectedKey = uniqueKey(
      out,
      fitString(key, stringLimit(budget), budget),
    );
    out[projectedKey] = projectValue(item, depth + 1, budget);
  }
  return out;
}

/**
 * Bound an MCP argument object for inclusion in the classifier prompt.
 * Non-object inputs project to `{}`.
 */
export function projectMcpArguments(args: unknown): ProjectMcpArgumentsResult {
  return projectMcpArgumentsWithBudget(args, {
    remaining: MCP_CLASSIFIER_MAX_TOTAL_CHARS,
    truncated: false,
  });
}

function projectMcpArgumentsWithBudget(
  args: unknown,
  budget: ProjectionBudget,
): ProjectMcpArgumentsResult {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { value: {}, truncated: false };
  }
  const value = projectValue(args, 0, budget) as Record<string, unknown>;
  return { value, truncated: budget.truncated };
}

/**
 * Cap a server / tool name and strip control characters (newlines could
 * otherwise let a hostile name inject lines into the classifier prompt).
 */
function fitName(name: string, budget: ProjectionBudget): string {
  const cleaned = name.replace(/\p{Cc}/gu, ' ');
  const limit = Math.max(
    0,
    Math.min(MCP_CLASSIFIER_MAX_NAME_CHARS, budget.remaining),
  );
  return fitString(cleaned, limit, budget);
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
 * Names and arguments share one budget.
 */
export function buildMcpClassifierInput(
  options: BuildMcpClassifierInputOptions,
): McpClassifierInput {
  const budget: ProjectionBudget = {
    remaining: MCP_CLASSIFIER_MAX_TOTAL_CHARS,
    truncated: false,
  };
  const server = fitName(options.serverName, budget);
  const tool = fitName(options.serverToolName, budget);
  const nameTruncated = budget.truncated;
  budget.truncated = false;

  const { value, truncated } = projectMcpArgumentsWithBudget(
    options.params,
    budget,
  );
  const annotations = projectAnnotations(options.annotations);
  const input: McpClassifierInput = {
    server,
    tool,
    ...(annotations ? { annotations } : {}),
    arguments: value,
  };
  if (truncated) input.arguments_truncated = true;
  if (nameTruncated) input.name_truncated = true;
  return input;
}
