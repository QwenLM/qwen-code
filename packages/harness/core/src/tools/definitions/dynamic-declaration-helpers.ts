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
import {
  SHELL_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SKILL_TOOL_NAME,
  SHELL_PARAM_COMMAND,
  PARAM_DESCRIPTION,
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
import { zodToToolJsonSchema } from '../../utils/zodToolJsonSchema.js';

/** Default foreground timeout for Bash in milliseconds (2 minutes). */
export const defaultTimeoutMs = 120000;
/** Maximum foreground timeout for Bash in milliseconds (10 minutes). */
export const maxTimeoutMs = 600000;
export const defaultBackgroundTimeoutMs = 600000;
export const maxBackgroundTimeoutMs = 7200000;
export const longBashSleepSeconds = 25;

const GIT_BASH_NOTE =
  'This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell. Use Unix shell syntax: `/dev/null` not `NUL`, forward slashes, `$VAR` not `%VAR%` or `$env:VAR`.';

const BASH_CWD_GUIDANCE =
  "A successful foreground command in the main session carries its final directory to the next call. If it ends outside the workspace, the next call starts in the original directory. Shell variables and functions are reset between calls, and the shell environment is initialized from the user's profile.";

const BASH_BACKGROUND_TIMEOUT_GUIDANCE =
  `For a non-PTY command started in the background, a positive \`timeout\` sets the time limit in milliseconds (default ${defaultBackgroundTimeoutMs}, max ${maxBackgroundTimeoutMs}). A command moved to the background after starting in the foreground gets the default limit from that point. Bash attempts to stop the command at the limit and reports the outcome in a task notification.`;

const BASH_SLEEP_GUIDANCE =
  `Keep foreground sleeps short. A leading literal \`sleep\` of at least ${longBashSleepSeconds} seconds starts in the background when eligible. Use Monitor with an \`until\` loop to wait for a condition when Monitor is available.`;

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
      ? '- Set `pty=true` for an interactive terminal or TUI. Continue the session with BashInput, BashOutput, or BashResize. Use `timeout` and `run_in_background` with non-PTY commands.'
      : '';
    return [
      'Executes a bash command and returns its output.',
      os.platform() === 'win32' ? GIT_BASH_NOTE : '',
      '',
      `- ${BASH_CWD_GUIDANCE} Prefer absolute paths. A compound \`cd\` can trigger a permission prompt. Use \`(cd "path" && command)\` for a one-call directory change.`,
      `- Use dedicated tools for file operations. Use ${avoidCommands} only when explicitly requested or when a dedicated tool cannot do the task.`,
      '- Command output is displayed to you, not reliably to the user.',
      `- \`timeout\` is in milliseconds (foreground default ${defaultTimeoutMs}, max ${maxTimeoutMs}).`,
      `- \`run_in_background\` detaches a command across turns. Omit the trailing \`&\`. ${BASH_BACKGROUND_TIMEOUT_GUIDANCE}`,
      `- ${BASH_SLEEP_GUIDANCE}`,
      leanPtyGuideline,
      '',
      '# Git',
      '- Interactive flags such as `git rebase -i` and `git add -i` are unsupported.',
      '- Use `gh` for GitHub operations when it is installed. Otherwise use an available GitHub integration.',
      '- Bare `@name` mentions in issues, pull requests, and comments can notify GitHub users. Use them only for people you intend to notify. Put placeholders and code in backticks.',
      '- Commit or push only when the user asks. Branch first when starting from the default branch.',
      '- Include any attribution lines supplied in a system reminder at the end of commit messages and pull request descriptions.',
    ]
      .filter((line, index, lines) => line || lines[index - 1] !== '')
      .join('\n');
  }

  return `Executes a given bash command and returns its output.${platformSection}
${BASH_CWD_GUIDANCE}

IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

${toolPreferenceItems}
While the ${SHELL_TOOL_NAME} tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

# Instructions
 - If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.
 - Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")
 - Prefer absolute paths. Use \`(cd "path" && command)\` to change directories for one call. In particular, never prepend \`cd <current-directory>\` to a \`git\` command — \`git\` already operates on the current working tree, and the compound triggers a permission prompt.
 - For non-PTY foreground commands, \`timeout\` is in milliseconds (default ${defaultTimeoutMs}, max ${maxTimeoutMs}). Eligible commands move to the background at this limit.
 - Use \`run_in_background\` when you can continue without the result. Omit the trailing \`&\`. Bash notifies you when it ends. ${BASH_BACKGROUND_TIMEOUT_GUIDANCE}${bashPtyGuidelines}
 - For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
 - Avoid unnecessary \`sleep\` commands:
  - Do not sleep between commands that can run immediately — just run them.
  - If your command is long running and you would like to be notified when it finishes — use \`run_in_background\`. No sleep needed.
  - Do not retry failing commands in a sleep loop — diagnose the root cause.
  - If waiting for a background task you started with \`run_in_background\`, you will be notified when it completes — do not poll.
  - ${BASH_SLEEP_GUIDANCE}
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
Use \`gh\` for GitHub operations such as issues, pull requests, checks, and releases when it is installed. Otherwise use an available GitHub integration.

GitHub notifies the owner of an \`@name\` mention in an issue, pull request, or comment. Use a bare mention only for someone you intend to notify. Put placeholders and code in backticks.

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
   - Create the pull request with the format below. When using gh pr create, pass the body through a HEREDOC to preserve its formatting.
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
- With gh installed, view pull request comments with gh api repos/foo/bar/pulls/123/comments`;
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
          description: 'Bash command to run from the session working directory.',
        },
        risk: {
          type: 'boolean',
          description:
            'Set true if the full command, including its arguments and any nested shell commands, could cause data loss or significant system changes. In Auto mode, true requests additional review. Set false for routine commands. Permission rules apply to either value.',
        },
        [PARAM_DESCRIPTION]: {
          type: 'string',
          description:
            'Describe what the command does in plain words and active voice. The user may read this description without seeing the command. For simple commands, use about 5–10 words. For commands with pipes or unfamiliar flags, explain the overall effect.\n\n- ls → "List files in current directory"\n- git status → "Show working tree status"\n- npm install → "Install package dependencies"\n- curl -s url | jq \'.data[]\' → "Fetch JSON and extract data array elements"',
        },
        [SHELL_PARAM_RUN_IN_BACKGROUND]: {
          type: 'boolean',
          description:
            'Set to true to run a non-PTY command detached and send a task notification when it ends. ' +
            BASH_BACKGROUND_TIMEOUT_GUIDANCE,
        },
        timeout: {
          type: 'number',
          description: `Time limit in milliseconds for non-PTY Bash (foreground default ${defaultTimeoutMs}, max ${maxTimeoutMs}). A command started in the background uses a positive timeout (default ${defaultBackgroundTimeoutMs}, max ${maxBackgroundTimeoutMs}).`,
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
  return {
    name: SKILL_TOOL_NAME,
    description: getActivateSkillDescription(),
    parametersJsonSchema: zodToToolJsonSchema(schema),
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
