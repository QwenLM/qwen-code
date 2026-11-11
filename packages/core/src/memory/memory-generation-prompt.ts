/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview SDK default memory-generation directive builder.
 *
 * Storage procedures belong in the background extraction directive, not in
 * the main agent or subagent system prompt. This preserves the SDK default
 * storage contract for custom roots without exposing it to the main agent.
 */

import { EXPLICIT_MEMORY_TYPES_SECTION } from './memory-types.js';
import type { MemoryPromptRoot } from './auto-memory-prompt.js';
import {
  ensureAutoMemoryDir,
  type MemoryScope,
} from './structured-memory-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENTRYPOINT_NAME = 'MEMORY.md';
const MAX_ENTRYPOINT_LINES = 200;

const AUTO_MEMORY_DISPLAY_NAME = 'auto memory';

const MAIN_SESSION_WRITE_POLICY: readonly string[] = [
  'In the main conversation, modify persistent memory only if the user explicitly asks you to remember or forget specific information. Save or remove the requested information immediately.',
  'Dedicated background memory extraction and Dream consolidation follow their own job instructions.',
  '',
];

const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{short-kebab-case-slug}}',
  'description: {{one-line summary — used to decide relevance in future conversations, so be specific}}',
  'metadata:',
  '  type: {{user, feedback, project, reference}}',
  '---',
  '',
  '{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines. Link related memories with [[their-name]].}}',
  '```',
];

const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## What NOT to save in memory',
  '',
  '- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.',
  '- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.',
  '- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.',
  '- Anything already documented in AGENTS.md files.',
  '- Ephemeral task details: in-progress work, temporary state, current conversation context.',
  '',
  'These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.',
];

const WHEN_TO_ACCESS_LINES: readonly string[] = [
  '## When to access memories',
  '- When memories seem relevant, or the user references prior-conversation work.',
  '- You MUST access memory when the user explicitly asks you to check or recall prior information.',
  '- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.',
];

