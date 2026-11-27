/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sanitize MCP tool `inputSchema.properties` keys so they satisfy the API's
 * wire-format constraint `^[a-zA-Z0-9_.-]{1,64}$`.
 *
 * Some MCP servers (notably ComfyUI-bridging servers like nanobanana2) emit
 * parameter names that embed node ids and node-class names such as
 * `8:BizyAir_NanoBanana2.aspect_ratio`. The `:` character is rejected by the
 * upstream API (`tools[*].custom.input_schema.properties: Property keys should
 * match pattern '^[a-zA-Z0-9_.-]{1,64}$'`).
 *
 * We rewrite the top-level property names when they are non-conforming and
 * keep a per-tool `sanitized → original` map so that tool calls issued by the
 * model can be reverse-mapped back to the original names before they are
 * dispatched to the MCP server.
 */
import { runLogger } from '../utils/runLogger.js';

/** Pattern the upstream API enforces on `input_schema.properties` keys. */
export const MCP_PROPERTY_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

/** Key-character whitelist used to rewrite individual code points. */
const MCP_PROPERTY_CHAR_PATTERN = /[a-zA-Z0-9_.-]/;

/** Maximum length allowed for a sanitized property key. */
const MAX_KEY_LENGTH = 64;

/**
 * Result of sanitizing one MCP tool's input schema.
 *
 * - `schema` is the (possibly rewritten) schema that is safe to send to the
 *   API. Returned as the same reference as `input` when no changes were
 *   required.
 * - `keyMap` is `null` when no rewriting occurred. Otherwise it maps
 *   `sanitized → original` for the top-level properties, ready to be used by
 *   {@link restoreOriginalArgKeys}.
 */
export interface SanitizedMcpInputSchema {
  schema: unknown;
  keyMap: Map<string, string> | null;
}

/**
 * Rewrite a single property-key string so it matches the allowed pattern.
 * Does not handle uniqueness — callers are responsible for disambiguation.
 */
function sanitizeKey(key: string): string {
  let out = '';
  for (const ch of key) {
    out += MCP_PROPERTY_CHAR_PATTERN.test(ch) ? ch : '_';
  }
  if (out.length === 0) out = '_';
  if (out.length > MAX_KEY_LENGTH) out = out.slice(0, MAX_KEY_LENGTH);
  return out;
}

/**
 * Drop `required` entries that reference properties which are not defined in
 * `properties`. Some MCP servers emit placeholder/ghost names such as
 * `//TODO: Add Field Name 0` in `required` without a matching property. Strict
 * upstreams (e.g. Moonshot/Kimi) reject the whole tool schema
 * (`required property ... is not defined in properties`), which breaks every
 * request in the session, so we prune those ghost entries defensively.
 *
 * Non-string entries are left untouched. Returns `undefined` when nothing was
 * removed so callers can preserve the original reference on the fast path.
 */
function pruneGhostRequired(
  required: unknown,
  validNames: Set<string>,
  toolName?: string,
): unknown[] | undefined {
  if (!Array.isArray(required)) return undefined;
  const cleaned = (required as unknown[]).filter(
    (r) => typeof r !== 'string' || validNames.has(r),
  );
  if (cleaned.length === required.length) return undefined;
  if (toolName) {
    const dropped = (required as unknown[]).filter(
      (r) => typeof r === 'string' && !validNames.has(r),
    );
    runLogger.warn(
      `[McpSchemaSanitizer] Tool '${toolName}' lists ${dropped.length} ` +
        `required propert${dropped.length === 1 ? 'y' : 'ies'} not defined in ` +
        `properties (${dropped.join(', ')}); dropped before API dispatch to ` +
        `avoid strict-schema rejection.`,
    );
  }
  return cleaned;
}

/**
 * Sanitize a top-level MCP inputSchema.
 *
 * Only rewrites `properties` keys (and mirrors the same rewrites into the
 * `required` array). Nested `properties` inside array `items` / object
 * children are intentionally left alone — in practice the constraint is
 * enforced at the top level, and leaving nested structures untouched keeps
 * the reverse-map (and therefore the MCP call path) simple and correct.
 */
