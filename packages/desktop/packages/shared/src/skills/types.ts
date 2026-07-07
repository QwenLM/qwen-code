/**
 * Skills Types
 *
 * Type definitions for workspace skills.
 * Skills are specialized instructions that extend the agent's capabilities.
 */

/**
 * Skill metadata from SKILL.md YAML frontmatter
 */
export interface SkillMetadata {
  /** Display name for the skill */
  name: string
  /** Brief description shown in skill list */
  description: string
  /** Optional file patterns that trigger this skill */
  globs?: string[]
  /** Optional tools to always allow when skill is active */
  alwaysAllow?: string[]
  /**
   * Optional icon - emoji or URL only.
   * - Emoji: rendered directly in UI (e.g., "🔧")
   * - URL: auto-downloaded to icon.{ext} file
   * Note: Relative paths and inline SVG are NOT supported.
   */
  icon?: string
  /** Optional source slugs to auto-enable when this skill is invoked */
  requiredSources?: string[]
}

/** Source of a loaded skill */
export type SkillSource = 'global' | 'workspace' | 'project' | 'provider'

/**
 * Plugin name for project-level and global skills.
 *
 * The SDK derives plugin names from `path.basename()` of the registered plugin
 * directory. Both `{project}/.agents/` and `~/.agents/` share the basename
 * `.agents`, so skills from either tier resolve to `.agents:skillSlug`.
 */
export const AGENTS_PLUGIN_NAME = '.agents'

/**
 * A loaded skill with parsed content
 */
export interface LoadedSkill {
  /** Directory name (slug) */
  slug: string
  /** Parsed metadata from YAML frontmatter */
  metadata: SkillMetadata
  /** Full SKILL.md content (without frontmatter) */
  content: string
  /** Absolute path to icon file if exists */
  iconPath?: string
  /** Absolute path to skill directory */
  path: string
  /** Where this skill was loaded from */
  source: SkillSource
  /** Whether this skill is currently model-invocable. Omitted for legacy local skills. */
  enabled?: boolean
  /** Provider-native storage level, when advertised by the provider runtime. */
  providerLevel?: string
}
