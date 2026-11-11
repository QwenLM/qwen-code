/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SettingsFileSource,
  SettingsService,
} from '@qwen-code/resource';

import stripJsonComments from 'strip-json-comments';
import { Storage } from '../../config/storage.js';
import { runLogger } from '../../utils/runLogger.js';
import type { ModelConfig, ReasoningEffortLevel } from '../model/model.js';
import { mergeModelConfig } from '../model/modelConfig.js';
import { QODER_PROVIDER_ID } from '../modelProvider.js';

/** store 绑定的 settings 层级：user 全局档，或 project+local 两档合并。 */
export type ModelConfigStoreScope = 'user' | 'project';

export interface CreateModelConfigStoreOptions {
  /** 归属 provider：hydration 时按 key 前缀过滤，只保留本 provider 的偏好。 */
  readonly providerId: string;
  readonly settingsService: SettingsService;
  readonly scope: ModelConfigStoreScope;
  /** scope === 'project' 时必填：决定读哪个工作区目录下的 settings。 */
  readonly cwd?: string;
}

/** 磁盘 reasoning 块与档位的最小映射：generation-config 旧栈依赖的内联版，只服务本文件。 */
type NormalizedReasoning = {
  enabled?: boolean;
  effort?: ReasoningEffortLevel;
  preserve?: boolean;
  thinking?:
    | { type: 'adaptive' | 'disabled' }
    | { type: 'enabled'; budgetTokens: number };
};

const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function parseEffortLevel(value: unknown): ReasoningEffortLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase().trim();
  if (normalized === 'disabled' || normalized === 'off') return 'none';
  return EFFORT_LEVELS.has(normalized)
    ? (normalized as ReasoningEffortLevel)
    : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeReasoning(raw: unknown): NormalizedReasoning | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return undefined;
  const record = raw as Record<string, unknown>;
  const result: NormalizedReasoning = {};
  const effort = parseEffortLevel(record['effort']);
  const rawEnabled = record['enabled'];
  const enabled = typeof rawEnabled === 'boolean' ? rawEnabled : undefined;
  const budgetTokens = positiveInt(record['budgetTokens']);
  const rawPreserve = record['preserve'];
  const preserve = typeof rawPreserve === 'boolean' ? rawPreserve : undefined;

  const rawThinking = record['thinking'];
  if (
    typeof rawThinking === 'object' &&
    rawThinking !== null &&
    !Array.isArray(rawThinking)
  ) {
    const thinking = rawThinking as Record<string, unknown>;
    const type = thinking['type'];
    if (type === 'adaptive' || type === 'disabled') {
      result.thinking = { type };
    } else if (type === 'enabled') {
      const budget = positiveInt(thinking['budgetTokens']);
      if (budget !== undefined)
        result.thinking = { type: 'enabled', budgetTokens: budget };
    }
  }
  if (!result.thinking) {
    if (enabled === false || effort === 'none') result.enabled = false;
    else if (budgetTokens !== undefined)
      result.thinking = { type: 'enabled', budgetTokens };
    else if (enabled === true) result.enabled = true;
  }
  if (effort && effort !== 'none') result.effort = effort;
  if (preserve !== undefined) result.preserve = preserve;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 只取用户显式配置的档位；固定 budget 不参与推导。 */
function explicitEffortOf(
  block: NormalizedReasoning | undefined,
): ReasoningEffortLevel | undefined {
  if (!block) return undefined;
  const disabled =
    block.enabled === false || block.thinking?.type === 'disabled';
  if (disabled && block.effort === undefined) return 'none';
  return block.effort;
}

