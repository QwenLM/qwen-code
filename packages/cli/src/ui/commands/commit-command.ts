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
- Run \`git status\` to see every modified, deleted, and untracked file — and to spot repository state such as a detached HEAD or an in-progress merge, rebase, or cherry-pick.
- Run \`git diff HEAD\` to read the actual changes (also check anything already staged). Untracked files never appear in this diff — open and read each untracked file directly before judging it.
- Run \`git log --oneline -n 20\` to learn the repository's existing commit message style.
- Note the current branch name; it often hints at the purpose of the change.
- If the repository has no commits yet, \`git diff HEAD\` and \`git log\` fail — skip them and work from \`git status\` plus reading the new files directly.

## 2. Stage selectively
- Review the \`git status\` output and deliberately choose which files belong in this commit.
- Stage the chosen files with targeted \`git add <path>\` commands. Do not run \`git add -A\` or \`git add .\` blindly.
- Never stage a file whose contents you have not seen; the secrets rule below applies to file contents, not file names.
- Leave out build artifacts, debug scratch files, and changes unrelated to this commit's purpose.
- If the user gave additional instructions with the command, let them guide the selection.

## 3. Draft the message
- Draft a commit message that matches the style of the repository's existing commits (subject format, scope prefixes, tense).
- Write a concise subject line. When the change deserves explanation, add a body separated from the subject by a blank line — multi-line messages are fully supported.
- For a multi-line message, prefer repeated inline \`-m\` flags (\`git commit -m "subject" -m "body"\`; git joins the values with blank lines) over ANSI-C $'...' quoting or \`-m "$(cat <<EOF ...)"\` wrappers — see Attribution for why the message form matters.

## 4. Commit
- Create the commit with the complete message text (subject plus body when present).
- If nothing ends up staged or there is nothing to commit, skip the commit and tell the user there is nothing to commit. Never pass \`--allow-empty\`.

## Safety rules (hard constraints)
- Never use \`--amend\` unless the user explicitly asked to amend the previous commit.
- Never pass \`--no-verify\` or bypass git hooks in any other way.
- Never stage or commit files that look like they contain secrets (.env files, private keys, credentials or token files). If such a file appears in the change set, warn the user and leave it out.
- If \`git status\` shows a detached HEAD or an in-progress merge, rebase, or cherry-pick, stop and report the state instead of committing; proceed only after the user confirms.
- If the user's instructions conflict with these rules, follow the rules and explain why.

## Attribution
- Qwen Code auto-appends the configured \`Co-authored-by\` trailer only when ALL of these hold: \`general.gitCoAuthor.commit\` is enabled (it is by default), the active shell is bash, and the commit carries a plain inline \`-m\`/\`--message\` value (quoted, without \`$()\` command substitution). On any other setup — PowerShell or cmd, a heredoc or \`git commit -F\` message, an editor session — no trailer is added.
- When the auto-append fires, the trailer is inserted as a new final paragraph of the message. Do not add your own AI-assistance trailer on top of it, or the commit ends up with two; and since git only recognizes the final trailer block, any trailer lines you wrote earlier in the message would be pushed out of it and degrade to body text.
- When the user explicitly names additional co-authors: on bash, commit with a non-inline message (a heredoc or \`git commit -F -\`) so the auto-append stays out of the way, and write the \`Co-authored-by: Name <email>\` lines yourself as the final paragraph (the configured trailer is not auto-added in that form). On other shells nothing is appended, so an inline \`-m\` message with your own trailer lines is fine.
- After committing, run \`git log -1 --format=%B\` and check which trailers actually landed. If the user asked for credit and a trailer is missing, say so — never claim attribution the commit does not contain.

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
