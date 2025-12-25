/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { ToolResult, ToolResultDisplay } from './tools.js';
import type { Config } from '../config/config.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SkillConfig } from '../skills/types.js';
import { logSkillLaunch, SkillLaunchEvent } from '../telemetry/index.js';
import path from 'path';

export interface SkillParams {
  skill: string;
}

/**
 * Skill tool that enables the model to access skill definitions.
 * The tool dynamically loads available skills and includes them in its description
 * for the model to choose from.
 */
export class SkillTool extends BaseDeclarativeTool<SkillParams, ToolResult> {
  static readonly Name: string = ToolNames.SKILL;

  private skillManager: SkillManager;
  private availableSkills: SkillConfig[] = [];

  constructor(private readonly config: Config) {
    // Initialize with a basic schema first
    const initialSchema = {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'The skill name (no arguments). E.g., "pdf" or "xlsx"',
        },
      },
      required: ['skill'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };

    super(
      SkillTool.Name,
      ToolDisplayNames.SKILL,
      'Execute a skill within the main conversation. Loading available skills...', // Initial description
      Kind.Read,
      initialSchema,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );

    this.skillManager = config.getSkillManager();
    this.skillManager.addChangeListener(() => {
      void this.refreshSkills();
    });

    // Initialize the tool asynchronously
    this.refreshSkills();
  }

  /**
   * Asynchronously initializes the tool by loading available skills
   * and updating the description and schema.
   */
  async refreshSkills(): Promise<void> {
    try {
      this.availableSkills = await this.skillManager.listSkills();
      this.updateDescriptionAndSchema();
    } catch (error) {
      console.warn('Failed to load skills for Skills tool:', error);
      this.availableSkills = [];
      this.updateDescriptionAndSchema();
    } finally {
      // Update the client with the new tools
      const geminiClient = this.config.getGeminiClient();
      if (geminiClient && geminiClient.isInitialized()) {
        await geminiClient.setTools();
      }
    }
  }

  /**
   * Updates the tool's description and schema based on available skills.
   */
  private updateDescriptionAndSchema(): void {
    let skillDescriptions = '';
    if (this.availableSkills.length === 0) {
      skillDescriptions =
        'No skills are currently configured. Skills can be created by adding directories with SKILL.md files to .qwen/skills/ or ~/.qwen/skills/.';
    } else {
      skillDescriptions = this.availableSkills
        .map(
          (skill) => `<skill>
<name>
${skill.name}
</name>
<description>
${skill.description} (${skill.level})
</description>
<location>
${skill.level}
</location>
</skill>`,
        )
        .join('\n');
    }

    const baseDescription = `Execute a skill within the main conversation

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to invoke:
- Use this tool with the skill name only (no arguments)
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "xlsx"\` - invoke the xlsx skill
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action
- NEVER just announce or mention a skill in your text response without actually calling this tool
- This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
</skills_instructions>

<available_skills>
${skillDescriptions}
</available_skills>
`;
    // Update description using object property assignment
    (this as { description: string }).description = baseDescription;
  }

  override validateToolParams(params: SkillParams): string | null {
    // Validate required fields
    if (
      !params.skill ||
      typeof params.skill !== 'string' ||
      params.skill.trim() === ''
    ) {
      return 'Parameter "skill" must be a non-empty string.';
    }

    // Validate that the skill exists
    const skillExists = this.availableSkills.some(
      (skill) => skill.name === params.skill,
    );

    if (!skillExists) {
      const availableNames = this.availableSkills.map((s) => s.name);
      if (availableNames.length === 0) {
        return `Skill "${params.skill}" not found. No skills are currently available.`;
      }
      return `Skill "${params.skill}" not found. Available skills: ${availableNames.join(', ')}`;
    }

    return null;
  }

  protected createInvocation(params: SkillParams) {
    return new SkillToolInvocation(this.config, this.skillManager, params);
  }

  getAvailableSkillNames(): string[] {
    return this.availableSkills.map((skill) => skill.name);
  }
}

class SkillToolInvocation extends BaseToolInvocation<SkillParams, ToolResult> {
  constructor(
    private readonly config: Config,
    private readonly skillManager: SkillManager,
    params: SkillParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Launching skill: "${this.params.skill}"`;
  }

  override async shouldConfirmExecute(): Promise<false> {
    // Skill loading is a read-only operation, no confirmation needed
    return false;
  }

  async execute(
    _signal?: AbortSignal,
    _updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    try {
      // Load the skill with runtime config (includes additional files)
      const skill = await this.skillManager.loadSkillForRuntime(
        this.params.skill,
      );

      if (!skill) {
        // Log failed skill launch
        logSkillLaunch(
          this.config,
          new SkillLaunchEvent(this.params.skill, false),
        );

        // Get parse errors if any
        const parseErrors = this.skillManager.getParseErrors();
        const errorMessages: string[] = [];

        for (const [filePath, error] of parseErrors) {
          if (filePath.includes(this.params.skill)) {
            errorMessages.push(`Parse error at ${filePath}: ${error.message}`);
          }
        }

        const errorDetail =
          errorMessages.length > 0
            ? `\nErrors:\n${errorMessages.join('\n')}`
            : '';

        return {
          llmContent: `Skill "${this.params.skill}" not found.${errorDetail}`,
          returnDisplay: `Skill "${this.params.skill}" not found.${errorDetail}`,
        };
      }

      // Log successful skill launch
      logSkillLaunch(
        this.config,
        new SkillLaunchEvent(this.params.skill, true),
      );

      const baseDir = path.dirname(skill.filePath);

      // Build markdown content for LLM (show base dir, then body)
      const llmContent = `Base directory for this skill: ${baseDir}\n\n${skill.body}\n`;

      return {
        llmContent: [{ text: llmContent }],
        returnDisplay: `Launching skill: ${skill.name}`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[SkillsTool] Error launching skill: ${errorMessage}`);

      // Log failed skill launch
      logSkillLaunch(
        this.config,
        new SkillLaunchEvent(this.params.skill, false),
      );

      return {
        llmContent: `Failed to load skill "${this.params.skill}": ${errorMessage}`,
        returnDisplay: `Failed to load skill "${this.params.skill}": ${errorMessage}`,
      };
    }
  }
}
