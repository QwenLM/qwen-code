/**
 * Tests for Skills Storage
 *
 * Verifies the three-tier skill loading system:
 * 1. Global skills: ~/.qwen/skills/ and ~/.agents/skills/ (lowest priority)
 * 2. Workspace skills: {workspaceRoot}/skills/ (medium priority)
 * 3. Project skills: {projectRoot}/.qwen/skills/ and .agents/skills/ (highest priority)
 *
 * Uses real temp directories to test actual filesystem operations.
 *
 * Note: The global skills directories (~/.qwen/skills/ and ~/.agents/skills/) are module-level constants
 * that cannot be mocked reliably when tests run in parallel with other test files.
 * The loadAllSkills tests account for any pre-existing global skills by capturing a
 * baseline count and validating relative to it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  loadAllSkills,
  loadWorkspaceSkills,
  loadSkill,
  skillExists,
  listSkillSlugs,
  deleteSkill,
} from '../storage.ts';

// ============================================================
// Temp Directory Setup
// ============================================================

let tempDir: string;
let workspaceRoot: string;
let projectRoot: string;

// The real global skills directory — we cannot mock this reliably.
const REAL_GLOBAL_SKILLS_DIR = join(homedir(), '.agents', 'skills');

// ============================================================
// Helpers
// ============================================================

/** Create a valid SKILL.md file in a skill directory */
function createSkill(
  skillsDir: string,
  slug: string,
  opts: { name?: string; description?: string; globs?: string[]; content?: string; icon?: string; requiredSources?: string[] } = {}
): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });

  const name = opts.name ?? slug.charAt(0).toUpperCase() + slug.slice(1);
  const description = opts.description ?? `A ${slug} skill`;
  const content = opts.content ?? `Instructions for ${slug}`;
  const globs = opts.globs ? `\nglobs:\n${opts.globs.map(g => `  - "${g}"`).join('\n')}` : '';
  const icon = opts.icon ? `\nicon: "${opts.icon}"` : '';
  const requiredSources = opts.requiredSources
    ? `\nrequiredSources:\n${opts.requiredSources.map(source => `  - "${source}"`).join('\n')}`
    : '';

  const skillMd = `---
name: "${name}"
description: "${description}"${globs}${icon}${requiredSources}
---

${content}
`;
  writeFileSync(join(skillDir, 'SKILL.md'), skillMd);
  return skillDir;
}

/** Create an invalid SKILL.md (missing required fields) */
function createInvalidSkill(skillsDir: string, slug: string): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\ntitle: "No name or description"\n---\nContent');
  return skillDir;
}

/** Create a directory without SKILL.md */
function createEmptySkillDir(skillsDir: string, slug: string): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });
  return skillDir;
}

/** Get the set of slugs currently in the real global skills directory */
function getExistingGlobalSlugs(): Set<string> {
  const emptyWs = mkdtempSync(join(tmpdir(), 'skills-baseline-'));
  mkdirSync(join(emptyWs, 'skills'), { recursive: true });
  try {
    const skills = loadAllSkills(emptyWs);
    // These are all global skills since the workspace is empty
    return new Set(skills.map(s => s.slug));
  } finally {
    rmSync(emptyWs, { recursive: true, force: true });
  }
}

