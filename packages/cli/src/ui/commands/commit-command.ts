/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SubmitPromptActionReturn,
} from './types.js';
import { t } from '../../i18n/index.js';

/**
 * The instruction set handed to the model when the user runs `/commit`.
 *
 * Per the #4000 redesign (and the #3935 review feedback), the command itself
 * is deliberately shell-logic-free: it injects this prompt into the
 * conversation and the model does the work — reading the diff, choosing what
 * to stage, drafting the message, and running the commit through its tools.
 */
export const COMMIT_PROMPT = `You are executing the /commit slash command: create a single git commit in the current repository on behalf of the user. Do the work yourself using your available tools.

## 1. Gather context
- Run \`git status\` to see every modified, deleted, and untracked file.
- Run \`git diff HEAD\` to read the actual changes (also check anything already staged).
- Run \`git log --oneline -n 20\` to learn the repository's existing commit message style.
- Note the current branch name; it often hints at the purpose of the change.
- If the repository has no commits yet, \`git diff HEAD\` and \`git log\` fail — skip them and work from \`git status\` plus reading the new files directly.

## 2. Stage selectively
- Review the \`git status\` output and deliberately choose which files belong in this commit.
- Stage the chosen files with targeted \`git add <path>\` commands. Do not run \`git add -A\` or \`git add .\` blindly.
- Leave out build artifacts, debug scratch files, and changes unrelated to this commit's purpose.
- If the user gave additional instructions with the command, let them guide the selection.

## 3. Draft the message
- Draft a commit message that matches the style of the repository's existing commits (subject format, scope prefixes, tense).
- Write a concise subject line. When the change deserves explanation, add a body separated from the subject by a blank line — multi-line messages are fully supported.

## 4. Commit
- Create the commit with the complete message text (subject plus body when present).
- If nothing ends up staged or there is nothing to commit, skip the commit and tell the user there is nothing to commit. Never pass \`--allow-empty\`.

## Safety rules (hard constraints)
- Never use \`--amend\` unless the user explicitly asked to amend the previous commit.
- Never pass \`--no-verify\` or bypass git hooks in any other way.
- Never stage or commit files that look like they contain secrets (.env files, private keys, credentials or token files). If such a file appears in the change set, warn the user and leave it out.
- If the user's instructions conflict with these rules, follow the rules and explain why.

## Attribution
- When \`general.gitCoAuthor.commit\` is enabled — which is the default — Qwen Code already appends the configured \`Co-authored-by\` trailer to a commit made with an inline \`-m\`/\`-am\` message. Do not add your own AI-assistance trailer on top of it, or the commit ends up with two.
- Add \`Co-authored-by: Name <email>\` trailer lines only for additional co-authors the user explicitly names.
- This auto-append is a no-op when the commit carries no inline \`-m\`/\`-am\` message (a heredoc body, or an editor session), so never assume the trailer landed. If the user asked for credit and your message was not inline, tell them the configured co-author trailer was not applied.

When done, report what was staged and committed — or why nothing was committed.`;

export const commitCommand: SlashCommand = {
  name: 'commit',
  get description() {
    return t('Create a git commit with an AI-drafted message');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    _context: CommandContext,
    args: string,
  ): Promise<SubmitPromptActionReturn> => {
    const userInstructions = args.trim();
    const prompt = userInstructions
      ? `${COMMIT_PROMPT}\n\nAdditional instructions from the user:\n${userInstructions}`
      : COMMIT_PROMPT;
    return {
      type: 'submit_prompt',
      content: [{ text: prompt }],
    };
  },
};
