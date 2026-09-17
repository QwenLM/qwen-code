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
  type ContextTier,
  type ContextToolDetail,
  type ContextMemoryDetail,
  type ContextSkillDetail,
} from '../types.js';
import type { Content } from '@google/genai';
import {
  DiscoveredMCPTool,
  uiTelemetryService,
  getMainSessionBaseSystemPrompt,
  DEFAULT_TOKEN_LIMIT,
  ToolNames,
  buildAvailableSkillsReminder,
  buildSkillLlmContent,
  computeThresholds,
  getStartupContextLength,
  isMediaPolicyToolHiddenFromModel,
  estimateContextTextTokens,
  formatContextFileDisplayPath,
  type CompactionThresholds,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import * as path from 'node:path';

/**
 * Classify a token count against the three-tier compaction ladder. Mirrors
 * the gating logic in `chatCompressionService` / `llmChat` so the
 * `/context` output's "current tier" label reflects exactly which tier the
 * runtime would treat the session as sitting in.
 */
function currentTier(
  tokens: number,
  thresholds: CompactionThresholds,
): ContextTier {
  if (tokens >= thresholds.hard) return 'hard';
  if (tokens >= thresholds.auto) return 'auto';
  if (tokens >= thresholds.warn) return 'warn';
  return 'safe';
}

/**
 * Parse concatenated memory content into individual file entries.
 * Memory content format: "--- Context from: <path> ---\n<content>\n--- End of Context from: <path> ---"
 */
function parseMemoryFiles(
  memoryContent: string,
  workingDir: string,
): ContextMemoryDetail[] {
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
      // Marker paths are relative to the session working directory (where
      // memory discovery ran, which may differ from process.cwd() in
      // ACP/daemon-served sessions); shorten home-dir files to `~/...` so
      // global memory files don't render as `../../..` chains.
      path: formatContextFileDisplayPath(
        path.resolve(workingDir, filePath),
        workingDir,
      ),
      tokens: estimateContextTextTokens(content),
    });
  }

  // If no structured markers found, treat as a single memory block
  if (results.length === 0 && memoryContent.trim().length > 0) {
    results.push({
      path: t('memory'),
      tokens: estimateContextTextTokens(memoryContent),
    });
  }

  return results;
}

/** Inverse of core's `escapeXml`; `&amp;` is decoded last. */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// `buildAvailableSkillsReminder` emits either the listing or, when nothing is
// available, a fixed notice in the same prelude slot.
const AVAILABLE_SKILLS_OPEN = '<available_skills>';
const NO_SKILLS_NOTICE = 'No skills are currently available.';
const SKILL_LISTING_ENTRY =
  /<skill>\n<name>\n([\s\S]*?)\n<\/name>[\s\S]*?<\/skill>/g;

interface SkillListingCost {
  /** The whole listing reminder as sent, wrapper included. */
  tokens: number;
  /** Per-entry cost, keyed by lower-cased skill name. */
  byName: Map<string, number>;
}

function isSkillListingText(text: string): boolean {
  return (
    text.includes(AVAILABLE_SKILLS_OPEN) || text.includes(NO_SKILLS_NOTICE)
  );
}

// Measured from the rendered text rather than re-derived from skill configs,
// so budget trimming and XML escaping are reflected exactly (#12033).
function measureSkillListing(text: string): SkillListingCost {
  const byName = new Map<string, number>();
  for (const match of text.matchAll(SKILL_LISTING_ENTRY)) {
    byName.set(
      unescapeXml(match[1]!).toLowerCase(),
      estimateContextTextTokens(match[0]),
    );
  }
  return { tokens: estimateContextTextTokens(text), byName };
}

interface StartupPreludeCost {
  skillListing: SkillListingCost;
  /** Prelude text outside the skill listing (environment context, MCP server instructions, deferred-tools reminder). */
  startupContextTokens: number;
}

