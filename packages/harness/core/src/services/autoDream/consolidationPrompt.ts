/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MEMORY_INDEX_FILENAME } from '../../memory/structured-memory-store.js';
import type { MemoryScope } from '../../memory/structured-memory-store.js';

const MAX_ENTRYPOINT_LINES = 200;

export function buildConsolidationPrompt(
  memoryRoot: string,
  memoryScope: MemoryScope,
  transcriptDir: string,
  extra: string,
): string {
  const scopeGuidance =
    memoryScope === 'user'
      ? `Memory scope: USER (shared across all projects)

This root is for stable cross-project user facts: identity, long-lived preferences, collaboration style, and reusable workflows. Do not store project-specific implementation details here. When several small \`type: user\` files describe the same person/profile area, prefer merging them into a single canonical user profile or preference file and tombstoning the superseded fragments.`
      : `Memory scope: PROJECT (only this project)

This root is for project-specific facts, repo paths, debugging conclusions, commands, and workflow preferences tied to this project. Do not move project-only facts into USER scope.`;

  return `# Dream: Memory Consolidation

You are performing a dream: a reflective pass over persistent memory files. Synthesize what you learned recently into durable, well-organized memories so future sessions can orient quickly.

Memory directory: \`${memoryRoot}\`
This directory already exists. Write memory files directly inside it; do not run mkdir only to check or create it.

${scopeGuidance}

Session transcripts: \`${transcriptDir}\` (large JSONL files; search narrowly and do not read whole files)

---

## Operating Budget

- Work in batches: when several file reads are independent, request all of them in the same assistant turn.
- Do not read every topic file. Use \`MEMORY.md\`, file names, and narrow Grep searches to choose only the files that are likely to need consolidation.
- Spend no more than a few tool rounds orienting. Once the relevant files are clear, move to Write/Edit. If nothing needs changing, stop and say so.
- When updating multiple files, issue the Write/Edit calls together when safe.

## Phase 1 - Orient

- Use Glob to list top-level memory Markdown files when needed.
- Read \`${MEMORY_INDEX_FILENAME}\` to understand the current index.
- Skim only the most relevant topic files so you improve them instead of creating duplicates.

## Phase 2 - Gather Recent Signal

Look for new information worth persisting. Sources in rough priority order:

1. Existing memories that drifted: facts contradicted by current project state or newer sessions.
2. Transcript search: use the Grep tool with narrow terms under \`${transcriptDir}\` when you need specific context.
3. Recent repeated preferences, workflows, commands, paths, IDs, or debugging conclusions that would help a future session.

Do not exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 - Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section.

Focus on:

- Merging new signal into existing topic files rather than creating near-duplicates.
- Converting relative dates like "yesterday" or "last week" to absolute dates.
- Deleting or correcting contradicted facts at the source.
- Keeping memories operational: exact repo paths, commands, artifacts, and verification evidence matter more than vague summaries.

## Phase 4 - Prune And Index

Update \`${MEMORY_INDEX_FILENAME}\` so it stays under ${MAX_ENTRYPOINT_LINES} lines and under about 25KB. It is an index, not a dump. Each entry should be one line under about 150 characters: \`- [Title](file.md) - one-line hook\`.

- Remove pointers to memories that are now stale, wrong, or superseded.
- Demote verbose entries: if an index line is over about 200 characters, move that detail into the topic file and shorten the index line.
- Add pointers to newly important memories.
- Resolve contradictions; if two files disagree, fix the wrong one.

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed, say so.${extra ? `\n\n## Additional Context\n\n${extra}` : ''}`;
}
