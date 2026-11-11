/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * @fileoverview `/batch` bundled skill — applies a batch change across the codebase
 */

import { AGENT_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import type { BundledSkillRegistrar } from './index.js';

const BATCH_PROMPT = `# Batch: Apply a Change Across the Codebase

You are executing a batch change. The user has described a transformation they want applied across multiple files or areas of the codebase.

## Phase 1: Plan

1. Understand the transformation described by the user
2. Use Grep, Glob, and Read to identify ALL files that need to change
3. Group the work into independent units that can be parallelized
4. Present a brief plan to the user via AskUserQuestion before proceeding

## Phase 2: Spawn Workers

For each independent unit of work, launch an Agent with \`isolation: "worktree"\` to make changes in an isolated git worktree. Use the ${AGENT_TOOL_NAME} tool to spawn workers concurrently — send all Agent calls in a single message to maximize parallelism.

Each worker agent should receive:
- The specific files/patterns it is responsible for
- The exact transformation to apply
- Instructions to make minimal, focused changes

Worker instructions template:
\`\`\`
You are a batch worker. Apply the following transformation to the specified files:

**Transformation**: [describe the change]
**Files**: [list the files]

Rules:
- Make ONLY the specified transformation — do not refactor, clean up, or make improvements
- Do not add comments, docstrings, or type annotations unless they are part of the transformation
- If a file doesn't need the change after inspection, skip it and report why
- Run relevant tests after making changes (if available)
- Report what you changed and what you skipped
\`\`\`

## Phase 3: Track Progress

1. Wait for all workers to complete
2. Review each worker's results
3. If any worker failed, diagnose and retry or fix manually
4. Provide a summary of all changes made

## Important Guidelines

- Always use \`isolation: "worktree"\` for worker agents — this prevents conflicts between parallel workers
- Keep each worker's scope focused and independent to avoid merge conflicts
- If the number of files is large (>10), split into multiple workers (3-5 files per worker)
- For very large batch operations, ask the user to confirm the plan before spawning workers
- If worktree isolation is not available (no git repo), fall back to sequential processing
`;

export function registerBatchSkill(registrar: BundledSkillRegistrar): void {
  registrar.registerBundledSkill({
    name: 'batch',
    description:
      'Apply a batch change across the codebase by spawning parallel worker agents in isolated worktrees.',
    location: 'bundled',
    body: '',
    userInvocable: true,
    disableModelInvocation: true,
    async getBody(args) {
      let prompt = BATCH_PROMPT;
      if (args) {
        prompt += `\n\n## User Instruction\n\n${args}`;
      }
      return prompt;
    },
  });
}
