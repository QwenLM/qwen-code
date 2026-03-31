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
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Config not loaded.'),
        },
        Date.now(),
      );
      return;
    }

    // --- Gather data ---

    const modelName = config.getModel() || 'unknown';
    const contentGeneratorConfig = config.getContentGeneratorConfig();
    const contextWindowSize =
      contentGeneratorConfig.contextWindowSize ?? DEFAULT_TOKEN_LIMIT;

    // Total prompt token count from API (most accurate)
    const apiTotalTokens = uiTelemetryService.getLastPromptTokenCount();
    // Cached content token count — when available (e.g. DashScope prefix caching),
    // represents the cached overhead (system prompt + tools). Using this gives a much
    // more accurate "Messages" count: promptTokens - cachedTokens = actual history tokens.
    const apiCachedTokens = uiTelemetryService.getLastCachedContentTokenCount();

    // 1. System prompt tokens (without memory, as memory is counted separately)
    const systemPromptText = getCoreSystemPrompt(undefined, modelName).full;
    const systemPromptTokens = estimateTokens(systemPromptText);

    // 2. Tool declarations tokens (includes ALL tools: built-in, MCP, skill tool)
    const toolRegistry = config.getToolRegistry();
    const allTools = toolRegistry ? toolRegistry.getAllTools() : [];
    const toolDeclarations = toolRegistry
      ? toolRegistry.getFunctionDeclarations()
      : [];
    const toolsJsonStr = JSON.stringify(toolDeclarations);
    const allToolsTokens = estimateTokens(toolsJsonStr);

    // 3. Per-tool details (for breakdown display)
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
        // Built-in tool (exclude SkillTool, which is shown under Skills)
        builtinTools.push({
          name: tool.name,
          tokens,
        });
      }
    }

    // 4. Memory files
    const memoryContent = config.getUserMemory();
    const memoryFiles = parseMemoryFiles(memoryContent);
    const memoryFilesTokens = memoryFiles.reduce((sum, f) => sum + f.tokens, 0);

    // 5. Skills (progressive disclosure)
    //    Two cost components:
    //    a) Tool definition: SkillTool's description embeds all skill
    //       name+description listings plus instruction text — always in context.
    //    b) Loaded bodies: When the model invokes a skill, the full SKILL.md
    //       body is injected into the conversation as a tool result. We track
    //       which skills have been loaded and attribute their body tokens here
    //       so the "Skills" category accurately reflects the total cost.
    const skillTool = allTools.find((tool) => tool.name === ToolNames.SKILL);
    const skillToolDefinitionTokens = skillTool
      ? estimateTokens(JSON.stringify(skillTool.schema))
      : 0;

    // Determine which skills have been loaded in this session
    const loadedSkillNames: ReadonlySet<string> =
      skillTool instanceof SkillTool
        ? skillTool.getLoadedSkillNames()
        : new Set();

    // Per-skill breakdown: listing cost + body cost for loaded skills
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

    // Total skills cost = tool definition + loaded bodies
    const skillsTokens = skillToolDefinitionTokens + loadedBodiesTokens;

    // 6. Autocompact buffer
    const compressionThreshold =
      config.getChatCompression()?.contextPercentageThreshold ??
      DEFAULT_COMPRESSION_THRESHOLD;
    const autocompactBuffer =
      compressionThreshold > 0
        ? Math.round((1 - compressionThreshold) * contextWindowSize)
        : 0;

    // 7. Calculate raw overhead
    //    allToolsTokens includes the skill tool definition; loadedBodiesTokens
    //    covers the on-demand skill bodies now attributed to Skills.
    const rawOverhead =
      systemPromptTokens +
      allToolsTokens +
      memoryFilesTokens +
      loadedBodiesTokens;

    // 8. Determine total tokens and build breakdown
    const isEstimated = apiTotalTokens === 0;

    // Sum of MCP tool tokens for category-level display
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
      // No API data yet: show raw overhead estimates only.
      // Use 0 as totalTokens so the progress bar stays empty —
      // avoids showing an inflated estimate that would "decrease"
      // once real API data arrives.
      totalTokens = 0;
      displaySystemPrompt = systemPromptTokens;
      // Skills = tool definition + loaded bodies
      displaySkills = skillsTokens;
      // builtinTools = allTools minus skills-definition minus mcpTools
      displayBuiltinTools = Math.max(
        0,
        allToolsTokens - skillToolDefinitionTokens - mcpToolsTotalTokens,
      );
      displayMcpTools = mcpToolsTotalTokens;
      displayMemoryFiles = memoryFilesTokens;
      messagesTokens = 0;
      // Free space accounts for the estimated overhead
      freeSpace = Math.max(
        0,
        contextWindowSize - rawOverhead - autocompactBuffer,
      );
      detailBuiltinTools = builtinTools;
      detailMcpTools = mcpTools;
      detailMemoryFiles = memoryFiles;
      detailSkills = skills;
    } else {
      // API data available: use actual total with proportional scaling
      totalTokens = apiTotalTokens;

      // When estimates overshoot API total, scale down proportionally
      // so the breakdown categories add up to totalTokens.
      const overheadScale =
        rawOverhead > totalTokens ? totalTokens / rawOverhead : 1;

      displaySystemPrompt = Math.round(systemPromptTokens * overheadScale);
      const scaledAllTools = Math.round(allToolsTokens * overheadScale);
      displayMemoryFiles = Math.round(memoryFilesTokens * overheadScale);
      // Skills = tool definition + loaded bodies (scaled together)
      displaySkills = Math.round(skillsTokens * overheadScale);
      const scaledMcpTotal = Math.round(mcpToolsTotalTokens * overheadScale);
      displayMcpTools = scaledMcpTotal;
      // builtinTools = allTools minus skill-definition minus mcpTools
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

      // When the API reports cached content tokens (e.g. DashScope prefix caching),
      // use them as the actual overhead indicator for a more accurate messages count.
      // cachedTokens ≈ system prompt + tools tokens actually served from cache.
      // This avoids the "messages = 0" problem caused by estimation overshoot.
      if (apiCachedTokens > 0) {
        messagesTokens = Math.max(0, totalTokens - apiCachedTokens);
      } else {
        messagesTokens = Math.max(0, totalTokens - scaledOverhead);
      }

      freeSpace = Math.max(
        0,
        contextWindowSize - totalTokens - autocompactBuffer,
      );

      // Scale detail items to match their parent categories
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

    const contextUsageItem: HistoryItemContextUsage = {
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

    context.ui.addItem(contextUsageItem, Date.now());
  },
};