function measureStartupPrelude(prelude: Content[]): StartupPreludeCost {
  const skillListing: SkillListingCost = { tokens: 0, byName: new Map() };
  let startupContextTokens = 0;
  for (const content of prelude) {
    for (const part of content.parts ?? []) {
      if (typeof part.text !== 'string') continue;
      if (isSkillListingText(part.text)) {
        const listing = measureSkillListing(part.text);
        skillListing.tokens += listing.tokens;
        for (const [name, tokens] of listing.byName) {
          skillListing.byName.set(name, tokens);
        }
      } else {
        startupContextTokens += estimateContextTextTokens(part.text);
      }
    }
  }
  return { skillListing, startupContextTokens };
}

/**
 * Content estimate of the conversation after the startup prelude. Skill tool
 * responses are skipped because the bodies they carry are billed under
 * `skills`. Media parts have no text to estimate; the provider still counts
 * them, so their cost surfaces as `unattributed`.
 */
function estimateConversationTokens(conversation: Content[]): number {
  let tokens = 0;
  for (const content of conversation) {
    for (const part of content.parts ?? []) {
      if (typeof part.text === 'string') {
        tokens += estimateContextTextTokens(part.text);
      } else if (part.functionCall) {
        tokens += estimateContextTextTokens(JSON.stringify(part.functionCall));
      } else if (
        part.functionResponse &&
        part.functionResponse.name !== ToolNames.SKILL
      ) {
        tokens += estimateContextTextTokens(
          JSON.stringify(part.functionResponse),
        );
      }
    }
  }
  return tokens;
}

