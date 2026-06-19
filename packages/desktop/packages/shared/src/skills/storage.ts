/**
 * Skills Storage
 *
 * CRUD operations for workspace skills.
 * Skills are stored in {workspace}/skills/{slug}/ directories.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import matter from 'gray-matter'
import type { LoadedSkill, SkillMetadata, SkillSource } from './types.ts'
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts'
import {
  validateIconValue,
  findIconFile,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
} from '../utils/icon.ts'

// ============================================================
// Agent Skills Paths (Issue #171)
// ============================================================

/** Global agent skills directory: ~/.agents/skills/ */
export const GLOBAL_AGENT_SKILLS_DIR = join(homedir(), '.agents', 'skills')

/** Global Qwen Code skills directory: ~/.qwen/skills/ */
export const GLOBAL_QWEN_SKILLS_DIR = join(homedir(), '.qwen', 'skills')

/** Project-level agent skills relative directory name */
export const PROJECT_AGENT_SKILLS_DIR = '.agents/skills'

/** Project-level Qwen Code skills relative directory name */
export const PROJECT_QWEN_SKILLS_DIR = '.qwen/skills'

/**
 * Normalize requiredSources frontmatter to a clean string array.
 * Accepts a single string or array of strings, trims whitespace, and deduplicates.
 */
function normalizeRequiredSources(value: unknown): string[] | undefined {
  const asArray =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value
        : undefined

  if (!asArray) return undefined

  const normalized = Array.from(
    new Set(
      asArray
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )

  return normalized.length > 0 ? normalized : undefined
}

// ============================================================
// Parsing
// ============================================================

/**
 * Parse SKILL.md content and extract frontmatter + body
 */
function parseSkillFile(
  content: string,
): { metadata: SkillMetadata; body: string } | null {
  try {
    const parsed = matter(content)

    // Validate required fields
    if (!parsed.data.name || !parsed.data.description) {
      return null
    }

    // Validate and extract optional icon field
    // Only accepts emoji or URL - rejects inline SVG and relative paths
    const icon = validateIconValue(parsed.data.icon, 'Skills')

    return {
      metadata: {
        name: parsed.data.name as string,
        description: parsed.data.description as string,
        globs: parsed.data.globs as string[] | undefined,
        alwaysAllow: parsed.data.alwaysAllow as string[] | undefined,
        icon,
        requiredSources: normalizeRequiredSources(parsed.data.requiredSources),
      },
      body: parsed.content,
    }
  } catch {
    return null
  }
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single skill from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param slug - Skill directory name
 * @param source - Where this skill is loaded from
 */
function loadSkillFromDir(
  skillsDir: string,
  slug: string,
  source: SkillSource,
): LoadedSkill | null {
  const skillDir = join(skillsDir, slug)
  const skillFile = join(skillDir, 'SKILL.md')

  // Check directory exists
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    return null
  }

  // Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return null
  }

  // Read and parse SKILL.md
  let content: string
  try {
    content = readFileSync(skillFile, 'utf-8')
  } catch {
    return null
  }

  const parsed = parseSkillFile(content)
  if (!parsed) {
    return null
  }

  return {
    slug,
    metadata: parsed.metadata,
    content: parsed.body,
    iconPath: findIconFile(skillDir),
    path: skillDir,
    source,
  }
}

/**
 * Load all skills from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param source - Where these skills are loaded from
 */
function loadSkillsFromDir(
  skillsDir: string,
  source: SkillSource,
): LoadedSkill[] {
  if (!existsSync(skillsDir)) {
    return []
  }

  const skills: LoadedSkill[] = []

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skill = loadSkillFromDir(skillsDir, entry.name, source)
      if (skill) {
        skills.push(skill)
      }
    }
  } catch {
    // Ignore errors reading skills directory
  }

  return skills
}

function loadSkillsFromDirs(
  skillsDirs: string[],
  source: SkillSource,
): LoadedSkill[] {
  const skillsBySlug = new Map<string, LoadedSkill>()

  for (const dir of skillsDirs) {
    for (const skill of loadSkillsFromDir(dir, source)) {
      if (!skillsBySlug.has(skill.slug)) {
        skillsBySlug.set(skill.slug, skill)
      }
    }
  }

  return [...skillsBySlug.values()]
}

/**
 * Load a single skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function loadSkill(
  workspaceRoot: string,
  slug: string,
): LoadedSkill | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot)
  return loadSkillFromDir(skillsDir, slug, 'workspace')
}

/**
 * Load all skills from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function loadWorkspaceSkills(workspaceRoot: string): LoadedSkill[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot)
  return loadSkillsFromDir(skillsDir, 'workspace')
}

// ── Skills cache ────────────────────────────────────────────────────────
// loadAllSkills reads from up to 3 directories on every call (~100ms).
// The result rarely changes during a session, so we cache it per
// (workspaceRoot, projectRoot) pair with a 5-minute safety TTL.

const skillsCache = new Map<string, { skills: LoadedSkill[]; ts: number }>()
const SKILLS_CACHE_TTL = 5 * 60_000 // 5 minutes

/** Invalidate the skills cache (call on working dir change or skill file events). */
export function invalidateSkillsCache(): void {
  skillsCache.clear()
}

