/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptSectionGateKey } from '../config-service/features/promptPolicy.js';
import type { ResolvedCommunication } from './behavior-policy.js';
import type { CodeModeSetting } from '../codemode/settings.js';

/** cache_control 的 scope 取值 */
export type CacheScope = 'org' | 'global';

/**
 * 单一事实来源：每个枚举只声明一次，联合类型由数组派生。
 * Section 描述符与 validatePromptSectionDescriptors 共用这些常量，
 * 新增一个 surface / bundle 只需改这一处。
 */
export const ALL_PROMPT_BUNDLES = ['full', 'lean'] as const;
export type PromptBundle = (typeof ALL_PROMPT_BUNDLES)[number];

export const ALL_ASSEMBLED_PROMPT_SOURCES = ['default'] as const;
export type AssembledPromptSource =
  (typeof ALL_ASSEMBLED_PROMPT_SOURCES)[number];

export const ALL_PROMPT_HOST_CAPABILITIES = [
  'compression',
  'memory',
  'workflows',
] as const;
export type PromptHostCapability =
  (typeof ALL_PROMPT_HOST_CAPABILITIES)[number];

/**
 * 与 entry surface 是不同的轴，尽管 4 个成员同名：这里把 'tui' 记作 'local_tui'，
 * 且没有 'acp'——ACP 在 acpClient 里已归并成 'sdk'。改动任一侧时不要假设两者
 * 可以互换。
 */
export const ALL_PROMPT_SURFACES = [
  'local_tui',
  'headless',
  'sdk',
  'remote_worker',
] as const;
export type PromptSurface = (typeof ALL_PROMPT_SURFACES)[number];

export type PromptSource =
  | 'default'
  | 'override'
  | 'custom'
  | 'agent';

export type SystemPromptBlockKind = 'stable' | 'dynamic';

export interface SystemPromptTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** System prompt content accepted by a model request. */
export type SystemPrompt = readonly SystemPromptTextBlock[];

export type AssembledSystemPrompt = readonly [stable: string, dynamic: string];

/** CLI-owned prompts report skill; full/lean remain valid for legacy and SDK metadata. */
export type MemoryPromptVersion = 'full' | 'lean' | 'skill' | 'custom' | 'none';

export type PromptBuildResult = {
  readonly memoryPromptVersion?: MemoryPromptVersion;
} & (
  | {
      readonly blocks: SystemPrompt;
      readonly source: 'default';
      readonly bundle: PromptBundle;
    }
  | {
      readonly blocks: SystemPrompt;
      readonly source: Exclude<PromptSource, 'default'>;
      readonly bundle?: never;
    }
);

export type SdkMemoryPromptState =
  | { readonly owner: 'native' }
  | { readonly owner: 'none' }
  | {
      readonly owner: 'sdk';
      readonly prompt: string;
      readonly version?: MemoryPromptVersion;
      readonly shapeKey: number;
    }
  | {
      /** SDK controls the roots, but the CLI owns the generated prompt body. */
      readonly owner: 'sdk';
      readonly promptsByBundle: Readonly<Record<PromptBundle, string>>;
      readonly shapeKey: number;
    };

export interface PromptSectionInput {
  readonly cacheVariant: string;
  compute(): string | null | Promise<string | null>;
}

export interface PromptBundleSectionInput {
  readonly cacheVariant: string;
  computeForBundle(
    bundle: PromptBundle,
  ): string | null | Promise<string | null>;
}

export interface PromptRenderInputs {
  readonly language?: PromptSectionInput;
  readonly outputStyle?: PromptSectionInput & {
    readonly keepCodingInstructions: boolean;
  };
  readonly usingTools: PromptSectionInput;
  readonly codeMode?: CodeModeSetting;
  readonly hostCapabilities: readonly PromptHostCapability[];
  /** 由输入的所有者决定 full / lean 下渲染什么。 */
  readonly memory?: PromptBundleSectionInput & {
    readonly owner: 'native' | 'sdk';
    versionForBundle?(bundle: PromptBundle): MemoryPromptVersion;
  };
  readonly sessionGuidance?: PromptBundleSectionInput;
}

export interface PromptAssemblyContext {
  readonly source: AssembledPromptSource;
  readonly bundle: PromptBundle;
  readonly surface: PromptSurface;
  readonly renderInputs: PromptRenderInputs;
  readonly enabledSectionGates: readonly PromptSectionGateKey[];
  readonly communication?: ResolvedCommunication;
  /** Present only when the section is enabled. Omit text for the built-in body. */
  readonly frontendGuidance?: { readonly text?: string };
}

export interface PromptSectionDescriptor {
  readonly id: string;
  readonly version: number;
  /** 请求中的 system block。该字段与 block 内的排列顺序相互独立。 */
  readonly systemBlock: SystemPromptBlockKind;
  /** section 在所属 system block 内的排列顺序。 */
  readonly order: number;
  /**
   * 只声明「限制」：省略 = 对所有 bundle / surface 生效。
   * 避免每个 descriptor 重复列举全集（新增 surface 时漏改会静默丢 section）。
   */
  readonly eligibleBundles?: readonly PromptBundle[];
  readonly eligibleSurfaces?: readonly PromptSurface[];
  readonly requiredCapabilities?: readonly PromptHostCapability[];
  readonly remoteGate?: PromptSectionGateKey;
  /** 强制 section：不允许被 remoteGate 关闭（由校验器强制）。 */
  readonly mandatory?: boolean;
  /**
   * cache key 的可变后缀。缓存键固定为 `${id}@${version}`，
   * 返回非空值时追加 `:${variant}`——无需手写、也不会与 id/version 失同步。
   */
  cacheVariant?(context: PromptAssemblyContext): string;
  render(
    context: PromptAssemblyContext,
  ): string | null | Promise<string | null>;
}

/** 计算一个 section 的完整缓存键。 */
export function promptSectionCacheKey(
  descriptor: PromptSectionDescriptor,
  context: PromptAssemblyContext,
): string {
  const base = `${descriptor.id}@${descriptor.version}`;
  const variant = descriptor.cacheVariant?.(context);
  return variant ? `${base}:${variant}` : base;
}

/**
 * Agent 定义的最小接口，供 buildEffectiveSystemPrompt 使用。
 * 调用方注入具体的 AgentDefinition 实现。
 */
export interface AgentDefinitionLike {
  getSystemPrompt(): string;
}

/** 计算函数类型：同步或异步，返回字符串或 null（表示该 section 不存在） */
export type SectionComputeFn = () => string | null | Promise<string | null>;

/**
 * 一个待解析的 system prompt section：第一次 compute() 后缓存到 session 结束
 * （或显式失效）。易变内容不走 section——它们作为 attachment 进入对话历史。
 */
export interface SystemPromptSection {
  name: string;
  compute: SectionComputeFn;
}
