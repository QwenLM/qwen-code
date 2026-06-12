/**
 * Skills Module
 *
 * Workspace skills are specialized instructions that extend the agent's capabilities.
 */

export * from './types.ts';
export * from './marketplace.ts';
export {
  GLOBAL_AGENT_SKILLS_DIR,
  GLOBAL_QWEN_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  PROJECT_QWEN_SKILLS_DIR,
  loadSkill,
  loadAllSkills,
  invalidateSkillsCache,
  loadSkillBySlug,
  getSkillIconPath,
  deleteSkill,
  skillExists,
  listSkillSlugs,
  skillNeedsIconDownload,
  downloadSkillIcon,
} from './storage.ts';
