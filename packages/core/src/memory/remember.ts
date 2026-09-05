/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { deriveConfig, type Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  runForkedAgent,
  type ForkedAgentResult,
} from '../agents/forkedAgent.js';
import { getAutoMemoryRoot, getUserAutoMemoryRoot } from './paths.js';
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
import {
  createMemoryScopedAgentConfig,
  isAllowedMemoryPath,
} from './memory-scoped-agent-config.js';
import {
  scanAutoMemoryTopicDocuments,
  scanUserAutoMemoryTopicDocuments,
} from './scan.js';
import { renderWriterKeywordVocabularySnapshot } from './writer-keyword-vocabulary.js';

const debugLogger = createDebugLogger('AUTO_MEMORY_REMEMBER');

export type WorkspaceRememberContextMode = 'workspace' | 'clean';
export type WorkspaceRememberScope = 'user' | 'project';
export type WorkspaceRememberTargetScope = WorkspaceRememberScope;

export interface ManagedRememberResult {
  summary?: string;
  filesTouched: string[];
  touchedScopes: WorkspaceRememberScope[];
}

export function buildManagedRememberPrompt(
  fact: string,
  projectRoot?: string,
  options: {
    wrapUserContent?: boolean;
    scope?: WorkspaceRememberTargetScope;
  } = {},
): string {
  const trimmed = fact.trim();
  const projectDir = projectRoot ? getAutoMemoryRoot(projectRoot) : undefined;
  const userDir = getUserAutoMemoryRoot();
  const dirHint =
    projectDir === undefined
      ? ''
      : options.scope === 'project'
        ? ` Store this memory only in PROJECT memory at \`${projectDir}\`. This explicit project target overrides the memory type's default destination; do not read or write USER memory at \`${userDir}\`.`
        : options.scope === 'user'
          ? ` Store this memory only in USER memory at \`${userDir}\`. This explicit user target overrides the memory type's default destination; do not read or write PROJECT memory at \`${projectDir}\`.`
          : ` Choose the destination directory by the type's \`<scope>\`: USER memory at \`${userDir}\` for cross-project facts, PROJECT memory at \`${projectDir}\` for this-project-only facts.`;
  const content = options.wrapUserContent
    ? `<user-content>\n${trimmed}\n</user-content>`
    : trimmed;
  return `Please save the following to your memory system.${dirHint} Choose the most appropriate memory type (user, feedback, project, or reference) based on the content:\n\n${content}`;
}

export function buildBareRememberPrompt(fact: string): string {
  return `Please save the following fact to memory (e.g. append to QWEN.md in the project root):\n\n${fact.trim()}`;
}

async function buildCleanMemorySystemPrompt(
  projectRoot: string,
  scope?: WorkspaceRememberTargetScope,
): Promise<string> {
  if (scope === 'user') {
    await ensureUserAutoMemoryScaffold();
    // Render the user store as the sole tier: the run's permission boundary
    // denies project writes, so a project tier here would only steer the agent
    // into burning turns on denied writes. Mirrors how an explicit project
    // target omits the user section below.
    return buildManagedAutoMemoryPrompt(
      getUserAutoMemoryRoot(),
      await readUserAutoMemoryIndex().catch(() => null),
      /* userSection */ undefined,
      /* teamSection */ undefined,
      // The remember agent needs the full protocol (type definitions, scope
      // routing, exclusion rules) to write correct memories — do not remove.
      {
        forceFullProtocol: true,
        keywordVocabularySnapshot: renderWriterKeywordVocabularySnapshot(
          await scanUserAutoMemoryTopicDocuments().catch(() => []),
          { scopes: ['user'] },
        ),
      },
    );
  }

  await ensureAutoMemoryScaffold(projectRoot);
  let userMemory:
    | { memoryDir: string; indexContent: string | null }
    | undefined;
  if (scope !== 'project') {
    try {
      await ensureUserAutoMemoryScaffold();
    } catch {
      // User-level memory remains best-effort for automatic scope selection.
    }
    userMemory = {
      memoryDir: getUserAutoMemoryRoot(),
      indexContent: await readUserAutoMemoryIndex().catch(() => null),
    };
  }
  const [projectIndex, projectDocs, userDocs] = await Promise.all([
    readAutoMemoryIndex(projectRoot),
    scanAutoMemoryTopicDocuments(projectRoot),
    scope === 'project'
      ? Promise.resolve([])
      : scanUserAutoMemoryTopicDocuments().catch(() => []),
  ]);

  return buildManagedAutoMemoryPrompt(
    getAutoMemoryRoot(projectRoot),
    projectIndex,
    userMemory,
    /* teamSection */ undefined,
    // The remember agent needs the full protocol (type definitions, scope routing,
    // exclusion rules) to write correct memories — do not remove.
    {
      forceFullProtocol: true,
      keywordVocabularySnapshot: renderWriterKeywordVocabularySnapshot(
        [...userDocs, ...projectDocs],
        { scopes: scope === 'project' ? ['project'] : ['user', 'project'] },
      ),
    },
  );
}

