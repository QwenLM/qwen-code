// Force strict mode and setup for ESM
"use strict";
import {
  recordAutoSkillUsage
} from "./chunk-IMV5DBIP.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-QE36VXWP.js";
import {
  ReviewWorkflowActivationError,
  applySkillSideEffects,
  buildSkillLlmContent,
  clearCollectedSkillEntriesCache,
  collectAvailableSkillEntries,
  skillModelInvocationBlock
} from "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-GVTAFLWB.js";
import {
  SkillLaunchEvent,
  logSkillLaunch,
  recordSkillInvocation
} from "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/skill.ts
init_esbuild_shims();
import path from "path";
var debugLogger = createDebugLogger("SKILL");
var SKILL_TOOL_DESCRIPTION = `Execute a skill within the main conversation

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to invoke:
- Use this tool with the skill name only (no arguments)
- Name the skill exactly as it appears in the available-skills listing; do not shorten or guess a spelling.
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "xlsx"\` - invoke the xlsx skill
  - \`skill: "ms-office-suite:pdf"\` - invoke the pdf skill owned by the ms-office-suite extension
  - \`skill: "mcp-prompt", args: "topic"\` - invoke a model-invocable command with arguments

Important:
- Available skills are listed in <system-reminder> messages in the conversation; only use skills listed there.
- A skill provided by an extension is registered as \`<extensionName>:<skillName>\` (e.g. \`ms-office-suite:pdf\`), so two extensions offering the same authored name are two different skills. Personal, project, and bundled skills keep the single name their author wrote and are never prefixed.
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
var SKILL_RESTORE_BLOCK_REASONS = {
  disabled: "it is disabled",
  inactive: "its `paths:` activation has not fired",
  hidden: "it is hidden from model invocation"
};
function logSkillNotRestored(skill, reason) {
  const declaresSideEffects = (skill.allowedTools?.length ?? 0) > 0 || Object.keys(skill.hooks ?? {}).length > 0;
  if (declaresSideEffects) {
    debugLogger.warn(
      `Not re-applying the hooks and allowedTools of skill "${skill.name}" on resume: ${reason}.`
    );
  }
}
__name(logSkillNotRestored, "logSkillNotRestored");
var SkillTool = class _SkillTool extends BaseDeclarativeTool {
  constructor(config) {
    const initialSchema = {
      type: "object",
      properties: {
        skill: {
          type: "string",
          description: 'The skill or command name. E.g., "pdf" or "xlsx"'
        },
        args: {
          type: "string",
          description: "Optional arguments for model-invocable slash commands."
        }
      },
      required: ["skill"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#"
    };
    super(
      _SkillTool.Name,
      ToolDisplayNames.SKILL,
      SKILL_TOOL_DESCRIPTION,
      // Static; live skill list is injected via system-reminders.
      "read" /* Read */,
      initialSchema,
      false,
      // isOutputMarkdown
      false
      // canUpdateOutput
    );
    this.config = config;
    const skillManager = config.getSkillManager();
    if (!skillManager) {
      throw new Error("SkillManager not available");
    }
    this.skillManager = skillManager;
    this.removeChangeListener = this.skillManager.addChangeListener(
      (options) => this.refreshSkills(options)
    );
    this.refreshSkills();
  }
  static {
    __name(this, "SkillTool");
  }
  static Name = ToolNames.SKILL;
  skillManager;
  availableSkills = [];
  // Conditional skills (with `paths:`) that exist on disk but have not yet
  // been activated by a matching tool invocation. Tracked separately so
  // validateToolParams can give a distinct error message when the model
  // names one of these: "gated by paths:, access a matching file first"
  // instead of the generic "not found".
  pendingConditionalSkillNames = /* @__PURE__ */ new Set();
  modelInvocableCommands = [];
  hiddenSkillNames = /* @__PURE__ */ new Set();
  loadedSkillNames = /* @__PURE__ */ new Set();
  loadedSkillContents = /* @__PURE__ */ new Set();
  // Cleanup function returned by `addChangeListener`. Stored so per-agent
  // SkillTool instances (subagents share the parent's SkillManager) can
  // detach their listener at teardown — without this the SkillManager
  // accumulates listeners across subagent lifetimes, and each path
  // activation would serialize through every stale listener's refreshSkills run.
  removeChangeListener;
  /**
   * Refreshes the in-memory runtime sets — `availableSkills`,
   * `pendingConditionalSkillNames`, `modelInvocableCommands` — that back
   * `validateToolParams` / `execute`. Invoked on construction and whenever the
   * SkillManager fires a change (skill-file edit, conditional activation, config
   * toggle, or MCP-prompt provider change).
   *
   * It deliberately does NOT mutate the tool declaration or call
   * `llmClient.setTools()`. The Skill tool's description is static
   * (`SKILL_TOOL_DESCRIPTION`), so the skill set no longer affects the tools
   * block — and the tools block is the front of the tools → system → messages
   * prompt-cache prefix, where any byte change invalidates the whole cached
   * prefix. These runtime sets are in-memory only and never serialized into a
   * request, so refreshing them is prompt-cache-neutral. The model's view of the
   * available skills comes from the `<available_skills>` snapshot in the startup
   * prelude plus per-turn `<system-reminder>` deltas.
   */
  async refreshSkills(options) {
    try {
      clearCollectedSkillEntriesCache(this.skillManager);
      const collected = await collectAvailableSkillEntries(
        this.skillManager,
        this.config
      );
      this.availableSkills = collected.availableSkills;
      this.pendingConditionalSkillNames = collected.pendingConditionalSkillNames;
      this.modelInvocableCommands = collected.modelInvocableCommands;
      this.hiddenSkillNames = collected.hiddenSkillNames ?? /* @__PURE__ */ new Set();
    } catch (error) {
      debugLogger.warn("Failed to load skills for Skills tool:", error);
      this.availableSkills = [];
      this.pendingConditionalSkillNames = /* @__PURE__ */ new Set();
      this.modelInvocableCommands = [];
      this.hiddenSkillNames = /* @__PURE__ */ new Set();
      if (options?.throwOnError) throw error;
    }
  }
  validateToolParams(params) {
    if (!params.skill || typeof params.skill !== "string" || params.skill.trim() === "") {
      return 'Parameter "skill" must be a non-empty string.';
    }
    if (params.args !== void 0 && typeof params.args !== "string") {
      return 'Parameter "args" must be a string when provided.';
    }
    const skillExists = this.availableSkills.some(
      (skill) => skill.name === params.skill && this.config.isSkillEnabled(skill)
    );
    if (skillExists) return null;
    const commandExists = this.getModelInvocableCommands().some(
      (cmd) => cmd.name === params.skill
    );
    if (commandExists) return null;
    const knownSkill = this.skillManager.getCachedSkills()?.find((skill) => skill.name === params.skill);
    if (this.config.getDisabledSkillNames().has(params.skill.toLowerCase()) || knownSkill && !this.config.isSkillEnabled(knownSkill)) {
      return `Skill "${params.skill}" is disabled. Re-enable it via /skills or remove it from skills.disabled.`;
    }
    if (this.pendingConditionalSkillNames.has(params.skill)) {
      return `Skill "${params.skill}" is gated by path-based activation (paths: frontmatter) and is not yet available. Access a file matching its paths patterns first to activate it.`;
    }
    const availableNames = [
      .../* @__PURE__ */ new Set([
        ...this.availableSkills.map((s) => s.name),
        ...this.getModelInvocableCommands().map((c) => c.name)
      ])
    ];
    if (availableNames.length === 0) {
      return `Skill "${params.skill}" not found. No skills are currently available.`;
    }
    return `Skill "${params.skill}" not found. Available skills: ${availableNames.join(", ")}`;
  }
  /**
   * Returns the model-invocable commands to validate against, preferring a
   * live read of the config provider over the cached snapshot from the last
   * `refreshSkills()` (see `validateToolParams` for the late-attach race).
   * Falls back to the cache when no provider is registered (e.g. SDK mode)
   * or when the provider throws. The provider is synchronous, so the live
   * read is cheap enough to run on every validation.
   *
   * Commands whose names collide with a file-based skill (active or pending
   * path-activation) are dropped, mirroring the `fileBasedSkillNames` dedup
   * in `collectAvailableSkillEntries` — without this, a command named after
   * a path-gated skill would pass validation here and bypass the
   * "gated by paths:" branch above.
   */
  getModelInvocableCommands() {
    let commands;
    const provider = this.config.getModelInvocableCommandsProvider();
    if (provider) {
      try {
        commands = provider();
      } catch (error) {
        debugLogger.warn(
          "Model-invocable commands provider threw; falling back to cached set:",
          error
        );
        commands = this.modelInvocableCommands;
      }
    } else {
      commands = this.modelInvocableCommands;
    }
    const knownSkills = this.skillManager.getCachedSkills() ?? [];
    const shadowedNames = /* @__PURE__ */ new Set([
      ...this.availableSkills.filter((skill) => this.config.isSkillEnabled(skill)).map((skill) => skill.name),
      ...Array.from(this.pendingConditionalSkillNames).filter((name) => {
        const skill = knownSkills.find((candidate) => candidate.name === name);
        return !skill || this.config.isSkillEnabled(skill);
      })
    ]);
    return commands.filter((cmd) => !shadowedNames.has(cmd.name));
  }
  createInvocation(params) {
    return new SkillToolInvocation(
      this.config,
      this.skillManager,
      params,
      (name, content) => {
        this.loadedSkillNames.add(name);
        if (content !== void 0) this.loadedSkillContents.add(content);
      },
      this.config.getModelInvocableCommandsExecutor(),
      (name) => this.loadedSkillNames.has(name),
      (name) => this.hiddenSkillNames.has(name)
    );
  }
  toAutoClassifierInput(params) {
    return params.args === void 0 ? { skill: params.skill } : { skill: params.skill, args: params.args };
  }
  getAvailableSkillNames() {
    return this.availableSkills.map((skill) => skill.name);
  }
  /**
   * Returns the set of skill names that have been successfully loaded
   * (invoked) during the current session. Used by /context to attribute
   * loaded skill body tokens separately from the tool-definition cost.
   */
  getLoadedSkillNames() {
    return this.loadedSkillNames;
  }
  getLoadedSkillContents() {
    return this.loadedSkillContents;
  }
  async restoreLoadedSkillsFromHistory(history) {
    this.clearLoadedSkills();
    let cachedSkills = this.skillManager.getCachedSkills();
    if (cachedSkills === null) {
      try {
        await this.skillManager.listSkills();
        cachedSkills = this.skillManager.getCachedSkills();
      } catch (error) {
        debugLogger.warn(
          "Failed to load skills while restoring a resumed session:",
          error
        );
      }
    }
    const skillByName = /* @__PURE__ */ new Map();
    for (const skill of cachedSkills ?? []) {
      const output = buildSkillLlmContent(
        path.dirname(skill.filePath),
        skill.body
      );
      skillByName.set(skill.name, { name: skill.name, output, config: skill });
    }
    for (const skill of cachedSkills ?? []) {
      const authored = (skill.authoredName ?? "").trim();
      if (authored && authored !== skill.name && !skillByName.has(authored)) {
        skillByName.set(authored, skillByName.get(skill.name));
      }
    }
    const restored = /* @__PURE__ */ new Map();
    const unmatched = /* @__PURE__ */ new Map();
    const restoreSkill = /* @__PURE__ */ __name((requestedName, output, rearm) => {
      if (typeof requestedName !== "string" || typeof output !== "string") {
        return;
      }
      const skill = skillByName.get(requestedName);
      if (!skill) return;
      if (output !== skill.output && !output.startsWith(`${skill.output}
