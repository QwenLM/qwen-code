/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import {
  MessageType,
  type HistoryItemContextUsage,
  type ContextCategoryBreakdown,
  type ContextToolDetail,
  type ContextMemoryDetail,
  type ContextSkillDetail,
} from '../types.js';
import {
  DiscoveredMCPTool,
  uiTelemetryService,
  getCoreSystemPrompt,
  DEFAULT_TOKEN_LIMIT,
  ToolNames,
  SkillTool,
  buildSkillLlmContent,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

/**
 * Default compression token threshold (triggers compression at 70% usage).
 * The autocompact buffer is (1 - threshold) * contextWindowSize.
 */
const DEFAULT_COMPRESSION_THRESHOLD = 0.7;

/**
 * Estimate token count for a string using a character-based heuristic.
 * ASCII chars ≈ 4 chars/token, CJK/non-ASCII chars ≈ 1.5 tokens/char.
 */
function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    if (charCode < 128) {
      asciiChars++;
    } else {
      nonAsciiChars++;
    }
  }
  // CJK and other non-ASCII characters typically produce 1.5-2 tokens each
  return Math.ceil(asciiChars / 4 + nonAsciiChars * 1.5);
}

/**
 * Parse concatenated memory content into individual file entries.
 * Memory content format: "--- Context from: <path> ---\n<content>\n--- End of Context from: <path> ---"
 */
function parseMemoryFiles(memoryContent: string): ContextMemoryDetail[] {
  if (!memoryContent || memoryContent.trim().length === 0) return [];

  const results: ContextMemoryDetail[] = [];
  // Use backreference (\1) to ensure start/end path markers match
  const regex =
    /--- Context from: (.+?) ---\n([\s\S]*?)--- End of Context from: \1 ---/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(memoryContent)) !== null) {
    const filePath = match[1]!;
    const content = match[2]!;
    results.push({
      path: filePath,
      tokens: estimateTokens(content),
    });
  }

  // If no structured markers found, treat as a single memory block
  if (results.length === 0 && memoryContent.trim().length > 0) {
    results.push({
      path: t('memory'),
      tokens: estimateTokens(memoryContent),
    });
  }

  return results;
}