function buildRememberSystemPrompt(memoryPrompt: string): string {
  return [
    'You are saving one explicit durable memory for Qwen Code.',
    '',
    'Rules:',
    '- This is an explicit add request. You must use a write or edit tool to create or update a managed memory entry. If the content duplicates an existing entry, update that entry so the latest request wins.',
    '- If the supplied content supersedes a conflicting instruction in the selected memory scope, update that entry so the latest explicit request wins.',
    '- Save only information provided in the task prompt.',
    '- Use the managed auto-memory system only; do not write QWEN.md or AGENTS.md.',
    '- Do not create or edit MEMORY.md. The caller rebuilds memory indexes after the entry write succeeds.',
    '- Create or update exactly one managed memory entry, then stop.',
    '- Do not inspect or depend on any user-visible chat session history.',
    '- Use read/list/search/write/edit tools only inside the managed memory directories.',
    '- Never modify, overwrite, rename, or delete anything under `pinned/`: those records are user-curated and protected. If the request conflicts with one, write your entry as a separate record instead.',
    '- When finished, report only whether the memory update completed; do not quote or summarize memory content.',
    '',
    memoryPrompt,
  ].join('\n');
}

function createHiddenRememberConfig(
  config: Config,
  options: { disableHooks?: boolean } = {},
): Config {
  return deriveConfig(config, {
    getChatRecordingService: () => undefined,
    getTranscriptPath: () => '',
    ...(options.disableHooks
      ? {
          getDisableAllHooks: () => true,
          getHookSystem: () => undefined,
          getMessageBus: () => undefined,
        }
      : {}),
  });
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
    if (!isAllowedMemoryPath(filePath, projectRoot)) {
      throw Object.assign(
        new Error(`Remember agent touched a non-memory path: ${filePath}`),
        { code: 'remember_path_escape' },
      );
    }
    if (
      isAllowedMemoryPath(filePath, projectRoot, { includeUserMemory: false })
    ) {
      scopes.push('project');
    } else {
      scopes.push('user');
    }
  }
  return uniqueSortedScopes(scopes);
}

