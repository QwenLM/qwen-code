/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  BackgroundAgentRunner,
  type BackgroundAgentResult,
} from '../background/backgroundAgentRunner.js';
import { getProjectHash, QWEN_DIR } from '../utils/paths.js';
import { AUTO_MEMORY_INDEX_FILENAME, getAutoMemoryRoot } from './paths.js';

const MAX_TURNS = 8;
const MAX_TIME_MINUTES = 5;

const DREAM_AGENT_SYSTEM_PROMPT = `You are performing a managed memory dream — a reflective consolidation pass over durable memory files.

Your job is to read the existing memory files, identify duplicates and inconsistencies, and merge them into a clean, well-organized set of memory files.

Rules:
- Merge semantically duplicate entries — if the same fact appears in multiple files, consolidate into one file and delete the rest.
- Preserve all durable information; do not delete content that is still accurate.
- Fix contradicted or stale facts only when the evidence is clear from the existing memory content.
- Update the MEMORY.md index to accurately reflect surviving files.
- Keep the MEMORY.md index concise: one line per file in the format \`- [Title](relative/path.md) — one-line hook\`.
- If nothing needs consolidation, do nothing and say so.`;

function getTranscriptDir(projectRoot: string): string {
  const projectHash = getProjectHash(projectRoot);
  return `${QWEN_DIR}/tmp/${projectHash}/chats`;
}

function buildConsolidationTaskPrompt(
  memoryRoot: string,
  transcriptDir: string,
): string {
  return [
    `Memory directory: \`${memoryRoot}\``,
    `Session transcripts: \`${transcriptDir}\` (large JSONL files — grep narrowly, don't read whole files)`,
    '',
    '## Phase 1 — Orient',
    '',
    '- List the memory directory to see what files exist',
    `- Read \`${memoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\` to understand the current index`,
    '- Skim topic subdirectories (`user/`, `project/`, `feedback/`, `reference/`)',
    '',
    '## Phase 2 — Gather recent signal',
    '',
    'Look for new information worth persisting. Sources in rough priority order:',
    '',
    '1. Existing memories that drifted — facts that contradict what you now know from current memory files',
    '2. Transcript search — if you need specific context, grep session transcripts for narrow terms:',
    `   \`grep -rn "<narrow term>" ${transcriptDir}/ --include="*.jsonl" | tail -50\``,
    '',
    "Don't exhaustively read transcripts. Look only for things you already suspect matter.",
    '',
    '## Phase 3 — Consolidate',
    '',
    'For each topic directory:',
    '- Identify duplicate or near-duplicate `.md` files (same fact expressed differently)',
    '- Merge duplicates: write the canonical version into one file, delete the redundant files',
    '- Fix stale or contradicted facts when clear from the existing content',
    '',
    '## Phase 4 — Update index',
    '',
    `Update \`${memoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\` to reflect surviving files.`,
    'Each entry: `- [Title](relative/path.md) — one-line hook`',
    'Remove pointers to deleted files. Add pointers to any newly created files.',
    '',
    '---',
    '',
    'Summarize what you merged or pruned. If nothing needed consolidation, say so briefly.',
  ].join('\n');
}

interface BackgroundAgentRunnerLike {
  run(request: Parameters<BackgroundAgentRunner['run']>[0]): Promise<BackgroundAgentResult>;
}

export async function planManagedAutoMemoryDreamByAgent(
  config: Config,
  projectRoot: string,
  runner: BackgroundAgentRunnerLike = new BackgroundAgentRunner(),
): Promise<BackgroundAgentResult> {
  const memoryRoot = getAutoMemoryRoot(projectRoot);
  const transcriptDir = getTranscriptDir(projectRoot);
  const result = await runner.run({
    taskType: 'managed-auto-memory-dream-agent',
    title: 'Managed auto-memory dream agent',
    description: 'Consolidate managed memory files into cleaner summaries.',
    projectRoot,
    sessionId: config.getSessionId(),
    dedupeKey: `managed-auto-memory-dream-agent:${projectRoot}`,
    name: 'managed-auto-memory-dreamer',
    runtimeContext: config,
    taskPrompt: buildConsolidationTaskPrompt(memoryRoot, transcriptDir),
    promptConfig: {
      systemPrompt: DREAM_AGENT_SYSTEM_PROMPT,
    },
    modelConfig: {
      model: config.getModel(),
      temp: 0,
    },
    runConfig: {
      max_turns: MAX_TURNS,
      max_time_minutes: MAX_TIME_MINUTES,
    },
    toolConfig: {
      tools: [
        'read_file',
        'write_file',
        'edit',
        'list_directory',
        'glob',
        'grep_search',
      ],
    },
    metadata: {
      planner: 'dream-agent',
      stage: 'consolidation',
    },
  });

  if (result.status === 'failed') {
    throw new Error(result.error || 'Dream agent failed');
  }

  return result;
}
