/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-local workspace skills enumeration.
 *
 * `/workspace/skills` is normally answered by the ACP child (which owns the
 * live `SkillManager`). But the child is not always available before the
 * first prompt: session creation is deferred until then, and the startup
 * preheat can time out on a slow cold start — most visibly under
 * `npm run dev`, where the child is transpiled on demand and its
 * `initialize` handshake routinely exceeds the 10s preheat budget, so no
 * channel ever comes up. In that window the child cannot list skills, which
 * drops skill-backed slash commands (e.g. `/review`) from the Web Shell's
 * pre-first-prompt autocomplete even though the skills exist on disk.
 *
 * This provider enumerates skills directly from the filesystem via
 * `SkillManager`, with no child and no MCP initialization, so the daemon can
 * answer `/workspace/skills` instantly whenever the child is unavailable.
 * `SkillManager.listSkills()` only reads a handful of `Config` getters
 * (safe/bare mode, project root, active extensions), so a lightweight config
 * shim is sufficient — no full `Config` construction (and no `initialize()`
 * side effects) required. The live child, when present, stays authoritative:
 * the facade only falls back here after a real child answer and the cached
 * last answer are both unavailable. This daemon-local view includes installed
 * extension Skills using the persistent extension store without binding a
 * runtime Config to the ExtensionManager.
 */

import {
  ExtensionManager,
  ExtensionStore,
  SkillManager,
  isSafeModeEnv,
  getExtensionDisplayName,
  authoredSkillName,
  qualifySkillName,
} from '@qwen-code/qwen-code-core';
import type {
  Config,
  Extension,
  ExtensionStoreSnapshot,
  SkillLevel,
} from '@qwen-code/qwen-code-core';
import type { ServeWorkspaceSkillsStatus } from '@qwen-code/acp-bridge/status';
import { STATUS_SCHEMA_VERSION } from '@qwen-code/acp-bridge/status';
import * as fs from 'node:fs/promises';
import { loadSettings } from '../config/settings.js';
import { resolveLanguage, resolveLanguageSetting } from '../i18n/index.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { mapSkillConfigToStatus } from '../runtime/workspace-skills-mapping.js';
import { resolveSkillSettings } from '../config/skill-settings.js';

export interface WorkspaceSkillsStatusProvider {
  (workspaceCwd: string): Promise<ServeWorkspaceSkillsStatus>;
  invalidate?(workspaceCwd: string): void;
}

export interface WorkspaceSkillsStatusProviderOptions {
  managedExtensionsDir?: string;
  workspaceTrusted?: boolean;
  /** Read inert on-disk Skill manifests without loading workspace settings. */
  includeUntrustedSkills?: boolean;
}

const VALID_SKILL_LEVELS: ReadonlySet<string> = new Set<SkillLevel>([
  'project',
  'user',
  'extension',
  'bundled',
]);

/**
 * The `Config` surface `SkillManager.listSkills()` actually reads. Declaring it
 * as a `Pick` (rather than casting an inline object literal) type-checks the
 * shimmed getters against `Config`'s real signatures, so a signature drift is
 * caught at compile time. Should `SkillManager` grow a dependency on some other
 * `Config` method, that call would be `undefined` at runtime — which
 * `buildWorkspaceSkillsStatus`'s try/catch turns into an empty, non-initialized
 * status (the facade then leaves skills to the live child) rather than a crash.
 */
type SkillManagerConfigShim = Pick<
  Config,
  | 'isSafeMode'
  | 'getBareMode'
  | 'getProjectRoot'
  | 'getActiveExtensions'
  | 'getDisabledSkillLevels'
>;

interface WorkspaceSkillManagers {
  skillManager: SkillManager;
  extensions: Extension[];
  extensionSkillStates: Map<Extension, Map<string, boolean>>;
}

export function createWorkspaceSkillsStatusProvider(
  options: WorkspaceSkillsStatusProviderOptions = {},
): WorkspaceSkillsStatusProvider {
  // Reuse one SkillManager per workspace so repeat queries hit its in-memory
  // skills cache instead of re-scanning (and re-parsing frontmatter / compiling
  // globs for) every level on each call. This is a best-effort pre-child
  // fallback, so slight staleness between explicit invalidation points is
  // acceptable: the live child re-lists authoritatively once a session exists.
  const managers = new Map<string, WorkspaceSkillManagers>();
  const provider = ((workspaceCwd: string) =>
    buildWorkspaceSkillsStatus(
      workspaceCwd,
      managers,
      options.workspaceTrusted ?? true,
      options.includeUntrustedSkills ?? false,
      options.managedExtensionsDir,
    )) as WorkspaceSkillsStatusProvider;
  provider.invalidate = (workspaceCwd) => managers.delete(workspaceCwd);
  return provider;
}

