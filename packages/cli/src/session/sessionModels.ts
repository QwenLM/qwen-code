/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContextConfig,
  ModelStrategy,
  ServerModelJson,
  ThinkingConfig,
} from '@qwen-code/core';

export type SessionModelSource = 'system' | 'user' | 'organization' | 'custom';

export interface SessionModelInfo {
  /** SDK-compatible model id alias. Kept alongside modelId for existing UI code. */
  value?: string;
  modelId: string;
  displayName: string;
  source: SessionModelSource;
  /** 外部模型渠道，例如 "cmcc"。 */
  outerProvider?: string;
  description?: string;
  /** 服务端提供的英文模型描述。 */
  descriptionEn?: string;
  isDefault?: boolean;
  isEnabled?: boolean;
  isNew?: boolean;
  /** Whether the model supports reasoning / chain-of-thought. */
  isReasoning?: boolean;
  /** Whether the model accepts multimodal/vision input. */
  isVl?: boolean;
  /** Maximum input token count. */
  maxInputTokens?: number;
  /** Maximum output token count. */
  maxOutputTokens?: number;
  /** Explicit reasoning effort levels supported by this model. */
  efforts?: string[];
  /** Server-designated default reasoning effort, when provided. */
  defaultEffort?: string;
  /** Whether the model supports disabling thinking explicitly. */
  supportsDisabled?: boolean;
  /** Supported configurable context window sizes in tokens. */
  availableContextWindows?: number[];
  /** Server-designated default tier (one of `availableContextWindows`). */
  defaultContextWindow?: number;
  /** Free-form tags (e.g. 'limited_time_free', 'DogFooding'). */
  tags?: string[];
  /**
   * Codebase security-tag strategies. Determines whether the model is available
   * when the workspace repo carries a given tag (e.g. 'C4'). Absent → no restriction.
   * Shape mirrors core `ModelStrategy` ({ tag, enabled, disabled_message_key }).
   */
  strategies?: ModelStrategy[];
  /** Output format, e.g. 'openai', 'dashscope'. */
  format?: string;
  /** Usage scene the entry belongs to, e.g. 'chat', 'assistant'. */
  scene?: string;
  /**
   * Original top-level key in the server model-list response before client-side
   * merging, e.g. 'assistant' or 'byok_enterprise'.
   */
  serverScene?: string;
  /**
   * Optional icon for the model — server-provided string (URL, emoji, or
   * provider identifier). Forwarded verbatim from the catalog response.
   */
  icon?: string;
  /** BYOK: custom endpoint URL. */
  url?: string;
  /** BYOK: bare model identifier within the provider, e.g. 'gpt-4o'. */
  model?: string;
  /** BYOK: provider key, e.g. 'openai', 'deepseek'. */
  provider?: string;
  /**
   * Raw `context_config` block from the server, preserved structure-for-structure
   * (tier labels → { token_count, is_default }).
   */
  context_config?: ContextConfig;
  /**
   * Raw `thinking_config` block from the server, preserved structure-for-structure.
   */
  thinking_config?: ThinkingConfig;
  /**
   * Raw model entry from the model list API. SDK hosts can read newly-added
   * server fields here without waiting for CLI DTO changes.
   */
  serverModel?: ServerModelJson;
}

import {
  normalizeContextWindows,
  parseReasoningEffortLevel,
} from '@qwen-code/core';

function asString(value: unknown): string | undefined {
  return value != null &&
    (value as { constructor?: unknown }).constructor === String
    ? (value as string)
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function asSessionModelSource(value: string | undefined): SessionModelSource {
  if (value === 'user' || value === 'organization' || value === 'custom') {
    return value;
  }
  return 'system';
}

function asEffortArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const effort = parseReasoningEffortLevel(item);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    out.push(effort);
  }
  return out.length > 0 ? out : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const str = asString(item);
    if (str) out.push(str);
  }
  return out.length > 0 ? out : undefined;
}