const WHEN_TO_ACCESS_SECTION: readonly string[] = [
  ...WHEN_TO_ACCESS_LINES,
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

const MEMORY_AND_PERSISTENCE_SECTION: readonly string[] = [
  '## Memory and other forms of persistence',
  'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
  '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
  '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
];

/**
 * Routing guidance for the USER vs PROJECT scope decision, rendered only when
 * native roots are used. Mirrors the memory-design doc §2: two types are
 * pinned to a scope, two float by cross-project applicability.
 */
function buildScopeRoutingLines(roots: readonly MemoryPromptRoot[]): string[] {
  if (roots.length === 1) {
    const activeScope = roots[0].scope;
    const inactiveScope = activeScope === 'user' ? 'project' : 'user';
    const activeDescription =
      activeScope === 'user'
        ? 'shared across all projects'
        : 'specific to this project';
    const floatingGuidance =
      activeScope === 'user'
        ? 'Save `feedback` or `reference` only when it applies across projects.'
        : 'Save `feedback` or `reference` only when it is specific to this project.';
    return [
      `## Active memory scope: ${activeScope.toUpperCase()}`,
      '',
      `Only the **${activeScope.toUpperCase()} scope** (${activeDescription}) is enabled: \`${roots[0].dir}/\`.`,
      `Do not save \`type: ${inactiveScope}\` memories while the ${inactiveScope.toUpperCase()} scope is disabled.`,
      floatingGuidance,
    ];
  }

  const { userDir, projectDir } = resolveScopeDirs(roots);
  return [
    '## Where to save: USER scope vs PROJECT scope',
    '',
    'You have two memory directories. Choose by one question: *is this fact true across all of this user’s projects, or only this project?*',
    '',
    `- **USER scope** (shared across all projects): \`${userDir}/\``,
    `- **PROJECT scope** (only this project): \`${projectDir}/\``,
    '',
    'Routing by type:',
    '- `user` → **always USER**.',
    '- `project` → **always PROJECT**.',
    '- `feedback` → default **USER** (personal collaboration style); use PROJECT only for a rule everyone working on this project must follow (e.g. a project-wide testing invariant).',
    '- `reference` → default **PROJECT** (this project’s dashboards/boards/docs); use USER only for a user-level resource (e.g. a company-wide wiki).',
    '',
    'Each directory has its own `MEMORY.md` index — write the pointer into the index of the same directory you saved the file in.',
  ];
}

/**
 * Resolve native scope paths for generation routing.
 */
function resolveScopeDirs(roots: readonly MemoryPromptRoot[]): {
  userDir: string | undefined;
  projectDir: string | undefined;
} {
  return {
    userDir: roots.find((root) => root.scope === 'user')?.dir,
    projectDir: roots.find((root) => root.scope === 'project')?.dir,
  };
}

function hasExplicitRootContract(roots: readonly MemoryPromptRoot[]): boolean {
  return roots.some(
    (root) => root.access !== undefined || root.indexFile !== undefined,
  );
}

function getRootIndexFile(root: MemoryPromptRoot): string {
  return root.indexFile ?? ENTRYPOINT_NAME;
}

function buildExplicitRootLocationLines(
  roots: readonly MemoryPromptRoot[],
): string[] {
  const hasWritableRoot = roots.some((root) => root.access !== 'read');
  return [
    'You have persistent, file-based memory directories:',
    ...roots.map(
      (root) =>
        `- ${root.id ?? root.scope}: \`${root.dir}/\` (${root.access ?? 'read-write'}; index: ${getRootIndexFile(root)})`,
    ),
    'These directories already exist — do not run mkdir or check for their existence.',
    hasWritableRoot
      ? 'Only create, edit, or delete memory files and indexes in directories marked read-write; directories marked read are read-only.'
      : 'All configured memory directories are read-only; do not create, edit, or delete memory files or indexes.',
  ];
}

function buildExplicitIndexWriteLines(
  roots: readonly MemoryPromptRoot[],
  stepLabel = false,
): string[] {
  const writableRoots = roots.filter((root) => root.access !== 'read');
  if (writableRoots.length === 0) return [];

  return [
    `${stepLabel ? '**Step 2** — add' : 'After writing a memory file in a read-write directory, add'} a one-line pointer (\`- [Title](file.md) — hook\`) to that directory's configured index:`,
    ...writableRoots.map(
      (root) =>
        `- ${root.id ?? root.scope}: \`${getRootIndexFile(root)}\` in \`${root.dir}/\``,
    ),
    `Keep each configured index concise: one line per memory, no frontmatter, and at most ${MAX_ENTRYPOINT_LINES} lines. Never put memory content directly in an index.`,
  ];
}

/**
 * Builds the SDK default background extraction directive for prepared roots.
 */
function buildMemoryGenerationPromptBody(
  roots: readonly MemoryPromptRoot[],
  scopeRouting: boolean,
): string {
  const multiRoot = roots.length > 1;
  const explicitRootContract = hasExplicitRootContract(roots);
  const hasWritableRoot = roots.some((root) => root.access !== 'read');

  const introLocation = explicitRootContract
    ? buildExplicitRootLocationLines(roots)
    : multiRoot
      ? [
          'You have persistent, file-based memory directories (these already exist — do not run mkdir or check for their existence):',
          ...roots.map((r) => `- ${r.id ?? r.scope}: \`${r.dir}/\``),
        ]
      : [
          `You have a persistent, file-based memory system at \`${roots[0]?.dir ?? ''}/\`. This directory already exists — do not run mkdir or check for its existence.`,
        ];

  const lines: string[] = [
    `# ${AUTO_MEMORY_DISPLAY_NAME}`,
    '',
    ...MAIN_SESSION_WRITE_POLICY,
    ...introLocation,
    '',
    ...(explicitRootContract && !hasWritableRoot
      ? [
          'The configured roots are read-only. You may recall their contents, but you cannot save or forget memories in them.',
          '',
        ]
      : []),
    ...EXPLICIT_MEMORY_TYPES_SECTION,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    '## How to save memories',
    '',
    'Saving a memory is a two-step process:',
    '',
    explicitRootContract
      ? '**Step 1** — choose a read-write root and write the memory to its own file (kebab-case filename, e.g., `user-role.md`, `feedback-testing.md`) using this frontmatter format:'
      : '**Step 1** — write the memory to its own file (kebab-case filename, e.g., `user-role.md`, `feedback-testing.md`) using this frontmatter format:',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
  ];

  if (explicitRootContract) {
    lines.push(...buildExplicitIndexWriteLines(roots, true), '');
  } else {
    lines.push(
      `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
      '',
      `- Keep each \`${ENTRYPOINT_NAME}\` index concise and at no more than ${MAX_ENTRYPOINT_LINES} lines`,
    );
  }

  lines.push(
    '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
  );

  if (scopeRouting && roots.length > 0) {
    lines.push('', ...buildScopeRoutingLines(roots));
  }

  lines.push(
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...BEFORE_RECOMMENDING_SECTION,
    '',
    ...MEMORY_AND_PERSISTENCE_SECTION,
  );

  return lines.join('\n').trimEnd();
}

/**
 * Builds writing instructions used only by SDK background memory extraction.
 * Custom root ids do not imply USER/PROJECT scope routing.
 */
type CliManagedMemoryPromptRoot = {
  id: string;
  dir: string;
  scope?: MemoryScope;
  access?: 'read' | 'read-write';
  indexFile?: string;
};

export async function loadAutoMemoryGenerationPromptForRoots(
  roots: readonly CliManagedMemoryPromptRoot[],
  options: { readonly scopeRouting?: boolean } = {},
): Promise<string> {
  const promptRoots: MemoryPromptRoot[] = [];
  for (const root of roots) {
    await ensureAutoMemoryDir(root.dir);
    promptRoots.push({
      id: root.id,
      scope: root.scope ?? 'project',
      dir: root.dir,
      access: root.access,
      indexFile: root.indexFile,
      indexContent: '',
    });
  }

  return buildMemoryGenerationPromptBody(
    promptRoots,
    options.scopeRouting ?? false,
  );
}
