/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reusable logic for generating tool declarations that depend on runtime state
 * (OS, platforms, or dynamic schema values like available skills).
 */

import os from 'node:os';
import { type FunctionDeclaration } from '@google/genai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  SHELL_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SKILL_TOOL_NAME,
  SHELL_PARAM_COMMAND,
  PARAM_DESCRIPTION,
  PARAM_DIR_PATH,
  SHELL_PARAM_RUN_IN_BACKGROUND,
  SKILL_PARAM_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  TOPIC_PARAM_TITLE,
  TOPIC_PARAM_SUMMARY,
  TOPIC_PARAM_STRATEGIC_INTENT,
  READ_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  AGENT_TOOL_NAME,
} from './base-declarations.js';
import {
  getExitPlanModeDescription,
  getActivateSkillDescription,
} from './tool-prompts/index.js';
import { isBashPtyToolsEnabled } from '../bash-pty-feature-gate.js';
import type { PromptBundle } from '../../prompts/types.js';

/** Default absolute timeout for shell commands in milliseconds (2 minutes). */
export const defaultTimeoutMs = 120000;
/** Maximum absolute timeout for shell commands in milliseconds (10 minutes). */
export const maxTimeoutMs = 600000;

const GIT_BASH_NOTE =
  'This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell. Use Unix shell syntax: `/dev/null` not `NUL`, forward slashes, `$VAR` not `%VAR%` or `$env:VAR`.';

/**
 * Generates the description for the shell tool: the full Bash prompt with
 * capability-specific additions for the product.
 */