export async function runManagedRememberByAgent(params: {
  config: Config;
  projectRoot: string;
  content: string;
  contextMode: WorkspaceRememberContextMode;
  scope?: WorkspaceRememberTargetScope;
  abortSignal?: AbortSignal;
}): Promise<ManagedRememberResult> {
  if (!params.config.isManagedMemoryAvailable()) {
    throw Object.assign(new Error('Managed memory is unavailable'), {
      code: 'managed_memory_unavailable',
    });
  }

  const memoryPrompt = await buildCleanMemorySystemPrompt(
    params.projectRoot,
    params.scope,
  );
  // The remember agent's system prompt already embeds the full managed
  // auto-memory protocol and MEMORY.md indexes (buildCleanMemorySystemPrompt
  // with forceFullProtocol). AgentCore.buildChatSystemPrompt would otherwise
  // append config.getAutoMemoryPrompt() a second time, duplicating the entire
  // section — and in clean mode re-injecting parent-session memory into the
  // intended blank-slate agent. Zero it out for every mode so the section is
  // present exactly once, via the remember system prompt above.
  const baseConfig = deriveConfig(params.config, {
    getAutoMemoryPrompt: () => '',
    ...(params.contextMode === 'clean' ? { getUserMemory: () => '' } : {}),
  });
  const hiddenConfig = createHiddenRememberConfig(baseConfig, {
    disableHooks: params.contextMode === 'clean',
  });
  const scopedConfig = createMemoryScopedAgentConfig(
    hiddenConfig,
    params.projectRoot,
    {
      bypassBaseAskForScopedPaths: true,
      includeProjectMemory: params.scope !== 'user',
      includeUserMemory: params.scope !== 'project',
      restrictReadsToMemoryPaths: true,
      // `pinned/` records are user-curated and declared read-only by the
      // extraction and dream planners, which both pass this. Remember is an
      // explicit write request whose rules steer the agent to update a
      // conflicting entry, and MEMORY.md — embedded in this agent's system
      // prompt — indexes pinned records like any other, so without this the
      // agent can be steered straight onto one and
      // `completeAfterFirstSuccessfulWrite` would report success over it.
      protectPinnedMemory: true,
    },
  );
  let result: ForkedAgentResult;
  try {
    result = await runForkedAgent({
      name: 'managed-auto-memory-remember',
      config: scopedConfig,
      taskPrompt: buildManagedRememberPrompt(
        params.content,
        params.projectRoot,
        {
          wrapUserContent: true,
          ...(params.scope ? { scope: params.scope } : {}),
        },
      ),
      systemPrompt: buildRememberSystemPrompt(memoryPrompt),
      maxTurns: params.config.getMemoryAgentMaxTurns() ?? 6,
      maxTimeMinutes: params.config.getMemoryAgentTimeoutMinutes() ?? 5,
      extraHistory: params.contextMode === 'clean' ? [] : undefined,
      preserveEmptyExtraHistory: params.contextMode === 'clean',
      tools: [
        ToolNames.READ_FILE,
        ToolNames.GREP,
        ToolNames.WRITE_FILE,
        ToolNames.EDIT,
      ],
      abortSignal: params.abortSignal,
      suppressChatRecording: true,
      completeAfterFirstSuccessfulWrite: (filePath) =>
        path.basename(filePath) !== 'MEMORY.md',
    });
  } catch (err) {
    // A rejection after a write (timeout abort mid model stream, any
    // mid-run throw) escapes the per-status repair below, and MEMORY.md
    // loads verbatim into every future session — rebuild every store
    // the agent could write to before surfacing the error.
    await Promise.all([
      ...(params.scope !== 'user'
        ? [rebuildManagedAutoMemoryIndex(params.projectRoot)]
        : []),
      ...(params.scope !== 'project' ? [rebuildUserAutoMemoryIndex()] : []),
    ]).catch((rebuildErr: unknown) => {
      debugLogger.error('Memory index rebuild failed:', rebuildErr);
    });
    throw err;
  }

  const filesWritten = result.filesWritten ?? [];
  const entryFilesWritten = filesWritten.filter(
    (filePath) => path.basename(filePath) !== 'MEMORY.md',
  );
  // Classify every successful write — MEMORY.md included — so a hand-written
  // index still triggers the rebuild that atomically regenerates it from the
  // entry files. MEMORY.md loads verbatim into every future session, so no
  // exit path may leave the agent's index write on disk unrepaired — failed
  // and cancelled runs included.
  // Classify per file rather than all-or-nothing: one unclassifiable path
  // must not void the repair of the classifiable ones it was reported
  // alongside. A mixed report is exactly the shape that leaves a
  // hand-written MEMORY.md on disk, so the escape is surfaced only after
  // every store it could be paired with has been rebuilt.
  const { writtenScopes, escapeError } = (() => {
    const scopes: WorkspaceRememberScope[] = [];
    let firstEscape: unknown;
    for (const filePath of filesWritten) {
      try {
        scopes.push(...classifyTouchedScopes([filePath], params.projectRoot));
      } catch (err) {
        firstEscape ??= err;
      }
    }
    return {
      writtenScopes: uniqueSortedScopes(scopes),
      escapeError: firstEscape,
    };
  })();
  const rebuildWrittenScopes = () =>
    Promise.all([
      writtenScopes.includes('project')
        ? rebuildManagedAutoMemoryIndex(params.projectRoot)
        : Promise.resolve(),
      writtenScopes.includes('user')
        ? params.scope === 'user'
          ? rebuildUserAutoMemoryIndex()
          : rebuildUserAutoMemoryIndex().catch((err: unknown) => {
              // Automatic scope selection keeps user memory best-effort.
              debugLogger.error('User memory index rebuild failed:', err);
            })
        : Promise.resolve(),
    ]);
  if (escapeError !== undefined) {
    if (result.status === 'completed') {
      // The audit failed, but the memory-root writes reported alongside the
      // escape are real and their index is stale until rebuilt.
      await rebuildWrittenScopes().catch((err: unknown) => {
        debugLogger.error('Memory index rebuild failed:', err);
      });
      throw escapeError;
    }
    // A failed or cancelled run surfaces its termination reason, not a
    // path-escape audit; the repair below still covers what could be
    // classified.
    debugLogger.error('Remember write audit failed:', escapeError);
  }
  if (result.status === 'failed' || result.status === 'cancelled') {
    // Best-effort: a rebuild failure must not mask the termination reason.
    await rebuildWrittenScopes().catch((err: unknown) => {
      debugLogger.error('Memory index rebuild failed:', err);
    });
    throw new Error(
      result.terminateReason ||
        (result.status === 'failed'
          ? 'Remember agent failed'
          : 'Remember agent cancelled'),
    );
  }
  if (entryFilesWritten.length === 0) {
    debugLogger.warn('Remember agent completed without writing memory.', {
      filesTouched: result.filesTouched,
      finalTextLength: result.finalText?.length ?? 0,
    });
    // Best-effort, exactly as on the failed/cancelled paths above: the
    // coded error is what every caller branches on, and a rebuild rejection
    // here would replace it with an uncoded one — the guard would still have
    // fired, but nothing downstream could tell that it had.
    await rebuildWrittenScopes().catch((err: unknown) => {
      debugLogger.error('Memory index rebuild failed:', err);
    });
    throw Object.assign(new Error('Remember agent did not update any memory'), {
      code: 'remember_no_update',
    });
  }
  const touchedScopes = classifyTouchedScopes(
    entryFilesWritten,
    params.projectRoot,
  );
  if (params.scope && touchedScopes.some((scope) => scope !== params.scope)) {
    // Same reason as the no-update guard: `remember_scope_mismatch` is the
    // signal the scope boundary was crossed, and a rebuild rejection must not
    // be able to stand in for it.
    await rebuildWrittenScopes().catch((err: unknown) => {
      debugLogger.error('Memory index rebuild failed:', err);
    });
    throw Object.assign(
      new Error(
        `Remember agent wrote outside the requested ${params.scope} scope`,
      ),
      { code: 'remember_scope_mismatch' },
    );
  }

  if (touchedScopes.includes('user')) {
    await params.config
      .getMemoryManager()
      .recordUserMutation(params.projectRoot, params.config);
  }
  await rebuildWrittenScopes();

  return {
    summary: 'Memory update completed.',
    filesTouched: entryFilesWritten,
    touchedScopes,
  };
}
