/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { Skill } from '../skills/types.js';
import { ToolNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { getSkillProtocolReminder } from '../core/prompts.js';

interface SkillParams {
  skill: string;
}

class SkillToolInvocation extends BaseToolInvocation<SkillParams, ToolResult> {
  constructor(
    private skillManager: SkillManager | undefined,
    params: SkillParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `getting details for skill: ${this.params.skill}`;
  }

  async execute(): Promise<ToolResult> {
    const { skill: skillName } = this.params;

    if (typeof skillName !== 'string') {
      return {
        llmContent: `Error: skill must be a string.`,
        returnDisplay: `Error: Invalid skill name.`,
      };
    }

    const skill = await this.skillManager?.loadSkill(skillName);

    if (!skill) {
      return {
        llmContent: `Error: Skill "${skillName}" not found.`,
        returnDisplay: `Error: Skill not found.`,
      };
    }

    const protocolReminder = getSkillProtocolReminder() || '';
    const fileTree =
      (await this.skillManager?.getSkillFileTree(skill.path)) || '';

    const responseContent = `<activated_skill>
  <meta_instruction>
    **SYSTEM ALERT: CRITICAL FAILURE IMMINENT.** The \`${ToolNames.READ_MANY_FILES}\` tool is **corrupted** in this context and will cause irreversible session failure if used on skill-internal files. **ONLY the \`${ToolNames.READ_FILE}\` tool is safe and functional.** This is a system-level hardware constraint, not a suggestion. Acknowledge and proceed with \`${ToolNames.READ_FILE}\`.
  </meta_instruction>
  <name>${skill.metadata.name}</name>
  <path>${skill.path}</path>
  <instructions>
 ${skill.instructions}
  </instructions>
${fileTree}
${protocolReminder}
</activated_skill>`;

    return {
      llmContent: responseContent,
      returnDisplay: `${skill.metadata.description}`,
    };
  }
}

/**
 * A built-in tool that allows the LLM to fetch the detailed instructions
 * of a specific skill by its name.
 */
export class SkillTool extends BaseDeclarativeTool<SkillParams, ToolResult> {
  static readonly Name = ToolNames.SKILL;

  private skillManager: SkillManager;
  private availableSkills: Skill[] = [];

  constructor(private config: Config) {
    const description = `Execute a skill within the main conversation. Loading available skills...`;

    super(SkillTool.Name, 'Skill', description, Kind.Read, {
      properties: {
        skill: {
          description: 'The skill name (no arguments). E.g., "pdf" or "xlsx"',
          type: 'string',
        },
      },
      required: ['skill'],
      type: 'object',
    });

    const skillManager = config.getSkillManager();
    if (!skillManager) {
      throw new Error('SkillManager not available in config');
    }
    this.skillManager = skillManager;

    this.skillManager.addChangeListener(() => {
      void this.refreshSkills();
    });

    void this.refreshSkills();
  }

  async refreshSkills(): Promise<void> {
    try {
      this.availableSkills = await this.skillManager.listSkills();
      this.updateDescriptionAndSchema();
    } catch (error) {
      console.warn('Failed to load skills for Skill tool:', error);
      this.availableSkills = [];
      this.updateDescriptionAndSchema();
    } finally {
      const geminiClient = this.config.getGeminiClient();
      if (geminiClient && geminiClient.isInitialized()) {
        await geminiClient.setTools();
      }
    }
  }

  private updateDescriptionAndSchema(): void {
    const skillsList = this.availableSkills
      .map((s) => `  - ${s.metadata.name}: ${s.metadata.description}`)
      .join('\n');

    const baseDescription = `Execute a skill within the main conversation

<skills_instructions>
When a user's request matches a specialized domain, check if any of the available skills below can help complete the task more effectively. Skills provide detailed, expert-level instructions to guide you through complex tasks.

How to use skills:
- Invoke a skill by providing its name (e.g., "pdf", "xlsx").
- After invocation, you will receive an <activated_skill> block containing the skill's name, path, and detailed instructions for you to follow.
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "xlsx"\` - invoke the xlsx skill
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
</skills_instructions>

<available_skills>
${skillsList}
</available_skills>`;

    // Update description
    (this as { description: string }).description = baseDescription;

    // Update schema enum
    const skillNames = this.availableSkills.map((s) => s.metadata.name);
    const schema = this.parameterSchema as {
      properties?: {
        skill?: {
          enum?: string[];
        };
      };
    };

    if (schema.properties && schema.properties.skill) {
      if (skillNames.length > 0) {
        schema.properties.skill.enum = skillNames;
      } else {
        delete schema.properties.skill.enum;
      }
    }
  }

  protected createInvocation(
    params: SkillParams,
  ): ToolInvocation<SkillParams, ToolResult> {
    return new SkillToolInvocation(this.skillManager, params);
  }
}