`)) {
        if (rearm) unmatched.set(skill.name, skill.config);
        return;
      }
      this.loadedSkillContents.add(skill.output);
      this.loadedSkillNames.add(skill.name);
      if (rearm) restored.set(skill.name, skill.config);
    }, "restoreSkill");
    const pendingSkillCalls = /* @__PURE__ */ new Map();
    const pendingExecCalls = /* @__PURE__ */ new Set();
    for (const content of history) {
      for (const part of content.parts ?? []) {
        const call = part.functionCall;
        if (call?.name === ToolNames.EXEC && typeof call.id === "string") {
          pendingExecCalls.add(call.id);
        }
        const requestedSkill = call?.args?.["skill"];
        if (call?.name === ToolNames.SKILL && typeof call.id === "string" && typeof requestedSkill === "string") {
          pendingSkillCalls.set(call.id, requestedSkill);
          continue;
        }
        const response = part.functionResponse;
        const output = response?.response?.["output"];
        if (response?.name === ToolNames.EXEC && typeof response.id === "string" && pendingExecCalls.delete(response.id) && typeof output === "string") {
          let payload;
          try {
            payload = JSON.parse(output.split("\n", 1)[0]);
          } catch {
            continue;
          }
          if (!payload || typeof payload !== "object" || !("toolResults" in payload) || !Array.isArray(payload.toolResults)) {
            continue;
          }
          const results = payload.toolResults;
          for (const result of results) {
            if (result && typeof result === "object" && "name" in result && result.name === ToolNames.SKILL && "args" in result && result.args && typeof result.args === "object" && "skill" in result.args && "output" in result) {
              restoreSkill(result.args.skill, result.output, false);
            }
          }
          continue;
        }
        if (response?.name !== ToolNames.SKILL || typeof response.id !== "string" || typeof output !== "string") {
          continue;
        }
        const requestedName = pendingSkillCalls.get(response.id);
        pendingSkillCalls.delete(response.id);
        if (requestedName === void 0) continue;
        restoreSkill(requestedName, output, true);
      }
    }
    for (const skill of restored.values()) {
      await this.restoreSkillSideEffects(skill);
    }
    for (const [name, skill] of unmatched) {
      if (!this.loadedSkillNames.has(name)) {
        logSkillNotRestored(
          skill,
          "no recorded response matches SKILL.md on disk"
        );
      }
    }
  }
  /**
   * Re-applies a restored skill's `allowedTools` and `hooks:`. Both live only
   * in process memory, so without this a resumed session keeps the skill's
   * instructions in context while its `PreToolUse` gate is gone (#11180).
   */
  async restoreSkillSideEffects(skill) {
    const blocked = skillModelInvocationBlock(
      this.config,
      this.skillManager,
      skill
    );
    if (blocked) {
      logSkillNotRestored(skill, SKILL_RESTORE_BLOCK_REASONS[blocked]);
      return;
    }
    try {
      await applySkillSideEffects(this.config, skill);
    } catch (error) {
      if (!(error instanceof ReviewWorkflowActivationError)) throw error;
      debugLogger.warn(
        `Review workflow activation failed while restoring skill "${skill.name}" on resume:`,
        error
      );
    }
  }
  /**
   * Clears the loaded-skills tracking. Called when the session is reset
   * (e.g. /clear) and conservatively at destructive history-rewrite
   * boundaries (compaction, truncation, orphan stripping), so a skill
   * whose body was evicted never stays stuck behind the dedup guard.
   */
  clearLoadedSkills() {
    this.loadedSkillNames.clear();
    this.loadedSkillContents.clear();
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
  dispose() {
    this.removeChangeListener();
  }
};
var SkillToolInvocation = class extends BaseToolInvocation {
  constructor(config, skillManager, params, onSkillLoaded, commandExecutor = null, isSkillLoaded = () => false, isSkillHidden = () => false) {
    super(params);
    this.config = config;
    this.skillManager = skillManager;
    this.onSkillLoaded = onSkillLoaded;
    this.commandExecutor = commandExecutor;
    this.isSkillLoaded = isSkillLoaded;
    this.isSkillHidden = isSkillHidden;
  }
  static {
    __name(this, "SkillToolInvocation");
  }
  // Populated by scheduler via setPromptId; empty = direct/non-scheduled
  // call, filter `prompt_id != ''` downstream. See design doc §4.1.1.
  promptId = "";
  setPromptId(promptId) {
    this.promptId = promptId;
  }
  getDescription() {
    return this.params.args === void 0 ? `Use skill: "${this.params.skill}"` : `Use skill: "${this.params.skill}" with args: "${formatArgsForDescription(this.params.args)}"`;
  }
  /**
   * Skills load user-defined code that runs with the agent's tool
   * access — they're a privileged sink. In AUTO mode the classifier
   * needs to inspect the skill name and any inline args before the
   * skill loads, but the scheduler short-circuits at L4 when
   * `finalPermission === 'allow'`. The L3 default must be `'ask'` so
   * the classifier projection added in this PR can be reached.
   */
  async getDefaultPermission() {
    return "ask";
  }
  /**
   * Apply the skill's side effects — `allowedTools` session allow rules and
   * frontmatter hooks — when the folder-trust gate allows it. Idempotent:
   * both underlying registrations dedup already-applied entries.
   *
   * The gate has two sides. This is the way in; a project skill's grants
   * are additionally marked trust-gated, and both the permission manager
   * and the hook event handler re-read `isTrustedFolder()` at decision
   * time, so a trust revoked mid-session (an IDE trust notification flips it
   * live) suspends the already-applied hooks and allow rules without a
   * restart, and a trust granted again restores them.
   */
  async applySideEffects(skill) {
    await applySkillSideEffects(this.config, skill);
  }
  async recordAutoSkillUsageBestEffort(skill) {
    try {
      await recordAutoSkillUsage(this.config.getProjectRoot(), skill);
    } catch (error) {
      debugLogger.warn(
        `Failed to record auto-skill usage: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async executeDisabledSkill() {
    let disabledCommandFallbackAttempted = false;
    if (this.commandExecutor) {
      disabledCommandFallbackAttempted = true;
      try {
        const content = await this.commandExecutor(
          this.params.skill,
          this.params.args ?? ""
        );
        if (content && typeof content === "object" && "error" in content) {
          return {
            llmContent: content.error,
            returnDisplay: content.error
          };
        }
        if (typeof content === "string") {
          return {
            llmContent: [{ text: content }],
            returnDisplay: `Delegated to command: ${this.params.skill}`
          };
        }
      } catch {
      }
    }
    logSkillLaunch(
      this.config,
      new SkillLaunchEvent(this.params.skill, false, this.promptId)
    );
    if (!disabledCommandFallbackAttempted) {
      recordSkillInvocation(this.config, {
        skillName: this.params.skill,
        success: false
      });
    }
    const msg = `Skill "${this.params.skill}" is disabled. Re-enable it via /skills or remove it from skills.disabled.`;
    return { llmContent: msg, returnDisplay: msg };
  }
  async execute(_signal, _updateOutput) {
    if (this.isSkillHidden(this.params.skill)) {
      let hiddenCommandFallbackAttempted = false;
      if (this.commandExecutor) {
        hiddenCommandFallbackAttempted = true;
        try {
          const content = await this.commandExecutor(
            this.params.skill,
            this.params.args ?? ""
          );
          if (content && typeof content === "object" && "error" in content) {
            return {
              llmContent: content.error,
              returnDisplay: content.error
            };
          }
          if (typeof content === "string") {
            return {
              llmContent: [{ text: content }],
              returnDisplay: `Delegated to command: ${this.params.skill}`
            };
          }
        } catch (error) {
          debugLogger.warn(
            `Hidden-skill command fallback failed for "${this.params.skill}":`,
            error
          );
        }
      }
      logSkillLaunch(
        this.config,
        new SkillLaunchEvent(this.params.skill, false, this.promptId)
      );
      if (!hiddenCommandFallbackAttempted) {
        recordSkillInvocation(this.config, {
          skillName: this.params.skill,
          success: false
        });
      }
      const msg = `Skill "${this.params.skill}" not found.`;
      return { llmContent: msg, returnDisplay: msg };
    }
    const disabled = this.config.getDisabledSkillNames().has(this.params.skill.toLowerCase());
    if (disabled) {
      return this.executeDisabledSkill();
    }
    let commandFallbackAttempted = false;
    try {
      const skill = await this.skillManager.loadSkillForRuntime(
        this.params.skill
      );
      if (skill && !this.config.isSkillEnabled(skill)) {
        return this.executeDisabledSkill();
      }
      if (!skill) {
        if (this.commandExecutor) {
          commandFallbackAttempted = true;
          const commandResult = await this.commandExecutor(
            this.params.skill,
            this.params.args ?? ""
          );
          if (commandResult && typeof commandResult === "object" && "error" in commandResult) {
            logSkillLaunch(
              this.config,
              new SkillLaunchEvent(this.params.skill, false, this.promptId)
            );
            return {
              llmContent: commandResult.error,
              returnDisplay: commandResult.error
            };
          }
          if (typeof commandResult === "string") {
            logSkillLaunch(
              this.config,
              new SkillLaunchEvent(this.params.skill, true, this.promptId)
            );
            return {
              llmContent: [{ text: commandResult }],
              returnDisplay: `Executed command: ${this.params.skill}`
            };
          }
        }
        logSkillLaunch(
          this.config,
          new SkillLaunchEvent(this.params.skill, false, this.promptId)
        );
        if (!commandFallbackAttempted) {
          recordSkillInvocation(this.config, {
            skillName: this.params.skill,
            success: false
          });
        }
        const parseErrors = this.skillManager.getParseErrors();
        const errorMessages = [];
        for (const [filePath, error] of parseErrors) {
          if (filePath.includes(this.params.skill)) {
            errorMessages.push(`Parse error at ${filePath}: ${error.message}`);
          }
        }
        const errorDetail = errorMessages.length > 0 ? `
Errors:
${errorMessages.join("\n")}` : "";
        return {
          llmContent: `Skill "${this.params.skill}" not found.${errorDetail}`,
          returnDisplay: `Skill "${this.params.skill}" not found.${errorDetail}`
        };
      }
      logSkillLaunch(
        this.config,
        new SkillLaunchEvent(this.params.skill, true, this.promptId)
      );
      let activationWarning = "";
      try {
        await this.applySideEffects(skill);
      } catch (error) {
        if (!(error instanceof ReviewWorkflowActivationError) || !this.isSkillLoaded(this.params.skill)) {
          throw error;
        }
        activationWarning = ` Warning: review workflow activation failed (${error.message}); workflow dispatch may be unavailable.`;
      }
      if (this.isSkillLoaded(this.params.skill)) {
        this.onSkillLoaded(this.params.skill);
        void this.recordAutoSkillUsageBestEffort(skill);
        const msg = `Skill "${this.params.skill}" is already loaded in context.${activationWarning}`;
        return {
          llmContent: msg,
          returnDisplay: msg
        };
      }
      const baseDir = path.dirname(skill.filePath);
      const llmContent = buildSkillLlmContent(baseDir, skill.body);
      this.onSkillLoaded(this.params.skill, llmContent);
      void this.recordAutoSkillUsageBestEffort(skill);
      recordSkillInvocation(this.config, {
        skillName: this.params.skill,
        success: true
      });
      return {
        llmContent: [{ text: llmContent }],
        returnDisplay: skill.description,
        modelOverride: skill.model
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      debugLogger.error(`[SkillsTool] Error using skill: ${errorMessage}`);
      logSkillLaunch(
        this.config,
        new SkillLaunchEvent(this.params.skill, false, this.promptId)
      );
      if (!commandFallbackAttempted) {
        recordSkillInvocation(this.config, {
          skillName: this.params.skill,
          success: false
        });
      }
      return {
        llmContent: `Failed to load skill "${this.params.skill}": ${errorMessage}`,
        returnDisplay: `Failed to load skill "${this.params.skill}": ${errorMessage}`
      };
    }
  }
};
function formatArgsForDescription(args) {
  const escapeMarkdown = /* @__PURE__ */ __name((value) => value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1"), "escapeMarkdown");
  return args.length > 120 ? `${escapeMarkdown(args.slice(0, 117))}...` : escapeMarkdown(args);
}
__name(formatArgsForDescription, "formatArgsForDescription");
export {
  SkillTool,
  buildSkillLlmContent
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
