/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SubmitPromptActionReturn } from './types.js';

export type ReviewTarget =
  | { type: 'current_changes' }
  | { type: 'base_branch'; branch: string }
  | { type: 'commit'; sha: string; title?: string };

export interface ReviewRequest {
  target: ReviewTarget;
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll('`', '\\`')}\``;
}

function assertUnreachable(value: never): never {
  throw new Error(`Unhandled review target: ${JSON.stringify(value)}`);
}

function buildTargetInstruction(target: ReviewTarget): string {
  switch (target.type) {
    case 'current_changes':
      return `Review the current code changes in this working tree, including staged changes, unstaged changes, and untracked files. Start with ${inlineCode('git status --short')}. Use ${inlineCode('git diff --staged')} and ${inlineCode('git diff')} to inspect tracked changes. For untracked files, inspect the file contents directly.`;
    case 'base_branch':
      return `Review the code changes on the current branch against the base branch ${inlineCode(target.branch)}. Start by finding the merge base between HEAD and ${inlineCode(target.branch)}, then run ${inlineCode(`git diff <merge-base-sha>`)} to inspect the changes that would be merged into ${inlineCode(target.branch)}.`;
    case 'commit': {
      const title = target.title ? ` (${JSON.stringify(target.title)})` : '';
      return `Review the code changes introduced by commit ${inlineCode(target.sha)}${title}. Use ${inlineCode(`git show --stat --oneline ${target.sha}`)} and ${inlineCode(`git show --format=fuller --find-renames ${target.sha}`)} to inspect the commit.`;
    }
    default:
      return assertUnreachable(target);
  }
}

export function buildReviewPrompt(request: ReviewRequest): string {
  const targetInstruction = buildTargetInstruction(request.target);

  return `You are a senior engineer reviewing a colleague's code change. Your goal is to be a helpful, thorough reviewer — the kind who catches real problems early and makes the codebase better, without nitpicking or being unnecessarily harsh.

## What to review

${targetInstruction}

## What to look for

Focus on things the author would genuinely want to know before merging: correctness issues, subtle bugs, regressions, unhandled edge cases, performance footguns, confusing logic that will trip up the next reader, and gaps in test coverage that leave real risk uncovered.

Stay focused on what the change itself introduces. Don't flag pre-existing issues unrelated to this diff, cosmetic style preferences, or sweeping refactors unless the change actively makes them necessary.

Before raising an issue, check the surrounding code to make sure you're not misreading intent or missing context.

## How to present findings

Organize findings from most to least severe. For each one, mention the file and line, explain why it matters, and suggest a concrete direction for the fix. Keep each finding focused on a single issue.

If nothing actionable stands out, simply say: No actionable findings found.

Skip the preamble — lead directly with findings. Only add context where it genuinely helps the author understand why something matters.

## Language

Respond in the same language the user is using in this conversation. If the conversation so far is in Chinese, write your review in Chinese. If in English, write in English. Match the user's language naturally.`;
}

export function performReview(
  request: ReviewRequest,
): SubmitPromptActionReturn {
  return {
    type: 'submit_prompt',
    content: buildReviewPrompt(request),
    isMeta: true,
  };
}