// ============================================================
// Test Setup
// ============================================================

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skills-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  projectRoot = join(tempDir, 'project');

  // Create base directories
  mkdirSync(join(workspaceRoot, 'skills'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================
// Tests: loadSkill (single workspace skill)
// ============================================================

describe('loadSkill', () => {
  it('should load a valid skill from workspace', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'commit', {
      name: 'Git Commit',
      description: 'Helps with git commits',
      content: 'Run git commit with a good message',
    });

    const skill = loadSkill(workspaceRoot, 'commit');

    expect(skill).not.toBeNull();
    expect(skill!.slug).toBe('commit');
    expect(skill!.metadata.name).toBe('Git Commit');
    expect(skill!.metadata.description).toBe('Helps with git commits');
    expect(skill!.content).toContain('Run git commit with a good message');
    expect(skill!.source).toBe('workspace');
    expect(skill!.path).toBe(join(skillsDir, 'commit'));
  });

  it('should return null for non-existent skill slug', () => {
    const skill = loadSkill(workspaceRoot, 'nonexistent');
    expect(skill).toBeNull();
  });

  it('should return null for directory without SKILL.md', () => {
    createEmptySkillDir(join(workspaceRoot, 'skills'), 'empty-skill');

    const skill = loadSkill(workspaceRoot, 'empty-skill');
    expect(skill).toBeNull();
  });

  it('should return null for invalid SKILL.md (missing required fields)', () => {
    createInvalidSkill(join(workspaceRoot, 'skills'), 'bad-skill');

    const skill = loadSkill(workspaceRoot, 'bad-skill');
    expect(skill).toBeNull();
  });

  it('should load skill with optional globs', () => {
    createSkill(join(workspaceRoot, 'skills'), 'frontend', {
      globs: ['*.tsx', '*.css'],
    });

    const skill = loadSkill(workspaceRoot, 'frontend');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.globs).toEqual(['*.tsx', '*.css']);
  });

  it('should load skill with normalized requiredSources', () => {
    createSkill(join(workspaceRoot, 'skills'), 'with-sources', {
      requiredSources: ['linear', ' github ', 'linear'],
    });

    const skill = loadSkill(workspaceRoot, 'with-sources');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.requiredSources).toEqual(['linear', 'github']);
  });

  it('should normalize single-string requiredSources into an array', () => {
    const skillDir = join(workspaceRoot, 'skills', 'single-source');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: "Single Source"
description: "Skill with scalar requiredSources"
requiredSources: linear
---

Use linear tools.
`);

    const skill = loadSkill(workspaceRoot, 'single-source');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.requiredSources).toEqual(['linear']);
  });

  it('should ignore invalid requiredSources entries', () => {
    const skillDir = join(workspaceRoot, 'skills', 'invalid-sources');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: "Invalid Sources"
description: "Skill with mixed requiredSources values"
requiredSources:
  - linear
  - 123
  - true
  - "  "
---

Use linear tools.
`);

    const skill = loadSkill(workspaceRoot, 'invalid-sources');

    expect(skill).not.toBeNull();
    expect(skill!.metadata.requiredSources).toEqual(['linear']);
  });

  it('should set iconPath when icon file exists', () => {
    const skillDir = createSkill(join(workspaceRoot, 'skills'), 'with-icon');
    writeFileSync(join(skillDir, 'icon.svg'), '<svg></svg>');

    const skill = loadSkill(workspaceRoot, 'with-icon');

    expect(skill).not.toBeNull();
    expect(skill!.iconPath).toBe(join(skillDir, 'icon.svg'));
  });

  it('should not set iconPath when no icon file exists', () => {
    createSkill(join(workspaceRoot, 'skills'), 'no-icon');

    const skill = loadSkill(workspaceRoot, 'no-icon');

    expect(skill).not.toBeNull();
    expect(skill!.iconPath).toBeUndefined();
  });
});

// ============================================================
// Tests: loadWorkspaceSkills (all skills from workspace)
// ============================================================

describe('loadWorkspaceSkills', () => {
  it('should load multiple skills from workspace', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'commit');
    createSkill(skillsDir, 'review');
    createSkill(skillsDir, 'deploy');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(3);
    const slugs = skills.map(s => s.slug).sort();
    expect(slugs).toEqual(['commit', 'deploy', 'review']);
    // All should be workspace source
    for (const skill of skills) {
      expect(skill.source).toBe('workspace');
    }
  });

  it('should return empty array for empty skills directory', () => {
    // workspaceRoot/skills/ exists but has no subdirectories
    const skills = loadWorkspaceSkills(workspaceRoot);
    expect(skills).toEqual([]);
  });

  it('should return empty array for non-existent workspace root', () => {
    const skills = loadWorkspaceSkills(join(tempDir, 'nonexistent'));
    expect(skills).toEqual([]);
  });

  it('should skip directories without SKILL.md', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'valid-skill');
    createEmptySkillDir(skillsDir, 'no-skill-md');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe('valid-skill');
  });

  it('should skip invalid SKILL.md files', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'valid');
    createInvalidSkill(skillsDir, 'invalid');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe('valid');
  });

  it('should skip non-directory entries', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'real-skill');
    // Create a plain file in the skills directory (not a subdirectory)
    writeFileSync(join(skillsDir, 'readme.txt'), 'This is not a skill');

    const skills = loadWorkspaceSkills(workspaceRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe('real-skill');
  });
});