export async function collectContextData(
  config: import('@qwen-code/qwen-code-core').Config,
  showDetails: boolean,
): Promise<HistoryItemContextUsage> {
  const modelName = config.getModel() || 'unknown';
  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const contextWindowSize =
    contentGeneratorConfig.contextWindowSize ?? DEFAULT_TOKEN_LIMIT;

  // Prefer the per-session chat's API-reported count. `uiTelemetryService` is
  // a process-global singleton shared by every session in a `serve` daemon, so
  // reading it here reports whichever session most recently completed a turn
  // (#5763). The active chat carries the correct per-session value; fall back
  // to the global singleton only when no chat exists yet (first /context,
  // --continue resume before any send).
  const llmClient = config.getLlmClient?.();
  const activeChat = llmClient?.isInitialized?.()
    ? llmClient.getChat()
    : undefined;
  const apiTotalTokens = activeChat
    ? activeChat.getLastPromptTokenCount()
    : uiTelemetryService.getLastPromptTokenCount();
  // Same per-session preference as the total (#5763 / #12047): the global
  // singleton reports whichever session last completed a turn in a `serve`
  // daemon. Fall back only when no chat exists yet.
  const apiCachedTokens =
    activeChat?.getLastCachedContentTokenCount?.() ??
    uiTelemetryService.getLastCachedContentTokenCount();

  // The startup prelude and the conversation after it are billed request
  // content, so both are measured from the history the chat will send.
  const history = activeChat?.getHistory?.() ?? [];
  const preludeLength = getStartupContextLength(history);
  const prelude = measureStartupPrelude(history.slice(0, preludeLength));
  const conversationTokens = estimateConversationTokens(
    history.slice(preludeLength),
  );

  const systemPromptText = getMainSessionBaseSystemPrompt(config);
  const systemPromptTokens = estimateContextTextTokens(systemPromptText);

  const toolRegistry = config.getToolRegistry();
  const allTools = toolRegistry ? toolRegistry.getAllTools() : [];
  // Match what's actually sent to the model: deferred tools — MCP tools and
  // low-frequency built-ins like web_fetch / monitor / cron_* — are absent
  // from the prompt unless ToolSearch has revealed them this session. See
  // client.ts which calls getFunctionDeclarations() with no args. The
  // per-tool loop below applies the same filter so allToolsTokens stays
  // aligned with the breakdown sum.
  const toolDeclarations = toolRegistry
    ? toolRegistry.getFunctionDeclarations()
    : [];
  const toolsJsonStr = JSON.stringify(toolDeclarations);
  const allToolsTokens = estimateContextTextTokens(toolsJsonStr);

  const builtinTools: ContextToolDetail[] = [];
  const mcpTools: ContextToolDetail[] = [];
  for (const tool of allTools) {
    if (toolRegistry?.isDeferredAndHidden(tool.name)) {
      continue;
    }
    // Same alignment rule for omni media-policy tools: fixed-only tools
    // (declared descriptor, modelAccess not enabled) are stripped from
    // getFunctionDeclarations() and cost the model zero prompt tokens, so
    // listing them here would make the breakdown sum exceed allToolsTokens.
    if (isMediaPolicyToolHiddenFromModel(config, tool)) {
      continue;
    }
    const toolJsonStr = JSON.stringify(tool.schema);
    const tokens = estimateContextTextTokens(toolJsonStr);
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
  const memoryFiles = parseMemoryFiles(memoryContent, config.getWorkingDir());
  const autoMemoryPrompt = config.getAutoMemoryPrompt();
  if (autoMemoryPrompt) {
    memoryFiles.push({
      path: t('auto memory'),
      tokens: estimateContextTextTokens(autoMemoryPrompt),
    });
  }
  const memoryFilesTokens = memoryFiles.reduce((sum, f) => sum + f.tokens, 0);

  const skillTool = allTools.find((tool) => tool.name === ToolNames.SKILL);
  const skillToolDefinitionTokens = skillTool
    ? estimateContextTextTokens(JSON.stringify(skillTool.schema))
    : 0;

  const loadedSkillNames: ReadonlySet<string> =
    skillTool && 'getLoadedSkillNames' in skillTool
      ? (
          skillTool as { getLoadedSkillNames(): ReadonlySet<string> }
        ).getLoadedSkillNames()
      : new Set();

  const skillManager = config.getSkillManager();
  const skillConfigs = skillManager ? await skillManager.listSkills() : [];
  const enabledSkillNames = new Set(
    skillConfigs
      .filter((skill) => config.isSkillEnabled(skill))
      .map((skill) => skill.name.toLowerCase()),
  );
  // Before a chat exists there is no prelude to read; measure the listing the
  // session would send so the pre-conversation estimate still includes it.
  let skillListing = prelude.skillListing;
  if (!activeChat) {
    const reminder = await buildAvailableSkillsReminder(config);
    if (reminder) {
      skillListing = measureSkillListing(reminder.reminder);
    }
  }
  let loadedBodiesTokens = 0;
  const skills: ContextSkillDetail[] = skillConfigs.map((skill) => {
    const listingTokens =
      skillListing.byName.get(skill.name.toLowerCase()) ?? 0;
    const isLoaded = loadedSkillNames.has(skill.name);
    let bodyTokens: number | undefined;
    if (isLoaded && skill.body) {
      const baseDir = skill.filePath
        ? skill.filePath.replace(/\/[^/]+$/, '')
        : '';
      bodyTokens = estimateContextTextTokens(
        buildSkillLlmContent(baseDir, skill.body),
      );
      loadedBodiesTokens += bodyTokens;
    }
    return {
      name: skill.name,
      tokens: listingTokens,
      loaded: isLoaded,
      bodyTokens,
    };
  });

  const skillsTokens =
    skillToolDefinitionTokens + skillListing.tokens + loadedBodiesTokens;
  const startupContextTokens = prelude.startupContextTokens;

  const thresholds = computeThresholds(
    contextWindowSize,
    config.getAutoCompactThreshold(),
  );
  // Keep the `(window - auto)` buffer for the legacy three-segment progress
  // bar in ContextUsage.tsx — it visualizes the headroom between the auto
  // threshold and the window edge, which is exactly `contextWindowSize -
  // thresholds.auto`. New consumers should read `breakdown.thresholds`
  // directly.
  const autocompactBuffer = Math.max(
    0,
    Math.round(contextWindowSize - thresholds.auto),
  );

  const rawOverhead =
    systemPromptTokens +
    allToolsTokens +
    memoryFilesTokens +
    skillListing.tokens +
    loadedBodiesTokens +
    startupContextTokens;

  const hasTokenCount = apiTotalTokens > 0;
  const isEstimated =
    !hasTokenCount || activeChat?.isLastPromptTokenCountEstimated() === true;

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
  let displayStartupContext: number;
  let messagesTokens: number;
  let unattributedTokens = 0;
  let freeSpace: number;
  let detailBuiltinTools: ContextToolDetail[];
  let detailMcpTools: ContextToolDetail[];
  let detailMemoryFiles: ContextMemoryDetail[];
  let detailSkills: ContextSkillDetail[];

  if (!hasTokenCount) {
    totalTokens = 0;
    displaySystemPrompt = systemPromptTokens;
    displaySkills = skillsTokens;
    displayStartupContext = startupContextTokens;
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

    // Categories partition the request by content (#12033). When the
    // estimates exceed the provider total they are all scaled down together;
    // when they fall short, the gap is reported as `unattributed` rather than
    // folded into another category. The cached count is never subtracted: a
    // cache hit spans several categories, so it is only an annotation.
    const rawContent = rawOverhead + conversationTokens;
    const scale = rawContent > totalTokens ? totalTokens / rawContent : 1;

    displaySystemPrompt = Math.round(systemPromptTokens * scale);
    const scaledAllTools = Math.round(allToolsTokens * scale);
    displayMemoryFiles = Math.round(memoryFilesTokens * scale);
    displaySkills = Math.round(skillsTokens * scale);
    displayStartupContext = Math.round(startupContextTokens * scale);
    const scaledMcpTotal = Math.round(mcpToolsTotalTokens * scale);
    displayMcpTools = scaledMcpTotal;
    const scaledSkillDefinition = Math.round(skillToolDefinitionTokens * scale);
    displayBuiltinTools = Math.max(
      0,
      scaledAllTools - scaledSkillDefinition - scaledMcpTotal,
    );

    const attributedOverhead =
      displaySystemPrompt +
      displayBuiltinTools +
      displayMcpTools +
      displayMemoryFiles +
      displaySkills +
      displayStartupContext;

    if (scale < 1) {
      // Fully attributed; messages absorbs the per-row rounding so the rows
      // sum to the total exactly.
      messagesTokens = Math.max(0, totalTokens - attributedOverhead);
    } else {
      messagesTokens = conversationTokens;
      unattributedTokens = Math.max(
        0,
        totalTokens - attributedOverhead - messagesTokens,
      );
    }

    freeSpace = Math.max(
      0,
      contextWindowSize - totalTokens - autocompactBuffer,
    );

    const scaleDetail = <T extends { tokens: number }>(items: T[]): T[] =>
      scale < 1
        ? items.map((item) => ({
            ...item,
            tokens: Math.round(item.tokens * scale),
          }))
        : items;

    detailBuiltinTools = scaleDetail(builtinTools);
    detailMcpTools = scaleDetail(mcpTools);
    detailMemoryFiles = scaleDetail(memoryFiles);
    detailSkills =
      scale < 1
        ? skills.map((item) => ({
            ...item,
            tokens: Math.round(item.tokens * scale),
            bodyTokens: item.bodyTokens
              ? Math.round(item.bodyTokens * scale)
              : undefined,
          }))
        : skills;
  }

  // Tier classification: prefer the API-reported total when available.
  // When no API call has happened yet (first /context, --continue resume,
  // sub-agent inheritance), classify against `rawOverhead` so a session
  // dominated by system prompt / skills / MCP tools doesn't silently show
  // "safe". (R2.2)
  //
  // SCOPE GAP (R5.1): `rawOverhead` excludes `messagesTokens` — the actual
  // chat history. A `--continue` restore with 100K of historical messages
  // (but small overhead) will still display "safe" here, even though the
  // cheap-gate inside chatCompressionService will trigger compression on
  // the very next send (it uses `estimatePromptTokens(history, ...)` which
  // walks the real history). This is a UI/runtime divergence — for a
  // single render — that resolves the moment any send happens.
  //
  // TODO: plumb the chat history into collectContextData and use
  // estimatePromptTokens(history, undefined, 0, 0, imageTokenEstimate) here
  // for same-source-of-truth as the cheap-gate. Defer because Config
  // doesn't expose the active chat instance today.
  const tierTokens = hasTokenCount ? apiTotalTokens : rawOverhead;

  const breakdown: ContextCategoryBreakdown = {
    systemPrompt: displaySystemPrompt,
    builtinTools: displayBuiltinTools,
    mcpTools: displayMcpTools,
    memoryFiles: displayMemoryFiles,
    skills: displaySkills,
    startupContext: displayStartupContext,
    messages: messagesTokens,
    unattributed: unattributedTokens,
    cachedTokens: hasTokenCount ? apiCachedTokens : 0,
    freeSpace,
    autocompactBuffer,
    thresholds,
    currentTier: currentTier(tierTokens, thresholds),
  };

  return {
    type: MessageType.CONTEXT_USAGE,
    modelName,
    totalTokens,
    contextWindowSize,
    breakdown,
    builtinTools: showDetails ? detailBuiltinTools : [],
    mcpTools: showDetails ? detailMcpTools : [],
    memoryFiles: showDetails ? detailMemoryFiles : [],
    skills: showDetails
      ? detailSkills.filter((skill) =>
          enabledSkillNames.has(skill.name.toLowerCase()),
        )
      : [],
    isEstimated,
    showDetails,
  };
}

/**
 * Format token count for display (e.g. 1234 -> "1.2k", 123456 -> "123.5k")
 */
function fmtTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return `${tokens}`;
}