export function getShellToolDescription(
  enableBashPtyTools: boolean = isBashPtyToolsEnabled(),
  bundle: PromptBundle = 'full',
): string {
  const platformSection =
    os.platform() === 'win32' ? `\n\n${GIT_BASH_NOTE}\n` : '\n';

  const avoidCommands = '`cat`, `head`, `tail`, `sed`, `awk`, or `echo`';

  const toolPreferenceItems = [
    `- Read files: Use ${READ_FILE_TOOL_NAME} (NOT cat/head/tail)`,
    `- Edit files: Use ${EDIT_TOOL_NAME} (NOT sed/awk)`,
    `- Write files: Use ${WRITE_FILE_TOOL_NAME} (NOT echo >/cat <<EOF)`,
    '- Communication: Output text directly (NOT echo/printf)',
  ].join('\n');

  const bashPtyGuidelines = enableBashPtyTools
    ? `
 - Use \`pty=true\` only when the command needs a real interactive terminal, such as launching or testing a TUI. A PTY command opens a persistent interactive session and returns a PID for follow-up BashInput, BashOutput, and BashResize calls.
 - Only when \`pty=true\` is set, the PTY launch parameters apply: \`cols\`, \`rows\`, \`wait_ms\`, and \`idle_ms\`. \`cols\` and \`rows\` are terminal size in character cells. \`wait_ms\` and \`idle_ms\` control how long Bash waits for the initial rendered screen before returning.
 - Recommended PTY workflow: start the TUI with \`Bash({ pty: true })\`, call BashOutput only if the initial screen is empty or still loading, then use BashInput to type text or send keys. BashInput returns the rendered screen after the input transaction settles.
 - Use BashInput with \`submit=true\` whenever typed text should be sent or executed after input. Do not split normal text submission into a text write plus a separate Enter write; BashInput sends text and Enter as one ordered transaction. Leave \`submit\` false for partial typing, menu navigation, focus/cursor movement, or control/function keys such as Esc, Tab, arrows, or Ctrl+C.
 - Use BashOutput when you need extra waiting or observation, such as an empty/loading screen, long asynchronous output, a previous BashInput with \`settled=false\` or \`input_warnings\`, or an explicit need to re-read the current screen. It is usually unnecessary immediately after a successful BashInput because BashInput already returns the rendered screen.
 - Use BashResize when the TUI layout needs a different terminal size after launch; resize uses character cells, not pixels.
`
    : '';

  if (bundle === 'lean') {
    const leanPtyGuideline = enableBashPtyTools
      ? '- Use `pty=true` only for an interactive terminal or TUI; continue the returned session with BashInput, BashOutput, or BashResize.'
      : '';
    const leanBackgroundGuideline =
      '- `run_in_background` runs the command detached and notifies you when it exits. No trailing `&` is needed.';

    return [
      'Executes a bash command and returns its output.',
      os.platform() === 'win32' ? GIT_BASH_NOTE : '',
      '',
      "- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (environment variables and functions) does not persist; the shell is initialized from the user's profile.",
      `- IMPORTANT: Avoid using this tool to run ${avoidCommands} commands unless explicitly instructed or after verifying that a dedicated tool cannot accomplish the task. Prefer the dedicated tool for a clearer, reviewable operation.`,
      '- Command output is displayed to you, not reliably to the user.',
      '- Commands are cheap to run and their errors are informative: run the straightforward command, then adjust from its output.',
      `- \`timeout\` is in milliseconds: default ${defaultTimeoutMs}, max ${maxTimeoutMs}.`,
      leanBackgroundGuideline,
      leanPtyGuideline,
      '',
      '# Git',
      '- Interactive flags such as `git rebase -i` and `git add -i` are not supported.',
      '- Commit or push only when the user asks. Prefer a new commit over amending an existing one.',
      '- Do not bypass hooks or signing unless the user explicitly asks.',
    ]
      .filter((line, index, lines) => line || lines[index - 1] !== '')
      .join('\n');
  }

  return `Executes a given bash command and returns its output.${platformSection}
The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

${toolPreferenceItems}
While the ${SHELL_TOOL_NAME} tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

# Instructions
 - If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.
 - Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")
 - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it. In particular, never prepend \`cd <current-directory>\` to a \`git\` command — \`git\` already operates on the current working tree, and the compound triggers a permission prompt.
 - You may specify an optional timeout in milliseconds (up to ${maxTimeoutMs}ms / ${maxTimeoutMs / 60000} minutes). By default, your command will timeout after ${defaultTimeoutMs}ms (${defaultTimeoutMs / 60000} minutes).
 - You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.${bashPtyGuidelines}
 - For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
 - Avoid unnecessary \`sleep\` commands:
  - Do not sleep between commands that can run immediately — just run them.
  - If your command is long running and you would like to be notified when it finishes — use \`run_in_background\`. No sleep needed.
  - Do not retry failing commands in a sleep loop — diagnose the root cause.
  - If waiting for a background task you started with \`run_in_background\`, you will be notified when it completes — do not poll.
  - If you must poll an external process, use a check command (e.g. \`gh run view\`) rather than sleeping first.
  - If you must sleep, keep the duration short to avoid blocking the user.
 - When running \`find\`, search from \`.\` (or a specific path), not \`/\` — scanning the full filesystem can exhaust system resources on large trees.
 - When using \`find -regex\` with alternation, put the longest alternative first. Example: use \`'.*\\.\\(tsx\\|ts\\)'\` not \`'.*\\.\\(ts\\|tsx\\)'\` — the second form silently skips \`.tsx\` files.

# Committing changes with git

Only create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:

You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. The numbered steps below indicate which commands should be batched in parallel.

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive

1. Run the following bash commands in parallel, each using the ${SHELL_TOOL_NAME} tool:
  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.
  - Run a git diff command to see both staged and unstaged changes that will be committed.
  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.
2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:
  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).
  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"
  - Ensure it accurately reflects the changes and their purpose
3. Run the following commands in parallel:
   - Add relevant untracked files to the staging area.
   - Create the commit with a message.
   - Run git status after the commit completes to verify success.
   Note: git status depends on the commit completing, so run it sequentially after the commit.
4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit

Important notes:
- NEVER run additional commands to read or explore code, besides git bash commands
- NEVER use ${WRITE_TODOS_TOOL_NAME}, ${TASK_CREATE_TOOL_NAME}, ${TASK_GET_TOOL_NAME}, ${TASK_UPDATE_TOOL_NAME}, ${TASK_LIST_TOOL_NAME}, or ${AGENT_TOOL_NAME}
- DO NOT push to the remote repository unless the user explicitly asks you to do so
- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.
- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:
<example>
git commit -m "$(cat <<'EOF'
   Commit message here.
   EOF
   )"
</example>

# Creating pull requests
Use the gh command via the ${SHELL_TOOL_NAME} tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.

IMPORTANT: When the user asks you to create a pull request, follow these steps carefully:

1. Run the following bash commands in parallel using the ${SHELL_TOOL_NAME} tool, in order to understand the current state of the branch since it diverged from the main branch:
   - Run a git status command to see all untracked files (never use -uall flag)
   - Run a git diff command to see both staged and unstaged changes that will be committed
   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote
   - Run a git log command and \`git diff [base-branch]...HEAD\` to understand the full commit history for the current branch (from the time it diverged from the base branch)
2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:
   - Keep the PR title short (under 70 characters)
   - Use the description/body for details, not the title
3. Run the following commands in parallel:
   - Create new branch if needed
   - Push to remote with -u flag if needed
   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.
<example>
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]
EOF
)"
</example>

Important:
- DO NOT use ${WRITE_TODOS_TOOL_NAME}, ${TASK_CREATE_TOOL_NAME}, ${TASK_GET_TOOL_NAME}, ${TASK_UPDATE_TOOL_NAME}, ${TASK_LIST_TOOL_NAME}, or ${AGENT_TOOL_NAME}
- Return the PR URL when you're done, so the user can see it

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`;
}

/**
 * Returns the FunctionDeclaration for the shell tool.
 */
