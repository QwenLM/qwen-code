/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SubmitPromptActionReturn } from './types.js';
import { CONFIG_DIR } from '../utils/paths.js';

export type InitMode = 'quick' | 'interactive';

export interface InitOptions {
  mode?: InitMode;
  /**
   * The session's primary context filename, from its own Config.
   *
   * Required rather than defaulted: which file `/init` writes is per-session
   * settings, and a default here would silently write the wrong filename for
   * any session that configured a different one.
   */
  contextFileName: string;
  configDir?: string;
}

export interface InitPromptActionReturn extends SubmitPromptActionReturn {
  content: string;
  isMeta: true;
}

function buildQuickInitPrompt(contextFileName: string): string {
  return `Analyze the codebase and write a minimal ${contextFileName}. ${contextFileName} is loaded into every session, so it must be concise — only include what the AI would get wrong without it.

## Step 1: Explore the codebase

1. List files and directories for a high-level overview of the structure.
2. Read the README file if it exists.
3. Iteratively read up to 10 important files (configuration files, main source files, build configs, CI config, existing AI tool configs like .cursor/rules, .cursorrules, .github/copilot-instructions.md).

## Step 2: Write ${contextFileName}

Write a minimal ${contextFileName} at the project root. Every line must pass this test: "Would removing this cause the AI to make mistakes?" If no, cut it.

Include:
- Build/test/lint commands the AI can't guess (non-standard scripts, flags, or sequences)
- Code style rules that DIFFER from language defaults
- Testing instructions and quirks
- Repo etiquette (branch naming, PR conventions, commit style)
- Required env vars or setup steps
- Non-obvious gotchas or architectural decisions
- Important parts from existing AI coding tool configs if they exist

Exclude:
- File-by-file structure or component lists
- Standard language conventions the AI already knows
- Generic advice ("write clean code", "handle errors")
- Commands obvious from manifest files (e.g., standard "npm test", "cargo test", "pytest")

Prefix the file with:

\`\`\`
# ${contextFileName}

This file provides guidance to the AI agent when working with code in this repository.
\`\`\`

If ${contextFileName} already exists: read it, propose specific changes as diffs, and explain why each change improves it. Do not silently overwrite.

## Step 3: Summary

Summarize what was written. Remind the user they can run \`/init\` again and choose "Interactive" mode for skills and hooks setup.`;
}

