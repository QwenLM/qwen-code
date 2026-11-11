/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Skill-related attachment generators.
 *
 * Generates skill_listing attachments for the LLM, using delta logic to
 * avoid re-sending unchanged skill lists.
 */

import {
  type AttachmentToolUseContext,
  SkillListingAttachment,
  InvokedSkillsAttachment,
} from '../types.js';
import type { SkillDefinition } from '@qwen-code/resource';
import stringWidth from 'string-width';
import { sha1 } from '../../utils/paths.js';
import { truncateString } from '../../utils/textUtils.js';
import type { Config } from '../../config/config.js';
import type { Model } from '../../provider/model/model.js';
import { getSkillListingColumnsPerToken } from '../../config/models.js';

import {
  DEFAULT_SKILL_LISTING_MAX_DESC_CHARS,
  DEFAULT_SKILL_LISTING_BUDGET_FRACTION,
} from '../../skills/skillListingDefaults.js';

/** Options for skill listing generation, sourced from settings and the model. */
export interface SkillListingConfig {
  /** 仅控制既有增量发送策略；简介预算始终保留全部名称。 */
  preserveNames?: boolean;
  contextWindowTokens?: number;
  /** 当前模型的显示列估算。 */
  columnsPerToken?: 3 | 4;
  getUsageScore?: (name: string) => number;
  /** 单项简介字符上限，包含截断省略号。 */
  maxDescChars?: number;
  /** 上下文预算比例；零值使用最小软预算，仍保留全部名称。 */
  budgetFraction?: number;
  /** Per-skill visibility overrides (for 'name-only' handling in listing). */
  visibilityOverrides?: Record<string, string>;
  /** Resolve source-aware visibility through the same manager as discovery. */
  getVisibilityOverride?: (name: string) => string | undefined;
}

/** Shared options for all skill-listing entry points. */
export async function getSkillListingConfig(
  config: Config,
  options: {
    model?: string;
    modelEntry?: Model;
    contextWindowTokens?: number;
  } = {},
): Promise<SkillListingConfig> {
  const settings: SkillListingConfig = {
    maxDescChars: config.getSkillListingMaxDescChars(),
    budgetFraction: config.getSkillListingBudgetFraction(),
    visibilityOverrides: config.getSkillVisibilityOverrides(),
  };
  const manager = config.getSkillManager();
  const model = options.model ?? config.getModel();
  const modelEntry =
    options.modelEntry ??
    (await config.getModelProviderManager().getModel(model));
  return {
    ...settings,
    preserveNames: true,
    contextWindowTokens:
      options.contextWindowTokens ??
      config.getEffectiveContextWindow?.(modelEntry),
    columnsPerToken: getSkillListingColumnsPerToken(modelEntry, model),
    getUsageScore: (name) => manager.getUsageScore(name),
    getVisibilityOverride: (name) => manager.getSkillVisibilityOverride(name),
  };
}

/**
 * Format a list of skills into a human-readable listing for the LLM.
 * The input is expected to already be the model-visible set
 * (see SkillManager.getModelVisibleSkills), so no further invocation
 * filtering happens here.
 * Skills with 'name-only' visibility override show only their name.
 */
function formatSkillListing(
  skills: SkillDefinition[],
  config?: SkillListingConfig,
): string {
  if (skills.length === 0) {
    return 'No skills are currently available.';
  }

  const maxDescChars =
    config?.maxDescChars ?? DEFAULT_SKILL_LISTING_MAX_DESC_CHARS;
  const visibility = (name: string) =>
    config?.getVisibilityOverride
      ? config.getVisibilityOverride(name)
      : config?.visibilityOverrides?.[name];

  const lines = skills.map((s) => {
    // 'name-only' override: list name without description
    if (visibility(s.name) === 'name-only') {
      return `- ${s.name}`;
    }

    // SK25: combine description + whenToUse, then truncate
    const desc = s.whenToUse
      ? `${s.description} - ${s.whenToUse}`
      : s.description;
    const shortened =
      desc.length > maxDescChars
        ? truncateString(desc, Math.max(0, maxDescChars - 1), '') + '\u2026'
        : desc;
    const line = `- ${s.name}: ${shortened}`;
    // 保留旧入口的子 Agent 提示，不改变现有发送策略。
    return s.agent && !config?.preserveNames
      ? `${line} (agent: ${s.agent})`
      : line;
  });

  let listing = lines.join('\n');
  const budgetFraction =
    config?.budgetFraction ?? DEFAULT_SKILL_LISTING_BUDGET_FRACTION;
  const estimatedContextTokens = config?.contextWindowTokens ?? 200_000;
  const maxColumns = Math.max(
    1,
    Math.floor(
      estimatedContextTokens * (config?.columnsPerToken ?? 4) * budgetFraction,
    ),
  );
  const lineWidths = lines.map((line) => stringWidth(line));
  const listingWidth = lineWidths.reduce(
    (sum, width) => sum + width,
    lines.length - 1,
  );
  if (listingWidth > maxColumns) {
    // 所有入口统一使用软预算：保留名称、内置简介和显式 name-only。
    const minimal = skills.map((skill, i) =>
      skill.isBuiltin || visibility(skill.name) === 'name-only'
        ? lines[i]
        : `- ${skill.name}`,
    );
    const minimalWidths = minimal.map((line) => stringWidth(line));
    let remaining =
      maxColumns -
      minimalWidths.reduce((sum, width) => sum + width, lines.length - 1);
    const candidates = skills
      .map((skill, index) => ({
        index,
        score: config?.getUsageScore?.(skill.name) ?? 0,
      }))
      .filter(({ index }) => minimal[index] !== lines[index]);
    candidates.sort((a, b) => b.score - a.score);
    for (const { index } of candidates) {
      const extra = lineWidths[index] - minimalWidths[index];
      if (extra <= remaining) {
        remaining -= extra;
        minimal[index] = lines[index];
      }
    }
    listing = minimal.join('\n');
  }

  return listing;
}