/**
 * Format a category row as text: "  label .............. 1.2k tokens (3.4%)"
 */
function fmtCategoryRow(
  label: string,
  tokens: number,
  contextWindowSize: number,
  indent = '  ',
): string {
  const percentage =
    contextWindowSize > 0
      ? ((tokens / contextWindowSize) * 100).toFixed(1)
      : '0.0';
  const right = `${fmtTokens(tokens)} tokens (${percentage}%)`;
  const leftPart = `${indent}${label}`;
  const totalWidth = 56;
  const dots = Math.max(1, totalWidth - leftPart.length - right.length);
  return `${leftPart}${' '.repeat(dots)}${right}`;
}

/** Locale-grouped integer (e.g. 147000 -> "147,000"). */
function formatNum(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Convert a HistoryItemContextUsage to a human-readable text string,
 * mirroring the layout of the interactive ContextUsage component.
 */
export function formatContextUsageText(data: HistoryItemContextUsage): string {
  const {
    modelName,
    totalTokens,
    contextWindowSize,
    breakdown,
    builtinTools,
    mcpTools,
    memoryFiles,
    skills,
    isEstimated,
    showDetails,
  } = data;
  const hasTokenCount = totalTokens > 0;

  const lines: string[] = [];
  lines.push('## Context Usage');
  lines.push('');

  if (!hasTokenCount) {
    lines.push('*No API response yet. Send a message to see actual usage.*');
    lines.push('');
    lines.push('**Estimated pre-conversation overhead**');
    lines.push(
      `Model: ${modelName}  Context window: ${fmtTokens(contextWindowSize)} tokens`,
    );
    lines.push('');
  } else {
    lines.push(
      `Model: ${modelName}  Context window: ${fmtTokens(contextWindowSize)} tokens`,
    );
    lines.push('');
    if (isEstimated) {
      lines.push(
        '*Token usage is estimated until provider usage is received.*',
      );
      lines.push('');
    }
    lines.push(fmtCategoryRow('Used', totalTokens, contextWindowSize));
    if ((breakdown.cachedTokens ?? 0) > 0) {
      lines.push(
        fmtCategoryRow(
          'Cached prefix',
          breakdown.cachedTokens!,
          contextWindowSize,
          '  └ ',
        ),
      );
    }
    lines.push(fmtCategoryRow('Free', breakdown.freeSpace, contextWindowSize));
    lines.push('');
    lines.push('**Compaction thresholds**');
    lines.push(
      `  Effective window:   ${formatNum(breakdown.thresholds.effectiveWindow)}  (window − ${formatNum(contextWindowSize - breakdown.thresholds.effectiveWindow)} reserve)`,
    );
    lines.push(`  Warn threshold:     ${formatNum(breakdown.thresholds.warn)}`);
    lines.push(`  Auto threshold:     ${formatNum(breakdown.thresholds.auto)}`);
    lines.push(`  Hard threshold:     ${formatNum(breakdown.thresholds.hard)}`);
    lines.push(`  Current tier:       ${breakdown.currentTier}`);
    lines.push('');
    lines.push('**Usage by category**');
  }

  lines.push(
    fmtCategoryRow('System prompt', breakdown.systemPrompt, contextWindowSize),
  );
  lines.push(
    fmtCategoryRow('Built-in tools', breakdown.builtinTools, contextWindowSize),
  );
  if (breakdown.mcpTools > 0) {
    lines.push(
      fmtCategoryRow('MCP tools', breakdown.mcpTools, contextWindowSize),
    );
  }
  lines.push(
    fmtCategoryRow('Memory files', breakdown.memoryFiles, contextWindowSize),
  );
  lines.push(fmtCategoryRow('Skills', breakdown.skills, contextWindowSize));
  if ((breakdown.startupContext ?? 0) > 0) {
    lines.push(
      fmtCategoryRow(
        'Startup context',
        breakdown.startupContext!,
        contextWindowSize,
      ),
    );
  }
  if (hasTokenCount) {
    lines.push(
      fmtCategoryRow('Messages', breakdown.messages, contextWindowSize),
    );
    if ((breakdown.unattributed ?? 0) > 0) {
      lines.push(
        fmtCategoryRow(
          'Unattributed',
          breakdown.unattributed!,
          contextWindowSize,
        ),
      );
    }
  }

  if (showDetails) {
    const sortedBuiltin = [...builtinTools].sort((a, b) => b.tokens - a.tokens);
    const sortedMcp = [...mcpTools].sort((a, b) => b.tokens - a.tokens);
    const sortedMemory = [...memoryFiles].sort((a, b) => b.tokens - a.tokens);
    const sortedSkills = [...skills].sort((a, b) => {
      if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
      return b.tokens + (b.bodyTokens ?? 0) - (a.tokens + (a.bodyTokens ?? 0));
    });

    if (sortedBuiltin.length > 0) {
      lines.push('');
      lines.push('**Built-in tools**');
      for (const tool of sortedBuiltin) {
        lines.push(
          fmtCategoryRow(tool.name, tool.tokens, contextWindowSize, '  └ '),
        );
      }
    }
    if (sortedMcp.length > 0) {
      lines.push('');
      lines.push('**MCP tools**');
      for (const tool of sortedMcp) {
        lines.push(
          fmtCategoryRow(tool.name, tool.tokens, contextWindowSize, '  └ '),
        );
      }
    }
    if (sortedMemory.length > 0) {
      lines.push('');
      lines.push('**Memory files**');
      for (const file of sortedMemory) {
        lines.push(
          fmtCategoryRow(file.path, file.tokens, contextWindowSize, '  └ '),
        );
      }
    }
    if (sortedSkills.length > 0) {
      lines.push('');
      lines.push('**Skills**');
      for (const skill of sortedSkills) {
        const label = skill.loaded ? `${skill.name} (active)` : skill.name;
        lines.push(
          fmtCategoryRow(label, skill.tokens, contextWindowSize, '  └ '),
        );
        if (skill.loaded && skill.bodyTokens && skill.bodyTokens > 0) {
          lines.push(
            fmtCategoryRow(
              'body loaded',
              skill.bodyTokens,
              contextWindowSize,
              '    └ ',
            ),
          );
        }
      }
    }
  } else {
    lines.push('');
    lines.push('*Run /context detail for per-item breakdown.*');
  }

  return lines.join('\n');
}

export const contextCommand: SlashCommand = {
  name: 'context',
  get description() {
    return t(
      'Show context window usage breakdown. Use "/context detail" for per-item breakdown.',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context: CommandContext, args?: string) => {
    const normalizedArgs = args?.trim().toLowerCase();
    const showDetails = normalizedArgs === 'detail' || normalizedArgs === '-d';
    const executionMode = context.executionMode ?? 'interactive';
    const { config } = context.services;
    if (!config) {
      if (executionMode === 'interactive') {
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

    if (executionMode === 'interactive') {
      context.ui.addItem(contextUsageItem, Date.now());
      return;
    }
    return {
      type: 'message',
      messageType: 'info',
      content: formatContextUsageText(contextUsageItem),
    };
  },
  subCommands: [
    {
      name: 'detail',
      get description() {
        return t('Show per-item context usage breakdown.');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: async (context: CommandContext) => {
        // Delegate to main action with 'detail' arg to show detailed view
        await contextCommand.action!(context, 'detail');
      },
    },
  ],
};
