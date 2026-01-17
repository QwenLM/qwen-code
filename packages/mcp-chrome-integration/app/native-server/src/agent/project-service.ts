/**
 * Project Service - Database-backed implementation using Drizzle ORM.
 *
 * Provides CRUD operations for agent projects with:
 * - Type-safe database queries
 * - Path validation with security checks
 * - Consistent with AgentProject interface from shared types
 */
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { eq, desc } from 'drizzle-orm';
import type { AgentProject } from 'chrome-mcp-shared';
import type { CreateOrUpdateProjectInput } from './project-types';
import { getDb, projects, type ProjectRow } from './db';

// ============================================================
// Security Configuration
// ============================================================

/**
 * Allowed base directories for project roots.
 * Only paths under these directories are considered safe.
 */
const ALLOWED_BASE_DIRS: string[] = [
  os.homedir(),
  process.env.USERPROFILE,
  process.env.MCP_ALLOWED_WORKSPACE_BASE,
].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);

// ============================================================
// Path Validation
// ============================================================

/**
 * Result of path validation.
 */
export interface PathValidationResult {
  valid: boolean;
  absolute: string;
  exists: boolean;
  needsCreation: boolean;
  error?: string;
}

/**
 * Validate a root path without creating it.
 * Returns validation result including whether directory needs creation.
 */
export async function validateRootPath(rootPath: string): Promise<PathValidationResult> {
  const trimmed = rootPath.trim();
  if (!trimmed) {
    return {
      valid: false,
      absolute: '',
      exists: false,
      needsCreation: false,
      error: 'Project rootPath must not be empty',
    };
  }

  const absolute = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(process.cwd(), trimmed);

  // Security check: ensure path is under allowed base directories
  const isAllowed = ALLOWED_BASE_DIRS.some((base) => absolute.startsWith(path.resolve(base)));

  if (!isAllowed) {
    return {
      valid: false,
      absolute,
      exists: false,
      needsCreation: false,
      error: `Project rootPath must be under allowed directories: ${ALLOWED_BASE_DIRS.join(', ')}`,
    };
  }

  // Check if path exists
  try {
    const s = await stat(absolute);
    if (!s.isDirectory()) {
      return {
        valid: false,
        absolute,
        exists: true,
        needsCreation: false,
        error: `Path exists but is not a directory: ${absolute}`,
      };
    }
    return { valid: true, absolute, exists: true, needsCreation: false };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      // Path doesn't exist but is valid - can be created
      return { valid: true, absolute, exists: false, needsCreation: true };
    }
    return {
      valid: false,
      absolute,
      exists: false,
      needsCreation: false,
      error: error.message || 'Unknown error validating path',
    };
  }
}

/**
 * Create a project directory after user confirmation.
 * This should only be called after validateRootPath returns needsCreation: true.
 */
export async function createProjectDirectory(absolutePath: string): Promise<void> {
  // Re-validate for safety
  const validation = await validateRootPath(absolutePath);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid path');
  }
  if (validation.exists) {
    throw new Error('Directory already exists');
  }
  await mkdir(absolutePath, { recursive: true });
}

/**
 * Normalize and validate root path.
 * @param rootPath - The path to normalize
 * @param allowCreate - If true, create directory if it doesn't exist
 */
async function normalizeRootPath(rootPath: string, allowCreate = false): Promise<string> {
  const result = await validateRootPath(rootPath);

  if (!result.valid) {
    throw new Error(result.error || 'Invalid path');
  }

  if (result.needsCreation) {
    if (allowCreate) {
      await mkdir(result.absolute, { recursive: true });
    } else {
      throw new Error(
        `Directory does not exist: ${result.absolute}. Use the validate-path API first and confirm creation with the user.`,
      );
    }
  }

  return result.absolute;
}

// ============================================================
// Type Conversion
// ============================================================

/**
 * Convert database row to AgentProject interface.
 */
function rowToProject(row: ProjectRow): AgentProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    rootPath: row.rootPath,
    preferredCli: row.preferredCli as AgentProject['preferredCli'],
    selectedModel: row.selectedModel ?? undefined,
    activeClaudeSessionId: row.activeClaudeSessionId ?? undefined,
    useCcr: row.useCcr === '1',
    enableChromeMcp: row.enableChromeMcp !== '0',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActiveAt: row.lastActiveAt ?? undefined,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * List all projects, sorted by last activity (most recent first).
 */
export async function listProjects(): Promise<AgentProject[]> {
  const db = getDb();
  const rows = await db.select().from(projects).orderBy(desc(projects.lastActiveAt));
  return rows.map(rowToProject);
}

/**
 * Get a single project by ID.
 */
export async function getProject(id: string): Promise<AgentProject | undefined> {
  const db = getDb();
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows.length > 0 ? rowToProject(rows[0]) : undefined;
}

/**
 * Create or update a project.
 */
export async function upsertProject(input: CreateOrUpdateProjectInput): Promise<AgentProject> {
  const db = getDb();
  const now = new Date().toISOString();
  const rootPath = await normalizeRootPath(input.rootPath, input.allowCreate ?? false);

  const id = input.id?.trim() || randomUUID();
  const existing = await getProject(id);

  // Convert booleans to strings for SQLite storage:
  // - useCcr: '1' or null (legacy)
  // - enableChromeMcp: '1' or '0' (non-null; defaults to enabled)
  const useCcrValue =
    input.useCcr !== undefined ? (input.useCcr ? '1' : null) : existing?.useCcr ? '1' : null;

  let enableChromeMcpValue: '1' | '0';
  if (typeof input.enableChromeMcp === 'boolean') {
    enableChromeMcpValue = input.enableChromeMcp ? '1' : '0';
  } else {
    enableChromeMcpValue = existing?.enableChromeMcp === false ? '0' : '1';
  }

  const projectData = {
    id,
    name: input.name.trim(),
    description: input.description?.trim() || existing?.description || null,
    rootPath,
    preferredCli: input.preferredCli ?? existing?.preferredCli ?? null,
    selectedModel: input.selectedModel ?? existing?.selectedModel ?? null,
    // Preserve activeClaudeSessionId from existing project (not settable via upsert)
    activeClaudeSessionId: existing?.activeClaudeSessionId ?? null,
    useCcr: useCcrValue,
    enableChromeMcp: enableChromeMcpValue,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastActiveAt: now,
  };

  if (existing) {
    // Update existing project
    await db.update(projects).set(projectData).where(eq(projects.id, id));
  } else {
    // Insert new project
    await db.insert(projects).values(projectData);
  }

  return rowToProject(projectData as ProjectRow);
}

/**
 * Delete a project by ID.
 * Messages are automatically deleted via cascade.
 */
export async function deleteProject(id: string): Promise<void> {
  const db = getDb();
  await db.delete(projects).where(eq(projects.id, id));
}

/**
 * Update the last activity timestamp for a project.
 */
export async function touchProjectActivity(id: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.update(projects).set({ lastActiveAt: now, updatedAt: now }).where(eq(projects.id, id));
}

/**
 * Update the active Claude session ID for a project.
 * This is called when the SDK returns a system/init message with a new session_id.
 * Pass empty string or null to clear the session ID.
 */
export async function updateProjectClaudeSessionId(
  id: string,
  claudeSessionId: string | null,
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .update(projects)
    .set({
      // Store null if empty string is passed (to clear the session)
      activeClaudeSessionId: claudeSessionId?.trim() || null,
      updatedAt: now,
    })
    .where(eq(projects.id, id));
}
