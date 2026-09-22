// Force strict mode and setup for ESM
"use strict";
import {
  escapeXml
} from "./chunk-GXNXX7A2.js";
import {
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/skill-utils.ts
init_esbuild_shims();

// packages/core/src/hooks/registerSkillHooks.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("SKILL_HOOKS");
function registerSkillHooks(sessionHooksManager, sessionId, skill) {
  if (!skill.hooks) {
    debugLogger.debug(`Skill '${skill.name}' has no hooks to register`);
    return 0;
  }
  const hooksSettings = skill.hooks;
  let registeredCount = 0;
  for (const eventName of Object.keys(hooksSettings)) {
    const matchers = hooksSettings[eventName];
    if (!matchers) continue;
    for (const matcher of matchers) {
      const matcherPattern = matcher.matcher || "";
      for (const hook of matcher.hooks) {
        if (hook.type === "function" /* Function */) {
          debugLogger.debug(
            "Skipping function hook from skill (not supported in frontmatter)"
          );
          continue;
        }
        const hookConfig = prepareHookConfig(
          hook,
          skill.skillRoot
        );
        const alreadyRegistered = sessionHooksManager.getHooksForEvent(sessionId, eventName).some(
          (entry) => entry.matcher === matcherPattern && entry.skillRoot === skill.skillRoot && hookConfigKey(entry.config) === hookConfigKey(hookConfig)
        );
        if (alreadyRegistered) {
          debugLogger.debug(
            `Hook for ${eventName} with matcher '${matcherPattern}' from skill '${skill.name}' already registered; skipping duplicate`
          );
          continue;
        }
        sessionHooksManager.addSessionHook(
          sessionId,
          eventName,
          matcherPattern,
          hookConfig,
          { skillRoot: skill.skillRoot, trustGated: skill.level === "project" }
        );
        registeredCount++;
        debugLogger.debug(
          `Registered hook for ${eventName} with matcher '${matcherPattern}' from skill '${skill.name}'`
        );
      }
    }
  }
  if (registeredCount > 0) {
    debugLogger.info(
      `Registered ${registeredCount} hooks from skill '${skill.name}'`
    );
  }
  return registeredCount;
}
__name(registerSkillHooks, "registerSkillHooks");
function hookConfigKey(hook) {
  return `${hook.type}:${JSON.stringify(hook)}`;
}
__name(hookConfigKey, "hookConfigKey");
function prepareHookConfig(hook, skillRoot) {
  if (hook.type === "command" && skillRoot) {
    return {
      ...hook,
      env: {
        ...hook.env,
        QWEN_SKILL_ROOT: skillRoot
      }
    };
  }
  return hook;
}
__name(prepareHookConfig, "prepareHookConfig");

// packages/core/src/tools/skill-utils.ts
var debugLogger2 = createDebugLogger("SKILL");
function skillModelInvocationBlock(config, skillManager, skill) {
  if (!config.isSkillEnabled(skill)) return "disabled";
  if (skill.disableModelInvocation) return "hidden";
  if (!skillManager.isSkillActive(skill)) return "inactive";
  return void 0;
}
__name(skillModelInvocationBlock, "skillModelInvocationBlock");
function buildSkillLlmContent(baseDir, body) {
  return `Base directory for this skill: ${baseDir}
Important: ALWAYS resolve absolute paths from this base directory when working with skills.

${body}
`;
}
__name(buildSkillLlmContent, "buildSkillLlmContent");
var collectCache = /* @__PURE__ */ new WeakMap();
var COLLECT_CACHE_TTL_MS = 2e3;
function clearCollectedSkillEntriesCache(skillManager) {
  if (skillManager) {
    collectCache.delete(skillManager);
  } else {
    collectCache = /* @__PURE__ */ new WeakMap();
  }
}
__name(clearCollectedSkillEntriesCache, "clearCollectedSkillEntriesCache");
async function collectAvailableSkillEntries(skillManager, config) {
  const cached = collectCache.get(skillManager);
  if (cached && Date.now() - cached.ts < COLLECT_CACHE_TTL_MS) {
    return cached.promise;
  }
  const promise = collectAvailableSkillEntriesUncached(skillManager, config);
  collectCache.set(skillManager, { promise, ts: Date.now() });
  promise.catch(() => {
    const entry = collectCache.get(skillManager);
    if (entry?.promise === promise) {
      collectCache.delete(skillManager);
    }
  });
  return promise;
}
__name(collectAvailableSkillEntries, "collectAvailableSkillEntries");
async function collectAvailableSkillEntriesUncached(skillManager, config) {
  const allSkills = await skillManager.listSkills();
  const isEnabled = /* @__PURE__ */ __name((skill) => config.isSkillEnabled(skill), "isEnabled");
  const availableSkills = allSkills.filter(
    (s) => skillModelInvocationBlock(config, skillManager, s) === void 0
  );
  const hiddenSkillNames = new Set(
    allSkills.filter((s) => s.disableModelInvocation).map((s) => s.name)
  );
  const pendingConditionalSkillNames = new Set(
    allSkills.filter(
      (s) => !s.disableModelInvocation && s.paths && s.paths.length > 0 && !skillManager.isSkillActive(s) && isEnabled(s)
    ).map((s) => s.name)
  );
  const provider = config.getModelInvocableCommandsProvider();
  const allCommands = provider ? provider() : [];
  const fileBasedSkillNames = new Set(
    allSkills.filter((s) => !s.disableModelInvocation && isEnabled(s)).map((s) => s.name)
  );
  const modelInvocableCommands = allCommands.filter(
    (cmd) => !fileBasedSkillNames.has(cmd.name)
  );
  const entries = [
    ...availableSkills.map((s) => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      level: s.level
    })),
    ...modelInvocableCommands.map((c) => ({
      name: c.name,
      description: c.description
    }))
  ];
  return {
    availableSkills,
    pendingConditionalSkillNames,
    modelInvocableCommands,
    hiddenSkillNames,
    entries
  };
}
__name(collectAvailableSkillEntriesUncached, "collectAvailableSkillEntriesUncached");
function compareSkillEntries(a, b) {
  const aGroup = a.level !== void 0 ? 0 : 1;
  const bGroup = b.level !== void 0 ? 0 : 1;
  if (aGroup !== bGroup) return aGroup - bGroup;
  return a.name.localeCompare(b.name);
}
__name(compareSkillEntries, "compareSkillEntries");
function renderAvailableSkillsBlock(entries) {
  return [...entries].sort(compareSkillEntries).map((entry) => {
    if (entry.level !== void 0) {
      const descText = `${escapeXml(entry.description)}${entry.whenToUse ? ` \u2014 ${escapeXml(entry.whenToUse)}` : ""} (${entry.level})`;
      return `<skill>
<name>
${escapeXml(entry.name)}
</name>
<description>
${descText}
</description>
<location>
${entry.level}
</location>
</skill>`;
    }
    return `<skill>
<name>
${escapeXml(entry.name)}
</name>
<description>
${escapeXml(entry.description)}
</description>
</skill>`;
  }).join("\n");
}
__name(renderAvailableSkillsBlock, "renderAvailableSkillsBlock");
function canApplySkillSideEffects(skill, config) {
  return skill.level !== "project" || config.isTrustedFolder();
}
__name(canApplySkillSideEffects, "canApplySkillSideEffects");
function applySkillAllowedTools(permissionManager, allowedTools, options) {
  if (!permissionManager || !allowedTools?.length) {
    return;
  }
  for (const rule of allowedTools) {
    permissionManager.addSessionAllowRule(rule, {
      trustGated: options?.trustGated === true
    });
  }
}
__name(applySkillAllowedTools, "applySkillAllowedTools");
function applySkillHooks(config, skill) {
  if (!skill.hooks || Object.keys(skill.hooks).length === 0) {
    return;
  }
  const hookSystem = config.getHookSystem();
  const sessionId = config.getSessionId();
  if (!hookSystem || !sessionId) {
    debugLogger2.warn(
      `Skipping hook registration for skill "${skill.name}": no hook system or session id (hooks disabled?)`
    );
    return;
  }
  const count = registerSkillHooks(
    hookSystem.getSessionHooksManager(),
    sessionId,
    skill
  );
  if (count > 0) {
    debugLogger2.info(`Registered ${count} hooks from skill "${skill.name}"`);
  } else {
    debugLogger2.debug(
      `No new hooks registered from skill "${skill.name}" (already registered or none registrable)`
    );
  }
}
__name(applySkillHooks, "applySkillHooks");
var ReviewWorkflowActivationError = class extends Error {
  static {
    __name(this, "ReviewWorkflowActivationError");
  }
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
};
async function applySkillSideEffects(config, skill) {
  if (!config) {
    return;
  }
  if (!canApplySkillSideEffects(skill, config)) {
    if (skill.allowedTools?.length || skill.hooks) {
      debugLogger2.warn(
        `Skill "${skill.name}" is a project skill in an untrusted folder; ignoring its allowedTools and hooks.`
      );
    }
    return;
  }
  applySkillAllowedTools(config.getPermissionManager(), skill.allowedTools, {
    trustGated: skill.level === "project"
  });
  applySkillHooks(config, skill);
  if (skill.level === "bundled" && skill.name === "review") {
    try {
      await config.enableReviewWorkflow();
    } catch (error) {
      throw new ReviewWorkflowActivationError(error);
    }
  }
}
__name(applySkillSideEffects, "applySkillSideEffects");
function clearLoadedSkillTracking(toolRegistry, logTag) {
  const tool = toolRegistry?.getTool(ToolNames.SKILL);
  if (tool && "clearLoadedSkills" in tool) {
    tool.clearLoadedSkills();
    debugLogger2.debug(
      `[SKILL_TRACKING] conservatively cleared loaded-skill tracking after ${logTag}`
    );
  }
}
__name(clearLoadedSkillTracking, "clearLoadedSkillTracking");

export {
  skillModelInvocationBlock,
  buildSkillLlmContent,
  clearCollectedSkillEntriesCache,
  collectAvailableSkillEntries,
  renderAvailableSkillsBlock,
  ReviewWorkflowActivationError,
  applySkillSideEffects,
  clearLoadedSkillTracking
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
