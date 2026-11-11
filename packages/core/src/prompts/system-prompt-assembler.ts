/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isPromptSectionGateKey } from '../config-service/features/promptPolicy.js';
import { maybeWriteSystemMd } from './utils.js';
import { PROMPT_SECTION_ID } from './section-ids.js';
import {
  clearSystemPromptSectionCache,
  resolveSystemPromptSections,
  systemPromptSection,
} from './section-registry.js';
import {
  ALL_PROMPT_SECTION_DESCRIPTORS,
  definePromptSectionDescriptors,
} from './sections/index.js';
import {
  ALL_PROMPT_BUNDLES,
  ALL_PROMPT_HOST_CAPABILITIES,
  ALL_PROMPT_SURFACES,
  promptSectionCacheKey,
} from './types.js';
import type {
  AssembledSystemPrompt,
  MemoryPromptVersion,
  PromptAssemblyContext,
  PromptSectionDescriptor,
  SystemPromptSection,
} from './types.js';

export interface SystemPromptAssemblerOptions {
  readonly sessionId: string;
}

const VALID_BUNDLES: ReadonlySet<string> = new Set(ALL_PROMPT_BUNDLES);
const VALID_SURFACES: ReadonlySet<string> = new Set(ALL_PROMPT_SURFACES);
const VALID_CAPABILITIES: ReadonlySet<string> = new Set(
  ALL_PROMPT_HOST_CAPABILITIES,
);

/**
 * 限制列表（省略 = 无限制）必须非空且取值合法：空数组等于「永不启用」，
 * 几乎总是笔误。
 */
function assertValidRestriction(
  versionedId: string,
  axis: string,
  values: readonly string[] | undefined,
  allowed: ReadonlySet<string>,
): void {
  if (values === undefined) return;
  if (values.length === 0 || values.some((value) => !allowed.has(value))) {
    throw new Error(`Prompt section has invalid ${axis}: ${versionedId}`);
  }
}

export function validatePromptSectionDescriptors(
  descriptors: readonly PromptSectionDescriptor[],
): void {
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    const versionedId = `${descriptor.id}@${descriptor.version}`;
    if (!descriptor.id || descriptor.id.includes('@')) {
      throw new Error(`Invalid prompt section id: ${descriptor.id}`);
    }
    if (!Number.isInteger(descriptor.version) || descriptor.version <= 0) {
      throw new Error(`Invalid prompt section version: ${versionedId}`);
    }
    if (ids.has(versionedId)) {
      throw new Error(`Duplicate prompt section descriptor: ${versionedId}`);
    }
    ids.add(versionedId);
    if (!Number.isInteger(descriptor.order) || descriptor.order < 0) {
      throw new Error(`Invalid prompt section order: ${versionedId}`);
    }
    assertValidRestriction(
      versionedId,
      'bundles',
      descriptor.eligibleBundles,
      VALID_BUNDLES,
    );
    assertValidRestriction(
      versionedId,
      'surfaces',
      descriptor.eligibleSurfaces,
      VALID_SURFACES,
    );
    assertValidRestriction(
      versionedId,
      'capabilities',
      descriptor.requiredCapabilities,
      VALID_CAPABILITIES,
    );
    if (
      descriptor.remoteGate !== undefined &&
      !isPromptSectionGateKey(descriptor.remoteGate)
    ) {
      throw new Error(`Unknown prompt section gate: ${descriptor.remoteGate}`);
    }
    if (descriptor.mandatory && descriptor.remoteGate !== undefined) {
      throw new Error(
        `Mandatory prompt section cannot be gated: ${versionedId}`,
      );
    }
  }
}

// descriptor 的约束（id / version / order / 各 eligible* 取值）都是编译期常量，
// 模块加载时校验一次即可；放在 build() 里会让每个 turn 重跑一遍全量扫描。
validatePromptSectionDescriptors(ALL_PROMPT_SECTION_DESCRIPTORS);

function isEligible(
  descriptor: PromptSectionDescriptor,
  context: PromptAssemblyContext,
): boolean {
  if (
    descriptor.eligibleBundles &&
    !descriptor.eligibleBundles.includes(context.bundle)
  ) {
    return false;
  }
  if (
    descriptor.eligibleSurfaces &&
    !descriptor.eligibleSurfaces.includes(context.surface)
  ) {
    return false;
  }
  if (
    descriptor.requiredCapabilities?.some(
      (capability) =>
        !context.renderInputs.hostCapabilities.includes(capability),
    )
  ) {
    return false;
  }
  return (
    descriptor.remoteGate === undefined ||
    context.enabledSectionGates.includes(descriptor.remoteGate)
  );
}

interface SelectedPromptSection {
  readonly descriptor: PromptSectionDescriptor;
  readonly section: SystemPromptSection;
}

function selectPromptSections(
  descriptors: readonly PromptSectionDescriptor[],
  context: PromptAssemblyContext,
): SelectedPromptSection[] {
  // Array#sort is stable (ES2019+), so equal `order` keeps declaration order.
  return descriptors
    .filter((descriptor) => isEligible(descriptor, context))
    .sort((a, b) => a.order - b.order)
    .map((descriptor) => ({
      descriptor,
      section: systemPromptSection(
        promptSectionCacheKey(descriptor, context),
        () => descriptor.render(context),
      ),
    }));
}

export class SystemPromptAssembler {
  private readonly sessionId: string;

  constructor(options: SystemPromptAssemblerOptions) {
    this.sessionId = options.sessionId;
  }

  async build(
    context: PromptAssemblyContext,
    onMemoryResolved?: (version: MemoryPromptVersion) => void,
  ): Promise<AssembledSystemPrompt> {
    const descriptors = definePromptSectionDescriptors(context);
    const selected = selectPromptSections(descriptors, context);
    // resolveSystemPromptSections 归一化后才写缓存，这里只需丢掉空 section。
    const resolved = await resolveSystemPromptSections(
      selected.map(({ section }) => section),
      this.sessionId,
    );
    let memoryPromptVersion: MemoryPromptVersion = 'none';
    const stable: string[] = [];
    const dynamic: string[] = [];
    for (const [index, section] of resolved.entries()) {
      if (section === null) continue;
      if (selected[index]?.descriptor.id === PROMPT_SECTION_ID.memoryAuto) {
        memoryPromptVersion =
          context.renderInputs.memory?.versionForBundle?.(context.bundle) ??
          'custom';
      }
      const target =
        selected[index]?.descriptor.systemBlock === 'stable'
          ? stable
          : dynamic;
      target.push(section);
    }
    const blocks: AssembledSystemPrompt = [
      stable.join('\n\n'),
      dynamic.join('\n\n'),
    ];
    maybeWriteSystemMd(() => blocks.filter(Boolean).join('\n\n'));
    onMemoryResolved?.(memoryPromptVersion);
    return blocks;
  }

  /**
   * 失效已缓存的 section。传入 sectionId 只失效该 section
   * （例如 memory 变化时无需重算读文件系统的 workflow / git 状态 section）。
   */
  clearCache(sectionId?: string): void {
    clearSystemPromptSectionCache(this.sessionId, sectionId);
  }
}