// ============================================================
// Tests: loadAllSkills (three-tier loading)
//
// These tests account for pre-existing global skills at ~/.agents/skills/.
// We capture a baseline and verify our test skills appear with correct sources.
// ============================================================

describe('loadAllSkills', () => {
  const getWorkspaceSkillsDir = () => join(workspaceRoot, 'skills');
  const getProjectSkillsDir = () => join(projectRoot, '.agents', 'skills');
  const getProjectQwenSkillsDir = () => join(projectRoot, '.qwen', 'skills');

  // Use unique slugs that won't collide with real global skills
  const TEST_PREFIX = '_test_storage_';

  it('should load workspace and project skills alongside any existing global skills', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(wsDir, `${TEST_PREFIX}ws`, { name: 'Workspace Skill', description: 'From workspace' });
    createSkill(projDir, `${TEST_PREFIX}proj`, { name: 'Project Skill', description: 'From project' });

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // Should have baseline global skills + our 2 test skills
    expect(skills.length).toBe(baselineGlobal.size + 2);

    const wsSkill = skills.find(s => s.slug === `${TEST_PREFIX}ws`);
    const projSkill = skills.find(s => s.slug === `${TEST_PREFIX}proj`);

    expect(wsSkill).toBeDefined();
    expect(wsSkill!.source).toBe('workspace');

    expect(projSkill).toBeDefined();
    expect(projSkill!.source).toBe('project');

    // All baseline global skills should still be present with source 'global'
    for (const globalSlug of baselineGlobal) {
      const skill = skills.find(s => s.slug === globalSlug);
      expect(skill).toBeDefined();
      expect(skill!.source).toBe('global');
    }
  });

  it('should load Qwen project skills without requiring a Craft workspace skills directory', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const qwenProjDir = getProjectQwenSkillsDir();
    mkdirSync(qwenProjDir, { recursive: true });

    createSkill(qwenProjDir, `${TEST_PREFIX}qwen_proj`, {
      name: 'Qwen Project Skill',
      description: 'From .qwen skills',
    });

    const skills = loadAllSkills(workspaceRoot, projectRoot);
    const skill = skills.find(s => s.slug === `${TEST_PREFIX}qwen_proj`);

    expect(skills.length).toBe(baselineGlobal.size + 1);
    expect(skill).toBeDefined();
    expect(skill!.source).toBe('project');
    expect(skill!.path).toBe(join(qwenProjDir, `${TEST_PREFIX}qwen_proj`));
  });

  it('should prefer .qwen project skills over .agents project skills with the same slug', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const qwenProjDir = getProjectQwenSkillsDir();
    const agentsProjDir = getProjectSkillsDir();
    mkdirSync(qwenProjDir, { recursive: true });
    mkdirSync(agentsProjDir, { recursive: true });

    createSkill(qwenProjDir, `${TEST_PREFIX}provider_dup`, {
      name: 'Qwen Provider Skill',
      description: 'From .qwen',
    });
    createSkill(agentsProjDir, `${TEST_PREFIX}provider_dup`, {
      name: 'Agents Provider Skill',
      description: 'From .agents',
    });

    const skills = loadAllSkills(workspaceRoot, projectRoot);
    const skill = skills.find(s => s.slug === `${TEST_PREFIX}provider_dup`);

    expect(skills.length).toBe(baselineGlobal.size + 1);
    expect(skill).toBeDefined();
    expect(skill!.metadata.name).toBe('Qwen Provider Skill');
    expect(skill!.path).toBe(join(qwenProjDir, `${TEST_PREFIX}provider_dup`));
  });

  it('should override global skills with workspace skills when slug matches', () => {
    const baselineGlobal = getExistingGlobalSlugs();

    // Only test override if there are actually global skills to override
    if (baselineGlobal.size === 0) {
      // No global skills — just verify workspace skills load
      const wsDir = getWorkspaceSkillsDir();
      createSkill(wsDir, `${TEST_PREFIX}ws_only`, { name: 'WS Only', description: 'WS only skill' });
      const skills = loadAllSkills(workspaceRoot);
      expect(skills.find(s => s.slug === `${TEST_PREFIX}ws_only`)).toBeDefined();
      return;
    }

    // Override one of the existing global skills with a workspace skill
    const globalSlugToOverride = [...baselineGlobal][0]!;
    const wsDir = getWorkspaceSkillsDir();
    createSkill(wsDir, globalSlugToOverride, {
      name: 'Workspace Override',
      description: 'This overrides the global skill',
    });

    const skills = loadAllSkills(workspaceRoot);

    const overridden = skills.find(s => s.slug === globalSlugToOverride);
    expect(overridden).toBeDefined();
    expect(overridden!.source).toBe('workspace');
    expect(overridden!.metadata.name).toBe('Workspace Override');

    // Total count should be same as baseline (overridden, not added)
    expect(skills.length).toBe(baselineGlobal.size);
  });

  it('should override workspace skills with project skills (same slug)', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(wsDir, `${TEST_PREFIX}deploy`, { name: 'Workspace Deploy', description: 'Workspace version' });
    createSkill(projDir, `${TEST_PREFIX}deploy`, { name: 'Project Deploy', description: 'Project version' });

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // Only 1 skill for this slug (project overrides workspace), plus baseline globals
    expect(skills.length).toBe(baselineGlobal.size + 1);
    const deploy = skills.find(s => s.slug === `${TEST_PREFIX}deploy`);
    expect(deploy).toBeDefined();
    expect(deploy!.source).toBe('project');
    expect(deploy!.metadata.name).toBe('Project Deploy');
    expect(deploy!.metadata.description).toBe('Project version');
  });

  it('should handle full three-tier override: project > workspace > global', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    // Same slug at workspace and project tiers
    createSkill(wsDir, `${TEST_PREFIX}shared`, { name: 'Workspace', description: 'Workspace version' });
    createSkill(projDir, `${TEST_PREFIX}shared`, { name: 'Project', description: 'Project version' });

    // Unique skills at each controllable tier
    createSkill(wsDir, `${TEST_PREFIX}only_ws`, { description: 'Only in workspace' });
    createSkill(projDir, `${TEST_PREFIX}only_proj`, { description: 'Only in project' });

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // Shared skill should be project version (highest priority)
    const shared = skills.find(s => s.slug === `${TEST_PREFIX}shared`);
    expect(shared).toBeDefined();
    expect(shared!.source).toBe('project');
    expect(shared!.metadata.name).toBe('Project');

    // Unique skills should keep their sources
    expect(skills.find(s => s.slug === `${TEST_PREFIX}only_ws`)!.source).toBe('workspace');
    expect(skills.find(s => s.slug === `${TEST_PREFIX}only_proj`)!.source).toBe('project');

    // Total: baseline globals + shared (1, deduplicated) + only_ws + only_proj = baseline + 3
    expect(skills.length).toBe(baselineGlobal.size + 3);
  });

  it('should handle missing project directory gracefully', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    createSkill(wsDir, `${TEST_PREFIX}ws_skill`);

    // Pass a non-existent project root
    const skills = loadAllSkills(workspaceRoot, join(tempDir, 'nonexistent-project'));

    expect(skills.length).toBe(baselineGlobal.size + 1);
    const wsSkill = skills.find(s => s.slug === `${TEST_PREFIX}ws_skill`);
    expect(wsSkill).toBeDefined();
    expect(wsSkill!.source).toBe('workspace');
  });

  it('should skip project tier when projectRoot is undefined', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });
    createSkill(projDir, `${TEST_PREFIX}project_only`);

    const wsDir = getWorkspaceSkillsDir();
    createSkill(wsDir, `${TEST_PREFIX}ws_skill`);

    // No projectRoot passed — project tier should be skipped
    const skills = loadAllSkills(workspaceRoot);

    // Should NOT contain the project-only skill
    expect(skills.find(s => s.slug === `${TEST_PREFIX}project_only`)).toBeUndefined();
    // Should contain the workspace skill
    expect(skills.find(s => s.slug === `${TEST_PREFIX}ws_skill`)).toBeDefined();
    expect(skills.length).toBe(baselineGlobal.size + 1);
  });

  it('should return only global skills when workspace and project are empty', () => {
    const baselineGlobal = getExistingGlobalSlugs();

    const skills = loadAllSkills(workspaceRoot);

    // With empty workspace and no project, only global skills remain
    expect(skills.length).toBe(baselineGlobal.size);
    for (const skill of skills) {
      expect(skill.source).toBe('global');
    }
  });

  it('should correctly assign source for workspace and project tiers', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    createSkill(wsDir, `${TEST_PREFIX}w1`);
    createSkill(wsDir, `${TEST_PREFIX}w2`);
    createSkill(projDir, `${TEST_PREFIX}p1`);

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    const testSkills = skills.filter(s => s.slug.startsWith(TEST_PREFIX));
    expect(testSkills.filter(s => s.source === 'workspace')).toHaveLength(2);
    expect(testSkills.filter(s => s.source === 'project')).toHaveLength(1);

    // Global skills should all have source 'global'
    const globalSkills = skills.filter(s => !s.slug.startsWith(TEST_PREFIX));
    for (const skill of globalSkills) {
      expect(skill.source).toBe('global');
    }
  });

  it('should deduplicate by slug across workspace and project tiers', () => {
    const baselineGlobal = getExistingGlobalSlugs();
    const wsDir = getWorkspaceSkillsDir();
    const projDir = getProjectSkillsDir();
    mkdirSync(projDir, { recursive: true });

    // Same slug in workspace and project — only project should remain
    createSkill(wsDir, `${TEST_PREFIX}dup`, { name: 'WS Dup', description: 'From workspace' });
    createSkill(projDir, `${TEST_PREFIX}dup`, { name: 'Proj Dup', description: 'From project' });
    // Unique skills
    createSkill(wsDir, `${TEST_PREFIX}unique_ws`);
    createSkill(projDir, `${TEST_PREFIX}unique_proj`);

    const skills = loadAllSkills(workspaceRoot, projectRoot);

    // 3 test skills (dup deduplicated to 1 + 2 uniques) + baseline
    const testSkills = skills.filter(s => s.slug.startsWith(TEST_PREFIX));
    expect(testSkills).toHaveLength(3);

    const dup = skills.find(s => s.slug === `${TEST_PREFIX}dup`);
    expect(dup!.source).toBe('project');
    expect(dup!.metadata.name).toBe('Proj Dup');
  });
});

