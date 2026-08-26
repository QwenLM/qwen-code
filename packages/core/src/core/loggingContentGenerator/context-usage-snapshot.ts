/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  ContentListUnion,
  ContentUnion,
  FunctionDeclaration,
  GenerateContentParameters,
  Part,
  PartUnion,
} from '@google/genai';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import { getCustomSystemPrompt } from '../prompts.js';
import { computeThresholds } from '../../services/chatCompressionService.js';
import {
  estimateContentTokens,
  estimateContextTextTokens,
} from '../../services/tokenEstimation.js';
import { buildSkillLlmContent } from '../../tools/skill-utils.js';
import { DiscoveredMCPTool } from '../../tools/mcp-tool.js';
import { ToolNames } from '../../tools/tool-names.js';
import {
  isValidContextUsage,
  type ContextUsageV1,
} from '../../telemetry/context-usage.js';

function toPart(part: PartUnion): Part {
  return typeof part === 'string' ? { text: part } : part;
}

function toContent(content: ContentUnion): Content {
  if (Array.isArray(content)) {
    return { role: 'user', parts: content.map(toPart) };
  }
  if (typeof content === 'string') {
    return { role: 'user', parts: [{ text: content }] };
  }
  if ('parts' in content) {
    return {
      ...content,
      parts: content.parts?.filter((part) => part != null).map(toPart) ?? [],
    };
  }
  return { role: 'user', parts: [toPart(content as Part)] };
}

function toContents(contents: ContentListUnion): Content[] {
  return Array.isArray(contents)
    ? contents.map((content) => toContent(content))
    : [toContent(contents)];
}

function requestFunctionDeclarations(
  request: GenerateContentParameters,
): FunctionDeclaration[] | undefined {
  const declarations: FunctionDeclaration[] = [];
  for (const tool of request.config?.tools ?? []) {
    if (typeof tool === 'object' && tool !== null && 'tool' in tool) {
      return undefined;
    }
    if (
      typeof tool === 'object' &&
      tool !== null &&
      'functionDeclarations' in tool &&
      Array.isArray(tool.functionDeclarations)
    ) {
      declarations.push(...tool.functionDeclarations);
    }
  }
  return declarations;
}

function estimateToolCategories(
  request: GenerateContentParameters,
  config: Config,
):
  | {
      builtinTools: number;
      mcpTools: number;
      skillTool: number;
    }
  | undefined {
  let builtinTools = 0;
  let mcpTools = 0;
  let skillTool = 0;
  const registry = config.getToolRegistry();

  const declarations = requestFunctionDeclarations(request);
  if (!declarations) return undefined;
  for (const declaration of declarations) {
    const tokens = estimateContextTextTokens(JSON.stringify(declaration));
    if (declaration.name === ToolNames.SKILL) {
      skillTool += tokens;
    } else if (
      declaration.name &&
      registry.getTool(declaration.name) instanceof DiscoveredMCPTool
    ) {
      mcpTools += tokens;
    } else {
      builtinTools += tokens;
    }
  }

  return { builtinTools, mcpTools, skillTool };
}

function extractMemoryTokens(
  systemInstruction: string,
  config: Config,
): { systemInstruction: string; memoryTokens: number } {
  let remaining = systemInstruction;
  let memoryTokens = 0;

  for (const configured of [
    config.getUserMemory(),
    config.getAutoMemoryPrompt(),
  ]) {
    const segment = configured.trim();
    if (!segment) continue;
    const index = remaining.indexOf(segment);
    if (index < 0) continue;
    remaining =
      remaining.slice(0, index) + remaining.slice(index + segment.length);
    memoryTokens += estimateContextTextTokens(segment);
  }

  return { systemInstruction: remaining, memoryTokens };
}

function loadedSkillBodies(config: Config): Map<string, number> {
  const skillTool = config.getToolRegistry().getTool(ToolNames.SKILL);
  if (
    !skillTool ||
    !('getLoadedSkillNames' in skillTool) ||
    typeof skillTool.getLoadedSkillNames !== 'function'
  ) {
    return new Map();
  }

  if (
    'getLoadedSkillContents' in skillTool &&
    typeof skillTool.getLoadedSkillContents === 'function'
  ) {
    return new Map(
      [...(skillTool.getLoadedSkillContents() as ReadonlySet<string>)].map(
        (content) => [content, estimateContextTextTokens(content)],
      ),
    );
  }

  const cachedSkills = config.getSkillManager()?.getCachedSkills();
  if (!cachedSkills) return new Map();

  const loadedNames = skillTool.getLoadedSkillNames() as ReadonlySet<string>;
  const indexedBodies = new Map<string, number>();
  for (const skill of cachedSkills) {
    if (!loadedNames.has(skill.name)) continue;
    const output = buildSkillLlmContent(
      path.dirname(skill.filePath),
      skill.body,
    );
    if (!indexedBodies.has(output)) {
      indexedBodies.set(output, estimateContextTextTokens(output));
    }
  }
  return indexedBodies;
}

function attributeLoadedSkillBodies(
  contents: Content[],
  indexedBodies: Map<string, number>,
): { contents: Content[]; skillBodyTokens: number } {
  if (indexedBodies.size === 0) {
    return { contents, skillBodyTokens: 0 };
  }

  let skillBodyTokens = 0;
  let contentsChanged = false;
  const attributedContents = contents.map((content) => {
    let partsChanged = false;
    const parts = content.parts?.map((part) => {
      const response = part.functionResponse;
      const output = response?.response?.['output'];
      if (response?.name !== ToolNames.SKILL || typeof output !== 'string') {
        return part;
      }
      const tokens = indexedBodies.get(output);
      if (tokens === undefined) return part;

      indexedBodies.delete(output);
      skillBodyTokens += tokens;
      partsChanged = true;
      return {
        ...part,
        functionResponse: {
          ...response,
          response: { ...response.response, output: '' },
        },
      };
    });
    if (!partsChanged) return content;
    contentsChanged = true;
    return { ...content, parts };
  });

  return {
    contents: contentsChanged ? attributedContents : contents,
    skillBodyTokens,
  };
}

export function createContextUsageSnapshot(
  request: GenerateContentParameters,
  config: Config,
  contextWindowSize: number,
): ContextUsageV1 | undefined {
  if (!Number.isSafeInteger(contextWindowSize) || contextWindowSize <= 0) {
    return undefined;
  }

  const systemText = getCustomSystemPrompt(request.config?.systemInstruction);
  const memory = extractMemoryTokens(systemText, config);
  const tools = estimateToolCategories(request, config);
  if (!tools) return undefined;
  const contents = toContents(request.contents);
  const attributedSkills = attributeLoadedSkillBodies(
    contents,
    loadedSkillBodies(config),
  );
  const thresholds = computeThresholds(
    contextWindowSize,
    config.getAutoCompactThreshold(),
  );
  const snapshot: ContextUsageV1 = {
    version: 1,
    window_size_tokens: contextWindowSize,
    breakdown: {
      system_prompt_tokens: estimateContextTextTokens(memory.systemInstruction),
      builtin_tools_tokens: tools.builtinTools,
      mcp_tools_tokens: tools.mcpTools,
      memory_files_tokens: memory.memoryTokens,
      skills_tokens: tools.skillTool + attributedSkills.skillBodyTokens,
      messages_tokens: estimateContentTokens(attributedSkills.contents),
    },
    compaction_reserve_tokens: contextWindowSize - thresholds.auto,
    estimated: true,
  };

  return isValidContextUsage(snapshot) ? snapshot : undefined;
}
