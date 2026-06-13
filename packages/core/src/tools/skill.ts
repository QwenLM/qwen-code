/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { ToolResult, ToolResultDisplay } from './tools.js';
import type {
  Config,
  ModelInvocableCommandExecutorResult,
} from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SkillConfig } from '../skills/types.js';
import { logSkillLaunch, SkillLaunchEvent } from '../telemetry/index.js';
import path from 'path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { registerSkillHooks } from '../hooks/registerSkillHooks.js';

const debugLogger = createDebugLogger('SKILL');

export interface SkillParams {
  skill: string;
  args?: string;
}

// Re-export for backward compatibility
export { buildSkillLlmContent } from './skill-utils.js';
import {
  buildSkillLlmContent,
  applySkillAllowedTools,
  collectAvailableSkillEntries,
} from './skill-utils.js';

/**
 * Static description for the Skill tool. The live list of available skills is
 * deliberately NOT embedded here — it is injected as an `<available_skills>`
 * `<system-reminder>` in the startup prelude (see `environmentContext`) and
 * refreshed via per-turn deltas. Keeping this description constant for the whole
 * session means skill changes never mutate the tools block, which sits at the
 * front of the tools → system → messages prompt-cache prefix. Mirrors Claude
 * Code's static SkillTool prompt ("Available skills are listed in
 * system-reminder messages in the conversation").
 */
const SKILL_TOOL_DESCRIPTION = `Execute a skill within the main conversation

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to invoke:
- Use this tool with the skill name only (no arguments)
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "xlsx"\` - invoke the xlsx skill
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name
  - \`skill: "mcp-prompt", args: "topic"\` - invoke a model-invocable command with arguments

Important:
- Available skills are listed in <system-reminder> messages in the conversation; only use skills listed there.
- When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action
- NEVER just announce or mention a skill in your text response without actually calling this tool
- This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- When executing scripts or loading referenced files, ALWAYS resolve absolute paths from skill's base directory. Examples:
  - \`bash scripts/init.sh\` -> \`bash /path/to/skill/scripts/init.sh\`
  - \`python scripts/helper.py\` -> \`python /path/to/skill/scripts/helper.py\`
  - \`reference.md\` -> \`/path/to/skill/reference.md\`
</skills_instructions>`;

