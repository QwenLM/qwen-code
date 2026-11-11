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

/** Average chars-per-token estimate for budget enforcement. */
const CHARS_PER_TOKEN = 4;

const SKILL_TRUNCATION_NOTICE =
  '\n\n[Skill content truncated during compaction recovery. Read the skill file if full instructions are needed.]';

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
 * Create an InvokedSkillsAttachment for skills invoked before compaction.
 *
 * Skills are sorted most-recently-invoked first, then truncated to fit within
 * the token budget (25k total, 5k per skill).
 *
 * @param invokedSkills - Skills invoked in the session before compact.
 * @returns The attachment, or null if no skills were invoked.
 */
export function createSkillAttachmentIfNeeded(
  invokedSkills: InvokedSkillRecord[],
): InvokedSkillsAttachment | null {
  if (invokedSkills.length === 0) return null;

  // Sort most-recently-invoked first.
  const sorted = [...invokedSkills].sort((a, b) => b.invokedAt - a.invokedAt);

  const skills: Array<{ name: string; path: string; content: string }> = [];
  let totalChars = 0;
  const totalBudgetChars = SKILL_TOKEN_BUDGET * CHARS_PER_TOKEN;
  const perSkillBudgetChars = PER_SKILL_MAX_TOKENS * CHARS_PER_TOKEN;

  for (const skill of sorted) {
    if (totalChars >= totalBudgetChars) break;

    const remaining = totalBudgetChars - totalChars;
    const skillBudgetChars = Math.min(perSkillBudgetChars, remaining);
    const isTruncated = skill.content.length > skillBudgetChars;
    if (isTruncated && skillBudgetChars <= SKILL_TRUNCATION_NOTICE.length) {
      break;
    }
    const truncated = isTruncated
      ? skill.content.slice(
          0,
          skillBudgetChars - SKILL_TRUNCATION_NOTICE.length,
        ) + SKILL_TRUNCATION_NOTICE
      : skill.content;

    skills.push({
      name: skill.name,
      path: skill.path,
      content: truncated,
    });

    totalChars += truncated.length;
  }

  if (skills.length === 0) return null;

  return new InvokedSkillsAttachment({
    type: 'invoked_skills',
    skills,
  });
}