function buildInteractiveInitPrompt(
  contextFileName: string,
  configDir: string,
): string {
  return `Set up ${contextFileName} (and optionally skills and hooks) for this repo. ${contextFileName} is loaded into every session, so it must be concise — only include what the AI would get wrong without it.

## Phase 1: Ask what to set up

Use AskUserQuestion to find out what the user wants:

- "Also set up skills and hooks?"
  Options: "Skills + hooks" | "Skills only" | "Hooks only" | "Neither, just ${contextFileName}"
  Description for skills: "On-demand capabilities you or the AI invoke with \`/skill-name\` — good for repeatable workflows and reference knowledge."
  Description for hooks: "Deterministic shell commands that run on tool events (e.g., format after every edit). The AI can't skip them."

## Phase 2: Explore the codebase

Launch a subagent to survey the codebase, and ask it to read key files to understand the project: manifest files (package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, etc.), README, Makefile/build configs, CI config, existing ${contextFileName}, ${configDir}/rules/, AGENTS.md, .cursor/rules or .cursorrules, .github/copilot-instructions.md, .windsurfrules, .clinerules.

Detect:
- Build, test, and lint commands (especially non-standard ones)
- Languages, frameworks, and package manager
- Project structure (monorepo with workspaces, multi-module, or single project)
- Code style rules that differ from language defaults
- Non-obvious gotchas, required env vars, or workflow quirks
- Existing ${configDir}/skills/ and ${configDir}/rules/ directories
- Formatter configuration (prettier, biome, ruff, black, gofmt, rustfmt, or a unified format script like \`npm run format\` / \`make fmt\`)

Note what you could NOT figure out from code alone — these become interview questions.

## Phase 3: Fill in the gaps

Use AskUserQuestion to gather what you still need to write a good ${contextFileName} file and skills. Ask only things the code can't answer.

Ask about codebase practices — non-obvious commands, gotchas, branch/PR conventions, required env setup, testing quirks. Skip things already in README or obvious from manifest files. Do not mark any options as "recommended" — this is about how their team works, not best practices.

**Synthesize a proposal from Phase 2 findings** — e.g., format-on-edit if a formatter exists, a \`/verify\` skill if tests exist, a ${contextFileName} note for anything from the gap-fill answers that's a guideline rather than a workflow. For each, pick the artifact type that fits, **constrained by the Phase 1 skills+hooks choice**:

  - **Hook** (stricter) — deterministic shell command on a tool event; the AI can't skip it. Fits mechanical, fast, per-edit steps: formatting, linting, running a quick test on the changed file.
  - **Skill** (on-demand) — you or the AI invoke \`/skill-name\` when you want it. Fits workflows that don't belong on every edit: deep verification, session reports, deploys.
  - **${contextFileName} note** (looser) — influences behavior but not enforced. Fits communication/thinking preferences: "plan before coding", "be terse", "explain tradeoffs".

  **Respect Phase 1's skills+hooks choice as a hard filter**: if the user picked "Skills only", downgrade any hook you'd suggest to a skill or a ${contextFileName} note. If "Hooks only", downgrade skills to hooks (where mechanically possible) or notes. If "Neither", everything becomes a ${contextFileName} note. Never propose an artifact type the user didn't opt into.

**Show the proposal via AskUserQuestion's \`preview\` field, not as a separate text message** — the dialog overlays your output, so preceding text is hidden. Structure it as:

  - \`question\`: short and plain, e.g. "Does this proposal look right?"
  - Each option gets a \`preview\` with the full proposal as markdown. The "Looks good — proceed" option's preview shows everything; per-item-drop options' previews show what remains after that drop.
  - **Keep previews compact.** One line per item, no blank lines between items, no header. Example preview content:

    • **Format-on-edit hook** (automatic) — \`ruff format <file>\` via PostToolUse
    • **/verify skill** (on-demand) — \`make lint && make typecheck && make test\`
    • **${contextFileName} note** (guideline) — "run lint/typecheck/test before marking done"

  - Option labels stay short ("Looks good", "Drop the hook", "Drop the skill") — the tool auto-adds an "Other" free-text option, so don't add your own catch-all.

**Build the preference queue** from the accepted proposal. Each entry: {type: hook|skill|note, description, target file, any Phase-2-sourced details like the actual test/format command}. Phases 4-6 consume this queue.

## Phase 4: Write ${contextFileName}

Write a minimal ${contextFileName} at the project root. Every line must pass this test: "Would removing this cause the AI to make mistakes?" If no, cut it.

**Consume \`note\` entries from the Phase 3 preference queue** — add each as a concise line in the most relevant section. These are the behaviors the user wants the AI to follow but didn't need guaranteed.

Include:
- Build/test/lint commands the AI can't guess (non-standard scripts, flags, or sequences)
- Code style rules that DIFFER from language defaults (e.g., "prefer type over interface")
- Testing instructions and quirks (e.g., "run single test with: pytest -k 'test_name'")
- Repo etiquette (branch naming, PR conventions, commit style)
- Required env vars or setup steps
- Non-obvious gotchas or architectural decisions
- Important parts from existing AI coding tool configs if they exist (AGENTS.md, .cursor/rules, .cursorrules, .github/copilot-instructions.md, .windsurfrules, .clinerules)

Exclude:
- File-by-file structure or component lists (the AI can discover these by reading the codebase)
- Standard language conventions the AI already knows
- Generic advice ("write clean code", "handle errors")
- Detailed API docs or long references — use \`@path/to/import\` syntax instead to inline content on demand without bloating ${contextFileName}
- Information that changes frequently — reference the source with \`@path/to/import\` so the AI always reads the current version
- Long tutorials or walkthroughs (move to a separate file and reference with \`@path/to/import\`, or put in a skill)
- Commands obvious from manifest files (e.g., standard "npm test", "cargo test", "pytest")

Be specific: "Use 2-space indentation in TypeScript" is better than "Format code properly."

Do not repeat yourself and do not make up sections like "Common Development Tasks" or "Tips for Development" — only include information expressly found in files you read.

Prefix the file with:

\`\`\`
# ${contextFileName}

This file provides guidance to the AI agent when working with code in this repository.
\`\`\`

If ${contextFileName} already exists: read it, propose specific changes as diffs, and explain why each change improves it. Do not silently overwrite.

For projects with multiple concerns, suggest organizing instructions into \`${configDir}/rules/\` as separate focused files (e.g., \`code-style.md\`, \`testing.md\`, \`security.md\`). These are loaded automatically alongside ${contextFileName} and can be scoped to specific file paths using \`paths\` frontmatter.

For projects with distinct subdirectories (monorepos, multi-module projects, etc.): mention that subdirectory ${contextFileName} files can be added for module-specific instructions (they're loaded automatically when working in those directories). Offer to create them if the user wants.

Mention that a \`${contextFileName.replace('.md', '.local.md')}\` file can be created for private, per-user project instructions that should not be committed to version control (e.g., personal workflow preferences, local environment paths, debugging shortcuts). This file is automatically picked up with higher priority than ${contextFileName} and is gitignored by default.

## Phase 5: Suggest and create skills (if user chose "Skills + hooks" or "Skills only")

Skills add capabilities the AI can use on demand without bloating every session.

**First, consume \`skill\` entries from the Phase 3 preference queue.** Each queued skill preference becomes a SKILL.md tailored to what the user described. For each:
- Name it from the preference (e.g., "verify-deep", "session-report", "deploy-sandbox")
- Write the body using the user's own words from the interview plus whatever Phase 2 found (test commands, report format, deploy target).
- Ask a quick follow-up if the preference is underspecified (e.g., "which test command should verify-deep run?")

**Then suggest additional skills** beyond the queue when you find:
- Reference knowledge for specific tasks (conventions, patterns, style guides for a subsystem)
- Repeatable workflows the user would want to trigger directly (deploy, fix an issue, release process, verify changes)

For each suggested skill, provide: name, one-line purpose, and why it fits this repo.

If \`${configDir}/skills/\` already exists with skills, review them first. Do not overwrite existing skills — only propose new ones that complement what is already there.

Create each skill at \`${configDir}/skills/<skill-name>/SKILL.md\`:

\`\`\`yaml
---
name: <skill-name>
description: <what the skill does and when to use it>
---

<Instructions for the AI>
\`\`\`

Both the user (\`/<skill-name>\`) and the AI can invoke skills by default. For workflows with side effects (e.g., \`/deploy\`, \`/fix-issue 123\`), add \`disable-model-invocation: true\` so only the user can trigger it, and use \`$ARGUMENTS\` to accept input.

## Phase 6: Suggest additional optimizations

Tell the user you're going to suggest a few additional optimizations now that ${contextFileName} and skills (if chosen) are in place.

Check the environment and ask about each gap you find (use AskUserQuestion):

- **GitHub CLI**: Run \`which gh\` (or \`where gh\` on Windows). If it's missing AND the project uses GitHub (check \`git remote -v\` for github.com), ask the user if they want to install it. Explain that the GitHub CLI lets the AI help with commits, pull requests, issues, and code review directly.

- **Linting**: If Phase 2 found no lint config (no .eslintrc, ruff.toml, .golangci.yml, etc. for the project's language), ask the user if they want the AI to set up linting for this codebase. Explain that linting catches issues early and gives the AI fast feedback on its own edits.

- **Proposal-sourced hooks** (if user chose "Skills + hooks" or "Hooks only"): Consume \`hook\` entries from the Phase 3 preference queue. If Phase 2 found a formatter and the queue has no formatting hook, offer format-on-edit as a fallback. If the user chose "Neither" or "Skills only" in Phase 1, skip this bullet entirely.

  For each hook preference (from the queue or the formatter fallback):

  1. Target file: \`${configDir}/settings.json\` (team-shared, committed to version control).

  2. Pick the event and matcher from the preference:
     - "after every edit" → \`PostToolUse\` with matcher \`Write|Edit\`
     - "when the AI finishes" / "before I review" → \`Stop\` event (fires at the end of every turn)
     - "before running bash" → \`PreToolUse\` with matcher \`Bash\`
     - "before committing" (literal git-commit gate) → **not a hooks.json hook.** Route this to a git pre-commit hook instead — offer to write one.
     Probe if the preference is ambiguous.

  3. **Construct the hook command.** Important runtime rules:

     - **The hook process's working directory is already the project root** — never \`cd\` to the project directory in the command. Just run the tool directly (e.g., \`npx prettier --write "$f"\` not \`cd /path/to/project && npx prettier --write "$f"\`).
     - **On Windows, hooks run in Git Bash by default** — always use POSIX paths (\`/c/Users/...\`), not Windows paths (\`C:\\Users\\...\`). But since cwd is already set, you almost never need absolute paths at all.
     - **The hook receives JSON on stdin** with tool context. To extract the file path, use \`jq\` into a quoted variable:
       \`\`\`bash
       jq -r '.tool_response.filePath // .tool_input.file_path' | { read -r f; prettier --write "$f"; } 2>/dev/null || true
       \`\`\`
       Never use unquoted \`| xargs\` (breaks on spaces in paths).
     - Use the project's actual package runner (npx/bunx/yarn/pnpm/./mvnw/./gradlew) — check Phase 2 findings.

     Hook JSON schema:

     \`\`\`json
     {
       "hooks": {
         "EVENT_NAME": [
           {
             "matcher": "ToolName|OtherTool",
             "hooks": [
               {
                 "type": "command",
                 "command": "your-command-here",
                 "timeout": 60
               }
             ]
           }
         ]
       }
     }
     \`\`\`

     Available hook events:
     | Event | Matcher | Purpose |
     |-------|---------|---------|
     | PreToolUse | Tool name | Run before tool execution, can block |
     | PostToolUse | Tool name | Run after successful tool execution |
     | PostToolUseFailure | Tool name | Run after tool failure |
     | Stop | - | Run when the AI stops a turn |
     | PreCompact | "manual"/"auto" | Before context compaction |
     | PostCompact | "manual"/"auto" | After context compaction |
     | UserPromptSubmit | - | When user submits a prompt |
     | SessionStart | - | When session starts |
     | Notification | Notification type | Run on notifications |

  4. **Pipe-test the command before writing.** Synthesize the stdin JSON and pipe it to your command to verify it works:
     \`\`\`bash
     echo '{"tool_name":"Edit","tool_input":{"file_path":"<a real file from this repo>"}}' | <your-command>
     \`\`\`
     Check exit code and side effect. If it fails (wrong package manager? tool not installed? jq path wrong?), fix and retest. Once it works, wrap with \`2>/dev/null || true\` (unless the user wants a blocking check).

  5. **Write and validate.** Read the target settings file if it exists, merge the new hook config, write it back. Then validate with \`jq -e . ${configDir}/settings.json\`.

Act on each "yes" before moving on.

## Phase 7: Summary and next steps

Recap what was set up — which files were written and the key points included in each. Remind the user these files are a starting point: they should review and tweak them, and can run \`/init\` again anytime to re-scan.`;
}

export function performInit(options: InitOptions): InitPromptActionReturn {
  const { mode = 'quick', contextFileName, configDir = CONFIG_DIR } = options;

  const content =
    mode === 'quick'
      ? buildQuickInitPrompt(contextFileName)
      : buildInteractiveInitPrompt(contextFileName, configDir);

  return {
    type: 'submit_prompt',
    content,
    isMeta: true,
  };
}
