/**
 * Mention Parsing Utilities
 *
 * Pure string-parsing functions for [bracket] mentions in chat messages.
 * No renderer/browser dependencies — safe to use in any context.
 *
 * Mention types:
 * - Skills:  [skill:slug] or [skill:workspaceId:slug]
 * - Sources: [source:slug]
 * - Files:   [file:path]
 * - Folders: [folder:path]
 */

// Simple path join that works in both Node and browser contexts.
// Cannot use node:path here — this module is imported by the Vite renderer.
function joinPath(base: string, relative: string): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return base.endsWith(sep) ? base + relative : base + sep + relative
}

// ============================================================================
// Constants
// ============================================================================

// Workspace ID character class for regex: word chars, spaces (NOT newlines), hyphens, dots
// Using literal space instead of \s to avoid matching newlines which would break parsing
export const WS_ID_CHARS = '[\\w .-]'

// ============================================================================
// Types
// ============================================================================

export interface ParsedMentions {
  /** Skill slugs mentioned via [skill:slug] */
  skills: string[]
  /** Invalid skill slugs mentioned but not found in availableSkillSlugs */
  invalidSkills: string[]
  /** Source slugs mentioned via [source:slug] */
  sources: string[]
  /** File paths mentioned via [file:path] */
  files: string[]
  /** Folder paths mentioned via [folder:path] */
  folders: string[]
}

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Parse all mentions from message text
 *
 * @param text - The message text to parse
 * @param availableSkillSlugs - Valid skill slugs to match against
 * @param availableSourceSlugs - Valid source slugs to match against
 * @returns Parsed mentions by type
 *
 * @example
 * parseMentions('[skill:commit] [source:linear]', ['commit'], ['linear'])
 * // Returns: { skills: ['commit'], sources: ['linear'] }
 */
export function parseMentions(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[]
): ParsedMentions {
  const result: ParsedMentions = {
    skills: [],
    invalidSkills: [],
    sources: [],
    files: [],
    folders: [],
  }

  // Match source mentions: [source:slug]
  const sourcePattern = /\[source:([\w-]+)\]/g
  let match: RegExpExecArray | null
  while ((match = sourcePattern.exec(text)) !== null) {
    const slug = match[1]!
    if (availableSourceSlugs.includes(slug) && !result.sources.includes(slug)) {
      result.sources.push(slug)
    }
  }

  // Match skill mentions: [skill:slug] or [skill:workspaceId:slug].
  // Prefer an exact advertised slug match first so ACP-provided names that
  // contain ':' can round-trip without desktop inventing a naming rule.
  const skillPattern = /\[skill:([^\]]+)\]/g
  while ((match = skillPattern.exec(text)) !== null) {
    const rawSkill = match[1]!.trim()
    const legacySlug = rawSkill.split(':').pop()?.trim() || rawSkill
    const slug = availableSkillSlugs.includes(rawSkill) ? rawSkill : legacySlug
    if (availableSkillSlugs.includes(slug)) {
      if (!result.skills.includes(slug)) {
        result.skills.push(slug)
      }
    } else {
      if (!result.invalidSkills.includes(slug)) {
        result.invalidSkills.push(slug)
      }
    }
  }

  // Match file mentions: [file:path] (path can contain any chars except ])
  const filePattern = /\[file:([^\]]+)\]/g
  while ((match = filePattern.exec(text)) !== null) {
    const filePath = match[1]!
    if (!result.files.includes(filePath)) {
      result.files.push(filePath)
    }
  }

  // Match folder mentions: [folder:path]
  const folderPattern = /\[folder:([^\]]+)\]/g
  while ((match = folderPattern.exec(text)) !== null) {
    const folderPath = match[1]!
    if (!result.folders.includes(folderPath)) {
      result.folders.push(folderPath)
    }
  }

  return result
}

/**
 * Strip all mentions from text, replacing skill/source mentions with their slug.
 *
 * @param text - The message text with mentions
 * @returns Text with skill/source mentions replaced by their slug
 *
 * @deprecated Prefer resolveSkillMentions + resolveSourceMentions for richer output.
 */
export function stripAllMentions(text: string): string {
  return text
    // Replace [source:slug] with just the slug
    .replace(/\[source:([\w-]+)\]/g, '$1')
    // Replace [skill:slug] or [skill:workspaceId:slug] with just the slug
    .replace(new RegExp(`\\[skill:(?:${WS_ID_CHARS}+:)?([\\w-]+)\\]`, 'g'), '$1')
    // Note: [file:...] and [folder:...] are NOT stripped — they are content
    // that gets resolved to absolute paths by resolveFileMentions().
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Resolve skill mentions to semantic markers with display names.
 *
 * [skill:datadog-api]           → [Mentioned skill: Datadog API (slug: datadog-api)]
 * [skill:My Workspace:commit]   → [Mentioned skill: Git Commit (slug: commit)]
 *
 * Skills not found in the map fall back to the slug as display name.
 *
 * @param text - The message text with skill mentions
 * @param skillNames - Map of slug → display name (from loaded skill metadata)
 */
export function resolveSkillMentions(
  text: string,
  skillNames: Map<string, string>
): string {
  return text.replace(
    new RegExp(`\\[skill:(?:${WS_ID_CHARS}+:)?([\\w-]+)\\]`, 'g'),
    (_match, slug: string) => {
      const name = skillNames.get(slug) || slug
      return `[Mentioned skill: ${name} (slug: ${slug})]`
    }
  )
}

/**
 * Resolve source mentions to semantic markers.
 *
 * [source:github] → [Mentioned source: github]
 *
 * @param text - The message text with source mentions
 */
export function resolveSourceMentions(text: string): string {
  return text.replace(
    /\[source:([\w-]+)\]/g,
    (_match, slug: string) => `[Mentioned source: ${slug}]`
  )
}

/**
 * Resolve file and folder mentions to semantic markers with absolute paths.
 *
 * [file:src/index.ts]       → [Mentioned file: index.ts (at /Users/me/project/src/index.ts)]
 * [folder:src/components]   → [Mentioned folder: components (at /Users/me/project/src/components)]
 * [file:/tmp/test.txt]      → [Mentioned file: test.txt (at /tmp/test.txt)]
 *
 * The semantic wrapper signals to the agent that the user explicitly referenced
 * this file/folder and it should be proactively read. This matches the
 * [Attached file: ...] pattern used by drag-and-drop attachments.
 *
 * Leaves other mention types ([skill:...], [source:...]) untouched.
 */
export function resolveFileMentions(text: string, workingDirectory: string): string {
  return text
    .replace(/\[file:([^\]]+)\]/g, (_match, filePath: string) => {
      const resolved = filePath.startsWith('/') || filePath.startsWith('~')
        ? filePath
        : joinPath(workingDirectory, filePath)
      const name = filePath.split('/').pop() || filePath
      return `[Mentioned file: ${name} (at ${resolved})]`
    })
    .replace(/\[folder:([^\]]+)\]/g, (_match, folderPath: string) => {
      const resolved = folderPath.startsWith('/') || folderPath.startsWith('~')
        ? folderPath
        : joinPath(workingDirectory, folderPath)
      const name = folderPath.split('/').pop() || folderPath
      return `[Mentioned folder: ${name} (at ${resolved})]`
    })
}
