/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Skill, SkillMetadata, ListSkillsOptions } from './types.js';
import { promises as fs, existsSync } from 'node:fs';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import type { SubagentLevel } from '../index.js';
import { glob } from 'glob';
import { Ajv, type JSONSchemaType } from 'ajv';
import type { Config } from '../config/config.js';

const IGNORED_PATTERNS = ['**/node_modules/**', '**/dist/**', '**/.*'];
const QWEN_CONFIG_DIR = '.qwen';
const SKILL_CONFIG_DIR = 'skills';

const skillMetadataSchema: JSONSchemaType<Skill['metadata']> = {
  type: 'object',
  properties: {
    name: { type: 'string', pattern: '^[a-z0-9-]+$' },
    description: { type: 'string', minLength: 1 },
    license: { type: 'string', nullable: true },
    color: { type: 'string', nullable: true },
    metadata: {
      type: 'object',
      propertyNames: { type: 'string' },
      required: [],
      nullable: true,
    },
  },
  required: ['name', 'description'],
  additionalProperties: false,
};

/**
 * Manages the repository of available skills and provides methods to interact with them.
 * This class operates on a pre-loaded list of skills, decoupled from the file system.
 */
export class SkillManager {
  private readonly ajv = new Ajv();
  private readonly validate = this.ajv.compile(skillMetadataSchema);
  // Initialized as null to indicate it hasn't been loaded yet
  private skillsCache: Map<string, Skill> | null = null;
  private lastProjectRoot: string | null = null;
  private readonly changeListeners: Set<() => void> = new Set();

  /**
   * Constructs a SkillManager.
   */
  constructor(private readonly config: Config) {}

