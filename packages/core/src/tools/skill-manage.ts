/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import type { ToolResult, ToolResultDisplay } from './tools.js';
import type { Config } from '../config/config.js';
import {
  assertProjectSkillPath,
  assertRealProjectSkillPath,
  getProjectSkillsRoot,
  sanitizeSkillName,
  SKILL_FILE_NAME,
} from '../skills/skill-paths.js';

export type SkillManageAction =
  | 'create'
  | 'edit'
  | 'patch'
  | 'write_file'
  | 'delete';

export interface SkillManageParams {
  action: SkillManageAction;
  name: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  category?: string;
  file_path?: string;
  file_content?: string;
}

export class SkillManageTool extends BaseDeclarativeTool<
  SkillManageParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.SKILL_MANAGE;

  constructor(private readonly config: Config) {
    super(
      SkillManageTool.Name,
      ToolDisplayNames.SKILL_MANAGE,
      'Create, update, patch, write files for, or delete a project-level skill in .qwen/skills/.',
      Kind.Edit,
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'edit', 'patch', 'write_file', 'delete'],
          },
          name: { type: 'string' },
          content: {
            type: 'string',
            description: 'Full SKILL.md content for create/edit.',
          },
          old_string: {
            type: 'string',
            description: 'For patch: text to find.',
          },
          new_string: {
            type: 'string',
            description: 'For patch: replacement text.',
          },
          category: {
            type: 'string',
            description: "Optional subdirectory, e.g. 'typescript'.",
          },
          file_path: {
            type: 'string',
            description:
              "For write_file: relative path like 'references/api.md'.",
          },
          file_content: { type: 'string' },
        },
        required: ['action', 'name'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      false,
      false,
    );
  }

  protected override validateToolParamValues(
    params: SkillManageParams,
  ): string | null {
    if (!params.name.trim()) {
      return 'Parameter "name" must be a non-empty string.';
    }
    if (
      (params.action === 'create' || params.action === 'edit') &&
      !params.content
    ) {
      return `Parameter "content" is required for action "${params.action}".`;
    }
    if (params.action === 'patch') {
      if (!params.old_string || params.new_string === undefined) {
        return 'Parameters "old_string" and "new_string" are required for action "patch".';
      }
    }
    if (params.action === 'write_file') {
      if (!params.file_path || params.file_content === undefined) {
        return 'Parameters "file_path" and "file_content" are required for action "write_file".';
      }
    }
    return null;
  }

  protected createInvocation(params: SkillManageParams) {
    return new SkillManageToolInvocation(this.config, params);
  }
}

class SkillManageToolInvocation extends BaseToolInvocation<
  SkillManageParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: SkillManageParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `${this.params.action} project skill ${this.params.name}`;
  }

  override toolLocations() {
    return [{ path: this.resolveTargetPath() }];
  }

  override getDefaultPermission() {
    return Promise.resolve('ask' as const);
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    try {
      const targetPath = this.resolveTargetPath();
      assertProjectSkillPath(targetPath, this.config.getProjectRoot());
      await assertRealProjectSkillPath(
        targetPath,
        this.config.getProjectRoot(),
      );

      switch (this.params.action) {
        case 'create':
          await this.writeSkillFileWithFallback(
            targetPath,
            this.params.content!,
          );
          break;
        case 'edit':
          await this.writeSkillFile(targetPath, this.params.content!, 'w');
          break;
        case 'patch':
          await this.patchSkillFile(targetPath);
          break;
        case 'write_file':
          await this.writeReferenceFile(targetPath);
          break;
        case 'delete':
          await fs.rm(path.dirname(targetPath), {
            recursive: true,
            force: true,
          });
          break;
        default:
          throw new Error(`Unsupported action: ${this.params.action}`);
      }

      await this.config.getSkillManager()?.refreshCache?.();
      const message = `skill_manage ${this.params.action} succeeded: ${targetPath}`;
      return { llmContent: message, returnDisplay: message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message },
      };
    }
  }

  private async writeSkillFileWithFallback(
    targetPath: string,
    content: string,
  ): Promise<void> {
    try {
      // Try exclusive create first
      await this.writeSkillFile(targetPath, content, 'wx');
    } catch (error) {
      // If file exists, fallback to edit (upsert behavior)
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') {
        // File already exists, upgrade to edit
        await this.writeSkillFile(targetPath, content, 'w');
      } else {
        throw error;
      }
    }
  }

  private async writeSkillFile(
    targetPath: string,
    content: string,
    flag: 'w' | 'wx',
  ): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      content.endsWith('\n') ? content : `${content}\n`,
      {
        encoding: 'utf-8',
        flag,
      },
    );
  }

  private async patchSkillFile(targetPath: string): Promise<void> {
    const oldString = this.params.old_string!;
    const newString = this.params.new_string!;
    const original = await fs.readFile(targetPath, 'utf-8');
    if (!original.includes(oldString)) {
      throw new Error('old_string was not found in the target skill file.');
    }
    await fs.writeFile(
      targetPath,
      original.replace(oldString, newString),
      'utf-8',
    );
  }

  private async writeReferenceFile(targetPath: string): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, this.params.file_content!, 'utf-8');
  }

  private resolveTargetPath(): string {
    const projectSkillsRoot = getProjectSkillsRoot(
      this.config.getProjectRoot(),
    );
    const skillName = sanitizeSkillName(this.params.name);
    const parts = [projectSkillsRoot];
    if (this.params.category) {
      parts.push(this.params.category);
    }
    parts.push(skillName);

    if (this.params.action === 'write_file') {
      const filePath = this.params.file_path ?? '';
      return path.resolve(path.join(...parts, filePath));
    }
    return path.resolve(path.join(...parts, SKILL_FILE_NAME));
  }
}
