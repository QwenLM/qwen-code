/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Memory guidance shared by main-agent and subagent system prompts.
 * Main-agent indexes arrive through user context; per-agent memory embeds its
 * index here. Storage procedures belong to background extraction directives.
 */

import type { Config } from '../config/config.js';
import { MEMORY_TYPES_SUMMARY } from './memory-types.js';
import {
  ensureAutoMemoryDir,
  getScopedAutoMemoryDirs,
  type MemoryScope,
} from './structured-memory-store.js';

const ENTRYPOINT_NAME = 'MEMORY.md';
const AUTO_MEMORY_DISPLAY_NAME = 'auto memory';
export const AGENT_MEMORY_DISPLAY_NAME = 'Persistent Agent Memory';

export type MemoryPromptVariant = 'full' | 'lean';

const MAIN_SESSION_WRITE_POLICY: readonly string[] = [
  'Only if the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
];

const MEMORY_AND_PERSISTENCE_SECTION: readonly string[] = [
  '## Memory and other forms of persistence',
  'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
  '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
  '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
];

const WHEN_TO_ACCESS_LINES: readonly string[] = [
  '## When to access memories',
  '- When memories seem relevant, or the user references prior-conversation work.',
  '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
  '- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.',
  '- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now.',
];

const BEFORE_RECOMMENDING_SECTION: readonly string[] = [
  '## Before recommending from memory',
  '',
  'A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:',
  '',
  '- If the memory names a file path: check the file exists.',
  '- If the memory names a function or flag: grep for it.',
  '- If the user is about to act on your recommendation (not just asking about history), verify first.',
  '',
  '"The memory says X exists" is not the same as "X exists now."',
  '',
  'A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.',
];

/** A single memory root rendered into the prompt. */
export interface MemoryPromptRoot {
  scope: MemoryScope;
  /** Stable caller-facing identifier. Defaults to scope for native roots. */
  id?: string;
  /** Absolute path to the memory directory. */
  dir: string;
  /** Explicit SDK access contract. Omitted for native roots. */
  access?: 'read' | 'read-write';
  /** Explicit SDK index filename. Omitted for native roots. */
  indexFile?: string;
  /** Pre-loaded MEMORY.md content or raw index state. Empty string when none. */
  indexContent: string;
}

export interface MemoryPromptOptions {
  displayName: string;
  /** Preserve the original opening policy; storage procedures remain omitted. */
  writePolicy?: 'explicit-request' | 'automatic';
  roots: readonly MemoryPromptRoot[];
  /** Additional reading guidance, such as a subagent's memory scope. */
  extraGuidelines?: readonly string[];
  /** Main-agent indexes arrive through user context instead. */
  includeIndexContent?: boolean;
  /** Explain active native USER/PROJECT scopes. Custom roots disable it. */
  scopeRouting?: boolean;
  /** Whether each root index is injected into context. */
  indexesLoadedIntoContext?: boolean;
}

function getRootIndexFile(root: MemoryPromptRoot): string {
  return root.indexFile ?? ENTRYPOINT_NAME;
}

function getRootScopeDescription(
  root: MemoryPromptRoot | undefined,
  enabled: boolean,
): string {
  if (!enabled || !root) return '';
  return root.scope === 'user'
    ? ' (shared across this user’s projects)'
    : ' (specific to this project)';
}

function hasExplicitRootContract(roots: readonly MemoryPromptRoot[]): boolean {
  return roots.some(
    (root) => root.access !== undefined || root.indexFile !== undefined,
  );
}

function buildExplicitRootLocationLines(
  roots: readonly MemoryPromptRoot[],
  scopeRouting: boolean,
): string[] {
  const hasWritableRoot = roots.some((root) => root.access !== 'read');
  return [
    'You have persistent, file-based memory directories:',
    ...roots.map(
      (root) =>
        `- ${root.id ?? root.scope}: \`${root.dir}/\` (${root.access ?? 'read-write'}; index: ${getRootIndexFile(root)})${getRootScopeDescription(root, scopeRouting)}`,
    ),
    'These directories already exist — do not run mkdir or check for their existence.',
    hasWritableRoot
      ? 'Only create, edit, or delete memory files and indexes in directories marked read-write; directories marked read are read-only.'
      : 'All configured memory directories are read-only; do not create, edit, or delete memory files or indexes.',
  ];
}