async function buildWorkspaceSkillsStatus(
  workspaceCwd: string,
  managers: Map<string, WorkspaceSkillManagers>,
  workspaceTrusted: boolean,
  includeUntrustedSkills: boolean,
  managedExtensionsDir?: string,
): Promise<ServeWorkspaceSkillsStatus> {
  try {
    const settings = loadSettings(workspaceCwd, {
      consumeCorruptionEnvVars: false,
      skipLoadEnvironment: true,
      skipWorkspaceSettings: !workspaceTrusted,
      workspaceTrusted,
    });
    const rawLanguage = settings.merged.general?.language;
    const locale = resolveLanguage(
      resolveLanguageSetting(
        typeof rawLanguage === 'string' ? rawLanguage : undefined,
      ),
    );
    let cached = managers.get(workspaceCwd);
    if (!cached) {
      // Mirror the CLI guard in loadCliConfig: safe mode nullifies
      // disabledSkillLevels so the child session loads all bundled skills.
      const rawLevels =
        !workspaceTrusted || isSafeModeEnv()
          ? undefined
          : settings.merged.skills?.disabledLevels;
      const disabledLevels = new Set<SkillLevel>(
        Array.isArray(rawLevels)
          ? rawLevels.filter(
              (v): v is SkillLevel =>
                typeof v === 'string' && VALID_SKILL_LEVELS.has(v),
            )
          : [],
      );
      const safeMode =
        (!workspaceTrusted && !includeUntrustedSkills) || isSafeModeEnv();
      let extensions: Extension[] = [];
      const extensionSkillStates = new Map<Extension, Map<string, boolean>>();
      if (workspaceTrusted && !safeMode) {
        const lstatOrUndefined = (target: string) =>
          fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
        // Construction is pure path computation; only the store-backed read
        // below materializes directories. A read-only status probe must not
        // create state: take the store-backed path only when state already
        // exists, because a store that has to be created cannot hold
        // activation preferences yet. A fresh home with a managed root is
        // answered by a store-free managed discovery with manifest defaults
        // — which also keeps working when the home cannot be written at all.
        const extensionStore = new ExtensionStore();
        const entry = await lstatOrUndefined(extensionStore.extensionsDir);
        const storeEntry = entry
          ? undefined
          : await lstatOrUndefined(extensionStore.storeDir);
        if (entry || storeEntry || managedExtensionsDir) {
          const extensionManager = new ExtensionManager({
            managedExtensionsDir,
            extensionStore,
            workspaceDir: workspaceCwd,
            isWorkspaceTrusted: workspaceTrusted,
            locale,
          });
          const defaultSkillStates = (extension: Extension) => {
            const states = new Map<string, boolean>();
            for (const skill of extension.skills ?? []) {
              const name = skill.name.trim().toLowerCase();
              const defaults = extension.config.skillStates;
              states.set(
                name,
                defaults && Object.hasOwn(defaults, name)
                  ? defaults[name]!
                  : true,
              );
            }
            return states;
          };
          const applySnapshotOverrides = (snapshot: ExtensionStoreSnapshot) => {
            for (const extension of extensions) {
              const states = defaultSkillStates(extension);
              for (const name of [...states.keys()]) {
                states.set(
                  name,
                  extensionStore.getSkillWorkspaceOverride(
                    snapshot,
                    extension.id,
                    workspaceCwd,
                    name,
                  ) ?? states.get(name)!,
                );
              }
              extensionSkillStates.set(extension, states);
            }
          };
          let storeRead = false;
          if (entry) {
            // State exists: a read failure must not fall back to manifest
            // defaults, which would report a managed package the user
            // disabled as active — the error propagates to the outer catch.
            await fs.readdir(extensionStore.extensionsDir);
            // createDataDir: false — a read-only status probe must not
            // create plugin data directories for agent-plugins packages.
            const snapshot = await extensionManager.refreshCacheWithSnapshot({
              createDataDir: false,
            });
            extensions = extensionManager.getLoadedExtensions();
            applySnapshotOverrides(snapshot);
            storeRead = true;
          } else if (storeEntry) {
            // A store without an extensions dir can hold managed activation
            // state, but no user packages. Read the snapshot without the
            // store lock: acquiring it materializes the store directories, a
            // write this probe must not perform (and cannot, on a read-only
            // home). A corrupt store still fails closed out of peekSnapshot.
            const snapshot = await extensionStore.peekSnapshot();
            if (snapshot) {
              if (managedExtensionsDir) {
                extensions = await extensionManager.loadManagedExtensions(
                  workspaceCwd,
                  { createDataDir: false },
                );
                for (const extension of extensions) {
                  extension.isActive =
                    extensionStore.getActivation(
                      snapshot,
                      extension.id,
                      extension.name,
                      workspaceCwd,
                    ).effective === 'enabled';
                }
              }
              applySnapshotOverrides(snapshot);
              storeRead = true;
            }
          }
          if (!storeRead) {
            // Fresh home: neither the user extensions dir nor the store
            // exists, so no activation preferences can exist, and a
            // store-free managed discovery with manifest defaults gives the
            // same answer — and performs no write. createDataDir: false
            // keeps the probe read-only even for agent-plugins-format
            // managed packages.
            if (managedExtensionsDir) {
              extensions = await extensionManager.loadManagedExtensions(
                workspaceCwd,
                { createDataDir: false },
              );
            }
            for (const extension of extensions) {
              extensionSkillStates.set(
                extension,
                defaultSkillStates(extension),
              );
            }
          }
        }
      }
      const shim: SkillManagerConfigShim = {
        // Honor the safe-mode env the same way `Config` does when no explicit
        // flag is passed, so an operator running in safe mode gets the same
        // bundled-only listing the child would produce.
        isSafeMode: () => safeMode,
        // Bare mode is the interactive `--bare` CLI flag; the daemon never runs
        // bare, so it is always off here.
        getBareMode: () => false,
        getProjectRoot: () => workspaceCwd,
        getActiveExtensions: () => extensions.filter((e) => e.isActive),
        getDisabledSkillLevels: () => disabledLevels,
      };
      const skillManager = new SkillManager(shim as Config);
      if (!safeMode) {
        for (const level of ['project', 'user'] as const) {
          if (disabledLevels.has(level)) continue;
          for (const directory of skillManager.getSkillsBaseDirs(level)) {
            try {
              await fs.readdir(directory);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
            }
          }
        }
      }
      cached = { skillManager, extensions, extensionSkillStates };
      managers.set(workspaceCwd, cached);
    }
    const { disablements, enabledNames } = resolveSkillSettings(settings);
    const { skillManager, extensions, extensionSkillStates } = cached;
    const skills = await skillManager.listSkills();
    const statuses = skills.map((skill) => {
      const extension =
        skill.level === 'extension'
          ? extensions.find((e) => e.name === skill.extensionName)
          : undefined;
      const enabled = extension
        ? extensionSkillStates
            .get(extension)
            ?.get(authoredSkillName(skill).trim().toLowerCase())
        : undefined;
      // Preserve missing display names; the helper otherwise falls back to the name.
      const localizedSkill =
        extension?.displayName !== undefined
          ? {
              ...skill,
              extensionDisplayName: getExtensionDisplayName(extension, locale),
            }
          : skill;
      return mapSkillConfigToStatus(localizedSkill, disablements, {
        enabled:
          enabledNames.has(skill.name.trim().toLowerCase()) ||
          enabled !== false,
      });
    });
    for (const extension of extensions) {
      if (extension.isActive) continue;
      const seenNames = new Set<string>();
      for (const skill of extension.skills ?? []) {
        if (seenNames.has(skill.name)) continue;
        seenNames.add(skill.name);
        statuses.push(
          mapSkillConfigToStatus(
            {
              ...skill,
              name: qualifySkillName(extension.name, skill.name),
              authoredName: skill.name,
              level: 'extension',
              extensionName: extension.name,
              extensionDisplayName:
                extension.displayName === undefined
                  ? undefined
                  : getExtensionDisplayName(extension, locale),
            },
            disablements,
            { disabled: true },
          ),
        );
      }
    }
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: true,
      skills: statuses.sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderrLine(
      `qwen serve: daemon-local skills enumeration failed for ${workspaceCwd}: ${message}`,
    );
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: false,
      skills: [],
      errors: [
        {
          kind: 'skills',
          status: 'error',
          error: message,
        },
      ],
    };
  }
}
