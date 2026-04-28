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
import { createDebugLogger } from '../utils/debugLogger.js';
import { registerSkillHooks } from '../hooks/registerSkillHooks.js';

const debugLogger = createDebugLogger('SKILL');

export interface SkillParams {
  skill: string;
}

// Re-export for backward compatibility
export { buildSkillLlmContent } from './skill-utils.js';
import { buildSkillLlmContent } from './skill-utils.js';

/**
 * Skill tool that enables the model to access skill definitions.
 * The tool dynamically loads available skills and includes them in its description
 * for the model to choose from.
 */
export class SkillTool extends BaseDeclarativeTool<SkillParams, ToolResult> {
  static readonly Name: string = ToolNames.SKILL;

  private skillManager: SkillManager;
  private availableSkills: SkillConfig[] = [];
  // Conditional skills (with `paths:`) that exist on disk but have not yet
  // been activated by a matching tool invocation. Tracked separately so
  // validateToolParams can give a distinct error message when the model
  // names one of these: "gated by paths:, access a matching file first"
  // instead of the generic "not found".
  private pendingConditionalSkillNames: Set<string> = new Set();
  private modelInvocableCommands: ReadonlyArray<{
    name: string;
    description: string;
  }> = [];
  private loadedSkillNames: Set<string> = new Set();

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
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );

    const skillManager = config.getSkillManager();
    if (!skillManager) {
      throw new Error('SkillManager not available');
    }
    this.skillManager = skillManager;
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
      // Include a skill in the tool description only when (a) it is not
      // hidden from the model (`disable-model-invocation`), and (b) it is
      // either unconditional or already activated by a matching file path
      // in this session. This keeps the tool description small in large
      // monorepos where most conditional skills are not yet relevant.
      const allSkills = await this.skillManager.listSkills();
      this.availableSkills = allSkills.filter(
        (s) => !s.disableModelInvocation && this.skillManager.isSkillActive(s),
      );
      // Track still-pending conditional skills so validateToolParams can
      // distinguish "not found" from "registered but not yet activated".
      this.pendingConditionalSkillNames = new Set(
        allSkills
          .filter(
            (s) =>
              !s.disableModelInvocation &&
              s.paths &&
              s.paths.length > 0 &&
              !this.skillManager.isSkillActive(s),
          )
          .map((s) => s.name),
      );
      // Merge in model-invocable commands from CommandService (injected via
      // Config), but exclude any whose names appear as ANY file-based skill —
      // including pending conditional skills. Using `availableSkills` (active
      // only) here would let a path-gated skill leak through the
      // <available_commands> listing and bypass validateToolParams's
      // pendingConditionalSkillNames check, breaking the activation contract.
      const provider = this.config.getModelInvocableCommandsProvider();
      const allCommands = provider ? provider() : [];
      const fileBasedSkillNames = new Set(allSkills.map((s) => s.name));
      this.modelInvocableCommands = allCommands.filter(
        (cmd) => !fileBasedSkillNames.has(cmd.name),
      );
      this.updateDescriptionAndSchema();
    } catch (error) {
      debugLogger.warn('Failed to load skills for Skills tool:', error);
      this.availableSkills = [];
      this.pendingConditionalSkillNames = new Set();
      this.modelInvocableCommands = [];
      this.updateDescriptionAndSchema();
    } finally {
      // Update the client with the new tools
      const geminiClient = this.config.getGeminiClient();
      if (geminiClient) {
        await geminiClient.setTools();
      }
    }
  }

  /**
   * Updates the tool's description and schema based on available skills and
   * model-invocable commands (e.g. bundled skills, file commands, MCP prompts).
   */
  private updateDescriptionAndSchema(): void {
    // Merge file-based skills and prompt commands into a single unified list,
    // matching Claude Code's design where all invocable commands are listed together.
    const allSkillEntries: string[] = [];

    for (const skill of this.availableSkills) {
      allSkillEntries.push(`<skill>
<name>
${skill.name}
</name>
<description>
${skill.description}${skill.whenToUse ? ` — ${skill.whenToUse}` : ''} (${skill.level})
</description>
<location>
${skill.level}
</location>
</skill>`);
    }

    for (const cmd of this.modelInvocableCommands) {
      allSkillEntries.push(`<skill>
<name>
${cmd.name}
</name>
<description>
${cmd.description}
</description>
</skill>`);
    }

    let skillDescriptions = '';
    if (allSkillEntries.length === 0) {
      skillDescriptions =
        'No skills are currently configured. Skills can be created by adding directories with SKILL.md files to .qwen/skills/ or ~/.qwen/skills/.';
    } else {
      skillDescriptions = allSkillEntries.join('\n');
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
- When executing scripts or loading referenced files, ALWAYS resolve absolute paths from skill's base directory. Examples:
  - \`bash scripts/init.sh\` -> \`bash /path/to/skill/scripts/init.sh\`
  - \`python scripts/helper.py\` -> \`python /path/to/skill/scripts/helper.py\`
  - \`reference.md\` -> \`/path/to/skill/reference.md\`
</skills_instructions>

<available_skills>
${skillDescriptions}
</available_skills>`;
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

    // Check file-based skills
    const skillExists = this.availableSkills.some(
      (skill) => skill.name === params.skill,
    );
    if (skillExists) return null;

    // Check model-invocable commands (e.g. MCP prompts) listed in the description
    const commandExists = this.modelInvocableCommands.some(
      (cmd) => cmd.name === params.skill,
    );
    if (commandExists) return null;

    // Distinct error for a conditional skill (registered via `paths:`
    // frontmatter) that has not yet been activated by a matching tool call.
    // Without this branch the model can't tell the difference between "no
    // such skill exists" and "exists but you need to access a matching file
    // to unlock it."
    if (this.pendingConditionalSkillNames.has(params.skill)) {
      return `Skill "${params.skill}" is gated by path-based activation (paths: frontmatter) and is not yet available. Access a file matching its paths patterns first to activate it.`;
    }

    const availableNames = [
      ...this.availableSkills.map((s) => s.name),
      ...this.modelInvocableCommands.map((c) => c.name),
    ];
    if (availableNames.length === 0) {
      return `Skill "${params.skill}" not found. No skills are currently available.`;
    }
    return `Skill "${params.skill}" not found. Available skills: ${availableNames.join(', ')}`;
  }

  protected createInvocation(params: SkillParams) {
    return new SkillToolInvocation(
      this.config,
      this.skillManager,
      params,
      (name: string) => this.loadedSkillNames.add(name),
      this.config.getModelInvocableCommandsExecutor(),
    );
  }

  getAvailableSkillNames(): string[] {
    return this.availableSkills.map((skill) => skill.name);
  }

  /**
   * Returns the set of skill names that have been successfully loaded
   * (invoked) during the current session. Used by /context to attribute
   * loaded skill body tokens separately from the tool-definition cost.
   */
  getLoadedSkillNames(): ReadonlySet<string> {
    return this.loadedSkillNames;
  }

  /**
   * Clears the loaded-skills tracking. Should be called when the session
   * is reset (e.g. /clear) so that stale body-token data is not shown.
   */
  clearLoadedSkills(): void {
    this.loadedSkillNames.clear();
  }
}