// ============================================================
// Tests: skillExists
// ============================================================

describe('skillExists', () => {
  it('should return true for existing skill with SKILL.md', () => {
    createSkill(join(workspaceRoot, 'skills'), 'exists-skill');
    expect(skillExists(workspaceRoot, 'exists-skill')).toBe(true);
  });

  it('should return false for non-existent skill', () => {
    expect(skillExists(workspaceRoot, 'ghost-skill')).toBe(false);
  });

  it('should return false for directory without SKILL.md', () => {
    createEmptySkillDir(join(workspaceRoot, 'skills'), 'empty');
    expect(skillExists(workspaceRoot, 'empty')).toBe(false);
  });
});

// ============================================================
// Tests: listSkillSlugs
// ============================================================

describe('listSkillSlugs', () => {
  it('should list all valid skill slugs', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'alpha');
    createSkill(skillsDir, 'beta');
    createEmptySkillDir(skillsDir, 'no-skill-md');

    const slugs = listSkillSlugs(workspaceRoot);
    expect(slugs.sort()).toEqual(['alpha', 'beta']);
  });

  it('should return empty array for empty skills directory', () => {
    const slugs = listSkillSlugs(workspaceRoot);
    expect(slugs).toEqual([]);
  });

  it('should return empty array for non-existent workspace', () => {
    const slugs = listSkillSlugs(join(tempDir, 'nonexistent'));
    expect(slugs).toEqual([]);
  });
});

// ============================================================
// Tests: deleteSkill
// ============================================================

describe('deleteSkill', () => {
  it('should delete an existing skill', () => {
    const skillsDir = join(workspaceRoot, 'skills');
    createSkill(skillsDir, 'to-delete');
    expect(skillExists(workspaceRoot, 'to-delete')).toBe(true);

    const result = deleteSkill(workspaceRoot, 'to-delete');

    expect(result).toBe(true);
    expect(skillExists(workspaceRoot, 'to-delete')).toBe(false);
  });

  it('should return false for non-existent skill', () => {
    const result = deleteSkill(workspaceRoot, 'nonexistent');
    expect(result).toBe(false);
  });
});
