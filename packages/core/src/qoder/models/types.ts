/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ServerModelListEntry {
  raw: unknown;
  /** 条目所在的服务端响应顶层 key。 */
  serverScene: string;
}

/**
 * Configurable context window tier as advertised by the server, e.g. "200K".
 * Preserved verbatim so consumers can render tier labels and detect the default.
 */
export interface ContextWindowConfigEntry {
  token_count: number;
  is_default?: boolean;
}

/** Server-side `context_config` map keyed by tier label (e.g. "200K", "1M"). */
export type ContextConfig = Record<string, ContextWindowConfigEntry>;

/** Server-side per-effort metadata under `thinking_config.enabled.efforts.<level>`. */
export interface EffortConfigEntry {
  description?: string;
  is_default?: boolean;
}

export interface ThinkingConfigDisabled {
  description?: string;
}

export interface ThinkingConfigEnabled {
  description?: string;
  efforts?: Record<string, EffortConfigEntry>;
  is_default?: boolean;
}

/** Server-side `thinking_config` block — preserved verbatim. */
export interface ThinkingConfig {
  disabled?: ThinkingConfigDisabled;
  enabled?: ThinkingConfigEnabled;
}

/** Localized text map from the model list API (e.g. { en, zh }). */
export type LocalizedModelText = {
  en?: string;
  zh?: string;
} & Record<string, string | undefined>;

/** JSON-compatible value inside a server model entry. */
export type ServerModelJsonValue =
  | string
  | number
  | boolean
  | null
  | ServerModelJsonValue[]
  | { [key: string]: ServerModelJsonValue };

/** Raw model entry from the model list API, exposed for SDK hosts. */
export type ServerModelJson = Record<string, ServerModelJsonValue>;

/**
 * Codebase tag strategy — defines model availability under a given repo security tag.
 * Mirrors Go CLI's router.ModelStrategy.
 *
 * Dual semantics (do not conflate when adding new consumers):
 *   - `enabled: false`: gating. The model is restricted when the surrounding
 *     codebase has this `tag` in its security tags (product side:
 *     `packages/qoder/c4-repo-status/c4-filter.ts`).
 *   - `enabled: true`: positive attribute declaration. The model carries this
 *     `tag` as an attribute; product attribute resolvers read it to surface
 *     model metadata (e.g. via MCP request headers). The gating filter ignores
 *     `enabled: true` entries.
 */
export interface ModelStrategy {
  /** The tag identifier (e.g. `'C4'` for a codebase security level, or
   * `'enterprise-safety'` for a positive attribute declaration). */
  tag: string;
  /** Whether the model is enabled when this tag is present (see dual semantics
   * above). Parsed with strict equality against `true` — any non-boolean value
   * is treated as `false`. */
  enabled: boolean;
  /** i18n key for the disabled message shown to the user. Only populated for
   * gating entries (`enabled: false`). */
  disabled_message_key: string;
}
