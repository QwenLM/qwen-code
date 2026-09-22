// Force strict mode and setup for ESM
"use strict";
import {
  mapSkillConfigToStatus
} from "./chunk-2YHL7MJB.js";
import {
  resolveSkillSettings
} from "./chunk-PXA6DGTN.js";
import {
  STATUS_SCHEMA_VERSION
} from "./chunk-SIUR4U2P.js";
import {
  loadSettings
} from "./chunk-DRYBBTI5.js";
import {
  resolveLanguage,
  resolveLanguageSetting
} from "./chunk-POMFSBEC.js";
import {
  ExtensionManager,
  ExtensionStore,
  SkillManager,
  getExtensionDisplayName
} from "./chunk-MRTRBONQ.js";
import {
  authoredSkillName,
  qualifySkillName
} from "./chunk-IMV5DBIP.js";
import {
  isSafeModeEnv
} from "./chunk-ADN5KESB.js";
import {
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/workspace-skills-status.ts
init_esbuild_shims();
import * as fs from "node:fs/promises";
var VALID_SKILL_LEVELS = /* @__PURE__ */ new Set([
  "project",
  "user",
  "extension",
  "bundled"
]);
function createWorkspaceSkillsStatusProvider(options = {}) {
  const managers = /* @__PURE__ */ new Map();
  const provider = /* @__PURE__ */ __name((workspaceCwd) => buildWorkspaceSkillsStatus(
    workspaceCwd,
    managers,
    options.workspaceTrusted ?? true,
    options.includeUntrustedSkills ?? false
  ), "provider");
  provider.invalidate = (workspaceCwd) => managers.delete(workspaceCwd);
  return provider;
}
__name(createWorkspaceSkillsStatusProvider, "createWorkspaceSkillsStatusProvider");
async function buildWorkspaceSkillsStatus(workspaceCwd, managers, workspaceTrusted, includeUntrustedSkills) {
  try {
    const settings = loadSettings(workspaceCwd, {
      consumeCorruptionEnvVars: false,
      skipLoadEnvironment: true,
      skipWorkspaceSettings: !workspaceTrusted,
      workspaceTrusted
    });
    const rawLanguage = settings.merged.general?.language;
    const locale = resolveLanguage(
      resolveLanguageSetting(
        typeof rawLanguage === "string" ? rawLanguage : void 0
      )
    );
    let cached = managers.get(workspaceCwd);
    if (!cached) {
      const rawLevels = !workspaceTrusted || isSafeModeEnv() ? void 0 : settings.merged.skills?.disabledLevels;
      const disabledLevels = new Set(
        Array.isArray(rawLevels) ? rawLevels.filter(
          (v) => typeof v === "string" && VALID_SKILL_LEVELS.has(v)
        ) : []
      );
      const safeMode = !workspaceTrusted && !includeUntrustedSkills || isSafeModeEnv();
      let extensionManager2;
      const extensionSkillStates2 = /* @__PURE__ */ new Map();
      if (workspaceTrusted && !safeMode) {
        const directory = Storage.getUserExtensionsDir();
        const entry = await fs.lstat(directory).catch((error) => {
          if (error.code === "ENOENT") return void 0;
          throw error;
        });
        if (entry) {
          await fs.readdir(directory);
          const extensionStore = new ExtensionStore();
          extensionManager2 = new ExtensionManager({
            extensionStore,
            workspaceDir: workspaceCwd,
            isWorkspaceTrusted: workspaceTrusted,
            locale
          });
          const snapshot = await extensionManager2.refreshCacheWithSnapshot();
          for (const extension of extensionManager2.getLoadedExtensions()) {
            const states = /* @__PURE__ */ new Map();
            for (const skill of extension.skills ?? []) {
              const name = skill.name.trim().toLowerCase();
              const defaults = extension.config.skillStates;
              const defaultEnabled = defaults && Object.hasOwn(defaults, name) ? defaults[name] : true;
              states.set(
                name,
                extensionStore.getSkillWorkspaceOverride(
                  snapshot,
                  extension.id,
                  workspaceCwd,
                  name
                ) ?? defaultEnabled
              );
            }
            extensionSkillStates2.set(extension, states);
          }
        }
      }
      const shim = {
        // Honor the safe-mode env the same way `Config` does when no explicit
        // flag is passed, so an operator running in safe mode gets the same
        // bundled-only listing the child would produce.
        isSafeMode: /* @__PURE__ */ __name(() => safeMode, "isSafeMode"),
        // Bare mode is the interactive `--bare` CLI flag; the daemon never runs
        // bare, so it is always off here.
        getBareMode: /* @__PURE__ */ __name(() => false, "getBareMode"),
        getProjectRoot: /* @__PURE__ */ __name(() => workspaceCwd, "getProjectRoot"),
        getActiveExtensions: /* @__PURE__ */ __name(() => extensionManager2?.getLoadedExtensions().filter((e) => e.isActive) ?? [], "getActiveExtensions"),
        getDisabledSkillLevels: /* @__PURE__ */ __name(() => disabledLevels, "getDisabledSkillLevels")
      };
      const skillManager2 = new SkillManager(shim);
      if (!safeMode) {
        for (const level of ["project", "user"]) {
          if (disabledLevels.has(level)) continue;
          for (const directory of skillManager2.getSkillsBaseDirs(level)) {
            try {
              await fs.readdir(directory);
            } catch (error) {
              if (error.code !== "ENOENT") {
                throw error;
              }
            }
          }
        }
      }
      cached = { skillManager: skillManager2, extensionManager: extensionManager2, extensionSkillStates: extensionSkillStates2 };
      managers.set(workspaceCwd, cached);
    }
    const { disablements, enabledNames } = resolveSkillSettings(settings);
    const { skillManager, extensionManager, extensionSkillStates } = cached;
    const extensions = extensionManager?.getLoadedExtensions() ?? [];
    const skills = await skillManager.listSkills();
    const statuses = skills.map((skill) => {
      const extension = skill.level === "extension" ? extensions.find((e) => e.name === skill.extensionName) : void 0;
      const enabled = extension ? extensionSkillStates.get(extension)?.get(authoredSkillName(skill).trim().toLowerCase()) : void 0;
      const localizedSkill = extension?.displayName !== void 0 ? {
        ...skill,
        extensionDisplayName: getExtensionDisplayName(extension, locale)
      } : skill;
      return mapSkillConfigToStatus(localizedSkill, disablements, {
        enabled: enabledNames.has(skill.name.trim().toLowerCase()) || enabled !== false
      });
    });
    for (const extension of extensions) {
      if (extension.isActive) continue;
      const seenNames = /* @__PURE__ */ new Set();
      for (const skill of extension.skills ?? []) {
        if (seenNames.has(skill.name)) continue;
        seenNames.add(skill.name);
        statuses.push(
          mapSkillConfigToStatus(
            {
              ...skill,
              name: qualifySkillName(extension.name, skill.name),
              authoredName: skill.name,
              level: "extension",
              extensionName: extension.name,
              extensionDisplayName: extension.displayName === void 0 ? void 0 : getExtensionDisplayName(extension, locale)
            },
            disablements,
            { disabled: true }
          )
        );
      }
    }
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: true,
      skills: statuses.sort((a, b) => a.name.localeCompare(b.name))
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderrLine(
      `qwen serve: daemon-local skills enumeration failed for ${workspaceCwd}: ${message}`
    );
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: false,
      skills: [],
      errors: [
        {
          kind: "skills",
          status: "error",
          error: message
        }
      ]
    };
  }
}
__name(buildWorkspaceSkillsStatus, "buildWorkspaceSkillsStatus");

export {
  createWorkspaceSkillsStatusProvider
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