/** Key under which an agent's already-sent skill names are tracked. */
export function skillListingScopeKey(ctx: AttachmentToolUseContext): string {
  return ctx.agentId ?? 'main';
}

/**
 * Reset the skill listing delta tracking state.
 *
 * Should be called after compaction: the previous listing lived in the
 * discarded prefix, so the next generator call must re-emit the full list.
 * The fingerprint is dropped too so an identical listing is not suppressed.
 */
export function resetSkillListingState(ctx: AttachmentToolUseContext): void {
  const agentId = skillListingScopeKey(ctx);
  ctx.sentSkillNames.delete(agentId);
  ctx.sentSkillListingFingerprints?.delete(agentId);
}

/**
 * Generate skill listing attachments for the current agent turn.
 *
 * Interactive discovery sends only names never sent in this agent scope.
 * Legacy entry points also resend on removals.
 *
 * @param ctx - Tool use context (contains sentSkillNames for dedup)
 * @param skills - Current list of enabled skills from SkillManager.getSkills()
 * @param isInitialTurn - True if this is the first turn for this agent
 * @param config - Optional skill listing config from settings
 */
export async function getSkillListingAttachments(
  ctx: AttachmentToolUseContext,
  skills: SkillDefinition[],
  isInitialTurn: boolean = false,
  config?: SkillListingConfig,
): Promise<SkillListingAttachment[]> {
  const agentId = skillListingScopeKey(ctx);
  const sentNames = ctx.sentSkillNames.get(agentId) ?? new Set<string>();
  let skillsToSend: SkillDefinition[];
  let isFullResend: boolean;

  if (config?.preserveNames) {
    ctx.sentSkillNames.set(agentId, sentNames);
    skillsToSend = skills.filter((skill) => !sentNames.has(skill.name));
    if (skillsToSend.length === 0) return [];
    isFullResend = sentNames.size === 0;
    for (const skill of skillsToSend) sentNames.add(skill.name);
  } else {
    const currentNames = new Set(skills.map((s) => s.name));

    // Check if anything changed
    const hasNew = skills.some((s) => !sentNames.has(s.name));
    let hasRemoved = false;
    for (const n of sentNames) {
      if (!currentNames.has(n)) {
        hasRemoved = true;
        break;
      }
    }

    // `sentNames` is the source of truth for what the model has already seen —
    // it survives resume via transcript restore, so an "initial" turn with a
    // restored listing must not resend.
    if (!hasNew && !hasRemoved && (!isInitialTurn || sentNames.size > 0)) {
      // No change — don't resend
      return [];
    }

    // Update sent names
    ctx.sentSkillNames.set(agentId, currentNames);

    // On initial turn or when skills were removed, send the full list.
    // Otherwise, send only newly added skills (delta) to save context tokens.
    isFullResend = isInitialTurn || sentNames.size === 0 || hasRemoved;
    skillsToSend = isFullResend
      ? skills
      : skills.filter((s) => !sentNames.has(s.name));
  }

  const content = formatSkillListing(skillsToSend, config);
  const names = skillsToSend.map((skill) => skill.name);

  // A hot reload clears the sent names so the next turn can resend. When the
  // reload left the listing identical, resending it would only repeat context
  // the model already has, so the fingerprint gate stops it here.
  const fingerprint = sha1(
    `${isFullResend ? 'full' : 'delta'}\u0000${content}`,
  );
  const fingerprints =
    ctx.sentSkillListingFingerprints ??
    (ctx.sentSkillListingFingerprints = new Map<string, string>());
  if (fingerprints.get(agentId) === fingerprint) {
    return [];
  }
  fingerprints.set(agentId, fingerprint);

  return [
    new SkillListingAttachment({
      type: 'skill_listing',
      content,
      names,
      skillCount: names.length,
      isInitial: isFullResend,
    }),
  ];
}

/**
 * Generate an InvokedSkillsAttachment for skills that have been activated
 * in this session. Used after compact to restore skill context.
 */
export function buildInvokedSkillsAttachment(
  invokedSkills: Array<{ name: string; path: string; content: string }>,
): InvokedSkillsAttachment | null {
  if (invokedSkills.length === 0) return null;
  return new InvokedSkillsAttachment({
    type: 'invoked_skills',
    skills: invokedSkills,
  });
}