/**
 * Skill tool that enables the model to access skill definitions. The tool keeps
 * an in-memory set of the currently available skills (for validation) but exposes
 * a static description to the model — the live listing reaches the model via the
 * startup-prelude snapshot and per-turn `<system-reminder>` deltas.
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
  // Cleanup function returned by `addChangeListener`. Stored so per-agent
  // SkillTool instances (subagents share the parent's SkillManager) can
  // detach their listener at teardown — without this the SkillManager
  // accumulates listeners across subagent lifetimes, and each path
  // activation would serialize through every stale listener's refreshSkills run.
  private removeChangeListener: () => void;

  constructor(private readonly config: Config) {
    // Initialize with a basic schema first
    const initialSchema = {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'The skill or command name. E.g., "pdf" or "xlsx"',
        },
        args: {
          type: 'string',
          description: 'Optional arguments for model-invocable slash commands.',
        },
      },
      required: ['skill'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };

    super(
      SkillTool.Name,
      ToolDisplayNames.SKILL,
      SKILL_TOOL_DESCRIPTION, // Static; live skill list is injected via system-reminders.
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
    // Await-able so SkillManager.notifyChangeListeners can sequence on it:
    // matchAndActivateByPaths must not resolve until the runtime sets reflect
    // the newly activated skill, otherwise validateToolParams could reject a
    // skill that the same-turn <system-reminder> just announced as available.
    // (refreshSkills now only updates in-memory sets; it no longer mutates the
    // tool declaration or calls setTools — see SKILL_TOOL_DESCRIPTION.)
    this.removeChangeListener = this.skillManager.addChangeListener(() =>
      this.refreshSkills(),
    );

    // Populate the runtime sets asynchronously.
    this.refreshSkills();
  }

  /**
   * Refreshes the in-memory runtime sets — `availableSkills`,
   * `pendingConditionalSkillNames`, `modelInvocableCommands` — that back
   * `validateToolParams` / `execute`. Invoked on construction and whenever the
   * SkillManager fires a change (skill-file edit, conditional activation, config
   * toggle, or MCP-prompt provider change).
   *
   * It deliberately does NOT mutate the tool declaration or call
   * `geminiClient.setTools()`. The Skill tool's description is static
   * (`SKILL_TOOL_DESCRIPTION`), so the skill set no longer affects the tools
   * block — and the tools block is the front of the tools → system → messages
   * prompt-cache prefix, where any byte change invalidates the whole cached
   * prefix. These runtime sets are in-memory only and never serialized into a
   * request, so refreshing them is prompt-cache-neutral. The model's view of the
   * available skills comes from the `<available_skills>` snapshot in the startup
   * prelude plus per-turn `<system-reminder>` deltas.
   */
  async refreshSkills(): Promise<void> {
    try {
      const collected = await collectAvailableSkillEntries(
        this.skillManager,
        this.config,
      );
      this.availableSkills = collected.availableSkills;
      this.pendingConditionalSkillNames =
        collected.pendingConditionalSkillNames;
      this.modelInvocableCommands = collected.modelInvocableCommands;
    } catch (error) {
      debugLogger.warn('Failed to load skills for Skills tool:', error);
      this.availableSkills = [];
      this.pendingConditionalSkillNames = new Set();
      this.modelInvocableCommands = [];
    }
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
    if (params.args !== undefined && typeof params.args !== 'string') {
      return 'Parameter "args" must be a string when provided.';
    }

    // Check file-based skills
    const skillExists = this.availableSkills.some(
      (skill) => skill.name === params.skill,
    );
    if (skillExists) return null;

    // Check model-invocable commands (e.g. MCP prompts) listed in <available_skills>
    const commandExists = this.modelInvocableCommands.some(
      (cmd) => cmd.name === params.skill,
    );
    if (commandExists) return null;

    // Disabled-by-user branch — placed AFTER commandExists so a same-named
    // MCP prompt or file command can still pass validation. With the
    // `fileBasedSkillNames` exclusion in `refreshSkills`, a disabled skill
    // no longer shadows a same-named non-skill command, and we don't want
    // this branch to block the legitimate command path.
    if (this.config.getDisabledSkillNames().has(params.skill.toLowerCase())) {
      return `Skill "${params.skill}" is disabled. Re-enable it via /skills or remove it from skills.disabled.`;
    }

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

  override toAutoClassifierInput(params: SkillParams): Record<string, unknown> {
    return params.args === undefined
      ? { skill: params.skill }
      : { skill: params.skill, args: params.args };
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

  /**
   * Detach the change listener from SkillManager. Tool registries call
   * this on teardown (mirroring AgentTool's pattern). Per-subagent
   * SkillTool instances share the parent's SkillManager via
   * `InProcessBackend.createPerAgentConfig`, so without dispose the
   * SkillManager would accumulate one stale listener per subagent
   * lifetime — and `notifyChangeListeners` is now `await`-ed
   * sequentially, so each path activation would serialize through every
   * accumulated listener's refreshSkills run.
   */
  dispose(): void {
    this.removeChangeListener();
  }
}

class SkillToolInvocation extends BaseToolInvocation<SkillParams, ToolResult> {
  // Populated by scheduler via setPromptId; empty = direct/non-scheduled
  // call, filter `prompt_id != ''` downstream. See design doc §4.1.1.
  private promptId = '';

  constructor(
    private readonly config: Config,
    private readonly skillManager: SkillManager,
    params: SkillParams,
    private readonly onSkillLoaded: (name: string) => void,
    private readonly commandExecutor:
      | ((
          name: string,
          args?: string,
        ) => Promise<ModelInvocableCommandExecutorResult | null>)
      | null = null,
  ) {
    super(params);
  }

  setPromptId(promptId: string): void {
    this.promptId = promptId;
  }

  getDescription(): string {
    return this.params.args === undefined
      ? `Use skill: "${this.params.skill}"`
      : `Use skill: "${this.params.skill}" with args: "${formatArgsForDescription(this.params.args)}"`;
  }

  /**
   * Skills load user-defined code that runs with the agent's tool
   * access — they're a privileged sink. In AUTO mode the classifier
   * needs to inspect the skill name and any inline args before the
   * skill loads, but the scheduler short-circuits at L4 when
   * `finalPermission === 'allow'`. The L3 default must be `'ask'` so
   * the classifier projection added in this PR can be reached.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  async execute(
    _signal?: AbortSignal,
    _updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    // Disabled-skill guard. Mirrors validateToolParams's commandExists →
    // disabled ordering at the execution layer: when a skill is disabled
    // but a same-named non-skill command (MCP prompt, file command)
    // exists, we MUST run the command instead of loading the disabled
    // skill from disk. `loadSkillForRuntime` resolves by name and ignores
    // the `skills.disabled` setting, so without this guard a disabled
    // skill would still execute its body whenever it shadows a real
    // command.
    const disabled = this.config
      .getDisabledSkillNames()
      .has(this.params.skill.toLowerCase());
    if (disabled) {
      if (this.commandExecutor) {
        // Wrap in try/catch matching the non-disabled path's graceful
        // degradation: if the MCP server throws
        // (network error, timeout, protocol violation), fall through to
        // the disabled-error message instead of propagating an unhandled
        // rejection out of execute(). Without this, disabling a skill
        // makes the system MORE fragile to MCP failures, not less.
        try {
          const content = await this.commandExecutor(
            this.params.skill,
            this.params.args ?? '',
          );
          if (content && typeof content === 'object' && 'error' in content) {
            return {
              llmContent: content.error,
              returnDisplay: content.error,
            };
          }
          if (typeof content === 'string') {
            // Delegated to a same-named non-skill command (file command
            // or MCP prompt). Don't emit `SkillLaunchEvent` and don't
            // track via `onSkillLoaded` — no skill body was loaded, and
            // conflating the two would inflate skill telemetry /
            // `/context` skill-token attribution with command runs.
            return {
              llmContent: [{ text: content }],
              returnDisplay: `Delegated to command: ${this.params.skill}`,
            };
          }
        } catch {
          // Fall through to the disabled-error message below.
        }
      }
      logSkillLaunch(
        this.config,
        new SkillLaunchEvent(this.params.skill, false, this.promptId),
      );
      const msg = `Skill "${this.params.skill}" is disabled. Re-enable it via /skills or remove it from skills.disabled.`;
      return { llmContent: msg, returnDisplay: msg };
    }

    try {
      // Load the skill with runtime config (includes additional files)
      const skill = await this.skillManager.loadSkillForRuntime(
        this.params.skill,
      );

      if (!skill) {
        // Try model-invocable command executor (e.g. MCP prompts)
        if (this.commandExecutor) {
          const commandResult = await this.commandExecutor(
            this.params.skill,
            this.params.args ?? '',
          );
          if (
            commandResult &&
            typeof commandResult === 'object' &&
            'error' in commandResult
          ) {
            logSkillLaunch(
              this.config,
              new SkillLaunchEvent(this.params.skill, false, this.promptId),
            );
            return {
              llmContent: commandResult.error,
              returnDisplay: commandResult.error,
            };
          }
          if (typeof commandResult === 'string') {
            logSkillLaunch(
              this.config,
              new SkillLaunchEvent(this.params.skill, true, this.promptId),
            );
            this.onSkillLoaded(this.params.skill);
            return {
              llmContent: [{ text: commandResult }],
              returnDisplay: `Executed command: ${this.params.skill}`,
            };
          }
        }

        // Log failed skill launch
        logSkillLaunch(
          this.config,
          new SkillLaunchEvent(this.params.skill, false, this.promptId),
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
        new SkillLaunchEvent(this.params.skill, true, this.promptId),
      );
      this.onSkillLoaded(this.params.skill);

      // Auto-approve the skill's declared allowedTools for the rest of the session.
      applySkillAllowedTools(
        this.config.getPermissionManager(),
        skill.allowedTools,
      );

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
        new SkillLaunchEvent(this.params.skill, false, this.promptId),
      );

      return {
        llmContent: `Failed to load skill "${this.params.skill}": ${errorMessage}`,
        returnDisplay: `Failed to load skill "${this.params.skill}": ${errorMessage}`,
      };
    }
  }
}

function formatArgsForDescription(args: string): string {
  const escapeMarkdown = (value: string) =>
    value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
  return args.length > 120
    ? `${escapeMarkdown(args.slice(0, 117))}...`
    : escapeMarkdown(args);
}
