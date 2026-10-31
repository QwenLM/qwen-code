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
  Storage,
  isSafeModeEnv,
  getExtensionDisplayName,
  authoredSkillName,
  qualifySkillName,
} from '@qwen-code/qwen-code-core';
import type { Config, Extension, SkillLevel } from '@qwen-code/qwen-code-core';
import type { ServeWorkspaceSkillsStatus } from '@qwen-code/acp-bridge/status';
import { STATUS_SCHEMA_VERSION } from '@qwen-code/acp-bridge/status';
import * as fs from 'node:fs/promises';
import { loadSettings } from '../config/settings.js';
import { resolveLanguage, resolveLanguageSetting } from '../i18n/index.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { mapSkillConfigToStatus } from '../runtime/workspace-skills-mapping.js';
import { resolveSkillSettings } from '../config/skill-settings.js';
import { WORKSPACE_SKILLS_REVALIDATE_INTERVAL_MS } from './workspace-service/index.js';

export interface WorkspaceSkillsStatusProvider {
  (workspaceCwd: string): Promise<ServeWorkspaceSkillsStatus>;
  invalidate?(workspaceCwd: string): void;
  /** Stops every file watcher this provider owns, after which it must not be called. */
  dispose?(): void;
}

export interface WorkspaceSkillsSnapshot {
  workspaceCwd: string;
  skills: Array<{
    name: string;
    description: string;
    body: string;
    model_invocable?: boolean;
    user_invocable?: boolean;
  }>;
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
 * Re-discover Skills at most this often per workspace. It is the runtime Skills
 * snapshot's interval (`workspace-service/index.ts`), so the two cannot drift:
 * file changes are applied by the `SkillManager` watchers as they happen, and
 * this interval only bounds the background revalidation that covers changes a
 * watcher could not observe (a Skills directory created after the watchers
 * started, a dropped event).
 */
export const SKILLS_REVALIDATE_INTERVAL_MS =
  WORKSPACE_SKILLS_REVALIDATE_INTERVAL_MS;

// The two levels the `SkillManager` watchers subscribe to (bundled Skills are
// immutable and extension Skills are managed by the extension system), so a
// watcher-driven revalidation rescans the same set instead of every level.
const WATCHED_SKILL_LEVELS = ['project', 'user'] as const;

/**
 * Every watcher the daemon-local catalog starts, tracked per workspace so the
 * daemon can release them on removal and shutdown no matter which provider
 * created them. Each provider starts at most one watcher set per workspace,
 * and the throwaway `snapshot()` path starts none.
 */
const watchingManagers = new Map<string, Set<SkillManager>>();

function trackWatchingManager(
  workspaceCwd: string,
  manager: SkillManager,
): void {
  let managers = watchingManagers.get(workspaceCwd);
  if (!managers) {
    managers = new Set();
    watchingManagers.set(workspaceCwd, managers);
  }
  managers.add(manager);
}

function stopWatchingManager(
  workspaceCwd: string,
  manager: SkillManager,
): void {
  watchingManagers.get(workspaceCwd)?.delete(manager);
  if (watchingManagers.get(workspaceCwd)?.size === 0) {
    watchingManagers.delete(workspaceCwd);
  }
  manager.stopWatching();
}

/** Stops the catalog watchers for a workspace that is no longer served. */
export function disposeWorkspaceSkillsWatchers(workspaceCwd: string): void {
  const managers = watchingManagers.get(workspaceCwd);
  if (!managers) return;
  watchingManagers.delete(workspaceCwd);
  for (const manager of managers) {
    manager.stopWatching();
  }
}

/** Stops every catalog watcher created by any provider, for daemon shutdown. */
export function disposeAllSkillsWatchers(): void {
  for (const workspaceCwd of [...watchingManagers.keys()]) {
    disposeWorkspaceSkillsWatchers(workspaceCwd);
  }
}

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
  extensionSkillStates: Map<Extension, Map<string, boolean>>;
  /** When the last background revalidation started; throttles it per workspace. */
  revalidatedAt: number;
  /** In-flight background revalidation shared by concurrent readers. */
  refreshing?: Promise<void>;
}

