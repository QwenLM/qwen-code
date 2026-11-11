/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model, ModelConfig } from './model.js';

export type { ModelConfig } from './model.js';

/** 后者覆盖前者；reasoning、sampling 按子字段合并，缺省字段不擦除下层。 */
export function mergeModelConfig(
  ...configs: ReadonlyArray<ModelConfig | undefined>
): ModelConfig {
  let merged: ModelConfig = {};
  for (const config of configs) {
    if (!config) continue;
    const { reasoning, context, sampling, ...rest } = config;
    merged = {
      ...merged,
      ...withoutUndefined(rest),
      ...(reasoning
        ? { reasoning: { ...merged.reasoning, ...withoutUndefined(reasoning) } }
        : {}),
      ...(context
        ? { context: { ...merged.context, ...withoutUndefined(context) } }
        : {}),
      ...(sampling
        ? { sampling: { ...merged.sampling, ...withoutUndefined(sampling) } }
        : {}),
    };
  }
  return merged;
}

/**
 * 按所选模型能力把配置修正为合法值，并补齐 effort / contextWindow 默认。
 * effort 'none' 视为显式关闭思考，始终放行；sampling 无能力元数据，原样透传。
 */
export function resolveSelectedModelConfig(
  model: Model,
  preferences: ModelConfig = {},
): ModelConfig {
  const reasoning = model.capabilities.reasoning;
  const efforts = reasoning.supportedEfforts;
  const requested = preferences.reasoning?.effort;
  const effort = !reasoning.supported
    ? 'none'
    : requested === 'none'
      ? 'none'
      : [
          requested,
          model.defaultModelConfig?.reasoning?.effort,
          'medium' as const,
        ].find((value) => value !== undefined && efforts.includes(value));
  const windows = model.capabilities.contextWindows
    .map(({ tokens }) => tokens)
    .filter((window) => Number.isSafeInteger(window) && window > 0);
  const window = [
    preferences.context?.contextWindow,
    model.defaultModelConfig?.context?.contextWindow,
  ].find(
    (value) =>
      value !== undefined &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      (windows.length > 0
        ? windows.includes(value)
        : value <= model.limits.maxContextTokens),
  );
  const outputLimit = model.limits.maxOutputTokens;
  const maxOutputTokens =
    preferences.context?.maxOutputTokens !== undefined && outputLimit !== undefined
      ? Math.min(preferences.context.maxOutputTokens, outputLimit)
      : preferences.context?.maxOutputTokens;
  const thinking = reasoning.supported
    ? preferences.reasoning?.thinking
    : undefined;
  const preserve = preferences.reasoning?.preserve;
  return {
    reasoning: {
      ...(effort !== undefined ? { effort } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(preserve !== undefined ? { preserve } : {}),
    },
    context: {
      contextWindow:
        window ??
        (windows.length > 0
          ? Math.max(...windows)
          : model.limits.maxContextTokens),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    },
    ...(preferences.sampling ? { sampling: preferences.sampling } : {}),
  };
}

/**
 * 偏好写入前按模型能力校验：effort 须在 supportedEfforts 内（'none' 与选模修正一致，始终放行），
 * contextWindow 须是声明档位之一（无档位时不超过 maxContextTokens）。显式 undefined 表示清除，
 * 不校验；其余字段没有能力元数据，原样放行。返回首个不支持字段的说明，全部支持时返回 undefined。
 */
export function findUnsupportedModelConfig(
  model: Model,
  patch: ModelConfig,
): string | undefined {
  const effort = patch.reasoning?.effort;
  if (
    effort !== undefined &&
    effort !== 'none' &&
    !model.capabilities.reasoning.supportedEfforts.includes(effort)
  ) {
    return `Model '${model.key}' does not support reasoning effort '${effort}'.`;
  }
  const window = patch.context?.contextWindow;
  if (window === undefined) return undefined;
  const windows = model.capabilities.contextWindows.map(({ tokens }) => tokens);
  const supported =
    Number.isSafeInteger(window) &&
    window > 0 &&
    (windows.length > 0
      ? windows.includes(window)
      : window <= model.limits.maxContextTokens);
  return supported
    ? undefined
    : `Model '${model.key}' does not support context window ${window}.`;
}

/** {@link findUnsupportedModelConfig} 的写入侧门禁：不支持时抛错。 */
export function assertModelConfigSupported(
  model: Model,
  patch: ModelConfig,
): void {
  const reason = findUnsupportedModelConfig(model, patch);
  if (reason !== undefined) throw new Error(reason);
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
