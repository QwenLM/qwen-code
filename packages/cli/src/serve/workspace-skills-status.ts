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
  SkillManager,
  Storage,
  isSafeModeEnv,
} from '@qwen-code/qwen-code-core';
import type { Config, SkillLevel } from '@qwen-code/qwen-code-core';
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
  extensionManager?: ExtensionManager;
  locale: string;
}

/**
 * Fails closed on an unreadable directory while tolerating one that does not
 * exist. `lstat` decides absence and `readdir` decides readability: a
 * dangling symlink lstat()s fine but readdir()s `ENOENT`, and a
 * present-but-unlistable root must fail closed rather than read as absent
 * (`fs.stat` cannot separate the two — it follows the link and throws the
 * same `ENOENT`). The store loader swallows listing errors, so without this
 * probe an unlistable root would silently yield a catalog missing its
 * entries.
 */
async function assertReadableDir(directory: string): Promise<void> {
  try {
    await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await fs.readdir(directory);
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
  // Per-workspace invalidation epochs, bumped synchronously by `invalidate`.
  // A cold build captures the epoch before its first await and installs only
  // while it is unchanged, so an invalidation delivered mid-build cannot be
  // undone by that build's own `managers.set`.
  const epochs = new Map<string, number>();
  const inFlight = new Map<
    string,
    { epoch: number; promise: Promise<ServeWorkspaceSkillsStatus> }
  >();
  const provider = ((workspaceCwd: string) => {
    // Coalesce concurrent cold builds of one workspace; a caller arriving
    // after an invalidation (newer epoch) starts a fresh build instead of
    // joining a pre-mutation one.
    const epoch = epochs.get(workspaceCwd) ?? 0;
    const pending = inFlight.get(workspaceCwd);
    if (pending?.epoch === epoch) return pending.promise;
    const promise = buildWorkspaceSkillsStatus(
      workspaceCwd,
      managers,
      epochs,
      epoch,
      options.workspaceTrusted ?? true,
      options.includeUntrustedSkills ?? false,
    );
    inFlight.set(workspaceCwd, { epoch, promise });
    const clear = () => {
      if (inFlight.get(workspaceCwd)?.promise === promise) {
        inFlight.delete(workspaceCwd);
      }
    };
    void promise.then(clear, clear);
    return promise;
  }) as WorkspaceSkillsStatusProvider;
  provider.invalidate = (workspaceCwd) => {
    managers.delete(workspaceCwd);
    epochs.set(workspaceCwd, (epochs.get(workspaceCwd) ?? 0) + 1);
  };
  return provider;
}

async function buildWorkspaceSkillsStatus(
  workspaceCwd: string,
  managers: Map<string, WorkspaceSkillManagers>,
  epochs: Map<string, number>,
  epoch: number,
  workspaceTrusted: boolean,
  includeUntrustedSkills: boolean,
): Promise<ServeWorkspaceSkillsStatus> {
  try {
    const settings = loadSettings(workspaceCwd, {
      consumeCorruptionEnvVars: false,
      skipLoadEnvironment: true,
      skipWorkspaceSettings: !workspaceTrusted,
      workspaceTrusted,
    });
    // Resolve the extension locale from this call's settings: a language
    // change reaches no invalidation point, so the locale is part of the
    // cache key. Settings carry no value validation, so guard the raw value —
    // a non-string `general.language` would otherwise throw inside locale
    // resolution and fail the whole catalog.
    const rawLanguage = settings.merged.general?.language;
    const locale = resolveLanguage(
      resolveLanguageSetting(
        typeof rawLanguage === 'string' ? rawLanguage : undefined,
      ),
    );
    let cached = managers.get(workspaceCwd);
    if (cached && cached.locale !== locale) {
      managers.delete(workspaceCwd);
      cached = undefined;
    }
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
      let extensionManager: ExtensionManager | undefined;
      // A failed extension load is served without extension Skills but not
      // cached, so the next call retries enumeration.
      let extensionLoadFailed = false;
      if (workspaceTrusted && !safeMode) {
        // A workspace that disabled extension discovery opted out of the
        // catalog-fatal tier: for it an unreadable root degrades like any
        // other load fault instead of failing the whole catalog.
        const extensionLevelDisabled = disabledLevels.has('extension');
        // The store loader swallows listing errors, so without the root
        // probe an unlistable root would silently yield a catalog missing
        // every extension Skill. Only the probe is catalog-fatal (and only
        // while discovery is enabled); a fault inside the load itself
        // degrades the extension entries either way.
        let rootProbed = false;
        try {
          await assertReadableDir(Storage.getUserExtensionsDir());
          rootProbed = true;
          extensionManager = new ExtensionManager({
            workspaceDir: workspaceCwd,
            isWorkspaceTrusted: workspaceTrusted,
            locale,
          });
          await extensionManager.refreshCache();
        } catch (error) {
          if (!rootProbed && !extensionLevelDisabled) throw error;
          extensionLoadFailed = true;
          extensionManager = undefined;
          writeStderrLine(
            `qwen serve: extension skill enumeration skipped for ${workspaceCwd}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
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
        // SkillManager applies the disabled-level gate itself (through
        // getDisabledSkillLevels) before ever calling this; inactive-extension
        // management entries are appended regardless, matching the child
        // producer.
        getActiveExtensions: () =>
          extensionManager?.getLoadedExtensions().filter((e) => e.isActive) ??
          [],
        getDisabledSkillLevels: () => disabledLevels,
      };
      const skillManager = new SkillManager(shim as Config);
      if (!safeMode) {
        for (const level of ['project', 'user'] as const) {
          if (disabledLevels.has(level)) continue;
          for (const directory of skillManager.getSkillsBaseDirs(level)) {
            await assertReadableDir(directory);
          }
        }
      }
      cached = { skillManager, extensionManager, locale };
      if (!extensionLoadFailed && (epochs.get(workspaceCwd) ?? 0) === epoch) {
        managers.set(workspaceCwd, cached);
      }
    }
    // Settings re-load on every call, while the extension store snapshot
    // stays frozen in the cached manager until invalidation — the two
    // freshness clocks are deliberate for this best-effort fallback.
    const { disablements, enabledNames } = resolveSkillSettings(settings);
    const { skillManager, extensionManager } = cached;
    const extensions = extensionManager?.getLoadedExtensions() ?? [];
    const skills = await skillManager.listSkills();
    const statuses = skills.map((skill) => {
      const extension =
        skill.level === 'extension'
          ? extensions.find((e) => e.name === skill.extensionName)
          : undefined;
      const state =
        extensionManager && extension
          ? extensionManager.getExtensionSkillState(extension.id, skill.name)
          : undefined;
      return mapSkillConfigToStatus(skill, disablements, {
        enabled:
          !state ||
          enabledNames.has(skill.name.trim().toLowerCase()) ||
          (state.workspaceEnabled ?? state.defaultEnabled),
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
              level: 'extension',
              extensionName: extension.name,
              extensionDisplayName: extension.displayName,
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