/** 把档位折进 reasoning 块：'none' 关闭思考，其他档位可重新打开被关闭的思考。 */
function foldReasoning(
  block: NormalizedReasoning | undefined,
  effort: ReasoningEffortLevel | undefined,
): NormalizedReasoning | undefined {
  const existing = block ?? {};
  const { effort: _dropped, ...rest } = existing;
  if (effort === 'none')
    return normalizeReasoning({ ...rest, thinking: undefined, enabled: false });
  const thinkingWasOff =
    existing.enabled === false ||
    existing.thinking?.type === 'disabled' ||
    (existing.enabled === undefined && existing.thinking === undefined);
  return normalizeReasoning({
    ...rest,
    ...(effort !== undefined ? { effort } : {}),
    ...(effort !== undefined && thinkingWasOff
      ? { thinking: undefined, enabled: true }
      : {}),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type MutableModelConfig = {
  -readonly [K in keyof ModelConfig]: ModelConfig[K];
};

/** reasoning 块 → ModelConfig.reasoning（档位、思考模式、跨轮保留）。 */
function reasoningFieldsOf(
  block: NormalizedReasoning | undefined,
): Pick<ModelConfig, 'reasoning'> {
  const effort = explicitEffortOf(block);
  const reasoning = {
    ...(effort !== undefined ? { effort } : {}),
    ...(block?.thinking !== undefined ? { thinking: block.thinking } : {}),
    ...(block?.preserve !== undefined ? { preserve: block.preserve } : {}),
  };
  return Object.keys(reasoning).length > 0 ? { reasoning } : {};
}

/** reasoningFieldsOf 的逆映射，供内存态复用 foldReasoning 的档位折叠语义。 */
function reasoningBlockOf(
  config: ModelConfig,
): NormalizedReasoning | undefined {
  const effort = config.reasoning?.effort;
  return normalizeReasoning({
    thinking: config.reasoning?.thinking,
    ...(effort === 'none' ? { enabled: false } : { effort }),
    preserve: config.reasoning?.preserve,
  });
}

/** 磁盘 model.preferences[key]（ModelPreferenceEntry）→ core ModelConfig。 */
function modelConfigFromPreferenceEntry(entry: unknown): ModelConfig {
  const record = asRecord(entry);
  const config: MutableModelConfig = reasoningFieldsOf(
    normalizeReasoning(record['reasoning']),
  );
  const contextWindow = positiveInt(record['contextWindow']);
  const maxOutputTokens = positiveInt(record['maxTokens']);
  if (contextWindow !== undefined || maxOutputTokens !== undefined) {
    config.context = {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    };
  }
  const sampling: {
    -readonly [K in keyof NonNullable<ModelConfig['sampling']>]: NonNullable<
      ModelConfig['sampling']
    >[K];
  } = {};
  for (const key of ['temperature', 'topP', 'topK'] as const) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      sampling[key] = value;
    }
  }
  if (
    Array.isArray(record['stop']) &&
    record['stop'].every((value) => typeof value === 'string')
  ) {
    sampling['stop'] = [...record['stop']];
  }
  if (Object.keys(sampling).length > 0) config.sampling = sampling;
  return config;
}

/**
 * 每模型偏好（settings 的 model.preferences[key]）对一个 settings scope 的
 * 通用读写器，QoderModelProvider（user 档）与 CustomModelProvider（user /
 * project 档）共用。差异只有"哪份 settings 文件"，由装配点以 scope + cwd
 * 打上，store 自身不感知路径规则。生命周期由持有方驱动：start() 一次性灌
 * 内存此后 load 走内存，stop() 清表；写侧先合并内存再按 persist 落盘（mutate
 * 原子写，只覆盖 patch 显式字段，其余键原样保留）。入参是裸模型 key，store
 * 持有 providerId 自行折算成带前缀的偏好 key（前缀段即归属）。根未绑定或
 * 文件异常退化为空表并 warn，不向调用方抛错。
 */
export class ModelConfigStore {
  private readonly entries = new Map<string, ModelConfig>();
  private started = false;

  constructor(private readonly options: CreateModelConfigStoreOptions) {}

  /** 幂等 hydration：把 scope 对应 settings 的 preferences 块整块灌进内存。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.hydrate();
  }

  /** 清空内存表，回到未启动态；下次 start() 重新 hydration。 */
  stop(): void {
    this.entries.clear();
    this.started = false;
  }

  /** 逐源容错；只收本 provider 归属的 key，project + local 按序灌入后写覆盖。 */
  private hydrate(): void {
    let sources: SettingsFileSource[];
    try {
      sources = this.readSources();
    } catch (error) {
      runLogger.warn(
        `[model-config-store] settings sources unavailable: ${error}`,
      );
      return;
    }
    for (const source of sources) {
      try {
        const text = source.read();
        if (!text) continue;
        const preferences = asRecord(
          asRecord(
            asRecord(
              JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ''))),
            )['model'],
          )['preferences'],
        );
        const owned = Object.entries(preferences)
          .map(([key, entry]) => ({
            key: this.ownedPreferenceKey(key),
            entry,
            legacy: !key.startsWith(`${this.options.providerId}/`),
          }))
          .filter(
            (item): item is { key: string; entry: unknown; legacy: boolean } =>
              item.key !== undefined,
          );
        // 旧版裸 key 先灌，新前缀 key 后灌：同一字段以新键为准。
        owned.sort((left, right) =>
          left.legacy === right.legacy ? 0 : left.legacy ? -1 : 1,
        );
        for (const { key, entry } of owned) {
          this.entries.set(
            key,
            mergeModelConfig(
              this.entries.get(key),
              modelConfigFromPreferenceEntry(entry),
            ),
          );
        }
      } catch (error) {
        runLogger.warn(`[model-config-store] hydration failed: ${error}`);
      }
    }
  }

  /**
   * 磁盘偏好 key → 内存 key。新格式为 `providerId/<key>`；qoder 仍兼容早期
   * 无前缀的裸模型 key（`auto`），映射到 `qoder/auto`，避免升级后已保存的
   * 模型设置被静默丢弃。无前缀 key 只归 qoder，custom provider 的裸 key
   * 不会被误挂到官方模型上。
   */
  private ownedPreferenceKey(key: string): string | undefined {
    const prefix = `${this.options.providerId}/`;
    if (key.startsWith(prefix)) return key;
    if (this.options.providerId === QODER_PROVIDER_ID && !key.includes('/')) {
      return `${prefix}${key}`;
    }
    return undefined;
  }

  /** 裸模型 key → 磁盘/内存偏好 key。 */
  private preferenceKey(key: string): string {
    const prefix = `${this.options.providerId}/`;
    return key.startsWith(prefix) ? key : `${prefix}${key}`;
  }

  load(key: string): ModelConfig | undefined {
    return this.entries.get(this.preferenceKey(key));
  }

  save(key: string, patch: ModelConfig, persist?: boolean): boolean {
    // 写入可能早于会话 start，先读磁盘，避免后续 hydration 覆盖会话变更。
    this.start();
    const preferenceKey = this.preferenceKey(key);
    const existing = this.entries.get(preferenceKey) ?? {};
    const merged: MutableModelConfig = mergeModelConfig(existing, patch);
    // 与请求配置的 merge 不同：偏好 patch 显式 undefined 表示恢复默认。
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) delete merged[field as keyof ModelConfig];
    }
    for (const group of ['reasoning', 'context', 'sampling'] as const) {
      const fields = patch[group];
      if (!fields) continue;
      const value = { ...merged[group] } as Record<string, unknown>;
      for (const [field, next] of Object.entries(fields)) {
        if (next === undefined) delete value[field];
      }
      if (Object.keys(value).length === 0) delete merged[group];
      else Object.assign(merged, { [group]: value });
    }
    const effort = patch.reasoning?.effort;
    const reasoningBeforeFold = merged.reasoning;
    if (effort !== undefined) {
      // 与落盘同一套折叠：改档位会连带重开/关闭思考模式，内存态不与磁盘分叉。
      delete merged.reasoning;
      Object.assign(
        merged,
        reasoningFieldsOf(
          foldReasoning(
            reasoningBlockOf({ reasoning: reasoningBeforeFold }),
            effort,
          ),
        ),
      );
    }
    this.entries.set(preferenceKey, merged);
    if (!persist) return true;
    try {
      return this.writePreferenceEntry(preferenceKey, patch);
    } catch (error) {
      runLogger.warn(`[model-config-store] persist ${key} failed: ${error}`);
      return false;
    }
  }

  /** 仅将显式 patch 合并写入目标档，保留其他偏好与 sampling 参数。 */
  private writePreferenceEntry(key: string, patch: ModelConfig): boolean {
    const target = this.writeTarget();
    if (!target) {
      runLogger.warn(
        `[model-config-store] persist ${key} skipped: settings source unavailable`,
      );
      return false;
    }
    target.mutate((latest) => {
      const model = asRecord(latest['model']);
      const preferences = asRecord(model['preferences']);
      const entry = asRecord(preferences[key]);
      for (const [field, value] of Object.entries(patch)) {
        if (value !== undefined) continue;
        if (field === 'sampling') {
          for (const key of ['temperature', 'topP', 'topK', 'stop'])
            delete entry[key];
        } else if (field === 'context') {
          delete entry['contextWindow'];
          delete entry['maxTokens'];
        } else delete entry[field];
      }
      if (patch.reasoning) {
        const raw = { ...asRecord(entry['reasoning']) };
        for (const [field, value] of Object.entries(patch.reasoning)) {
          if (value !== undefined) continue;
          delete raw[field];
          if (field === 'effort' || field === 'thinking') {
            delete raw['enabled'];
            delete raw['budgetTokens'];
          }
        }
        const block = normalizeReasoning({
          ...raw,
          ...(patch.reasoning.thinking !== undefined
            ? { thinking: patch.reasoning.thinking, enabled: undefined }
            : {}),
          ...(patch.reasoning.preserve !== undefined
            ? { preserve: patch.reasoning.preserve }
            : {}),
        });
        entry['reasoning'] = foldReasoning(
          block,
          patch.reasoning.effort ?? explicitEffortOf(block),
        );
      }
      for (const [field, value] of Object.entries(patch.sampling ?? {})) {
        if (value === undefined) delete entry[field];
        else entry[field] = value;
      }
      for (const [field, value] of Object.entries(patch.context ?? {})) {
        const key = field === 'maxOutputTokens' ? 'maxTokens' : field;
        if (value === undefined) delete entry[key];
        else entry[key] = value;
      }
      preferences[key] = entry;
      model['preferences'] = preferences;
      latest['model'] = model;
      return true;
    });
    return true;
  }

  /** project 档两份源；workspace-home 目录下无项目上下文返回 undefined。 */
  private projectSources():
    | {
        all: [SettingsFileSource, SettingsFileSource];
        write: SettingsFileSource;
      }
    | undefined {
    const storage = new Storage(this.options.cwd ?? process.cwd());
    if (storage.isWorkspaceHomeDir()) return undefined;
    const { project, local } =
      this.options.settingsService.getProjectSettingsSources(
        storage.getWorkspaceSettingsPath(),
        storage.getWorkspaceLocalSettingsPath(),
      );
    return { all: [project, local], write: project };
  }

  /** 读源列表：project 档返回 project + local 两份（local 后写覆盖）。 */
  private readSources(): SettingsFileSource[] {
    if (this.options.scope === 'user') {
      const source = this.userSource();
      return source ? [source] : [];
    }
    return this.projectSources()?.all ?? [];
  }

  /** 写档：user 写 user 档；project 写 project 档（local 留给个人手工覆盖）。 */
  private writeTarget(): SettingsFileSource | undefined {
    if (this.options.scope === 'user') return this.userSource();
    return this.projectSources()?.write;
  }

  /** 不钉根的 user 源读面；根未绑定时返回 undefined。 */
  private userSource(): SettingsFileSource | undefined {
    return this.options.settingsService.peekUserSettingsSource(
      Storage.getGlobalSettingsPath(),
    );
  }
}