export function createWorkspaceSkillsStatusProvider(
  options: WorkspaceSkillsStatusProviderOptions = {},
): WorkspaceSkillsStatusProvider & {
  snapshot(workspaceCwd: string): Promise<WorkspaceSkillsSnapshot>;
} {
  // Reuse one SkillManager per workspace so repeat queries hit its in-memory
  // skills cache instead of re-scanning (and re-parsing frontmatter / compiling
  // globs for) every level on each call. Its file watchers apply Skill changes
  // made directly on disk, so reads stay cache-backed like the runtime Skills
  // endpoint; the background revalidation below only covers changes the
  // watchers could not observe. The live child still re-lists authoritatively
  // once a session exists.
  const managers = new Map<string, WorkspaceSkillManagers>();
  // An enumeration that overlaps an invalidation captured pre-invalidation
  // settings, so it must not install its managers; the next read rebuilds.
  const epochs = new Map<string, number>();
  const inFlight = new Map<string, Promise<ServeWorkspaceSkillsStatus>>();
  const provider = ((workspaceCwd: string) => {
    const pending = inFlight.get(workspaceCwd);
    if (pending) return pending;
    const epoch = epochs.get(workspaceCwd) ?? 0;
    const promise = buildWorkspaceSkillsStatus(
      workspaceCwd,
      managers,
      options.workspaceTrusted ?? true,
      options.includeUntrustedSkills ?? false,
      () => (epochs.get(workspaceCwd) ?? 0) === epoch,
      true,
    ).finally(() => {
      if (inFlight.get(workspaceCwd) === promise) {
        inFlight.delete(workspaceCwd);
      }
    });
    inFlight.set(workspaceCwd, promise);
    return promise;
  }) as WorkspaceSkillsStatusProvider & {
    snapshot(workspaceCwd: string): Promise<WorkspaceSkillsSnapshot>;
  };
  provider.invalidate = (workspaceCwd) => {
    epochs.set(workspaceCwd, (epochs.get(workspaceCwd) ?? 0) + 1);
    const cached = managers.get(workspaceCwd);
    if (cached) stopWatchingManager(workspaceCwd, cached.skillManager);
    managers.delete(workspaceCwd);
    // An enumeration that started before this invalidation must not answer a
    // read issued after it; the caller needs its own observation.
    inFlight.delete(workspaceCwd);
  };
  provider.dispose = () => {
    for (const workspaceCwd of [...managers.keys()]) {
      provider.invalidate?.(workspaceCwd);
    }
  };
  provider.snapshot = async (workspaceCwd) => {
    if (options.workspaceTrusted === false)
      throw new Error('Skills snapshots require a trusted Workspace.');
    const freshManagers = new Map<string, WorkspaceSkillManagers>();
    // A throwaway enumeration must not leave watchers behind, so it never
    // starts them.
    const status = await buildWorkspaceSkillsStatus(
      workspaceCwd,
      freshManagers,
      true,
      false,
      undefined,
      false,
    );
    const manager = freshManagers.get(workspaceCwd)?.skillManager;
    if (
      !status.initialized ||
      status.errors?.length ||
      !manager ||
      manager.hasDiscoveryErrors()
    )
      throw new Error('The enabled Skills could not be completely discovered.');
    const configured = new Map(
      manager.getCachedSkills()!.map((skill) => [skill.name, skill]),
    );
    const skills = status.skills
      .filter((skill) => skill.status === 'ok')
      .map((entry) => {
        const skill = configured.get(entry.name);
        if (!skill)
          throw new Error('An enabled Skill is missing its instructions.');
        return {
          name: entry.name,
          description: entry.description,
          body: skill.body,
          ...(entry.modelInvocable ? {} : { model_invocable: false }),
          ...(entry.userInvocable === false ? { user_invocable: false } : {}),
        };
      });
    if (
      skills.length > 256 ||
      skills.some(
        (skill) => Buffer.byteLength(skill.body, 'utf8') > 512 * 1024,
      ) ||
      Buffer.byteLength(JSON.stringify(skills), 'utf8') > 2 * 1024 * 1024
    )
      throw new Error(
        'Enabled Skills exceed the 256-item, 512-KiB/body or 2-MiB catalog limit.',
      );
    return { workspaceCwd, skills };
  };
  return provider;
}

