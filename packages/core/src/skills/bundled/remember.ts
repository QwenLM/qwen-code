/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `/remember` bundled skill — reviews the user's auto-memory
 * landscape and proposes promotions/cleanup across memory layers.
 */

import type { Config } from '../../config/config.js';
import type { BundledSkillRegistrar } from './index.js';

function buildPrompt(config: Config): string {
  const projectMd = config.getCurrentContextFileName();
  const localMd = config.getAllLocalContextFileNames()[0];

  return `# Memory Review

## Goal
Review the user's memory landscape and produce a clear report of proposed changes, grouped by action type. Do NOT apply changes — present proposals for user approval.

## Steps

### 1. Gather all memory layers
Read ${projectMd} and ${localMd} from the project root (if they exist). Your auto-memory content is already in your system prompt — review it there.

**Success criteria**: You have the contents of all memory layers and can compare them.

### 2. Classify each auto-memory entry
For each substantive entry in auto-memory, determine the best destination:

| Destination | What belongs there | Examples |
|---|---|---|
| **${projectMd}** | Project conventions and instructions that all contributors should follow | "use bun not npm", "API routes use kebab-case", "test command is bun test", "prefer functional style" |
| **${localMd}** | Personal instructions specific to this user, not applicable to other contributors | "I prefer concise responses", "always explain trade-offs", "don't auto-commit", "run tests before committing" |
| **Stay in auto-memory** | Working notes, temporary context, or entries that don't clearly fit elsewhere | Session-specific observations, uncertain patterns |

**Important distinctions:**
- ${projectMd} and ${localMd} contain instructions for the assistant, not user preferences for external tools (editor theme, IDE keybindings, etc. don't belong in either)
- Workflow practices (PR conventions, merge strategies, branch naming) are ambiguous — ask the user whether they're personal or team-wide
- When unsure, ask rather than guess

**Success criteria**: Each entry has a proposed destination or is flagged as ambiguous.

### 3. Identify cleanup opportunities
Scan across all layers for:
- **Duplicates**: Auto-memory entries already captured in ${projectMd} or ${localMd} → propose removing from auto-memory
- **Outdated**: ${projectMd} or ${localMd} entries contradicted by newer auto-memory entries → propose updating the older layer
- **Conflicts**: Contradictions between any two layers → propose resolution, noting which is more recent

**Success criteria**: All cross-layer issues identified.

### 4. Present the report
Output a structured report grouped by action type:
1. **Promotions** — entries to move, with destination and rationale
2. **Cleanup** — duplicates, outdated entries, conflicts to resolve
3. **Ambiguous** — entries where you need the user's input on destination
4. **No action needed** — brief note on entries that should stay put

If auto-memory is empty, say so and offer to review ${projectMd} for cleanup.

**Success criteria**: User can review and approve/reject each proposal individually.

## Rules
- Present ALL proposals before making any changes
- Do NOT modify files without explicit user approval
- Do NOT create new files unless the target doesn't exist yet
- Ask about ambiguous entries — don't guess
`;
}

export function registerRememberSkill(
  registrar: BundledSkillRegistrar,
  config: Config,
): void {
  registrar.registerBundledSkill({
    name: 'remember',
    description: `Review auto-memory entries and propose promotions to ${config.getCurrentContextFileName()} or ${config.getAllLocalContextFileNames()[0]}. Also detects outdated, conflicting, and duplicate entries across memory layers.`,
    whenToUse:
      'Use when the user wants to review, organize, or promote their auto-memory entries. Also useful for cleaning up outdated or conflicting entries across memory layers.',
    location: 'bundled',
    body: '',
    userInvocable: true,
    isEnabled: () => config.isAutoMemoryEnabled(),
    async getBody(args) {
      let prompt = buildPrompt(config);
      if (args) {
        prompt += `\n## Additional context from user\n\n${args}`;
      }
      return prompt;
    },
  });
}
