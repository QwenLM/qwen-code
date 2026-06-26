/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { runForkedAgent } from '../utils/forkedAgent.js';
import {
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
  isAnyAutoMemPath,
  isAutoMemPath,
  isUserAutoMemPath,
} from './paths.js';
import { buildManagedAutoMemoryPrompt } from './prompt.js';
import {
  readAutoMemoryIndex,
  readUserAutoMemoryIndex,
  ensureAutoMemoryScaffold,
  ensureUserAutoMemoryScaffold,
} from './store.js';
import {
  rebuildManagedAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';
import { createMemoryScopedAgentConfig } from './memory-scoped-agent-config.js';

export type WorkspaceRememberContextMode = 'workspace' | 'clean';
export type WorkspaceRememberScope = 'user' | 'project';

export interface ManagedRememberResult {
  summary?: string;
  filesTouched: string[];
  touchedScopes: WorkspaceRememberScope[];
}

export function buildManagedRememberPrompt(
  fact: string,
  projectRoot?: string,
): string {
  const trimmed = fact.trim();
  const projectDir = projectRoot ? getAutoMemoryRoot(projectRoot) : undefined;
  const userDir = getUserAutoMemoryRoot();
  const dirHint =
    projectDir !== undefined
      ? ` Choose the destination directory by the type's \`<scope>\`: USER memory at \`${userDir}\` for cross-project facts, PROJECT memory at \`${projectDir}\` for this-project-only facts.`
      : '';
  return `Please save the following to your memory system.${dirHint} Choose the most appropriate memory type (user, feedback, project, or reference) based on the content:\n\n${trimmed}`;
}

export function buildBareRememberPrompt(fact: string): string {
  return `Please save the following fact to memory (e.g. append to QWEN.md in the project root):\n\n${fact.trim()}`;
}

async function buildCleanMemorySystemPrompt(
  projectRoot: string,
): Promise<string> {
  await ensureAutoMemoryScaffold(projectRoot);
  try {
    await ensureUserAutoMemoryScaffold();
  } catch {
    // User-level memory is best-effort elsewhere in managed memory. Keep
    // project memory usable if ~/.qwen/memories cannot be scaffolded.
  }
  const [projectIndex, userIndex] = await Promise.all([
    readAutoMemoryIndex(projectRoot),
    readUserAutoMemoryIndex().catch(() => null),
  ]);

  return buildManagedAutoMemoryPrompt(
    getAutoMemoryRoot(projectRoot),
    projectIndex,
    {
      memoryDir: getUserAutoMemoryRoot(),
      indexContent: userIndex,
    },
  );
}

function buildRememberSystemPrompt(memoryPrompt: string): string {
  return [
    'You are saving one explicit durable memory for Qwen Code.',
    '',
    'Rules:',
    '- Save only information provided in the task prompt.',
    '- Use the managed auto-memory system only; do not write QWEN.md or AGENTS.md.',
    '- Do not inspect or depend on any user-visible chat session history.',
    '- Use read/list/search/write/edit tools only inside the managed memory directories.',
    '- When finished, briefly summarize what memory was saved and where.',
    '',
    memoryPrompt,
  ].join('\n');
}

function uniqueSortedScopes(scopes: Iterable<WorkspaceRememberScope>) {
  return [...new Set(scopes)].sort();
}

function classifyTouchedScopes(
  filesTouched: string[],
  projectRoot: string,
): WorkspaceRememberScope[] {
  const scopes: WorkspaceRememberScope[] = [];
  for (const filePath of filesTouched) {
    if (!isAnyAutoMemPath(filePath, projectRoot)) {
      throw Object.assign(
        new Error(`Remember agent touched a non-memory path: ${filePath}`),
        { code: 'remember_path_escape' },
      );
    }
    if (isUserAutoMemPath(filePath)) {
      scopes.push('user');
    } else if (isAutoMemPath(filePath, projectRoot)) {
      scopes.push('project');
    }
  }
  return uniqueSortedScopes(scopes);
}

export async function runManagedRememberByAgent(params: {
  config: Config;
  projectRoot: string;
  content: string;
  contextMode: WorkspaceRememberContextMode;
  abortSignal?: AbortSignal;
}): Promise<ManagedRememberResult> {
  if (!params.config.isManagedMemoryAvailable()) {
    throw Object.assign(new Error('Managed memory is unavailable'), {
      code: 'managed_memory_unavailable',
    });
  }

  const memoryPrompt = await buildCleanMemorySystemPrompt(params.projectRoot);
  const baseConfig =
    params.contextMode === 'clean'
      ? (() => {
          const cleanConfig = Object.create(params.config) as Config;
          cleanConfig.getUserMemory = () => '';
          return cleanConfig;
        })()
      : params.config;
  const scopedConfig = createMemoryScopedAgentConfig(
    baseConfig,
    params.projectRoot,
  );
  const result = await runForkedAgent({
    name: 'managed-auto-memory-remember',
    config: scopedConfig,
    taskPrompt: buildManagedRememberPrompt(params.content, params.projectRoot),
    systemPrompt: buildRememberSystemPrompt(memoryPrompt),
    maxTurns: 6,
    maxTimeMinutes: 5,
    tools: [
      ToolNames.READ_FILE,
      ToolNames.GREP,
      ToolNames.LS,
      ToolNames.WRITE_FILE,
      ToolNames.EDIT,
    ],
    abortSignal: params.abortSignal,
  });

  if (result.status === 'failed') {
    throw new Error(result.terminateReason || 'Remember agent failed');
  }
  if (result.status === 'cancelled') {
    throw new Error(result.terminateReason || 'Remember agent cancelled');
  }

  const touchedScopes = classifyTouchedScopes(
    result.filesTouched,
    params.projectRoot,
  );
  if (touchedScopes.includes('project')) {
    await rebuildManagedAutoMemoryIndex(params.projectRoot);
  }
  if (touchedScopes.includes('user')) {
    try {
      await rebuildUserAutoMemoryIndex();
    } catch {
      // Mirrors existing managed-memory behavior: user memory is useful
      // when available, but project memory writes should not fail because
      // ~/.qwen/memories cannot be indexed.
    }
  }

  return {
    summary: result.finalText,
    filesTouched: result.filesTouched,
    touchedScopes,
  };
}