export function sanitizeMcpInputSchema(
  input: unknown,
  toolName?: string,
): SanitizedMcpInputSchema {
  if (!input || typeof input !== 'object') {
    return { schema: input, keyMap: null };
  }

  const schemaObj = input as Record<string, unknown>;
  const properties = schemaObj['properties'];
  if (!properties || typeof properties !== 'object') {
    if (schemaObj['type'] !== 'object') {
      return { schema: input, keyMap: null };
    }
    const cleanedRequired = pruneGhostRequired(
      schemaObj['required'],
      new Set(),
      toolName,
    );
    if (cleanedRequired !== undefined) {
      return {
        schema: { ...schemaObj, required: cleanedRequired },
        keyMap: null,
      };
    }
    return { schema: input, keyMap: null };
  }

  const propsObj = properties as Record<string, unknown>;
  const originalKeys = Object.keys(propsObj);

  // Fast path: every property key already satisfies the pattern. The only
  // remaining hazard is a `required` array that references undefined (ghost)
  // properties, which strict upstreams reject — prune those but otherwise keep
  // the original reference untouched.
  if (originalKeys.every((k) => MCP_PROPERTY_KEY_PATTERN.test(k))) {
    const cleanedRequired = pruneGhostRequired(
      schemaObj['required'],
      new Set(originalKeys),
      toolName,
    );
    if (cleanedRequired === undefined) {
      return { schema: input, keyMap: null };
    }
    return {
      schema: { ...schemaObj, required: cleanedRequired },
      keyMap: null,
    };
  }

  const newProperties: Record<string, unknown> = {};
  const sanitizedToOriginal = new Map<string, string>();
  const originalToSanitized = new Map<string, string>();
  const usedKeys = new Set<string>();

  // Pass 1: claim slots for every already-valid key so that a sanitized
  // rewrite of some other key can never silently overwrite an existing
  // valid sibling (e.g. when `foo:bar` precedes `foo_bar` in iteration
  // order, the former must yield to `foo_bar_1`).
  for (const original of originalKeys) {
    if (MCP_PROPERTY_KEY_PATTERN.test(original)) {
      usedKeys.add(original);
    }
  }

  // Pass 2: emit properties in original iteration order, rewriting only
  // the non-conforming keys and disambiguating against `usedKeys`.
  for (const original of originalKeys) {
    let sanitized: string;
    if (MCP_PROPERTY_KEY_PATTERN.test(original)) {
      sanitized = original;
    } else {
      sanitized = sanitizeKey(original);
      if (usedKeys.has(sanitized)) {
        // Dynamic suffix budget so result never exceeds MAX_KEY_LENGTH,
        // even at extreme collision counts (`_100`, `_1000`, ...).
        let suffix = 1;
        let candidate: string;
        do {
          const suffixStr = `_${suffix}`;
          const baseBudget = Math.max(0, MAX_KEY_LENGTH - suffixStr.length);
          candidate = sanitized.slice(0, baseBudget) + suffixStr;
          suffix += 1;
        } while (usedKeys.has(candidate));
        sanitized = candidate;
      }
      usedKeys.add(sanitized);
    }
    newProperties[sanitized] = propsObj[original];
    if (sanitized !== original) {
      sanitizedToOriginal.set(sanitized, original);
      originalToSanitized.set(original, sanitized);
    }
  }

  if (sanitizedToOriginal.size === 0) {
    return { schema: input, keyMap: null };
  }

  if (toolName) {
    runLogger.warn(
      `[McpSchemaSanitizer] Tool '${toolName}' has ${sanitizedToOriginal.size} ` +
        `property key(s) that violate '${MCP_PROPERTY_KEY_PATTERN.source}'; ` +
        `renamed for API dispatch and will be reverse-mapped on invoke.`,
    );
  }

  const newSchema: Record<string, unknown> = {
    ...schemaObj,
    properties: newProperties,
  };

  const required = schemaObj['required'];
  if (Array.isArray(required)) {
    const validNames = new Set(Object.keys(newProperties));
    const mapped = (required as unknown[]).map((r) =>
      typeof r === 'string' ? (originalToSanitized.get(r) ?? r) : r,
    );
    newSchema['required'] =
      pruneGhostRequired(mapped, validNames, toolName) ?? mapped;
  }

  return { schema: newSchema, keyMap: sanitizedToOriginal };
}

/**
 * Reverse-map the top-level argument keys produced by the model back to the
 * original MCP property names before dispatching to the MCP server.
 *
 * Returns the same reference as `args` when no rewriting is needed.
 */
export function restoreOriginalArgKeys(
  args: Record<string, unknown> | undefined,
  keyMap: Map<string, string> | null | undefined,
): Record<string, unknown> | undefined {
  if (!args || !keyMap || keyMap.size === 0) return args;

  // Skip the rebuild when no sanitized key appears in the args.
  let needsRewrite = false;
  for (const k of Object.keys(args)) {
    if (keyMap.has(k)) {
      needsRewrite = true;
      break;
    }
  }
  if (!needsRewrite) return args;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const original = keyMap.get(key);
    result[original ?? key] = value;
  }
  return result;
}