class SkillToolInvocation extends BaseToolInvocation<SkillParams, ToolResult> {
  constructor(
    private readonly config: Config,
    private readonly skillManager: SkillManager,
    params: SkillParams,
    private readonly onSkillLoaded: (name: string) => void,
    private readonly commandExecutor:
      | ((name: string, args?: string) => Promise<string | null>)
      | null = null,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Use skill: "${this.params.skill}"`;
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
        // Try model-invocable command executor (e.g. MCP prompts)
        if (this.commandExecutor) {
          const content = await this.commandExecutor(this.params.skill);
          if (content !== null) {
            logSkillLaunch(
              this.config,
              new SkillLaunchEvent(this.params.skill, true),
            );
            this.onSkillLoaded(this.params.skill);
            return {
              llmContent: [{ text: content }],
              returnDisplay: `Executed command: ${this.params.skill}`,
            };
          }
        }

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
      this.onSkillLoaded(this.params.skill);

      // Register skill hooks if present
      debugLogger.debug('Skill hooks check:', {
        hasHooks: !!skill.hooks,
        hooksKeys: skill.hooks ? Object.keys(skill.hooks) : [],
        skillName: skill.name,
      });
      if (skill.hooks) {
        const hookSystem = this.config.getHookSystem();
        const sessionId = this.config.getSessionId();
        debugLogger.debug('Hook system and session:', {
          hasHookSystem: !!hookSystem,
          sessionId,
        });
        if (hookSystem && sessionId) {
          const sessionHooksManager = hookSystem.getSessionHooksManager();
          const hookCount = registerSkillHooks(
            sessionHooksManager,
            sessionId,
            skill,
          );
          if (hookCount > 0) {
            debugLogger.info(
              `Registered ${hookCount} hooks from skill "${this.params.skill}"`,
            );
          } else {
            debugLogger.warn(
              `No hooks registered from skill "${this.params.skill}"`,
            );
          }
        }
      } else {
        debugLogger.warn(
          `Skill "${this.params.skill}" has no hooks to register`,
        );
      }

      const baseDir = path.dirname(skill.filePath);
      const llmContent = buildSkillLlmContent(baseDir, skill.body);

      return {
        llmContent: [{ text: llmContent }],
        returnDisplay: skill.description,
        modelOverride: skill.model,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(`[SkillsTool] Error using skill: ${errorMessage}`);

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