function buildMemoryPromptIntro(
  options: MemoryPromptOptions,
  variant: MemoryPromptVariant,
): string[] {
  const {
    displayName,
    roots,
    writePolicy = 'explicit-request',
    scopeRouting = roots.length > 1,
  } = options;
  const explicitRootContract = hasExplicitRootContract(roots);
  const lines = [variant === 'lean' ? '# Memory' : `# ${displayName}`, ''];

  if (explicitRootContract) {
    lines.push(...buildExplicitRootLocationLines(roots, scopeRouting));
  } else if (roots.length > 1) {
    lines.push(
      variant === 'full'
        ? 'You have persistent, file-based memory directories (these already exist — do not run mkdir or check for their existence):'
        : 'You have persistent file-based memory directories:',
      ...roots.map(
        (root) =>
          `- ${root.id ?? root.scope}: \`${root.dir}/\`${getRootScopeDescription(root, scopeRouting)}`,
      ),
    );
    if (variant === 'lean') {
      lines.push(
        'These directories already exist — do not run mkdir or check for their existence.',
      );
    }
  } else {
    lines.push(
      variant === 'full'
        ? `You have a persistent, file-based memory system at \`${roots[0]?.dir ?? ''}/\`${getRootScopeDescription(roots[0], scopeRouting)}. This directory already exists — do not run mkdir or check for its existence.`
        : `You have a persistent file-based memory at \`${roots[0]?.dir ?? ''}/\`${getRootScopeDescription(roots[0], scopeRouting)}. This directory already exists — do not run mkdir or check for its existence.`,
    );
  }

  if (writePolicy === 'explicit-request') {
    lines.push('', ...MAIN_SESSION_WRITE_POLICY);
  }

  if (variant === 'full') {
    const hasWritableRoot = roots.some((root) => root.access !== 'read');
    if (
      writePolicy === 'automatic' ||
      (explicitRootContract && !hasWritableRoot)
    ) {
      lines.push(
        '',
        explicitRootContract
          ? hasWritableRoot
            ? 'If the user explicitly asks you to remember something, save it immediately as whichever type fits best in a read-write root. If they ask you to forget something, only remove the relevant entry when it is stored in a read-write root.'
            : 'The configured roots are read-only. You may recall their contents, but you cannot save or forget memories in them.'
          : 'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
      );
    }
  }
  return lines;
}

/** Builds memory guidance without storage procedures or index-maintenance rules. */
export function buildMemoryPromptBody(
  options: MemoryPromptOptions,
  variant: MemoryPromptVariant = 'full',
): string {
  const {
    roots,
    extraGuidelines,
    includeIndexContent = true,
    indexesLoadedIntoContext = true,
  } = options;
  const lines = buildMemoryPromptIntro(options, variant);

  if (!indexesLoadedIntoContext) {
    lines.push(
      '',
      'Read the configured indexes and linked topic files when relevant.',
    );
  }

  lines.push('', ...MEMORY_TYPES_SUMMARY);

  lines.push('', ...WHEN_TO_ACCESS_LINES);
  if (variant === 'full') {
    lines.push(
      '',
      ...BEFORE_RECOMMENDING_SECTION,
      '',
      ...MEMORY_AND_PERSISTENCE_SECTION,
    );
  }

  if (extraGuidelines && extraGuidelines.length > 0) {
    lines.push('', ...extraGuidelines);
  }

  if (includeIndexContent) {
    for (const root of roots) {
      lines.push(
        '',
        roots.length > 1
          ? `## ${getRootIndexFile(root)} (${root.id ?? root.scope})`
          : `## ${getRootIndexFile(root)}`,
        '',
        root.indexContent.trim() ||
          `Your ${root.scope} ${getRootIndexFile(root)} is currently empty.`,
      );
    }
  }

  return lines.join('\n').trimEnd();
}

/** Loads main-agent memory-reading guidance; content arrives via user context. */
export async function loadAutoMemoryPrompt(
  config: Config,
  variant: MemoryPromptVariant = 'full',
): Promise<string | null> {
  if (!config.isAutoMemoryEnabled()) return null;

  const roots: MemoryPromptRoot[] = [];
  for (const { scope, dir } of getScopedAutoMemoryDirs(config)) {
    await ensureAutoMemoryDir(dir);
    roots.push({ scope, dir, indexContent: '' });
  }
  if (roots.length === 0) return null;

  return buildMemoryPromptBody(
    {
      displayName: AUTO_MEMORY_DISPLAY_NAME,
      roots,
      includeIndexContent: false,
      scopeRouting: true,
    },
    variant,
  );
}

type CliManagedMemoryPromptRoot = {
  id: string;
  dir: string;
  scope?: MemoryScope;
  access?: 'read' | 'read-write';
  indexFile?: string;
};

/** Loads default system memory-reading guidance for SDK-provided roots. */
export async function loadAutoMemoryPromptForRoots(
  roots: readonly CliManagedMemoryPromptRoot[],
  variant: MemoryPromptVariant = 'full',
  options: { readonly scopeRouting?: boolean } = {},
): Promise<string> {
  const promptRoots: MemoryPromptRoot[] = [];
  for (const root of roots) {
    await ensureAutoMemoryDir(root.dir);
    promptRoots.push({
      ...root,
      scope: root.scope ?? 'project',
      indexContent: '',
    });
  }

  return buildMemoryPromptBody(
    {
      displayName: AUTO_MEMORY_DISPLAY_NAME,
      roots: promptRoots,
      includeIndexContent: false,
      scopeRouting: options.scopeRouting ?? false,
      // SDK generation and consumption can use different files.
      indexesLoadedIntoContext: false,
    },
    variant,
  );
}
