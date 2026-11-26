/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Compact recovery attachment generators.
 *
 * These generators are called by the compression pipeline (or the QueryEngine)
 * AFTER a compaction completes, to rebuild the baseline context the LLM needs
 * after its history has been summarized.
 *
 * Spec reference: attachment/08-compact-recovery.md §4.2 – §4.4
 *
 *   createPlanAttachmentIfNeeded()  — restore plan file content (§4.2)
 *   createSkillAttachmentIfNeeded() — restore invoked skill content (§4.4)
 */

import type { Message } from '../../protocol/transcript/message.js';
import { findSkillBodyInHistory } from '../../skills/skillBodyInHistory.js';
import {
  estimateTextTokens,
  limitTextToTokenBudget,
} from '../../utils/tokenCalculation.js';
import {
  PlanFileReferenceAttachment,
  InvokedSkillsAttachment,
} from '../types.js';

// ---------------------------------------------------------------------------
// Token budget constants (mirroring spec §4.4)
// ---------------------------------------------------------------------------

/** Total token budget for skill restoration. */
const SKILL_TOKEN_BUDGET = 25_000;

/** Per-skill token limit during compact restore. */
const PER_SKILL_MAX_TOKENS = 5_000;

const SKILL_TRUNCATION_NOTICE =
  '\n\n[Skill content truncated during compaction recovery. Read the skill file if full instructions are needed.]';

const TRUNCATED_PREFIX_BUDGET =
  PER_SKILL_MAX_TOKENS - estimateTextTokens(SKILL_TRUNCATION_NOTICE);

// ---------------------------------------------------------------------------
// createPlanAttachmentIfNeeded
// ---------------------------------------------------------------------------

/**
 * Create a PlanFileReferenceAttachment for the current plan file, if any.
 *
 * Called after compact to restore the plan content into the new context so
 * the model knows the approved plan without re-reading it.
 *
 * @param planFilePath - Absolute path to the plan file.
 * @param planContent  - Current plan file content (caller reads from disk).
 * @returns The attachment, or null if no plan content is available.
 */
export function createPlanAttachmentIfNeeded(
  planFilePath: string | undefined,
  planContent: string | undefined,
): PlanFileReferenceAttachment | null {
  if (!planFilePath || !planContent || !planContent.trim()) return null;

  return new PlanFileReferenceAttachment({
    type: 'plan_file_reference',
    planFilePath,
    planContent,
  });
}

// ---------------------------------------------------------------------------
// createSkillAttachmentIfNeeded
// ---------------------------------------------------------------------------

/** A skill that was invoked during the current session (caller provides). */
export interface InvokedSkillRecord {
  name: string;
  path: string;
  content: string;
  /** Epoch ms — used to sort most-recently-invoked first. */
  invokedAt: number;
}

/**
 * Restore recently invoked skills within the single-skill and total budgets.
 * Keep the invocation cache consistent with the text that survives compaction.
 */
export function createSkillAttachmentIfNeeded(
  invokedSkills: readonly InvokedSkillRecord[],
  retainedHistory: readonly Message[] = [],
  updateCachedBody?: (name: string, content: string) => void,
): InvokedSkillsAttachment | null {
  const sorted = [...invokedSkills].sort((a, b) => b.invokedAt - a.invokedAt);
  const skills: InvokedSkillsAttachment['skills'] = [];
  let totalTokens = 0;

  for (const skill of sorted) {
    if (!skill.content) continue;
    const copy = findSkillBodyInHistory(retainedHistory, skill.content);
    if (copy === 'attachment') continue;

    const fitted = limitTextToTokenBudget(skill.content, PER_SKILL_MAX_TOKENS);
    const content = fitted.truncated
      ? limitTextToTokenBudget(fitted.text, TRUNCATED_PREFIX_BUDGET).text +
        SKILL_TRUNCATION_NOTICE
      : fitted.text;
    const tokens = estimateTextTokens(content);

    if (totalTokens + tokens > SKILL_TOKEN_BUDGET) {
      if (copy !== 'body') updateCachedBody?.(skill.name, '');
      continue;
    }

    skills.push({ name: skill.name, path: skill.path, content });
    totalTokens += tokens;
    if (copy !== 'body' && content !== skill.content) {
      updateCachedBody?.(skill.name, content);
    }
  }

  if (skills.length === 0) return null;
  return new InvokedSkillsAttachment({ type: 'invoked_skills', skills });
}
