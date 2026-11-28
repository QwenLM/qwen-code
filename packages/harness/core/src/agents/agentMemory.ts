/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Per-agent persistent memory — scoped memory directories
 * that survive across sessions.
 *
 * Three scopes are supported:
 *   - `user`:    <config-root>/agent-memory/<agentName>/
 *   - `project`: <cwd>/${CONFIG_DIR}/agent-memory/<agentName>/
 *   - `local`:   <cwd>/${CONFIG_DIR}/agent-memory-local/<agentName>/
 *
 * Each directory contains a MEMORY.md entrypoint plus individual topic files.
 * The agent reads/writes these files via standard FileRead/FileWrite/FileEdit
 * tools, guided by behavioral instructions injected into the system prompt.
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { CONFIG_DIR, getConfigHomeDir } from '../utils/paths.js';
import {
  AGENT_MEMORY_DISPLAY_NAME,
  buildMemoryPromptBody,
} from '../memory/auto-memory-prompt.js';
import { truncateIndexContent } from '../memory/memory-index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentMemoryScope = 'user' | 'project' | 'local';

export const VALID_MEMORY_SCOPES: ReadonlySet<string> = new Set<string>([
  'user',
  'project',
  'local',
]);

export function isValidMemoryScope(
  value: string | undefined,
): value is AgentMemoryScope {
  return value !== undefined && VALID_MEMORY_SCOPES.has(value);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_MEMORY_SUBDIR = 'agent-memory';
const AGENT_MEMORY_LOCAL_SUBDIR = 'agent-memory-local';
const MEMORY_ENTRYPOINT = 'MEMORY.md';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Sanitize an agent name for use as a directory name.
 * Replaces colons (used in plugin-namespaced agent types) with dashes,
 * and removes any path-traversal segments.
 */
function sanitizeAgentNameForPath(agentName: string): string {
  return agentName.replace(/:/g, '-').replace(/[/\\]/g, '-');
}

/**
 * Returns the memory directory for a given agent name and scope.
 *
 * - `user`:    <config-root>/agent-memory/<agentName>/
 * - `project`: <cwd>/${CONFIG_DIR}/agent-memory/<agentName>/
 * - `local`:   <cwd>/${CONFIG_DIR}/agent-memory-local/<agentName>/
 */
export function getAgentMemoryDir(
  agentName: string,
  scope: AgentMemoryScope,
  cwd: string,
): string {
  const dirName = sanitizeAgentNameForPath(agentName);
  switch (scope) {
    case 'user': {
      return path.join(getConfigHomeDir(), AGENT_MEMORY_SUBDIR, dirName);
    }
    case 'project':
      return path.join(cwd, CONFIG_DIR, AGENT_MEMORY_SUBDIR, dirName);
    case 'local':
      return path.join(cwd, CONFIG_DIR, AGENT_MEMORY_LOCAL_SUBDIR, dirName);
    default:
      throw new Error(`Unknown agent memory scope: ${scope as string}`);
  }
}

/**
 * Returns the MEMORY.md entrypoint path for a given agent.
 */
export function getAgentMemoryEntrypoint(
  agentName: string,
  scope: AgentMemoryScope,
  cwd: string,
): string {
  return path.join(getAgentMemoryDir(agentName, scope, cwd), MEMORY_ENTRYPOINT);
}

/**
 * Checks if an absolute path is within any agent memory directory.
 * Used by the permission system to auto-allow reads/writes.
 */
export function isAgentMemoryPath(absolutePath: string, cwd: string): boolean {
  const normalized = path.normalize(absolutePath);

  // User scope: <config-root>/agent-memory/
  const userMemBase =
    path.join(getConfigHomeDir(), AGENT_MEMORY_SUBDIR) + path.sep;
  if (normalized.startsWith(userMemBase)) {
    return true;
  }

  // Project scope: <cwd>/${CONFIG_DIR}/agent-memory/
  const projectMemBase =
    path.join(cwd, CONFIG_DIR, AGENT_MEMORY_SUBDIR) + path.sep;
  if (normalized.startsWith(projectMemBase)) {
    return true;
  }

  // Local scope: <cwd>/${CONFIG_DIR}/agent-memory-local/
  const localMemBase =
    path.join(cwd, CONFIG_DIR, AGENT_MEMORY_LOCAL_SUBDIR) + path.sep;
  if (normalized.startsWith(localMemBase)) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Memory directory creation
// ---------------------------------------------------------------------------

/**
 * Ensures the agent memory directory exists.
 * Fire-and-forget — the agent won't try to write until after a full API
 * round-trip, by which time mkdir will have completed.
 */
export async function ensureAgentMemoryDirExists(dir: string): Promise<void> {
  try {
    await fsPromises.mkdir(dir, { recursive: true });
  } catch {
    // Best-effort; FileWrite also does its own mkdir.
  }
}

// ---------------------------------------------------------------------------
// Memory prompt construction
// ---------------------------------------------------------------------------

/**
 * Per-scope guidance bullet appended to the shared memory prompt.
 */
function getScopeNote(scope: AgentMemoryScope): string {
  switch (scope) {
    case 'user':
      return '- This user-scope memory contains context shared across all projects.';
    case 'project':
      return '- This project-scope memory contains project context shared with your team via version control.';
    case 'local':
    default:
      return '- This local-scope memory contains context specific to this project and machine and is not checked into version control.';
  }
}

/**
 * Builds the full memory prompt for injection into a subagent's system prompt.
 *
 * Delegates the body to `buildMemoryPromptBody` (shared with the main agent's
 * `loadAutoMemoryPrompt`), passing a per-scope guidance bullet via
 * `extraGuidelines`. The only differences vs the main agent prompt are:
 *   - Heading: `# Persistent Agent Memory` instead of `# auto memory`.
 *   - Trailing scope note explaining user/project/local semantics.
 *
 * Synchronous: the calling site (agent-setup.ts) is sync. Directory creation
 * is fire-and-forget; MEMORY.md is read synchronously.
 */
export function buildAgentMemoryPrompt(
  agentName: string,
  scope: AgentMemoryScope,
  cwd: string,
): string {
  const memoryDir = getAgentMemoryDir(agentName, scope, cwd);
  const entrypointPath = getAgentMemoryEntrypoint(agentName, scope, cwd);

  // Preserve directory initialization for the agent's memory lifecycle.
  void ensureAgentMemoryDirExists(memoryDir);

  let raw = '';
  try {
    raw = fs.readFileSync(entrypointPath, { encoding: 'utf-8' });
  } catch {
    // No memory file yet — leave empty.
  }
  const indexContent = raw.trim() ? truncateIndexContent(raw) : '';

  return buildMemoryPromptBody({
    displayName: AGENT_MEMORY_DISPLAY_NAME,
    writePolicy: 'automatic',
    // Per-agent memory is single-root; map its own scope onto the project slot
    // (no USER/PROJECT auto-memory routing applies here).
    roots: [{ scope: 'project', dir: memoryDir, indexContent }],
    extraGuidelines: [getScopeNote(scope)],
  });
}
