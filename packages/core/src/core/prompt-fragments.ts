/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const PROMPT_TIERS = ['stable', 'context', 'volatile'] as const;

export type PromptTier = (typeof PROMPT_TIERS)[number];
export type PromptRole = 'system' | 'user';

export interface PromptFragment {
  marker: string;
  role: PromptRole;
  tier: PromptTier;
  content: string | null | undefined;
}

export function orderPromptFragments(
  fragments: readonly PromptFragment[],
): PromptFragment[] {
  return PROMPT_TIERS.flatMap((tier) =>
    fragments.filter(
      (fragment) => fragment.tier === tier && Boolean(fragment.content?.trim()),
    ),
  );
}

export function renderPromptFragments(
  fragments: readonly PromptFragment[],
): string {
  const ordered = orderPromptFragments(fragments);
  const roles = new Set(ordered.map((fragment) => fragment.role));
  if (roles.size > 1) {
    throw new Error(
      'Prompt fragments with different roles cannot be rendered together',
    );
  }

  return PROMPT_TIERS.map((tier) =>
    ordered
      .filter((fragment) => fragment.tier === tier)
      .map((fragment) => fragment.content)
      .join('\n\n'),
  )
    .filter(Boolean)
    .join('\n\n---\n\n');
}
