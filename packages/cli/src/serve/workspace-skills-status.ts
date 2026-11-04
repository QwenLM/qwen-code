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

import { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';
import { ExtensionStore } from '@qwen-code/qwen-code-core/extension/extension-store.js';
import {
  SkillManager,
  watcherIgnored,
  WATCHER_MAX_DEPTH,
} from '@qwen-code/qwen-code-core/skills/skill-manager.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { isSafeModeEnv } from '@qwen-code/qwen-code-core/utils/safe-mode.js';
import { closeFileWatcher } from '@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js';
import { getExtensionDisplayName } from '@qwen-code/qwen-code-core/extension/i18n.js';
import {
  authoredSkillName,
  qualifySkillName,
} from '@qwen-code/qwen-code-core/skills/types.js';
import type { Config, Extension, SkillLevel } from '@qwen-code/qwen-code-core';
import type { ServeWorkspaceSkillsStatus } from '@qwen-code/acp-bridge/status';
import { STATUS_SCHEMA_VERSION } from '@qwen-code/acp-bridge/status';
import * as fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import { loadSettings } from '../config/settings.js';
import { resolveLanguage, resolveLanguageSetting } from '../i18n/index.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { mapSkillConfigToStatus } from '../runtime/workspace-skills-mapping.js';
import { resolveSkillSettings } from '../config/skill-settings.js';
import {
  WORKSPACE_SKILLS_REVALIDATE_INTERVAL_MS,
  WORKSPACE_SKILLS_REVALIDATE_TIMEOUT_MS,
} from './workspace-skills-refresh-policy.js';

export interface WorkspaceSkillsStatusProvider {
  (workspaceCwd: string): Promise<ServeWorkspaceSkillsStatus>;
  invalidate?(workspaceCwd: string): void;
  dispose?(): Promise<void>;
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
  /** Enable independent automatic discovery for the configuration catalog. */
  autoDiscover?: boolean;
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
  | 'isSkillEnabled'
>;

interface WorkspaceSkillManagers {
  skillManager: SkillManager;
  extensionManager?: ExtensionManager;
  extensionSkillStates: Map<Extension, Map<string, boolean>>;
  watchDirectories: string[];
}

interface SkillsDiscoveryState {
  safeMode: boolean;
  startedAt: number;
  sequence: number;
  publishedSequence: number;
  activeScans: number;
  dirty: boolean;
  directories: Set<string>;
  debounce?: NodeJS.Timeout;
  pending?: { timeout: NodeJS.Timeout };
}

export function createWorkspaceSkillsStatusProvider(
  options: WorkspaceSkillsStatusProviderOptions = {},
): WorkspaceSkillsStatusProvider & {
  snapshot(workspaceCwd: string): Promise<WorkspaceSkillsSnapshot>;
} {
  // Warm reads reuse a committed manager while discovery builds its replacement
  // separately. Runtime fallback callers keep explicit invalidation semantics.
  const managers = new Map<string, WorkspaceSkillManagers>();
  // An enumeration that overlaps an invalidation captured pre-invalidation
  // settings, so it must not install its managers; the next read rebuilds.
  const epochs = new Map<string, number>();
  const inFlight = new Map<string, Promise<ServeWorkspaceSkillsStatus>>();
  const discovery = new Map<string, SkillsDiscoveryState>();
  const watchers = new Map<
    string,
    { watcher: FSWatcher; workspaces: Set<string> }
  >();
  const closing = new Set<Promise<void>>();
  const watcherRetryAfter = new Map<string, number>();
  let disposed = false;

  function closeWatcher(directory: string): void {
    const subscription = watchers.get(directory);
    if (!subscription) return;
    watchers.delete(directory);
    const pending = closeFileWatcher(subscription.watcher)
      .catch((error: unknown) => {
        writeStderrLine(
          `qwen serve: Skills watcher close failed: ${String(error)}`,
        );
      })
      .finally(() => closing.delete(pending));
    closing.add(pending);
  }

  function releaseDirectories(
    workspaceCwd: string,
    state: SkillsDiscoveryState,
  ) {
    for (const directory of state.directories) {
      const subscription = watchers.get(directory);
      subscription?.workspaces.delete(workspaceCwd);
      if (subscription?.workspaces.size === 0) closeWatcher(directory);
    }
    state.directories.clear();
  }

  function scheduleChange(workspaceCwd: string, state: SkillsDiscoveryState) {
    if (disposed || discovery.get(workspaceCwd) !== state) return;
    state.dirty = true;
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => {
      state.debounce = undefined;
      refresh(workspaceCwd, state);
    }, 150);
    state.debounce.unref();
  }

  function subscribe(workspaceCwd: string, state: SkillsDiscoveryState) {
    const cached = managers.get(workspaceCwd);
    if (!cached || disposed || discovery.get(workspaceCwd) !== state) return;
    const directories = new Set(cached.watchDirectories);
    for (const directory of state.directories) {
      if (directories.has(directory)) continue;
      const subscription = watchers.get(directory);
      subscription?.workspaces.delete(workspaceCwd);
      if (subscription?.workspaces.size === 0) closeWatcher(directory);
    }
    state.directories = directories;
    for (const directory of directories) {
      const existing = watchers.get(directory);
      if (existing) {
        existing.workspaces.add(workspaceCwd);
        continue;
      }
      if (Date.now() < (watcherRetryAfter.get(directory) ?? 0)) continue;
      try {
        const workspaces = new Set([workspaceCwd]);
        const watcher = watch(directory, {
          ignoreInitial: true,
          ignored: watcherIgnored,
          depth: WATCHER_MAX_DEPTH,
        });
        watchers.set(directory, { watcher, workspaces });
        watcherRetryAfter.delete(directory);
        watcher.on('all', () => {
          for (const cwd of workspaces) {
            const current = discovery.get(cwd);
            if (current) scheduleChange(cwd, current);
          }
        });
        watcher.on('error', (error: unknown) => {
          if (watchers.get(directory)?.watcher !== watcher) return;
          watcherRetryAfter.set(directory, Date.now() + 30_000);
          writeStderrLine(
            `qwen serve: Skills watcher failed: ${String(error)}`,
          );
          if (watchers.get(directory)?.watcher === watcher)
            closeWatcher(directory);
        });
      } catch (error) {
        watcherRetryAfter.set(directory, Date.now() + 30_000);
        writeStderrLine(`qwen serve: Skills watcher failed: ${String(error)}`);
      }
    }
  }

  function refresh(workspaceCwd: string, state: SkillsDiscoveryState): void {
    if (
      disposed ||
      discovery.get(workspaceCwd) !== state ||
      state.pending ||
      state.activeScans >= 2
    )
      return;
    state.activeScans++;
    state.dirty = false;
    state.startedAt = Date.now();
    const sequence = ++state.sequence;
    const freshManagers = new Map<string, WorkspaceSkillManagers>();
    const release = () => {
      clearTimeout(pending.timeout);
      if (state.pending === pending) state.pending = undefined;
      if (!state.pending && state.dirty && state.activeScans < 2)
        scheduleChange(workspaceCwd, state);
    };
    const pending = {
      timeout: setTimeout(release, WORKSPACE_SKILLS_REVALIDATE_TIMEOUT_MS),
    };
    pending.timeout.unref();
    state.pending = pending;
    void buildWorkspaceSkillsStatus(
      workspaceCwd,
      freshManagers,
      options.workspaceTrusted ?? true,
      options.includeUntrustedSkills ?? false,
    )
      .then((status) => {
        const candidate = freshManagers.get(workspaceCwd);
        if (
          !status.initialized ||
          status.errors?.length ||
          !candidate ||
          candidate.skillManager.hasDiscoveryReadErrors()
        )
          return;
        // A timeout releases the slot, not publication rights. A valid slow
        // scan can still publish, but cannot overwrite a newer successful one.
        if (
          disposed ||
          discovery.get(workspaceCwd) !== state ||
          state.safeMode !== isSafeModeEnv() ||
          sequence <= state.publishedSequence
        )
          return;
        state.publishedSequence = sequence;
        managers.set(workspaceCwd, candidate);
        subscribe(workspaceCwd, state);
      })
      .catch((error: unknown) => {
        writeStderrLine(
          `qwen serve: Skills revalidation failed: ${String(error)}`,
        );
      })
      .finally(() => {
        state.activeScans--;
        release();
      });
  }

  const provider = ((workspaceCwd: string) => {
    if (disposed) {
      return Promise.resolve({
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: false,
        skills: [],
      } satisfies ServeWorkspaceSkillsStatus);
    }
    let state = discovery.get(workspaceCwd);
    if (state && state.safeMode !== isSafeModeEnv()) {
      provider.invalidate?.(workspaceCwd);
      state = undefined;
    }
    if (options.autoDiscover && !state) {
      state = {
        safeMode: isSafeModeEnv(),
        startedAt: Date.now(),
        sequence: 0,
        publishedSequence: 0,
        activeScans: 0,
        dirty: false,
        directories: new Set(),
      };
      discovery.set(workspaceCwd, state);
    }
    const pending = inFlight.get(workspaceCwd);
    if (pending) return pending;
    const epoch = epochs.get(workspaceCwd) ?? 0;
    const current = () =>
      !disposed && (epochs.get(workspaceCwd) ?? 0) === epoch;
    if (state && managers.has(workspaceCwd)) {
      const elapsed = Date.now() - state.startedAt;
      if (elapsed < 0 || elapsed >= WORKSPACE_SKILLS_REVALIDATE_INTERVAL_MS) {
        refresh(workspaceCwd, state);
      }
    }
    const promise = buildWorkspaceSkillsStatus(
      workspaceCwd,
      managers,
      options.workspaceTrusted ?? true,
      options.includeUntrustedSkills ?? false,
      current,
    )
      .then((status) => {
        if (state && current()) subscribe(workspaceCwd, state);
        return status;
      })
      .finally(() => {
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
    managers.delete(workspaceCwd);
    // An enumeration that started before this invalidation must not answer a
    // read issued after it; the caller needs its own observation.
    inFlight.delete(workspaceCwd);
    const state = discovery.get(workspaceCwd);
    discovery.delete(workspaceCwd);
    if (state) {
      clearTimeout(state.debounce);
      clearTimeout(state.pending?.timeout);
      releaseDirectories(workspaceCwd, state);
    }
  };
  provider.dispose = async () => {
    disposed = true;
    for (const cwd of new Set([
      ...managers.keys(),
      ...inFlight.keys(),
      ...discovery.keys(),
    ])) {
      provider.invalidate?.(cwd);
    }
    await Promise.all(closing);
    watcherRetryAfter.clear();
  };
  provider.snapshot = async (workspaceCwd) => {
    if (options.workspaceTrusted === false)
      throw new Error('Skills snapshots require a trusted Workspace.');
    const freshManagers = new Map<string, WorkspaceSkillManagers>();
    const status = await buildWorkspaceSkillsStatus(
      workspaceCwd,
      freshManagers,
      true,
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
      // Mirror loadCliConfig: safe mode turns managed auto-memory off, and the
      // daemon never runs bare.
      const managedAutoMemoryEnabled =
        !isSafeModeEnv() &&
        settings.merged.memory?.enableManagedAutoMemory !== false;
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
        // SkillManager asks only about the bundled skills that serve an
        // optional feature; the catalog applies `skills.disabled` itself.
        // `auto-memory` follows the child's managed auto-memory switch. The
        // structured recall protocol, which also hides it, needs a corpus scan
        // the daemon does not run, so the catalog lists it as legacy does.
        isSkillEnabled: (skill) =>
          !(
            skill.level === 'bundled' &&
            skill.name === 'auto-memory' &&
            !managedAutoMemoryEnabled
          ),
      };
      const skillManager = new SkillManager(shim as Config);
      const watchDirectories: string[] = [];
      if (!safeMode) {
        for (const level of ['project', 'user'] as const) {
          if (disabledLevels.has(level)) continue;
          for (const directory of skillManager.getSkillsBaseDirs(level)) {
            try {
              await fs.readdir(directory);
              if (workspaceTrusted) watchDirectories.push(directory);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
            }
          }
        }
      }
      cached = {
        skillManager,
        extensionManager,
        extensionSkillStates,
        watchDirectories,
      };
      if (!canInstall || canInstall()) managers.set(workspaceCwd, cached);
    }
    const { disablements, enabledNames } = resolveSkillSettings(settings);
    const { skillManager, extensionManager, extensionSkillStates } = cached;
    const extensions = extensionManager?.getLoadedExtensions() ?? [];
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
