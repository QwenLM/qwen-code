/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResolvedPromptSource } from './effective-prompt.js';
import {
  MANDATORY_PREFIX_SEPARATOR,
  renderReplacementMandatoryPrefix,
} from './mandatory-prefix.js';
import {
  areSystemPromptBlocksEnabled,
  systemPromptFromText,
} from './system-prompt.js';
import type { SystemPromptAssembler } from './system-prompt-assembler.js';
import type {
  MemoryPromptVersion,
  PromptAssemblyContext,
  PromptBuildResult,
  PromptSurface,
  SdkMemoryPromptState,
  SystemPrompt,
} from './types.js';

export interface BuildSystemPromptForTurnOptions {
  /**
   * 由调用方用 resolveEffectivePromptSource() 解析好传进来。这里不再接收
   * override / custom / agent 三个原始输入——否则同一套优先级会有两份实现，
   * 而且同时传两者时原始字段会被静默忽略。
   */
  readonly resolvedSource: ResolvedPromptSource;
  readonly promptSurface?: PromptSurface;
  readonly cliAppendSystemPrompt?: string;
  readonly appendSystemPrompt?: string;
  readonly assemblyContext?: PromptAssemblyContext;
  readonly sdkMemoryState?: SdkMemoryPromptState;
}

function joinNonEmpty(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    )
    .join(MANDATORY_PREFIX_SEPARATOR);
}

function buildSystemPromptBlocks(
  stable: string,
  dynamic: string,
): SystemPrompt {
  const parts = [stable, dynamic].filter((part) => part.length > 0);
  if (!areSystemPromptBlocksEnabled()) {
    return systemPromptFromText(parts.join(MANDATORY_PREFIX_SEPARATOR));
  }
  return parts.map((text) => ({ type: 'text', text }));
}

export async function buildSystemPromptResultForTurn(
  assembler: SystemPromptAssembler | undefined,
  options: BuildSystemPromptForTurnOptions,
): Promise<PromptBuildResult> {
  const resolved = options.resolvedSource;
  // SDK initialize historically treats its append as an override of the CLI
  // append source. Other surfaces merge the startup and runtime sources.
  const mergedAppend =
    options.promptSurface === 'sdk'
      ? joinNonEmpty([
          options.appendSystemPrompt !== undefined
            ? options.appendSystemPrompt
            : options.cliAppendSystemPrompt,
        ])
      : joinNonEmpty([
          options.cliAppendSystemPrompt,
          options.appendSystemPrompt,
        ]);

  if (resolved.source === 'default') {
    if (!assembler || !options.assemblyContext) {
      throw new Error(
        `Prompt assembler and assembly context are required for source=${resolved.source}`,
      );
    }
    let memoryPromptVersion: MemoryPromptVersion | undefined;
    const [stableSections, dynamicSections] = await assembler.build(
      options.assemblyContext,
      (version) => {
        memoryPromptVersion = version;
      },
    );
    const memoryMetadata =
      memoryPromptVersion === undefined ? {} : { memoryPromptVersion };
    const dynamic = joinNonEmpty([dynamicSections, mergedAppend]);
    const blocks = buildSystemPromptBlocks(stableSections, dynamic);
    return {
      blocks,
      source: 'default',
      bundle: options.assemblyContext.bundle,
      ...memoryMetadata,
    };
  }

  // Fixed-body sources (override / custom / agent) render no sections, so they
  // never carry an assembly context — `promptSurface` is the only surface here.
  const prefix = renderReplacementMandatoryPrefix();
  // SDK overrides omit the main-session memory prompt.
  const sdkMemoryPrompt =
    resolved.source !== 'override' &&
    options.promptSurface === 'sdk' &&
    options.sdkMemoryState?.owner === 'sdk'
      ? 'prompt' in options.sdkMemoryState
        ? options.sdkMemoryState.prompt
        : options.sdkMemoryState.promptsByBundle.full
      : undefined;
  // The generic override remains absolute. Remote Worker and SDK are protocol
  // compatibility exceptions: develop precomposed their integration append
  // with the override before passing it to QueryEngine.
  const overrideAppend =
    resolved.source === 'override' &&
    (options.promptSurface === 'remote_worker' ||
      options.promptSurface === 'sdk')
      ? options.promptSurface === 'remote_worker'
        ? joinNonEmpty([options.appendSystemPrompt])
        : mergedAppend
      : undefined;
  const blocks = buildSystemPromptBlocks(
    joinNonEmpty([prefix, resolved.fixedBody]),
    joinNonEmpty([
      resolved.source === 'override' ? overrideAppend : mergedAppend,
      sdkMemoryPrompt,
    ]),
  );
  const sdkState = options.sdkMemoryState;
  const memoryPromptVersion: MemoryPromptVersion | undefined =
    sdkMemoryPrompt?.trim() && sdkState?.owner === 'sdk'
      ? 'prompt' in sdkState
        ? (sdkState.version ?? 'custom')
        : 'skill'
      : undefined;
  return {
    blocks,
    source: resolved.source,
    ...(memoryPromptVersion === undefined ? {} : { memoryPromptVersion }),
  };
}

export async function buildSystemPromptForTurn(
  assembler: SystemPromptAssembler | undefined,
  options: BuildSystemPromptForTurnOptions,
): Promise<SystemPrompt> {
  return (await buildSystemPromptResultForTurn(assembler, options)).blocks;
}