  addChangeListener(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChangeListeners(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.warn('Skill change listener threw an error:', error);
      }
    }
  }

  private async loadSkillsFrom(dir: string): Promise<Skill[]> {
    if (!existsSync(dir)) {
      return [];
    }
    const skillDirs = await this.discoverSkillDirectories(dir);
    const settledResults = await Promise.allSettled(
      skillDirs.map((skillDir) => this.parseSkill(skillDir)),
    );

    const validSkills: Skill[] = [];
    for (const result of settledResults) {
      if (result.status === 'fulfilled') {
        validSkills.push(result.value);
      } else {
        console.error(`[SkillLoader] Failed to load skill: ${result.reason}`);
      }
    }
    return validSkills;
  }

  /**
   * Refreshes the skills cache by scanning global and project-level directories.
   * Merges skills, with project skills overriding global ones.
   */
  private async refreshCache(): Promise<void> {
    const projectRoot = this.config.getProjectRoot();
    this.lastProjectRoot = projectRoot;

    const homeDir = os.homedir();
    const globalSkillsDir = path.join(
      homeDir,
      QWEN_CONFIG_DIR,
      SKILL_CONFIG_DIR,
    );
    const projectSkillsDir = path.join(
      projectRoot,
      QWEN_CONFIG_DIR,
      SKILL_CONFIG_DIR,
    );

    const globalSkills = await this.loadSkillsFrom(globalSkillsDir);
    const projectSkills = await this.loadSkillsFrom(projectSkillsDir);

    const newSkillsMap = new Map<string, Skill>();

    // Merge skills, with project skills overriding global ones.
    for (const skill of globalSkills) {
      newSkillsMap.set(skill.metadata.name, skill);
    }
    for (const skill of projectSkills) {
      newSkillsMap.set(skill.metadata.name, skill);
    }

    this.skillsCache = newSkillsMap;
    this.notifyChangeListeners();
  }

  /**
   * Ensures the cache is populated and valid for the current project root.
   * If not, triggers a refresh.
   */
  private async ensureCache(): Promise<void> {
    const currentProjectRoot = this.config.getProjectRoot();
    if (
      this.skillsCache === null ||
      this.lastProjectRoot !== currentProjectRoot
    ) {
      await this.refreshCache();
    }
  }

  async isNameAvailable(name: string): Promise<boolean> {
    await this.ensureCache();
    return !this.skillsCache!.has(name);
  }

  getSkillPath(
    name: string,
    level: SubagentLevel,
    projectRoot: string,
  ): string {
    const baseDir =
      level === 'project'
        ? path.join(projectRoot, QWEN_CONFIG_DIR, SKILL_CONFIG_DIR)
        : path.join(os.homedir(), QWEN_CONFIG_DIR, SKILL_CONFIG_DIR);
    return path.join(baseDir, name, 'SKILL.md');
  }

  async getSkillFileTree(skillDirectory: string): Promise<string> {
    type TreeNode = { [key: string]: TreeNode | '[file]' };
    const files = await glob('**/*', {
      cwd: skillDirectory,
      nodir: true,
      absolute: true,
      ignore: IGNORED_PATTERNS,
    });

    if (files.length === 0) {
      return '<file_tree>No files found in skill directory.</file_tree>';
    }

    // Create a tree structure
    const tree: TreeNode = {};
    for (const file of files) {
      const relativePath = path.relative(skillDirectory, file);
      const parts = relativePath.split(path.sep);
      let currentLevel: TreeNode = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          // File
          currentLevel[part] = `[file]`;
        } else {
          // Directory
          if (!currentLevel[part]) {
            currentLevel[part] = {};
          }
          currentLevel = currentLevel[part] as TreeNode;
        }
      }
    }

    // Format the tree into a string
    const formatTree = (node: TreeNode, indent = ''): string => {
      let result = '';
      const entries = Object.keys(node);
      for (let i = 0; i < entries.length; i++) {
        const key = entries[i];
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        if (node[key] === '[file]') {
          result += `${indent}${connector}${key}\n`;
        } else {
          result += `${indent}${connector}${key}/\n`;
          result += formatTree(
            node[key],
            `${indent}${isLast ? '    ' : '│   '}`,
          );
        }
      }
      return result;
    };

    const treeString = formatTree(tree);

    return `<file_tree>
<absolute_base_path>${skillDirectory}</absolute_base_path>
\`\`\`
${treeString}\`\`\`
</file_tree>`;
  }

  async createSkill(
    skillMetadata: SkillMetadata & { instructions?: string },
    options: { level: SubagentLevel; overwrite: boolean; projectRoot: string },
  ) {
    const { name, description, instructions, color } = skillMetadata;
    const { level, overwrite, projectRoot } = options;
    const skillDir = path.dirname(this.getSkillPath(name, level, projectRoot));

    if (existsSync(skillDir) && !overwrite) {
      throw new Error(`Skill "${name}" already exists at ${level} level.`);
    }

    await fs.mkdir(skillDir, { recursive: true });

    const content =
      instructions ||
      `
# ${name}

This skill helps to... (Briefly describe the primary purpose of this skill)

## Overview

(Explain when this skill should be used and what it accomplishes.)

## Workflow

1.  (Step 1)
2.  (Step 2)
3.  (Step 3)

## Examples

(Provide concrete examples of how to use this skill.)
`;

    // Filter out undefined values from data
    const data: Record<string, string> = {
      name,
      description,
    };
    if (color) {
      data['color'] = color;
    }

    const skillMdContent = matter.stringify(content, data);

    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMdContent);

    // Refresh cache to include the new skill
    await this.refreshCache();
  }

  async updateSkill(
    name: string,
    updates: Partial<SkillMetadata & { instructions?: string }>,
    level?: SubagentLevel,
  ): Promise<void> {
    const existing = await this.loadSkill(name, level);
    if (!existing) {
      throw new Error(`Skill "${name}" not found.`);
    }

    const newMetadata = {
      ...existing.metadata,
      ...updates,
      // Ensure name cannot be changed via update for now, or handle rename logic if needed
      name: existing.metadata.name,
    };
    const newInstructions = updates.instructions ?? existing.instructions;

    // We reuse createSkill with overwrite=true to perform the update
    // We need to determine the level if not provided or different
    // Since we loaded it, we can infer the location, but createSkill needs explicit level.
    // However, existing.path gives us a clue, but let's rely on the user passing level or assume project if it matches.
    // For simplicity in this implementation, we require level or derive it if we can (e.g. from existing path).
    // But since createSkill takes projectRoot, we should use that.

    // A simple heuristic: if existing path is in project root, level is project, else user.
    const projectRoot = this.config.getProjectRoot();
    // Re-calculating level based on path is tricky without knowing exact project root resolution at load time.
    // But we can try to guess or require it. For now, let's assume if it's in project .qwen, it's project.
    let targetLevel: SubagentLevel = 'project';
    if (
      existing.path.startsWith(os.homedir()) &&
      !existing.path.startsWith(projectRoot)
    ) {
      targetLevel = 'user';
    }
    // If user provided level, use that
    if (level) targetLevel = level;

    await this.createSkill(
      { ...newMetadata, instructions: newInstructions },
      { level: targetLevel, overwrite: true, projectRoot },
    );
  }

  async deleteSkill(skillPath: string): Promise<void> {
    if (!existsSync(skillPath)) {
      // Skill directory doesn't exist, nothing to do.
      return;
    }

    await fs.rm(skillPath, { recursive: true, force: true });

    // Refresh cache to remove the deleted skill
    await this.refreshCache();
  }

  private async discoverSkillDirectories(baseDir: string): Promise<string[]> {
    const skillFiles = await glob('**/{SKILL,skill}.md', {
      cwd: baseDir,
      absolute: true,
      nodir: true,
      ignore: IGNORED_PATTERNS,
    });
    return skillFiles.map((file) => path.dirname(file));
  }

  private async parseSkill(skillDirectory: string): Promise<Skill> {
    let skillMdPath = path.join(skillDirectory, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      const lowerCasePath = path.join(skillDirectory, 'skill.md');
      if (existsSync(lowerCasePath)) {
        skillMdPath = lowerCasePath;
      }
      // If neither exists, readFile will throw, which is fine as it's expected to exist based on discovery
    }

    const fileContent = await fs.readFile(skillMdPath, 'utf-8');

    const { data, content } = matter(fileContent);

    if (!this.validate(data)) {
      const errorMessages =
        this.validate.errors?.map((e) => `${e.instancePath} ${e.message}`) ??
        [];
      throw new Error(
        `Skill metadata validation failed for ${skillMdPath}: ${errorMessages.join(
          ', ',
        )}`,
      );
    }

    // Additional validation: directory name must match metadata name
    const dirName = path.basename(skillDirectory);
    if (dirName !== data.name) {
      throw new Error(
        `Skill validation failed for ${skillMdPath}: Directory name '${dirName}' does not match metadata name '${data.name}'.`,
      );
    }

    return {
      path: skillDirectory,
      metadata: data,
      instructions: content.trim(),
    };
  }

  /**
   * Retrieves a skill by its unique name.
   * @param name The name of the skill to retrieve.
   * @param level Optional level to limit the search.
   * @returns The `Skill` object if found, otherwise `undefined`.
   */
  async loadSkill(
    name: string,
    level?: SubagentLevel,
  ): Promise<Skill | undefined> {
    await this.ensureCache();
    const skill = this.skillsCache!.get(name);

    if (!skill) return undefined;

    // If level is specified, check if the skill belongs to that level
    if (level) {
      const projectRoot = this.config.getProjectRoot();
      const isProject = skill.path.startsWith(
        path.join(projectRoot, QWEN_CONFIG_DIR),
      );
      if (level === 'project' && !isProject) return undefined;
      if (level === 'user' && isProject) return undefined;
      // 'builtin' and 'session' logic would go here if/when skills support them
    }

    return skill;
  }

  /**
   * Lists all loaded skills with optional filtering and sorting.
   * @param options Filtering and sorting options.
   * @returns An array of `Skill` objects.
   */
  async listSkills(options: ListSkillsOptions = {}): Promise<Skill[]> {
    if (options.force) {
      await this.refreshCache();
    } else {
      await this.ensureCache();
    }

    let skills = Array.from(this.skillsCache!.values());

    // Filter by level
    if (options.level) {
      const projectRoot = this.config.getProjectRoot();
      skills = skills.filter((skill) => {
        const isProject = skill.path.startsWith(
          path.join(projectRoot, QWEN_CONFIG_DIR),
        );
        if (options.level === 'project') return isProject;
        if (options.level === 'user') return !isProject;
        return true;
      });
    }

    // Sort
    if (options.sortBy) {
      skills.sort((a, b) => {
        let comparison = 0;
        if (options.sortBy === 'name') {
          comparison = a.metadata.name.localeCompare(b.metadata.name);
        } else if (options.sortBy === 'level') {
          // Project > User
          const aIsProject = a.path.startsWith(this.config.getProjectRoot());
          const bIsProject = b.path.startsWith(this.config.getProjectRoot());
          if (aIsProject === bIsProject) comparison = 0;
          else comparison = aIsProject ? -1 : 1;
        }
        return options.sortOrder === 'desc' ? -comparison : comparison;
      });
    }

    return skills;
  }
}