/**
 * Load all skills from all sources (global, workspace, project)
 * Skills with the same slug are overridden by higher-priority sources.
 * Priority: global (lowest) < workspace < project (highest)
 *
 * Results are cached per (workspaceRoot, projectRoot) pair. Call
 * invalidateSkillsCache() on working directory changes or skill file events.
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param projectRoot - Optional project root (working directory) for project-level skills
 */
export function loadAllSkills(
  workspaceRoot: string,
  projectRoot?: string,
): LoadedSkill[] {
  const cacheKey = `${workspaceRoot}::${projectRoot ?? ''}`
  const now = Date.now()
  const cached = skillsCache.get(cacheKey)
  if (cached && now - cached.ts < SKILLS_CACHE_TTL) {
    return cached.skills
  }

  const skillsBySlug = new Map<string, LoadedSkill>()

  // 1. Global skills (lowest priority): ~/.qwen/skills/ then ~/.agents/skills/
  for (const skill of loadSkillsFromDirs(
    [GLOBAL_QWEN_SKILLS_DIR, GLOBAL_AGENT_SKILLS_DIR],
    'global',
  )) {
    skillsBySlug.set(skill.slug, skill)
  }

  // 2. Workspace skills (medium priority)
  for (const skill of loadWorkspaceSkills(workspaceRoot)) {
    skillsBySlug.set(skill.slug, skill)
  }

  // 3. Project skills (highest priority): {projectRoot}/.qwen/skills/ then .agents/skills/
  if (projectRoot) {
    const projectSkillsDirs = [
      join(projectRoot, PROJECT_QWEN_SKILLS_DIR),
      join(projectRoot, PROJECT_AGENT_SKILLS_DIR),
    ]
    for (const skill of loadSkillsFromDirs(projectSkillsDirs, 'project')) {
      skillsBySlug.set(skill.slug, skill)
    }
  }

  const result = Array.from(skillsBySlug.values())
  skillsCache.set(cacheKey, { skills: result, ts: now })
  return result
}

/**
 * Load a single skill by slug from all sources (project > workspace > global).
 * Unlike loadAllSkills(), this only reads the specific slug directory — O(1) not O(N).
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill slug to load
 * @param projectRoot - Optional project root for project-level skills
 */
export function loadSkillBySlug(
  workspaceRoot: string,
  slug: string,
  projectRoot?: string,
): LoadedSkill | null {
  // Highest priority: project-level
  if (projectRoot) {
    for (const projectSkillsDir of [
      PROJECT_QWEN_SKILLS_DIR,
      PROJECT_AGENT_SKILLS_DIR,
    ]) {
      const skill = loadSkillFromDir(
        join(projectRoot, projectSkillsDir),
        slug,
        'project',
      )
      if (skill) return skill
    }
  }

  // Medium priority: workspace
  const workspaceSkill = loadSkillFromDir(
    getWorkspaceSkillsPath(workspaceRoot),
    slug,
    'workspace',
  )
  if (workspaceSkill) return workspaceSkill

  // Lowest priority: global
  return (
    loadSkillFromDir(GLOBAL_QWEN_SKILLS_DIR, slug, 'global') ??
    loadSkillFromDir(GLOBAL_AGENT_SKILLS_DIR, slug, 'global')
  )
}

/**
 * Get icon path for a skill
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function getSkillIconPath(
  workspaceRoot: string,
  slug: string,
): string | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot)
  const skillDir = join(skillsDir, slug)

  if (!existsSync(skillDir)) {
    return null
  }

  return findIconFile(skillDir) || null
}

// ============================================================
// Delete Operations
// ============================================================

/**
 * Delete a skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function deleteSkill(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot)
  const skillDir = join(skillsDir, slug)

  if (!existsSync(skillDir)) {
    return false
  }

  try {
    rmSync(skillDir, { recursive: true })
    return true
  } catch {
    return false
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Check if a skill exists in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function skillExists(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot)
  const skillDir = join(skillsDir, slug)
  const skillFile = join(skillDir, 'SKILL.md')

  return existsSync(skillDir) && existsSync(skillFile)
}

/**
 * List skill slugs in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function listSkillSlugs(workspaceRoot: string): string[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot)

  if (!existsSync(skillsDir)) {
    return []
  }

  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false
        const skillFile = join(skillsDir, entry.name, 'SKILL.md')
        return existsSync(skillFile)
      })
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

// ============================================================
// Icon Download (uses shared utilities)
// ============================================================

/**
 * Download an icon from a URL and save it to the skill directory.
 * Returns the path to the downloaded icon, or null on failure.
 */
export async function downloadSkillIcon(
  skillDir: string,
  iconUrl: string,
): Promise<string | null> {
  return downloadIcon(skillDir, iconUrl, 'Skills')
}

/**
 * Check if a skill needs its icon downloaded.
 * Returns true if metadata has a URL icon and no local icon file exists.
 */
export function skillNeedsIconDownload(skill: LoadedSkill): boolean {
  return needsIconDownload(skill.metadata.icon, skill.iconPath)
}

// Re-export icon utilities for convenience
export { isIconUrl } from '../utils/icon.ts'