async function buildWorkspaceSkillsStatus(
  workspaceCwd: string,
  managers: Map<string, WorkspaceSkillManagers>,
  workspaceTrusted: boolean,
  includeUntrustedSkills: boolean,
  canInstall?: () => boolean,
  watch = true,
): Promise<ServeWorkspaceSkillsStatus> {
  try {
    const settings = loadSettings(workspaceCwd, {
      consumeCorruptionEnvVars: false,
      skipLoadEnvironment: true,
      skipWorkspaceSettings: !workspaceTrusted,
      workspaceTrusted,
    });
    const safeMode =
      (!workspaceTrusted && !includeUntrustedSkills) || isSafeModeEnv();
    // Only a trusted, non-safe catalog watches the workspace: an untrusted or
    // safe-mode read lists bundled Skills only, so a subscription (and the user
    // Skills directory `startWatching` creates) would be a side effect with
    // nothing to observe.
    const watchEnabled = watch && workspaceTrusted && !safeMode;
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
      let extensionManager: ExtensionManager | undefined;
      const extensionSkillStates = new Map<Extension, Map<string, boolean>>();
      if (workspaceTrusted && !safeMode) {
        const directory = Storage.getUserExtensionsDir();
        const entry = await fs
          .lstat(directory)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
        if (entry) {
          await fs.readdir(directory);
          const extensionStore = new ExtensionStore();
          extensionManager = new ExtensionManager({
            extensionStore,
            workspaceDir: workspaceCwd,
            isWorkspaceTrusted: workspaceTrusted,
            locale,
          });
          const snapshot = await extensionManager.refreshCacheWithSnapshot();
          for (const extension of extensionManager.getLoadedExtensions()) {
            const states = new Map<string, boolean>();
            for (const skill of extension.skills ?? []) {
              const name = skill.name.trim().toLowerCase();
              const defaults = extension.config.skillStates;
              const defaultEnabled =
                defaults && Object.hasOwn(defaults, name)
                  ? defaults[name]!
                  : true;
              states.set(
                name,
                extensionStore.getSkillWorkspaceOverride(
                  snapshot,
                  extension.id,
                  workspaceCwd,
                  name,
                ) ?? defaultEnabled,
              );
            }
            extensionSkillStates.set(extension, states);
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
      const watching = watchEnabled
        ? await startSkillsWatcher(workspaceCwd, skillManager)
        : false;
      cached = {
        skillManager,
        extensionManager,
        extensionSkillStates,
        revalidatedAt: Date.now(),
      };
      if (!canInstall || canInstall()) {
        managers.set(workspaceCwd, cached);
      } else if (watching) {
        stopWatchingManager(workspaceCwd, skillManager);
      }
    }
    const { disablements, enabledNames } = resolveSkillSettings(settings);
    const { skillManager, extensionManager, extensionSkillStates } = cached;
    // A workspace removal stops the watchers but keeps this provider alive, so
    // the next read over the retained manager must re-subscribe. A manager this
    // read built and did not install never gets here: nothing will read it, and
    // a subscription for it would outlive its catalog.
    if (
      watchEnabled &&
      managers.get(workspaceCwd) === cached &&
      !skillManager.hasActiveWatcher()
    ) {
      await startSkillsWatcher(workspaceCwd, skillManager);
    }
    const extensions = extensionManager?.getLoadedExtensions() ?? [];
    if (watch && managers.get(workspaceCwd) === cached) {
      scheduleSkillsRevalidation(workspaceCwd, cached, managers);
    }
    const skills = await skillManager.listSkills({});
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

/**
 * Starts the same directory discovery the runtime `SkillManager` uses, so a
 * Skill created, edited, or removed on disk refreshes the retained cache
 * without a configuration mutation. A watcher failure is reported and leaves
 * the background revalidation as the only refresh path — it must not fail the
 * read.
 */
async function startSkillsWatcher(
  workspaceCwd: string,
  manager: SkillManager,
): Promise<boolean> {
  try {
    await manager.startWatching();
    if (!manager.hasActiveWatcher()) {
      // chokidar can report an attach failure after `startWatching()` resolves;
      // recording that as a live watcher would leave the failure invisible.
      writeStderrLine(
        `qwen serve: daemon-local Skills watcher failed for ${workspaceCwd}: no directory attached`,
      );
      return false;
    }
    trackWatchingManager(workspaceCwd, manager);
    return true;
  } catch (error) {
    manager.stopWatching();
    writeStderrLine(
      `qwen serve: daemon-local Skills watcher failed for ${workspaceCwd}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Covers the changes the watchers cannot observe — a Skills directory created
 * after they started, or a dropped event — by re-running discovery at most once
 * per interval. This is a bounded forced rescan over the watched levels,
 * independent of watcher health, so it also covers a watcher that never
 * attached. The read never waits for it: the retained cache answers, so the
 * catalog stays bounded to the runtime endpoint's freshness policy instead of
 * blocking a request on a full scan.
 */
function scheduleSkillsRevalidation(
  workspaceCwd: string,
  cached: WorkspaceSkillManagers,
  managers: Map<string, WorkspaceSkillManagers>,
): void {
  if (cached.refreshing) return;
  const elapsed = Date.now() - cached.revalidatedAt;
  // A backwards clock step makes `elapsed` negative; treating that as fresh
  // would freeze the fallback until the clock caught up.
  if (elapsed >= 0 && elapsed < SKILLS_REVALIDATE_INTERVAL_MS) return;
  if (managers.get(workspaceCwd) !== cached) return;
  cached.revalidatedAt = Date.now();
  cached.refreshing = cached.skillManager
    .refreshCache({ levels: WATCHED_SKILL_LEVELS })
    .then(
      () => undefined,
      (error: unknown) => {
        writeStderrLine(
          `qwen serve: daemon-local Skills revalidation failed for ${workspaceCwd}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    )
    .finally(() => {
      cached.refreshing = undefined;
    });
}