export function getShellDeclaration(
  enableBashPtyTools: boolean = isBashPtyToolsEnabled(),
  bundle: PromptBundle = 'full',
): FunctionDeclaration {
  const ptyProperties = enableBashPtyTools
    ? {
        pty: {
          type: 'boolean',
          description:
            'Set to true only when the command needs a real interactive terminal, such as launching or testing a TUI. When true, Bash opens a persistent PTY session and returns a PID for BashInput, BashOutput, and BashResize.',
        },
        cols: {
          type: 'number',
          description:
            'Only applies when pty=true. Initial PTY width in character cells. Defaults to 160.',
        },
        rows: {
          type: 'number',
          description:
            'Only applies when pty=true. Initial PTY height in character cells. Defaults to 50.',
        },
        wait_ms: {
          type: 'number',
          description:
            'Only applies when pty=true. Maximum time to wait for terminal output before returning the initial rendered screen.',
        },
        idle_ms: {
          type: 'number',
          description:
            'Only applies when pty=true. Consider the initial rendered screen stable after this many milliseconds without new output.',
        },
      }
    : {};
  return {
    name: SHELL_TOOL_NAME,
    description: getShellToolDescription(enableBashPtyTools, bundle),
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [SHELL_PARAM_COMMAND]: {
          type: 'string',
          description: 'The command to execute',
        },
        [PARAM_DESCRIPTION]: {
          type: 'string',
          description:
            'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls → "List files in current directory"\n- git status → "Show working tree status"\n- npm install → "Install package dependencies"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"\n- git reset --hard origin/main → "Discard all local changes and match remote main"\n- curl -s url | jq \'.data[]\' → "Fetch JSON from URL and extract data array elements"',
        },
        [PARAM_DIR_PATH]: {
          type: 'string',
          description:
            '(OPTIONAL) The directory to run the command in. If omitted, the current working directory is used. Relative paths are resolved against the project root directory. Must be a directory within the workspace and must already exist.',
        },
        [SHELL_PARAM_RUN_IN_BACKGROUND]: {
          type: 'boolean',
          description: 'Set to true to run this command in the background.',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in milliseconds (max 600000)',
        },
        ...ptyProperties,
      },
      required: [SHELL_PARAM_COMMAND],
    },
  };
}

/**
 * Cached FunctionDeclaration for exiting plan mode (fully static).
 */
const EXIT_PLAN_MODE_DECLARATION: FunctionDeclaration = {
  name: EXIT_PLAN_MODE_TOOL_NAME,
  description: getExitPlanModeDescription(),
  parametersJsonSchema: {
    type: 'object',
    properties: {
      allowedPrompts: {
        type: 'array',
        description:
          'Optional list of Bash command categories to pre-authorize for the implementation phase. ' +
          'Each entry describes a category of shell commands semantically (e.g. "run tests", "install dependencies"). ' +
          'Reserved for future use by the permission system.',
        items: {
          type: 'object',
          required: ['tool', 'prompt'],
          properties: {
            tool: {
              type: 'string',
              enum: [SHELL_TOOL_NAME],
              description: 'The tool these permissions apply to.',
            },
            prompt: {
              type: 'string',
              description:
                'Semantic description of the allowed command category, e.g. "run tests", "install dependencies".',
            },
          },
        },
      },
    },
  },
};

export function getExitPlanModeDeclaration(): FunctionDeclaration {
  return EXIT_PLAN_MODE_DECLARATION;
}

/**
 * Cached FunctionDeclaration for activating a skill (fully static).
 */
const ACTIVATE_SKILL_DECLARATION: FunctionDeclaration = (() => {
  const schema = z.object({
    [SKILL_PARAM_NAME]: z
      .string()
      .describe(
        'The name of a skill from the available-skills list. Do not guess names.',
      ),
    args: z
      .string()
      .optional()
      .describe('Optional arguments to pass to the skill.'),
  });
  const { $schema: _$schema, ...parametersJsonSchema } =
    zodToJsonSchema(schema);

  return {
    name: SKILL_TOOL_NAME,
    description: getActivateSkillDescription(),
    parametersJsonSchema,
  };
})();

export function getActivateSkillDeclaration(): FunctionDeclaration {
  return ACTIVATE_SKILL_DECLARATION;
}

/**
 * Returns the FunctionDeclaration for updating the topic context.
 */
export function getUpdateTopicDeclaration(): FunctionDeclaration {
  return {
    name: UPDATE_TOPIC_TOOL_NAME,
    description:
      'Manages your narrative flow. Include `title` and `summary` only when starting a new Chapter (logical phase) or shifting strategic intent.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [TOPIC_PARAM_TITLE]: {
          type: 'string',
          description: 'The title of the new topic or chapter.',
        },
        [TOPIC_PARAM_SUMMARY]: {
          type: 'string',
          description:
            '(OPTIONAL) A detailed summary (5-10 sentences) covering both the work completed in the previous topic and the strategic intent of the new topic. This is required when transitioning between topics to maintain continuity.',
        },
        [TOPIC_PARAM_STRATEGIC_INTENT]: {
          type: 'string',
          description:
            'A mandatory one-sentence statement of your immediate intent.',
        },
      },
      required: [TOPIC_PARAM_STRATEGIC_INTENT],
    },
  };
}
