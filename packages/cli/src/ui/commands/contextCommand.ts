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
import type { Content, Part } from '@google/genai';
import {
  DiscoveredMCPTool,
  uiTelemetryService,
  getMainSessionBaseSystemPrompt,
  DEFAULT_TOKEN_LIMIT,
  ToolNames,
  buildAvailableSkillsReminder,
  computeThresholds,
  getStartupContextLength,
  isMediaPolicyToolHiddenFromModel,
  estimateContextTextTokens,
  resolveSlimmingConfig,
  formatContextFileDisplayPath,
  type CompactionThresholds,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import * as path from 'node:path';
import { getSanitizedExtensionDisplayName } from '../../utils/extension-mention.js';

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
 * Absolute context-file path → its extension-attributed display label.
 *
 * An extension's context file is resident in every request of every session it
 * is active in, and its marker path alone does not say which extension is
 * paying for it (#12030). Built from the live extension list so a row can name
 * the owner instead of an opaque path.
 */
function extensionContextFileOwners(
  config: import('@qwen-code/qwen-code-core').Config,
  workingDir: string,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const extension of config.getActiveExtensions?.() ?? []) {
    const displayName = getSanitizedExtensionDisplayName(extension);
    for (const contextFile of extension.contextFiles ?? []) {
      const absolutePath = path.resolve(workingDir, contextFile);
      const fileLabel = formatContextFileDisplayPath(
        absolutePath,
        extension.path,
      );
      owners.set(
        absolutePath,
        `${t('Extension')}: ${displayName} · ${fileLabel}`,
      );
    }
  }
  return owners;
}

/**
 * Parse concatenated memory content into individual file entries.
 * Memory content format: "--- Context from: <path> ---\n<content>\n--- End of Context from: <path> ---"
 */
function parseMemoryFiles(
  memoryContent: string,
  workingDir: string,
  extensionOwners: ReadonlyMap<string, string> = new Map(),
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
    // Marker paths are relative to the session working directory (where
    // memory discovery ran, which may differ from process.cwd() in
    // ACP/daemon-served sessions); shorten home-dir files to `~/...` so
    // global memory files don't render as `../../..` chains.
    const absolutePath = path.resolve(workingDir, filePath);
    const owner = extensionOwners.get(absolutePath);
    results.push({
      // An extension's file is named by its extension rather than by a path
      // under the install directory, which is what makes the row actionable:
      // the reader can disable or migrate that extension.
      path: owner ?? formatContextFileDisplayPath(absolutePath, workingDir),
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

interface SkillListingEntryCost {
  /** Name exactly as rendered in the listing (unescaped, original case). */
  name: string;
  tokens: number;
}

interface SkillListingCost {
  /** The whole listing reminder as sent, wrapper included. */
  tokens: number;
  /** Per-entry cost, keyed by lower-cased skill name. */
  byName: Map<string, SkillListingEntryCost>;
}

function isSkillListingText(text: string): boolean {
  return (
    text.includes(AVAILABLE_SKILLS_OPEN) || text.includes(NO_SKILLS_NOTICE)
  );
}

// Measured from the rendered text rather than re-derived from skill configs,
// so budget trimming and XML escaping are reflected exactly (#12033).
function measureSkillListing(text: string): SkillListingCost {
  const byName = new Map<string, SkillListingEntryCost>();
  for (const match of text.matchAll(SKILL_LISTING_ENTRY)) {
    const name = unescapeXml(match[1]!);
    byName.set(name.toLowerCase(), {
      name,
      tokens: estimateContextTextTokens(match[0]),
    });
  }
  return { tokens: estimateContextTextTokens(text), byName };
}

function mergeSkillListing(
  into: SkillListingCost,
  from: SkillListingCost,
): void {
  into.tokens += from.tokens;
  for (const [name, entry] of from.byName) {
    into.byName.set(name, entry);
  }
}

/**
 * Skill-listing reminders that landed *after* the startup prelude. A skill
 * enabled mid-session is announced by a tail `<system-reminder>` carrying an
 * `<available_skills>` block (`buildChangedSkillsReminder`, and the scheduler's
 * equivalent), which `getStartupContextLength` never inspects. Those tokens are
 * listing cost, not conversation, so they are measured here and billed with the
 * startup listing under `skills` — otherwise the entry is billed to `messages`
 * while its detail row prints `0`.
 *
 * Text that merely mentions `<available_skills>` without a single `<skill>`
 * entry (a pasted example, the fixed "no skills" notice) is left alone: only
 * measured listings are excluded from `messages`.
 */
function measureTailSkillListings(conversation: Content[]): {
  listing: SkillListingCost;
  /** The exact part texts whose cost the listing already carries. */
  billedTexts: Set<string>;
} {
  const listing: SkillListingCost = { tokens: 0, byName: new Map() };
  const billedTexts = new Set<string>();
  for (const content of conversation) {
    for (const part of content.parts ?? []) {
      const text = part.text;
      if (typeof text !== 'string' || !isSkillListingText(text)) continue;
      const measured = measureSkillListing(text);
      if (measured.byName.size === 0) continue;
      mergeSkillListing(listing, measured);
      billedTexts.add(text);
    }
  }
  return { listing, billedTexts };
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
        mergeSkillListing(skillListing, measureSkillListing(part.text));
      } else {
        startupContextTokens += estimateContextTextTokens(part.text);
      }
    }
  }
  return { skillListing, startupContextTokens };
}

/**
 * Estimate of a tool response. Only the text-bearing envelope is serialized:
 * qwen-code attaches media to `functionResponse.parts` (an extension to the
 * `@google/genai` schema; see `coreToolScheduler.createFunctionResponsePart`),
 * and `JSON.stringify`ing the whole part would bill that raw base64 as ASCII
 * text — a single ~100 KB screenshot alone is enough to push the estimate past
 * the provider total and deflate every category row through `scale`. Nested
 * media is charged at the flat per-image budget core uses for the same carrier
 * (`estimatePartChars` in `compactionInputSlimming`).
 */
function estimateFunctionResponseTokens(
  part: Part,
  imageTokenEstimate: number,
): number {
  const response = part.functionResponse!;
  let tokens = estimateContextTextTokens(
    JSON.stringify({
      id: response.id,
      name: response.name,
      response: response.response,
    }),
  );
  // Same carrier core's slimmer strips, read the same way.
  const nested = (response as { parts?: unknown }).parts;
  if (Array.isArray(nested)) {
    for (const inner of nested as Part[]) {
      if (inner.inlineData || inner.fileData) {
        tokens += imageTokenEstimate;
      } else if (typeof inner.text === 'string') {
        tokens += estimateContextTextTokens(inner.text);
      }
    }
  }
  return tokens;
}

/**
 * Consume one `skill` response carrying a body that `skills` already bills
 * (`loadedBodiesTokens`). Membership is by body, not by tool name: the Skill
 * tool also returns raw command output for a same-named non-skill command
 * without tracking it — "the result is raw command text, not a skill body"
 * (`tools/skill.ts`) — and tracking is cleared by `/restore`, by compression and
 * by a startup resume that declines to match (`clearLoadedSkillTracking`). Those
 * responses are ordinary conversation content, so a name-keyed skip dropped them
 * out of `messages` and into `unattributed`, which owns nothing. Core accepts the
 * same two shapes when it restores tracking (`restoreLoadedSkillsFromHistory`):
 * the body verbatim, or the body with a suffix appended after a newline.
 */
function consumeBilledSkillBody(
  part: Part,
  billedSkillBodies: Set<string>,
): boolean {
  if (billedSkillBodies.size === 0) return false;
  const output = (
    part.functionResponse?.response as { output?: unknown } | undefined
  )?.output;
  if (typeof output !== 'string') return false;
  if (billedSkillBodies.delete(output)) return true;
  for (const body of billedSkillBodies) {
    if (output.startsWith(`${body}\n`)) {
      billedSkillBodies.delete(body);
      return true;
    }
  }
  return false;
}

interface ConversationBilling {
  imageTokenEstimate: number;
  /** `buildSkillLlmContent` bodies already billed under `skills`. */
  billedSkillBodies: ReadonlySet<string>;
  /** Tail `<available_skills>` reminder texts already billed under `skills`. */
  billedListingTexts: ReadonlySet<string>;
}

/**
 * Content estimate of the conversation after the startup prelude. A part whose
 * cost another category already owns is skipped here: tracked skill bodies and
 * tail skill-listing reminders are both billed under `skills`. Top-level media
 * is charged at the same flat per-image budget as the nested carrier: a pasted
 * screenshot is the ordinary shape, and leaving it uncounted would hide it from
 * `freeSpace` and `tierTokens`, which read this estimate.
 */
function estimateConversationTokens(
  conversation: Content[],
  billing: ConversationBilling,
): number {
  let tokens = 0;
  // The historical body map bills each distinct body once under skills.
  const remainingSkillBodies = new Set(billing.billedSkillBodies);
  for (const content of conversation) {
    for (const part of content.parts ?? []) {
      if (typeof part.text === 'string') {
        if (billing.billedListingTexts.has(part.text)) continue;
        tokens += estimateContextTextTokens(part.text);
      } else if (part.inlineData || part.fileData) {
        tokens += billing.imageTokenEstimate;
      } else if (part.functionCall) {
        tokens += estimateContextTextTokens(JSON.stringify(part.functionCall));
      } else if (part.functionResponse) {
        if (
          part.functionResponse.name === ToolNames.SKILL &&
          consumeBilledSkillBody(part, remainingSkillBodies)
        ) {
          continue;
        }
        tokens += estimateFunctionResponseTokens(
          part,
          billing.imageTokenEstimate,
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
  // `getHistory()` is `structuredClone(this.history)` — a full deep copy of
  // every base64 payload for a caller that only reads. Prefer the shallow
  // reader (core's own pattern, `client.ts`), falling back for chat objects
  // that don't implement it. Never pass `curated: true`: curation merges the
  // prelude into the first user prompt, which would defeat
  // `getStartupContextLength` and bill the whole prelude to `messages`.
  const history =
    activeChat?.getHistoryShallow?.() ?? activeChat?.getHistory?.() ?? [];
  const preludeLength = getStartupContextLength(history);
  const prelude = measureStartupPrelude(history.slice(0, preludeLength));
  const conversationHistory = history.slice(preludeLength);
  // Skill-listing reminders appended after the prelude are listing cost, not
  // conversation, and are billed with the startup listing under `skills`.
  const tailSkillListings = measureTailSkillListings(conversationHistory);
  // Measured below, once the set of skill bodies `skills` actually bills is
  // known: a `skill` response is skipped here only when that set owns its body.
  let conversationTokens = 0;

  const systemPromptText = getMainSessionBaseSystemPrompt(config);
  const systemPromptTokens = estimateContextTextTokens(systemPromptText);

  const toolRegistry = config.getToolRegistry();
  const allTools = toolRegistry ? toolRegistry.getAllTools() : [];
  // Match what's actually sent to the model: deferred tools — MCP tools and
  // low-frequency built-ins like web_fetch / monitor / cron_* — are absent
  // from the prompt unless session setup has revealed them. See
  // client.ts which calls getFunctionDeclarations() with no args. The
  // per-tool loop below applies the same filter so allToolsTokens stays
  // aligned with the breakdown sum.
  const toolDeclarations = toolRegistry
    ? toolRegistry.getFunctionDeclarations()
    : [];
  const toolDeclarationsByName = new Map(
    toolDeclarations
      .filter((declaration) => declaration.name)
      .map((declaration) => [declaration.name!, declaration] as const),
  );
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
    const declaration = toolDeclarationsByName.get(tool.name);
    if (!declaration) continue;
    const toolJsonStr = JSON.stringify(declaration);
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
  const memoryFiles = parseMemoryFiles(
    memoryContent,
    config.getWorkingDir(),
    extensionContextFileOwners(config, config.getWorkingDir()),
  );
  const autoMemoryPrompt = config.getAutoMemoryPrompt();
  if (autoMemoryPrompt) {
    memoryFiles.push({
      path: t('auto memory'),
      tokens: estimateContextTextTokens(autoMemoryPrompt),
    });
  }
  const memoryFilesTokens = memoryFiles.reduce((sum, f) => sum + f.tokens, 0);

  const skillTool = allTools.find((tool) => tool.name === ToolNames.SKILL);
  const skillDeclaration = toolDeclarationsByName.get(ToolNames.SKILL);
  const skillToolDefinitionTokens = skillDeclaration
    ? estimateContextTextTokens(JSON.stringify(skillDeclaration))
    : 0;

  const loadedContentNames: ReadonlyMap<string, string> =
    skillTool && 'getLoadedSkillContentNames' in skillTool
      ? (
          skillTool as {
            getLoadedSkillContentNames(): ReadonlyMap<string, string>;
          }
        ).getLoadedSkillContentNames()
      : new Map();
  const bodyTokensByName = new Map<string, number>();
  for (const [content, name] of loadedContentNames) {
    bodyTokensByName.set(
      name,
      (bodyTokensByName.get(name) ?? 0) + estimateContextTextTokens(content),
    );
  }
  const loadedBodiesTokens = [...bodyTokensByName.values()].reduce(
    (sum, tokens) => sum + tokens,
    0,
  );

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
  mergeSkillListing(skillListing, tailSkillListings.listing);

  const billedSkillBodies = new Set(loadedContentNames.keys());
  const skills: ContextSkillDetail[] = skillConfigs.map((skill) => {
    const listingTokens =
      skillListing.byName.get(skill.name.toLowerCase())?.tokens ?? 0;
    const bodyTokens = bodyTokensByName.get(skill.name);
    const isLoaded = bodyTokens !== undefined;
    return {
      name: skill.name,
      tokens: listingTokens,
      loaded: isLoaded,
      bodyTokens,
    };
  });

  const discoveredNames = new Set(skillConfigs.map((skill) => skill.name));
  for (const [name, bodyTokens] of bodyTokensByName) {
    if (!discoveredNames.has(name)) {
      skills.push({
        name,
        tokens: skillListing.byName.get(name.toLowerCase())?.tokens ?? 0,
        loaded: true,
        bodyTokens,
      });
    }
  }

  // The listing also carries model-invocable commands — a user's own
  // `.qwen/commands/*.toml`, extension saved workflows with `whenToUse` — which
  // `listSkills()` never returns, while their tokens are inside the measured
  // listing that `skillsTokens` bills. Give each one a row so the rows and the
  // category cover the same set. Rows never feed `skillsTokens`: Built-in tools
  // subtracts the Skill tool definition *because* `skills` carries it.
  const rowedNames = new Set(skills.map((s) => s.name.toLowerCase()));
  for (const [key, entry] of skillListing.byName) {
    if (rowedNames.has(key)) continue;
    rowedNames.add(key);
    // Rendered into the listing, so model-invocable by definition.
    enabledSkillNames.add(key);
    skills.push({ name: entry.name, tokens: entry.tokens });
  }

  conversationTokens = estimateConversationTokens(conversationHistory, {
    imageTokenEstimate: resolveSlimmingConfig(config.getChatCompression?.())
      .imageTokenEstimate,
    billedSkillBodies,
    billedListingTexts: tailSkillListings.billedTexts,
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
  // Everything the session already holds, measured locally: the request
  // overhead plus the conversation after the startup prelude.
  const rawContent = rawOverhead + conversationTokens;

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

  // The per-tool loop bills only declared tools, so the Skill definition and
  // the MCP schemas can exceed `allToolsTokens` only by estimator rounding;
  // floor the builtin remainder at zero.
  const builtinToolsTokens = Math.max(
    0,
    allToolsTokens - skillToolDefinitionTokens - mcpToolsTotalTokens,
  );

  if (!hasTokenCount) {
    totalTokens = 0;
    displaySystemPrompt = systemPromptTokens;
    displaySkills = skillsTokens;
    displayStartupContext = startupContextTokens;
    displayBuiltinTools = builtinToolsTokens;
    displayMcpTools = mcpToolsTotalTokens;
    displayMemoryFiles = memoryFilesTokens;
    messagesTokens = 0;
    // Include the conversation: a `/model` switch, `/restore` or a resume
    // zeroes the provider count while leaving `this.history` intact, and such a
    // session must not report a 100K history as free window.
    freeSpace = Math.max(0, contextWindowSize - rawContent - autocompactBuffer);
    detailBuiltinTools = builtinTools;
    detailMcpTools = mcpTools;
    detailMemoryFiles = memoryFiles;
    detailSkills = skills;
  } else {
    totalTokens = apiTotalTokens;

    // Categories partition the request by content (#12033). When the overhead
    // exceeds the provider total it is scaled down as a whole; when it falls
    // short, the gap is reported as `unattributed` rather than folded into
    // another category. The cached count is never subtracted: a cache hit spans
    // several categories, so it is only an annotation.
    //
    // Only the overhead is scaled, and only against itself. Conversation content
    // is deliberately kept out of the denominator: `conversationTokens` measures
    // a strictly larger content set than the last request's `promptTokenCount`
    // (which excludes the answer `history` already carries) with a CJK-aware
    // estimator, so including it deflates every exactly-measured row. The total
    // is not always provider-reported either — `compressFast()` and resume
    // seeding stamp a char/4 estimate of the compressed history alone, which can
    // sit below the overhead — so the clamp must stay armed there too, or the
    // rows overshoot the total with no row able to report it. Conversation-side
    // overshoot is absorbed by the `messages` cap below.
    const scale = rawOverhead > totalTokens ? totalTokens / rawOverhead : 1;

    // The categories partition `rawOverhead` before scaling. Flooring each
    // share keeps their sum at or below `totalTokens`; independently rounding
    // them can overshoot the total by a token with no negative row available
    // to absorb the excess.
    displaySystemPrompt = Math.floor(systemPromptTokens * scale);
    displayBuiltinTools = Math.floor(builtinToolsTokens * scale);
    displayMcpTools = Math.floor(mcpToolsTotalTokens * scale);
    displayMemoryFiles = Math.floor(memoryFilesTokens * scale);
    displaySkills = Math.floor(skillsTokens * scale);
    displayStartupContext = Math.floor(startupContextTokens * scale);

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
      // Unscaled, the overhead already fits inside the total
      // (`rawOverhead <= totalTokens`), so `messages` is capped only by the
      // conversation estimate. A genuine shortfall still surfaces as
      // `unattributed`.
      messagesTokens = Math.min(
        conversationTokens,
        Math.max(0, totalTokens - attributedOverhead),
      );
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
  // sub-agent inheritance, or a `/model` switch that zeroes the count while
  // leaving the history intact), classify against everything the session
  // already holds — overhead plus conversation — so neither a system-prompt-
  // heavy nor a history-heavy session silently shows "safe" on the render right
  // before the cheap gate compacts. (R2.2)
  //
  // SCOPE GAP (R5.1): `estimateConversationTokens` is still not the cheap
  // gate's estimator — this file measures with the CJK-aware
  // `estimateContextTextTokens` and skips the parts another category already
  // owns (tracked skill bodies, skill listings), while
  // chatCompressionService uses `estimatePromptTokens(history, ...)` over the
  // real history. The tier can therefore land on the far side of a threshold
  // from the runtime's own answer, for a single render, until a send replaces
  // the estimate with a provider count.
  //
  // TODO: use estimatePromptTokens(history, undefined, 0, 0,
  // imageTokenEstimate) here for same-source-of-truth as the cheap gate.
  const tierTokens = hasTokenCount ? apiTotalTokens : rawContent;

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
      ? detailSkills.filter(
          (skill) =>
            skill.loaded || enabledSkillNames.has(skill.name.toLowerCase()),
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
        lines.push(
          fmtCategoryRow(skill.name, skill.tokens, contextWindowSize, '  └ '),
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