function asStrategyArray(value: unknown): ModelStrategy[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ModelStrategy[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const tag = asString(rec['tag']);
    if (!tag) continue;
    const enabled = asBoolean(rec['enabled']);
    const disabledMessageKey =
      asString(rec['disabled_message_key']) ??
      asString(rec['disabledMessageKey']);
    out.push({
      tag,
      enabled: enabled ?? false,
      disabled_message_key: disabledMessageKey ?? '',
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse an over-the-wire array of `SessionModelInfo`-shaped records.
 * Drops malformed entries and ignores unknown fields.
 */
export function parseSessionModels(
  value: unknown,
): SessionModelInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SessionModelInfo[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const modelId = asString(rec['modelId']) ?? asString(rec['value']);
    const displayName = asString(rec['displayName']);
    const sourceRaw = asString(rec['source']);
    if (!modelId || !displayName) continue;
    const info: SessionModelInfo = {
      value: asString(rec['value']) ?? modelId,
      modelId,
      displayName,
      source: asSessionModelSource(sourceRaw),
    };
    const outerProvider = asString(rec['outerProvider']);
    if (outerProvider) info.outerProvider = outerProvider;
    const description = asString(rec['description']);
    if (description !== undefined) info.description = description;
    const descriptionEn = asString(rec['descriptionEn']);
    if (descriptionEn !== undefined) info.descriptionEn = descriptionEn;
    if (rec['isDefault'] === true) info.isDefault = true;
    const isEnabled = asBoolean(rec['isEnabled']);
    if (isEnabled !== undefined) info.isEnabled = isEnabled;
    const isNew = asBoolean(rec['isNew']);
    if (isNew !== undefined) info.isNew = isNew;
    const efforts = asEffortArray(rec['efforts']);
    if (efforts) info.efforts = efforts;
    const supportsDisabled =
      asBoolean(rec['supportsDisabled']) ?? asBoolean(rec['supports_disabled']);
    if (supportsDisabled === true) info.supportsDisabled = true;
    const availableContextWindows = normalizeContextWindows(
      rec['availableContextWindows'] ?? rec['available_context_windows'],
    );
    if (availableContextWindows) {
      info.availableContextWindows = availableContextWindows;
    }
    const defaultContextWindowRaw =
      rec['defaultContextWindow'] ?? rec['default_context_window'];
    if (
      typeof defaultContextWindowRaw === 'number' &&
      Number.isInteger(defaultContextWindowRaw) &&
      defaultContextWindowRaw > 0
    ) {
      info.defaultContextWindow = defaultContextWindowRaw;
    }
    const isReasoning = asBoolean(rec['isReasoning']);
    if (isReasoning !== undefined) info.isReasoning = isReasoning;
    const isVl = asBoolean(rec['isVl']);
    if (isVl !== undefined) info.isVl = isVl;
    const maxInputTokens = asNumber(rec['maxInputTokens']);
    if (maxInputTokens !== undefined) info.maxInputTokens = maxInputTokens;
    const maxOutputTokens = asNumber(rec['maxOutputTokens']);
    if (maxOutputTokens !== undefined) info.maxOutputTokens = maxOutputTokens;
    const defaultEffort = asString(rec['defaultEffort']);
    if (defaultEffort) info.defaultEffort = defaultEffort;
    const tags = asStringArray(rec['tags']);
    if (tags) info.tags = tags;
    const strategies = asStrategyArray(rec['strategies']);
    if (strategies) info.strategies = strategies;
    const format = asString(rec['format']);
    if (format) info.format = format;
    const scene = asString(rec['scene']);
    if (scene) info.scene = scene;
    const serverScene =
      asString(rec['serverScene']) ?? asString(rec['server_scene']);
    if (serverScene) info.serverScene = serverScene;
    const icon = asString(rec['icon']);
    if (icon) info.icon = icon;
    const url = asString(rec['url']);
    if (url) info.url = url;
    const model = asString(rec['model']);
    if (model) info.model = model;
    const provider = asString(rec['provider']);
    if (provider) info.provider = provider;
    const contextConfig = rec['context_config'];
    if (contextConfig && typeof contextConfig === 'object') {
      info.context_config = contextConfig as SessionModelInfo['context_config'];
    }
    const thinkingConfig = rec['thinking_config'];
    if (thinkingConfig && typeof thinkingConfig === 'object') {
      info.thinking_config =
        thinkingConfig as SessionModelInfo['thinking_config'];
    }
    const serverModel = rec['serverModel'];
    if (
      serverModel &&
      typeof serverModel === 'object' &&
      !Array.isArray(serverModel)
    ) {
      info.serverModel = serverModel as SessionModelInfo['serverModel'];
    }
    out.push(info);
  }
  return out;
}