export async function collectContextData(
  config: import('@qwen-code/qwen-code-core').Config,
  showDetails: boolean,
): Promise<HistoryItemContextUsage> {
  const modelName = config.getModel() || 'unknown';
  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const contextWindowSize =
    contentGeneratorConfig.contextWindowSize ?? DEFAULT_TOKEN_LIMIT;

  const apiTotalTokens = uiTelemetryService.getLastPromptTokenCount();
  const apiCachedTokens = uiTelemetryService.getLastCachedContentTokenCount();

  const systemPromptText = getCoreSystemPrompt(undefined, modelName);
  const systemPromptTokens = estimateTokens(systemPromptText);

  const toolRegistry = config.getToolRegistry();
  const allTools = toolRegistry ? toolRegistry.getAllTools() : [];
  const toolDeclarations = toolRegistry
    ? toolRegistry.getFunctionDeclarations()
    : [];
  const toolsJsonStr = JSON.stringify(toolDeclarations);
  const allToolsTokens = estimateTokens(toolsJsonStr);

  const builtinTools: ContextToolDetail[] = [];
  const mcpTools: ContextToolDetail[] = [];
  for (const tool of allTools) {
    const toolJsonStr = JSON.stringify(tool.schema);
    const tokens = estimateTokens(toolJsonStr);
    if (tool instanceof DiscoveredMCPTool) {
      mcpTools.push({
        name: `${tool.serverName}__${tool.serverToolName || tool.name}`,
        tokens,
      });
    } else if (tool.name !== ToolNames.SKILL) {
      builtinTools.push({
        name: tool.name,
        tokens,
      });
    }
  }

  const memoryContent = config.getUserMemory();
  const memoryFiles = parseMemoryFiles(memoryContent);
  const memoryFilesTokens = memoryFiles.reduce((sum, f) => sum + f.tokens, 0);

  const skillTool = allTools.find((tool) => tool.name === ToolNames.SKILL);
  const skillToolDefinitionTokens = skillTool
    ? estimateTokens(JSON.stringify(skillTool.schema))
    : 0;

  const loadedSkillNames: ReadonlySet<string> =
    skillTool instanceof SkillTool
      ? skillTool.getLoadedSkillNames()
      : new Set();

  const skillManager = config.getSkillManager();
  const skillConfigs = skillManager ? await skillManager.listSkills() : [];
  let loadedBodiesTokens = 0;
  const skills: ContextSkillDetail[] = skillConfigs.map((skill) => {
    const listingTokens = estimateTokens(
      `<skill>\n<name>\n${skill.name}\n</name>\n<description>\n${skill.description} (${skill.level})\n</description>\n<location>\n${skill.level}\n</location>\n</skill>`,
    );
    const isLoaded = loadedSkillNames.has(skill.name);
    let bodyTokens: number | undefined;
    if (isLoaded && skill.body) {
      const baseDir = skill.filePath
        ? skill.filePath.replace(/\/[^/]+$/, '')
        : '';
      bodyTokens = estimateTokens(buildSkillLlmContent(baseDir, skill.body));
      loadedBodiesTokens += bodyTokens;
    }
    return {
      name: skill.name,
      tokens: listingTokens,
      loaded: isLoaded,
      bodyTokens,
    };
  });

  const skillsTokens = skillToolDefinitionTokens + loadedBodiesTokens;

  const compressionThreshold =
    config.getChatCompression()?.contextPercentageThreshold ??
    DEFAULT_COMPRESSION_THRESHOLD;
  const autocompactBuffer =
    compressionThreshold > 0
      ? Math.round((1 - compressionThreshold) * contextWindowSize)
      : 0;

  const rawOverhead =
    systemPromptTokens +
    allToolsTokens +
    memoryFilesTokens +
    loadedBodiesTokens;

  const isEstimated = apiTotalTokens === 0;

  const mcpToolsTotalTokens = mcpTools.reduce(
    (sum, tool) => sum + tool.tokens,
    0,
  );

  let totalTokens: number;
  let displaySystemPrompt: number;
  let displayBuiltinTools: number;
  let displayMcpTools: number;
  let displayMemoryFiles: number;
  let displaySkills: number;
  let messagesTokens: number;
  let freeSpace: number;
  let detailBuiltinTools: ContextToolDetail[];
  let detailMcpTools: ContextToolDetail[];
  let detailMemoryFiles: ContextMemoryDetail[];
  let detailSkills: ContextSkillDetail[];

  if (isEstimated) {
    totalTokens = 0;
    displaySystemPrompt = systemPromptTokens;
    displaySkills = skillsTokens;
    displayBuiltinTools = Math.max(
      0,
      allToolsTokens - skillToolDefinitionTokens - mcpToolsTotalTokens,
    );
    displayMcpTools = mcpToolsTotalTokens;
    displayMemoryFiles = memoryFilesTokens;
    messagesTokens = 0;
    freeSpace = Math.max(
      0,
      contextWindowSize - rawOverhead - autocompactBuffer,
    );
    detailBuiltinTools = builtinTools;
    detailMcpTools = mcpTools;
    detailMemoryFiles = memoryFiles;
    detailSkills = skills;
  } else {
    totalTokens = apiTotalTokens;

    const overheadScale =
      rawOverhead > totalTokens ? totalTokens / rawOverhead : 1;

    displaySystemPrompt = Math.round(systemPromptTokens * overheadScale);
    const scaledAllTools = Math.round(allToolsTokens * overheadScale);
    displayMemoryFiles = Math.round(memoryFilesTokens * overheadScale);
    displaySkills = Math.round(skillsTokens * overheadScale);
    const scaledMcpTotal = Math.round(mcpToolsTotalTokens * overheadScale);
    displayMcpTools = scaledMcpTotal;
    const scaledSkillDefinition = Math.round(
      skillToolDefinitionTokens * overheadScale,
    );
    displayBuiltinTools = Math.max(
      0,
      scaledAllTools - scaledSkillDefinition - scaledMcpTotal,
    );

    const scaledOverhead =
      displaySystemPrompt +
      scaledAllTools +
      displayMemoryFiles +
      Math.round(loadedBodiesTokens * overheadScale);

    if (apiCachedTokens > 0) {
      messagesTokens = Math.max(0, totalTokens - apiCachedTokens);
    } else {
      messagesTokens = Math.max(0, totalTokens - scaledOverhead);
    }

    freeSpace = Math.max(
      0,
      contextWindowSize - totalTokens - autocompactBuffer,
    );

    const scaleDetail = <T extends { tokens: number }>(items: T[]): T[] =>
      overheadScale < 1
        ? items.map((item) => ({
            ...item,
            tokens: Math.round(item.tokens * overheadScale),
          }))
        : items;

    detailBuiltinTools = scaleDetail(builtinTools);
    detailMcpTools = scaleDetail(mcpTools);
    detailMemoryFiles = scaleDetail(memoryFiles);
    detailSkills =
      overheadScale < 1
        ? skills.map((item) => ({
            ...item,
            tokens: Math.round(item.tokens * overheadScale),
            bodyTokens: item.bodyTokens
              ? Math.round(item.bodyTokens * overheadScale)
              : undefined,
          }))
        : skills;
  }

  const breakdown: ContextCategoryBreakdown = {
    systemPrompt: displaySystemPrompt,
    builtinTools: displayBuiltinTools,
    mcpTools: displayMcpTools,
    memoryFiles: displayMemoryFiles,
    skills: displaySkills,
    messages: messagesTokens,
    freeSpace,
    autocompactBuffer,
  };

  return {
    type: MessageType.CONTEXT_USAGE,
    modelName,
    totalTokens,
    contextWindowSize,
    breakdown,
    builtinTools: detailBuiltinTools,
    mcpTools: detailMcpTools,
    memoryFiles: detailMemoryFiles,
    skills: detailSkills,
    isEstimated,
    showDetails,
  };
}

export const contextCommand: SlashCommand = {
  name: 'context',
  get description() {
    return t(
      'Show context window usage breakdown. Use "/context detail" for per-item breakdown.',
    );
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext, args?: string) => {
    const showDetails =
      args?.trim().toLowerCase() === 'detail' ||
      args?.trim().toLowerCase() === '-d';
    const { config } = context.services;
    if (!config) {
      if (context.executionMode === 'interactive') {
        context.ui.addItem(
          {
            type: MessageType.ERROR,
            text: t('Config not loaded.'),
          },
          Date.now(),
        );
        return;
      }
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const contextUsageItem = await collectContextData(config, showDetails);

    if (context.executionMode === 'interactive') {
      context.ui.addItem(contextUsageItem, Date.now());
      return;
    } else {
      return {
        type: 'message',
        messageType: 'info',
        content: JSON.stringify(contextUsageItem, null, 2),
      };
    }
  },
};
