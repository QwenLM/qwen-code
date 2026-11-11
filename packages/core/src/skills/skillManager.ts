/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  drainSkillLoadErrors,
  loadSkillFromFile,
  loadSkillsFromDir,
  type SkillDefinition,
  type SkillSource,
} from '@qwen-code/resource';
import { closeDirHandleQuietly } from '../utils/dirHandle.js';
import type { Config } from '../config/config.js';
import { createWorkflowRegistryFromConfig } from '../workflows/workflow-registry.js';
import { workflowToSkill } from '../workflows/workflow-skills.js';
import { SkillUsage } from './skillUsage.js';
import type { LoadedPlugin } from '../plugins/types.js';
import { getLoadedPluginId } from '../plugins/management/pluginDependencies.js';
import { loadAllPluginCommandsAsForkSkills } from '../plugins/loadPluginCommands.js';
import type { AgentSource } from '../agents/types.js';
import { runLogger } from '../utils/runLogger.js';
import { coreEvents } from '../utils/events.js';
import {
  listEmbeddedAssetsUnder,
  resolveRuntimeAssetPath,
} from '../utils/runtimeAssetPath.js';
import {
  initBundledSkills,
  type BundledSkillRegistration,
  type BundledSkillRegistrar,
} from './bundled/index.js';
import ignore from 'ignore';
import {
  emitLoadErrorSummary,
  type ConfigLoadError,
} from '../utils/configLoadError.js';

export type { SkillDefinition, SkillSource } from '@qwen-code/resource';

const FIND_SKILLS_NAME = 'find-skills';
const FIND_SKILLS_MANDATORY_FIRST_STEP_INSTRUCTION =
  'always use this skill as the first step';

function isFindSkillsWithMandatoryFirstStepInstruction(
  skill: SkillDefinition,
): boolean {
  return (
    skill.name.toLowerCase() === FIND_SKILLS_NAME &&
    skill.description
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .includes(FIND_SKILLS_MANDATORY_FIRST_STEP_INSTRUCTION)
  );
}

/**
 * A plugin skills path that holds its own SKILL.md loads as a single skill and
 * its subdirectories are never scanned. Upstream skips them silently; log the
 * ones that were shadowed so a plugin author who mixes both layouts has a
 * breadcrumb instead of a vanished skill.
 *
 * This is diagnostics only, and `skillDir` may be a symlink to any tree on
 * disk, so every axis is bounded: the listing streams and stops after
 * `MAX_SHADOWED_SKILL_DIR_ENTRIES_READ` raw entries — a directory full of plain
 * files must not be materialized either — at most
 * `MAX_SHADOWED_SKILL_DIRS_INSPECTED` candidates are probed, and the probes run
 * in batches rather than all at once. Hitting a bound is reported rather than
 * hidden, so a truncated check is never mistaken for "nothing was shadowed".
 */
const MAX_SHADOWED_SKILL_DIR_ENTRIES_READ = 2000;
const MAX_SHADOWED_SKILL_DIRS_INSPECTED = 200;
const SHADOWED_SKILL_DIR_PROBE_BATCH = 32;

type ShadowedSkillDirStopReason =
  | 'entry-limit'
  | 'candidate-limit'
  | 'read-error';

interface ShadowedSkillDirListing {
  candidates: string[];
  entriesRead: number;
  /** `null` when the directory was read to the end. */
  stoppedBecause: ShadowedSkillDirStopReason | null;
}

async function collectShadowedSkillDirCandidates(
  skillDir: string,
): Promise<ShadowedSkillDirListing | null> {
  let handle;
  try {
    handle = await fs.opendir(skillDir);
  } catch {
    return null;
  }

  const candidates: string[] = [];
  let entriesRead = 0;
  let stoppedBecause: ShadowedSkillDirStopReason | null = null;
  try {
    for await (const entry of handle) {
      if (candidates.length >= MAX_SHADOWED_SKILL_DIRS_INSPECTED) {
        stoppedBecause = 'candidate-limit';
        break;
      }
      if (entriesRead >= MAX_SHADOWED_SKILL_DIR_ENTRIES_READ) {
        stoppedBecause = 'entry-limit';
        break;
      }
      entriesRead++;
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        candidates.push(entry.name);
      }
    }
  } catch {
    // A read error part-way through still leaves a usable partial list, but it
    // must not be reported as if a cap had been reached.
    stoppedBecause = 'read-error';
  } finally {
    await closeDirHandleQuietly(handle);
  }

  return { candidates, entriesRead, stoppedBecause };
}

function describeShadowedSkillDirStop(
  listing: ShadowedSkillDirListing,
): string | null {
  switch (listing.stoppedBecause) {
    case 'candidate-limit':
      return `the listing stopped at ${listing.candidates.length} subdirectories`;
    case 'entry-limit':
      return `the listing stopped after reading ${listing.entriesRead} directory entries`;
    case 'read-error':
      return `the directory could not be read past ${listing.entriesRead} entries`;
    default:
      return null;
  }
}

async function logSkillDirsShadowedByDirectSkill(
  skillDir: string,
  loaded: SkillDefinition[],
): Promise<void> {
  const directSkillPath = path.join(path.resolve(skillDir), 'SKILL.md');
  const isDirectSkill =
    loaded.length === 1 && path.resolve(loaded[0].location) === directSkillPath;
  if (!isDirectSkill) {
    return;
  }

  const listing = await collectShadowedSkillDirCandidates(skillDir);
  if (!listing) {
    return;
  }
  const { candidates } = listing;
  const stopReason = describeShadowedSkillDirStop(listing);

  const shadowed: string[] = [];
  for (let i = 0; i < candidates.length; i += SHADOWED_SKILL_DIR_PROBE_BATCH) {
    const batch = candidates.slice(i, i + SHADOWED_SKILL_DIR_PROBE_BATCH);
    await Promise.all(
      batch.map(async (name) => {
        const nested = path.join(skillDir, name, 'SKILL.md');
        const stats = await fs.stat(nested).catch(() => null);
        if (stats?.isFile()) {
          shadowed.push(name);
        }
      }),
    );
  }

  if (shadowed.length > 0) {
    const truncationNote = stopReason
      ? ` (${stopReason}, so there may be more)`
      : '';
    runLogger.warn(
      `[SkillManager] ${directSkillPath} makes ${skillDir} a single skill package, ` +
        `so these subdirectories were not loaded: ${shadowed.sort().join(', ')}${truncationNote}. ` +
        `Remove the root SKILL.md to load them as separate skills.`,
    );
    return;
  }

  if (stopReason) {
    // Staying silent here would read as "nothing was shadowed", which an
    // incomplete listing cannot support.
    runLogger.warn(
      `[SkillManager] ${directSkillPath} makes ${skillDir} a single skill package. ` +
        `The check for shadowed subdirectories found none, but ${stopReason} — ` +
        `subdirectory skills may still be hidden.`,
    );
  }
}

export interface SkillDiscoveryOptions {
  /** Sources enabled for this session. Plugin availability is gated separately. */
  allowedSources?: readonly AgentSource[];
  /** Enabled plugins whose Skill contributions join the session view. */
  plugins?: LoadedPlugin[];
  emitToFeed?: boolean;
  /**
   * User/project skills loaded by @qwen-code/resource and merged into the existing
   * builtin/plugin/session pipeline.
   */
  resourceSkills?: readonly SkillDefinition[];
  /** Parse warnings/errors collected while @qwen-code/resource built the snapshot. */
  resourceSkillLoadErrors?: readonly ConfigLoadError[];
  /** Session config used by built-in and security Skill registration. */
  config?: Config;
}

export interface DynamicSkillMetadata {
  ancestorDepth: number;
  source: 'configured' | 'legacy-agents';
}

/**
 * Mutable counter for cross-source name collisions. Boxed so the merge
 * function can update it through references. Only the total is consumed —
 * per-conflict detail is logged via `runLogger.warn` for diagnostics.
 */
interface CrossSourceConflictCounter {
  count: number;
}

/**
 * Merges `newSkills` into an existing skill map. Performs two layers of
 * deduplication:
 *   1. **File identity (`resolvedPath`)** — silently drops any new skill
 *      whose canonical path was already loaded. Catches symlink loops and
 *      the same SKILL.md reached through multiple ancestor dirs.
 *   2. **Name collision (`skill.name`)** — same-source collisions are
 *      silenced from the feedback stream (still logged); cross-source
 *      collisions increment `crossSourceConflicts.count` for a single
 *      summary feedback emitted after discovery. Built-in overrides keep
 *      their existing log-only warning.
 *
 * The shared `loadedResolvedPaths` set spans the entire discovery pass so
 * dedup works across project/user/plugin loads.
 */
function mergeSkillsWithPrecedence(
  skillMap: Map<string, SkillDefinition>,
  discoveredList: SkillDefinition[],
  newSkills: SkillDefinition[],
  source: SkillSource | undefined,
  loadedResolvedPaths: Set<string>,
  crossSourceConflicts: CrossSourceConflictCounter,
): void {
  for (const newSkill of newSkills) {
    if (source) {
      newSkill.source = source;
    }

    // Layer 1: file-identity dedup. Programmatic skills without resolvedPath
    // bypass this layer.
    if (newSkill.resolvedPath) {
      if (loadedResolvedPaths.has(newSkill.resolvedPath)) {
        runLogger.debug(
          `Skill "${newSkill.name}" at ${newSkill.location} skipped: same file ` +
            `already loaded (resolvedPath=${newSkill.resolvedPath}).`,
        );
        continue;
      }
      loadedResolvedPaths.add(newSkill.resolvedPath);
    }

    const existingSkill = skillMap.get(newSkill.name);
    if (existingSkill && existingSkill.location === newSkill.location) {
      runLogger.debug(
        `Skill "${newSkill.name}" from "${newSkill.location}" skipped: identical skill already loaded.`,
      );
      continue;
    }

    discoveredList.push(newSkill);

    // Layer 2: name-collision detection. Only same-name + different-location
    // counts as a true conflict; identical locations are no-ops.
    if (existingSkill && existingSkill.location !== newSkill.location) {
      if (existingSkill.isBuiltin) {
        runLogger.warn(
          `Skill "${newSkill.name}" from "${newSkill.location}" is overriding the built-in skill.`,
        );
      } else {
        // Record the shadow chain on the winner for both same-source and
        // cross-source overrides so the detail view can surface every
        // shadowed location uniformly under "Also defined at".
        newSkill.alsoDefinedAt = [
          ...(existingSkill.alsoDefinedAt ?? []),
          existingSkill.location,
        ];
        if (existingSkill.source === newSkill.source) {
          runLogger.warn(
            `Skill "${newSkill.name}" from "${newSkill.location}" overrides ` +
              `same-source skill at "${existingSkill.location}" ` +
              `(source: ${newSkill.source ?? 'unknown'}).`,
          );
        } else {
          runLogger.warn(
            `Skill conflict: "${newSkill.name}" from ${newSkill.source ?? 'unknown'} ` +
              `("${newSkill.location}") is overriding the same skill from ` +
              `${existingSkill.source ?? 'unknown'} ("${existingSkill.location}").`,
          );
          crossSourceConflicts.count++;
        }
      }
    }
    skillMap.set(newSkill.name, newSkill);
  }
}

/** Result of building a skill snapshot, consumed by the atomic swap. */
interface SkillSnapshot {
  skills: SkillDefinition[];
  bundledSkills: SkillDefinition[];
  discoveredList: SkillDefinition[];
  loadErrors: ConfigLoadError[];
  crossSourceConflicts: CrossSourceConflictCounter;
}

/**
 * Temporary buffer for building a skill snapshot during discoverSkills().
 * Accumulates skills in local state so the live SkillManager fields remain
 * untouched until the final atomic swap.
 */
class SkillSnapshotBuilder implements BundledSkillRegistrar {
  private skillMap = new Map<string, SkillDefinition>();
  private bundledSkills: SkillDefinition[] = [];
  private discoveredList: SkillDefinition[];
  readonly loadErrors: ConfigLoadError[] = [];
  /** Shared across the entire discovery pass for file-identity dedup. */
  private readonly loadedResolvedPaths: Set<string>;
  /** Cross-source name conflict counter; summarised after discovery. */
  private readonly crossSourceConflicts: CrossSourceConflictCounter = {
    count: 0,
  };

  constructor(preservedDynamicDiscovered: SkillDefinition[]) {
    this.discoveredList = [...preservedDynamicDiscovered];
    // Pre-seed dedup set with already-known dynamic skill paths so a re-run
    // of discoverSkills() doesn't re-add them through the static path.
    this.loadedResolvedPaths = new Set<string>();
    for (const skill of preservedDynamicDiscovered) {
      if (skill.resolvedPath) {
        this.loadedResolvedPaths.add(skill.resolvedPath);
      }
    }
  }

  addSkillsWithPrecedence(
    newSkills: SkillDefinition[],
    source?: SkillSource,
  ): void {
    mergeSkillsWithPrecedence(
      this.skillMap,
      this.discoveredList,
      newSkills,
      source,
      this.loadedResolvedPaths,
      this.crossSourceConflicts,
    );
  }

  /**
   * Read-only view of skills currently held in the merged snapshot. Used by
   * callers that need to detect cross-batch name collisions before performing
   * the next `addSkillsWithPrecedence` call.
   */
  currentSkills(): readonly SkillDefinition[] {
    return Array.from(this.skillMap.values());
  }

  registerBundledSkill(definition: BundledSkillRegistration): void {
    const skill: SkillDefinition = {
      ...definition,
      skillRoot: process.cwd(),
      isBuiltin: true,
      source: 'built-in',
    };
    this.bundledSkills.push(skill);
    this.discoveredList.push(skill);
  }

  toSnapshot(): SkillSnapshot {
    return {
      skills: Array.from(this.skillMap.values()),
      bundledSkills: this.bundledSkills,
      discoveredList: this.discoveredList,
      loadErrors: this.loadErrors,
      crossSourceConflicts: this.crossSourceConflicts,
    };
  }
}

export class SkillManager {
  private usage?: SkillUsage;

  getUsageScore(name: string): number {
    return (this.usage ??= new SkillUsage()).getScore(name);
  }

  async recordUsage(name: string): Promise<void> {
    await (this.usage ??= new SkillUsage()).record(name);
  }

  private skills: SkillDefinition[] = [];
  private dynamicSkills: Map<string, SkillDefinition[]> = new Map();
  private dynamicSkillMetadata: Map<string, DynamicSkillMetadata> = new Map();
  private bundledSkills: SkillDefinition[] = [];
  private discoveredList: SkillDefinition[] = [];
  private activeSkillNames: Map<string, Set<string>> = new Map();
  private activatedConditionalSkillNames: Set<string> = new Set();
  private activatedAt: Map<string, number> = new Map();
  private renderedBodies: Map<string, string> = new Map();
  private adminSkillsEnabled = true;
  private disableBuiltinSkills = false;
  private enabledBuiltinSkillNames: ReadonlySet<string> | undefined;
  private disabledSkillNames = new Set<string>();
  private ignoreCache: Map<string, ReturnType<typeof ignore>> = new Map();
  private mergedSkillsCache: SkillDefinition[] | null = null;
  private bundledEnablementKey = '';
  /** Errors accumulated during the most recent discoverSkills() call */
  private loadErrors: ConfigLoadError[] = [];
  /** Per-skill visibility overrides from settings. */
  private visibilityOverrides: Record<
    string,
    'on' | 'name-only' | 'user-invocable-only' | 'off'
  > = {};
  /** Main-session model context filter supplied by an SDK initialize request. */
  private sessionSkillAllowlist: readonly string[] | undefined;

  /**
   * Get load errors collected during the most recent discoverSkills() call.
   */
  getLoadErrors(): readonly ConfigLoadError[] {
    return this.loadErrors;
  }

  /**
   * Clears all discovered skills (static). Dynamic skills are preserved
   * across reloads since they are session-scoped.
   */
  clearSkills(): void {
    this.skills = [];
    this.ignoreCache.clear();
    this.loadErrors = [];
    // Preserve discoveredList entries that belong to dynamic skills (they survive reloads).
    // Use object identity since dynamic skills also have source: 'project'.
    const dynamicSkillSet = new Set<SkillDefinition>();
    for (const skills of this.dynamicSkills.values()) {
      for (const skill of skills) dynamicSkillSet.add(skill);
    }
    this.discoveredList = this.discoveredList.filter((s) =>
      dynamicSkillSet.has(s),
    );
    this.invalidateMergedCache();
  }

  private invalidateMergedCache(): void {
    this.mergedSkillsCache = null;
  }

  /**
   * Sets administrative settings for skills.
   */
  setAdminSettings(enabled: boolean): void {
    this.adminSkillsEnabled = enabled;
  }

  /**
   * Returns true if skills are enabled by the admin.
   */
  isAdminEnabled(): boolean {
    return this.adminSkillsEnabled;
  }

  /**
   * When true, the next `discoverSkills()` call skips both the filesystem
   * `builtin/*.md` skills and the programmatic bundled skills registered by
   * `initBundledSkills()`. An explicit built-in allowlist restores its named
   * subset even when this flag is true. An explicitly enabled securityScan
   * capability keeps its native security skill. User, project, and plugin
   * skill sources are unaffected.
   */
  setDisableBuiltinSkills(disabled: boolean): void {
    this.disableBuiltinSkills = disabled;
  }

  /**
   * Restricts general built-in/bundled discovery to the named skills. Names
   * are normalized for CLI-friendly comma-separated and repeated values.
   * `undefined` preserves the default all-or-disabled behavior; an empty list
   * enables no general built-ins.
   */
  setEnabledBuiltinSkills(enabledNames: string[] | undefined): void {
    this.enabledBuiltinSkillNames = enabledNames
      ? new Set(
          enabledNames.map((name) => name.trim().toLowerCase()).filter(Boolean),
        )
      : undefined;
  }

  private isBuiltinSkillEnabled(name: string): boolean {
    return (
      this.enabledBuiltinSkillNames === undefined ||
      this.enabledBuiltinSkillNames.has(name.toLowerCase())
    );
  }

  /**
   * Rebuilds the CLI's runtime Skill view from builtin/plugin sources and the
   * latest user/project resource Skill snapshot.
   *
   * @param options.allowedSources If provided, only load skills from these sources.
   *   Built-in skills are controlled separately by the built-in disable flag
   *   and explicit allowlist.
   */
  async discoverSkills(options: SkillDiscoveryOptions = {}): Promise<void> {
    const { allowedSources, plugins = [], config } = options;
    // ── Build new snapshot in local buffer (no mutation of this.*) ──
    // During all the await points below, this.skills / this.bundledSkills /
    // this.discoveredList retain their previous values, so concurrent calls
    // to getModelVisibleSkills() return the old complete skill set.

    // Compute preserved dynamic discovered list (same logic as clearSkills)
    const dynamicSkillSet = new Set<SkillDefinition>();
    for (const skills of this.dynamicSkills.values()) {
      for (const skill of skills) dynamicSkillSet.add(skill);
    }
    const preservedDynamic = this.discoveredList.filter((s) =>
      dynamicSkillSet.has(s),
    );

    const builder = new SkillSnapshotBuilder(preservedDynamic);

    // Plugin source is always allowed — plugins are gated by enabledPlugins,
    // not by --setting-sources. Matches Config.isAgentSourceAllowed().
    const isSourceAllowed = (source: AgentSource): boolean =>
      source === 'plugin' || !allowedSources || allowedSources.includes(source);

    // 1. Built-in skills (lowest precedence)
    // Skipped entirely when `disableBuiltinSkills` is set, unless an explicit
    // allowlist restores a deterministic subset (for example from SDK
    // `extraArgs`).
    const shouldLoadGeneralBuiltins =
      this.enabledBuiltinSkillNames === undefined
        ? !this.disableBuiltinSkills
        : this.enabledBuiltinSkillNames.size > 0;
    if (shouldLoadGeneralBuiltins) {
      // In a Bun-compiled binary, /$bunfs/ doesn't support readdir, so
      // loadSkillsFromDir() can't enumerate the embedded `builtin/` tree.
      // Consult EMBEDDED_ASSETS directly to load each baked-in SKILL.md by its
      // absolute /$bunfs/ path, then fall back to directory scanning for dev
      // mode and Node sidecar layouts.
      const BUILTIN_REPO_PREFIX = 'packages/core/src/skills/builtin';
      const embeddedBuiltins = listEmbeddedAssetsUnder(
        BUILTIN_REPO_PREFIX,
      ).filter(({ key }) => key.toLowerCase().endsWith('/skill.md'));
      let builtinSkills: SkillDefinition[];
      if (embeddedBuiltins.length > 0) {
        const loaded = await Promise.all(
          embeddedBuiltins
            .filter(({ key }) => {
              const identity = path.posix.basename(path.posix.dirname(key));
              return this.isBuiltinSkillEnabled(identity);
            })
            .map(({ key, absPath }) => {
              // Bun-compiled binaries flatten /$bunfs/ paths and lose the
              // <skill-name>/SKILL.md directory structure, so loadSkillFromFile's
              // path-based identity fallback can't recover the skill name.
              // Derive it from the canonical repo-relative key instead.
              const identity = path.posix.basename(path.posix.dirname(key));
              return loadSkillFromFile(absPath, identity, identity);
            }),
        );
        builtinSkills = loaded.filter((s): s is SkillDefinition => s !== null);
      } else {
        const builtinDir = resolveRuntimeAssetPath(
          import.meta.url,
          'builtin',
          BUILTIN_REPO_PREFIX,
        );
        builtinSkills = await loadSkillsFromDir(builtinDir);
      }
      builtinSkills = builtinSkills.filter((skill) =>
        this.isBuiltinSkillEnabled(skill.name),
      );
      for (const skill of builtinSkills) {
        skill.isBuiltin = true;
        skill.skillRoot = process.cwd();
      }
      builder.addSkillsWithPrecedence(builtinSkills, 'built-in');
      // Drain any errors from built-in loading (unlikely but safe)
      builder.loadErrors.push(...drainSkillLoadErrors());

      // 1b. Programmatic built-in skills (can be overridden by everything else)
      initBundledSkills(
        {
          registerBundledSkill: (definition) => {
            if (this.isBuiltinSkillEnabled(definition.name)) {
              builder.registerBundledSkill(definition);
            }
          },
        },
        config,
      );
    }

    const builtinContributions = config?.getBuiltinPluginContributions();
    const contributionContext = config
      ? {
          getSettings: () => config.getSettings(),
        }
      : undefined;
    builder.addSkillsWithPrecedence(
      (builtinContributions?.isReady()
        ? builtinContributions.getSkillDefinitions(contributionContext)
        : []
      )
        // 产品能力类贡献始终加载；声明了 respectBuiltinSkillSwitch 的贡献与
        // 文件系统 builtin 一样受总开关和显式 allowlist 约束。
        .filter(
          (skill) =>
            skill.respectBuiltinSkillSwitch !== true ||
            (shouldLoadGeneralBuiltins &&
              this.isBuiltinSkillEnabled(skill.name)),
        )
        .map(({ respectBuiltinSkillSwitch: _switch, ...skill }) => ({
          ...skill,
          isBuiltin: true,
          source: 'built-in' as const,
        })),
      'built-in',
    );

    // 2. Plugin skills (loaded from plugin skill directories)
    if (isSourceAllowed('plugin')) {
      const pluginSkillResults = await Promise.all(
        plugins.map(async (plugin) => {
          const skillDirs: string[] = [];
          if (plugin.skillsPath) skillDirs.push(plugin.skillsPath);
          if (plugin.skillsPaths) skillDirs.push(...plugin.skillsPaths);

          // Deduplicate directories via realpath to avoid loading the same
          // physical location twice (e.g. convention dir + manifest path).
          const seen = new Set<string>();
          const uniqueDirs: string[] = [];
          for (const dir of skillDirs) {
            try {
              const real = await fs.realpath(dir);
              if (!seen.has(real)) {
                seen.add(real);
                uniqueDirs.push(dir);
              }
            } catch {
              // Path cannot be resolved (e.g. broken symlink) — keep it
              uniqueDirs.push(dir);
            }
          }

          // Load skills from all unique directories in parallel
          const dirResults = await Promise.all(
            uniqueDirs.map(async (skillDir) => {
              try {
                // Plugin skill paths are direct-or-container: a SKILL.md at
                // the root wins and short-circuits the subtree scan. Unlike a
                // user/project skills root, this is a path the plugin author
                // declares, and upstream supports it — a manifest may point
                // `skills` straight at one skill package. `requireSkills`
                // surfaces a load error when the declared path yields nothing,
                // so a mislaid layout cannot silently drop every skill.
                const skills = await loadSkillsFromDir(skillDir, {
                  allowDirectSkill: true,
                  requireSkills: true,
                });
                await logSkillDirsShadowedByDirectSkill(skillDir, skills);
                return skills;
              } catch (e) {
                runLogger.warn(
                  `[SkillManager] Error loading plugin skills from ${skillDir}:`,
                  e,
                );
                return [];
              }
            }),
          );

          const allSkills: SkillDefinition[] = [];
          for (const skills of dirResults) {
            // Prefix each skill name with the plugin name for collision prevention
            for (const skill of skills) {
              if (!skill.name.startsWith(`${plugin.name}:`)) {
                skill.name = `${plugin.name}:${skill.name}`;
              }
              skill.pluginName = plugin.name;
              skill.pluginPath = plugin.path;
              skill.pluginId = getLoadedPluginId(plugin);
            }
            allSkills.push(...skills);
          }
          return allSkills;
        }),
      );

      for (const skills of pluginSkillResults) {
        builder.addSkillsWithPrecedence(skills, 'plugin');
      }

      // 2c. Fork-context plugin commands: registered as SkillDefinition so they
      // share the skill activation pipeline (tool execution, allowedTools enforcement,
      // agent selection). Inline-context commands stay on PluginCommandLoader.
      const pluginCommandForkSkills =
        loadAllPluginCommandsAsForkSkills(plugins);
      if (pluginCommandForkSkills.length > 0) {
        const existingPluginSkillNames = new Set(
          builder
            .currentSkills()
            .filter((s) => s.source === 'plugin')
            .map((s) => s.name),
        );
        for (const skill of pluginCommandForkSkills) {
          if (existingPluginSkillNames.has(skill.name)) {
            runLogger.warn(
              `[SkillManager] plugin command '${skill.name}' shadows a same-named plugin skill (precedence: command wins).`,
            );
          }
        }
        builder.addSkillsWithPrecedence(pluginCommandForkSkills, 'plugin');
      }

      // Attribute plugin skill load errors to the plugin tab and collect them
      // on this pass — otherwise they would leak into the next drain point
      // (or be dropped entirely when later sources are filtered out).
      const pluginLoadErrors = drainSkillLoadErrors();
      for (const err of pluginLoadErrors) {
        err.source ??= 'plugin';
      }
      builder.loadErrors.push(...pluginLoadErrors);
    }

    // Workflow commands override plugin/bundled skills, but file skills win.
    // This joins the existing atomic snapshot; reload uses the same discovery path.
    if (config) {
      const workflows =
        await createWorkflowRegistryFromConfig(config).listAvailable();
      builder.addSkillsWithPrecedence(
        workflows.entries
          .filter((entry) =>
            entry.source === 'built-in'
              ? shouldLoadGeneralBuiltins &&
                this.isBuiltinSkillEnabled(entry.name)
              : isSourceAllowed(entry.source),
          )
          .map((entry) => workflowToSkill(entry, config)),
      );
      for (const diagnostic of workflows.diagnostics) {
        builder.loadErrors.push({
          name: diagnostic.name,
          filePath:
            diagnostic.scriptPath ?? diagnostic.name ?? diagnostic.source,
          message: diagnostic.message,
          configType: 'skill',
          source: diagnostic.source,
          severity: diagnostic.kind === 'shadowed' ? 'warning' : 'error',
        });
      }
    }

    // 3. User/project file skills. The resource candidates are the only
    // source.
    builder.addSkillsWithPrecedence(
      [...(options.resourceSkills ?? [])].filter(
        (skill) => !skill.source || isSourceAllowed(skill.source),
      ),
    );
    builder.loadErrors.push(...(options.resourceSkillLoadErrors ?? []));

    // ── Atomic swap (synchronous, cannot be interrupted by event loop) ──
    const snapshot = builder.toSnapshot();
    this.skills = snapshot.skills;
    this.bundledSkills = snapshot.bundledSkills;
    this.discoveredList = snapshot.discoveredList;
    this.loadErrors = snapshot.loadErrors;
    this.ignoreCache.clear();
    // The snapshot holds freshly built skill objects with no `disabled` flag,
    // so re-stamp the known disabled list instead of waiting for the caller to
    // invoke setDisabledSkills() again.
    this.applyDisabledSkills();
    this.invalidateMergedCache();

    // Emit a summarized feed-stream warning for any load errors (only on initial load)
    if (options.emitToFeed !== false) {
      emitLoadErrorSummary(this.loadErrors, 'skill', (severity, message) =>
        coreEvents.emitFeedback(severity, message),
      );

      // Summarise cross-source skill name conflicts in a single feedback line
      // instead of N per-conflict lines. Per-conflict detail is already in
      // the log via runLogger.warn; the detail view surfaces the shadowed
      // locations via `Also defined at`.
      const n = snapshot.crossSourceConflicts.count;
      if (n > 0) {
        coreEvents.emitFeedback(
          'warning',
          `Detected ${n} skill name conflict${n === 1 ? '' : 's'} across sources. ` +
            `Run /skills to inspect.`,
        );
      }
    }
  }

  /**
   * Adds skills to the manager programmatically.
   */
  addSkills(skills: SkillDefinition[], source?: SkillSource): void {
    this.addSkillsWithPrecedence(skills, source);
  }

  private addSkillsWithPrecedence(
    newSkills: SkillDefinition[],
    source?: SkillSource,
  ): void {
    const skillMap = new Map<string, SkillDefinition>(
      this.skills.map((s) => [s.name, s]),
    );
    // Seed dedup set from every already-discovered skill (including dynamic +
    // bundled entries that live in discoveredList but not in this.skills) so
    // programmatic adds don't re-emit the same SKILL.md when called twice.
    const loadedResolvedPaths = new Set<string>();
    for (const skill of this.discoveredList) {
      if (skill.resolvedPath) loadedResolvedPaths.add(skill.resolvedPath);
    }
    // Post-discovery programmatic adds don't surface a summary feedback;
    // the counter is incremented locally and discarded.
    const conflicts: CrossSourceConflictCounter = { count: 0 };
    mergeSkillsWithPrecedence(
      skillMap,
      this.discoveredList,
      newSkills,
      source,
      loadedResolvedPaths,
      conflicts,
    );
    this.skills = Array.from(skillMap.values());
    this.applyDisabledSkills();
    this.invalidateMergedCache();
  }

  // ---------------------------------------------------------------------------
  // Dynamic skill management for monorepo subdirectories
  // ---------------------------------------------------------------------------

  /**
   * Returns whether a skill directory has already been loaded as dynamic skills.
   */
  hasDynamicSkillDir(dir: string): boolean {
    return this.dynamicSkills.has(dir);
  }

  /**
   * Adds dynamically discovered skills from a monorepo subdirectory.
   * These are stored separately from static skills and survive `clearSkills()`
   * (reload). Dynamic skills have higher precedence than static skills when
   * names collide.
   *
   * @param dir - The skill directory path (e.g. `packages/foo/${CONFIG_DIR}/skills/`).
   * @param skills - The skills loaded from that directory.
   * @param metadata - Explicit ancestor depth and source precedence for JIT discovery.
   */
  addDynamicSkills(
    dir: string,
    skills: SkillDefinition[],
    metadata?: DynamicSkillMetadata,
  ): void {
    if (skills.length === 0 || this.dynamicSkills.has(dir)) return;
    for (const skill of skills) {
      skill.source = 'project';
      this.discoveredList.push(skill);
    }
    this.dynamicSkills.set(dir, skills);
    this.dynamicSkillMetadata.set(
      dir,
      metadata ?? {
        ancestorDepth: path.resolve(dir).split(path.sep).filter(Boolean).length,
        source: 'configured',
      },
    );
    this.applyDisabledSkills();
    this.invalidateMergedCache();
    runLogger.debug(
      `Added ${skills.length} dynamic skill(s) from ${dir}: ${skills.map((s) => s.name).join(', ')}`,
    );
  }

  /**
   * Merges static and dynamic skills, with dynamic skills taking precedence
   * over static skills with the same name. Result is cached until invalidated.
   */
  private getMergedSkills(): SkillDefinition[] {
    // Runtime gates can change without skill rediscovery. Preserve the merge
    // cache while making its key include each bundled skill's live eligibility.
    const enabledBundled = this.bundledSkills.map((skill) =>
      skill.isEnabled ? skill.isEnabled() : true,
    );
    const enablementKey = enabledBundled.map(Number).join('');
    if (enablementKey !== this.bundledEnablementKey) {
      this.bundledEnablementKey = enablementKey;
      this.invalidateMergedCache();
    }
    if (this.mergedSkillsCache) {
      return this.mergedSkillsCache;
    }

    const skillMap = new Map<string, SkillDefinition>();

    // Programmatic bundled skills first (lowest precedence)
    for (const [index, skill] of this.bundledSkills.entries()) {
      if (!enabledBundled[index]) continue;
      skillMap.set(skill.name, skill);
    }

    // Static skills override bundled (higher precedence)
    for (const skill of this.skills) {
      skillMap.set(skill.name, skill);
    }

    // Dynamic skills override static skills. Shallower ancestors are applied
    // first so deeper ancestors win; at the same depth, the configured
    // directory is applied after the legacy `.agents` compatibility source.
    const sortedDynamicEntries = [...this.dynamicSkills.entries()].sort(
      ([dirA], [dirB]) => {
        const metadataA = this.dynamicSkillMetadata.get(dirA);
        const metadataB = this.dynamicSkillMetadata.get(dirB);
        const depthDifference =
          (metadataA?.ancestorDepth ?? 0) - (metadataB?.ancestorDepth ?? 0);
        if (depthDifference !== 0) return depthDifference;

        const sourcePriority = (metadata?: DynamicSkillMetadata): number =>
          metadata?.source === 'configured' ? 1 : 0;
        return sourcePriority(metadataA) - sourcePriority(metadataB);
      },
    );
    for (const [_dir, skills] of sortedDynamicEntries) {
      for (const skill of skills) {
        skillMap.set(skill.name, skill);
      }
    }

    const result = Array.from(skillMap.values());
    this.mergedSkillsCache = result;
    return result;
  }

  /**
   * Returns the list of enabled discovered skills.
   */
  getSkills(): SkillDefinition[] {
    return this.getMergedSkills().filter((s) => !s.disabled);
  }

  /**
   * Returns the list of enabled discovered skills that should be displayed in the UI.
   * This excludes skills with userInvocable === false (SK28).
   */
  getDisplayableSkills(): SkillDefinition[] {
    return this.getMergedSkills().filter(
      (s) => !s.disabled && s.userInvocable !== false,
    );
  }

  /**
   * Returns all discovered skills, including disabled ones.
   */
  getAllSkills(): SkillDefinition[] {
    return this.getMergedSkills();
  }

  /**
   * Returns every discovered skill, including shadowed duplicates that were
   * overridden by higher-precedence skills. Used by TUI to display shadow info.
   */
  getAllDiscoveredSkills(): SkillDefinition[] {
    return [...this.discoveredList];
  }

  /**
   * Sets the list of disabled skill names.
   */
  setDisabledSkills(disabledNames: string[]): void {
    this.disabledSkillNames = new Set(
      disabledNames.map((n) => n.toLowerCase()),
    );
    this.applyDisabledSkills();
    this.invalidateMergedCache();
  }

  /**
   * Stamps `disabled` on every skill collection the manager owns.
   *
   * `this.bundledSkills` must be included: programmatic built-ins registered
   * via `registerBundledSkill()` (simplify, quest, mcp-config, verify, ...)
   * are kept in their own list and merged straight into `getMergedSkills()`,
   * so leaving their `disabled` flag `undefined` makes every downstream
   * `!skill.disabled` filter (model listing, `/skills` panel, Skill tool)
   * silently ignore `settings.skills.disabled` for them.
   */
  private applyDisabledSkills(): void {
    const stamp = (skill: SkillDefinition): void => {
      skill.disabled = this.disabledSkillNames.has(skill.name.toLowerCase());
    };
    for (const skill of this.skills) {
      stamp(skill);
    }
    for (const skill of this.bundledSkills) {
      stamp(skill);
    }
    for (const skills of this.dynamicSkills.values()) {
      for (const skill of skills) {
        stamp(skill);
      }
    }
  }

  /**
   * Sets per-skill visibility overrides from settings.
   *
   * - `'on'`: fully visible (default behaviour).
   * - `'off'`: hidden from model listing and rejected on Skill tool invoke.
   * - `'name-only'`: listed by name without description.
   * - `'user-invocable-only'`: hidden from model listing but available via
   *    slash command (user-initiated invocation).
   */
  setSkillVisibilityOverrides(
    overrides: Record<
      string,
      'on' | 'name-only' | 'user-invocable-only' | 'off'
    >,
  ): void {
    this.visibilityOverrides = overrides;
  }

  /**
   * Returns the visibility override for a given skill name, or undefined
   * if no override is set (equivalent to 'on').
   *
   * Local TUI plugin commands always use 'on'. Other entries and integration
   * modes try the name as-given first. For qualified names of the
   * form `pluginName:skillName`, falls back to the bare `skillName` so that
   * users can target a skill regardless of which plugin it lives in (the
   * upstream cc-sdk documents `skillOverrides` as "keyed by skill name").
   */
  getSkillVisibilityOverride(
    name: string,
  ): 'on' | 'name-only' | 'user-invocable-only' | 'off' | undefined {
    if (this.getSkill(name)?.source === 'plugin') {
      return 'on';
    }
    const direct = this.visibilityOverrides[name];
    if (direct !== undefined) return direct;
    const colonIdx = name.indexOf(':');
    if (colonIdx >= 0) {
      const bare = name.slice(colonIdx + 1);
      return this.visibilityOverrides[bare];
    }
    return undefined;
  }

  /**
   * Sets the main-session skill allowlist. `undefined` keeps the CLI default
   * discovery behavior; an empty array hides every skill from the main model.
   */
  setSessionSkillAllowlist(allowlist: string[] | undefined): void {
    this.sessionSkillAllowlist =
      allowlist === undefined ? undefined : [...allowlist];
  }

  /**
   * Returns whether a skill is included in the main session's context filter.
   * Fully qualified names match exactly; a bare allowlist entry also matches
   * plugin-qualified canonical names ending in `:<name>`.
   */
  isSkillAllowedForMainSession(name: string): boolean {
    if (this.sessionSkillAllowlist === undefined) return true;

    const requestedName = name.startsWith('/') ? name.slice(1) : name;
    const canonicalName = this.getSkill(requestedName)?.name ?? requestedName;
    return this.sessionSkillAllowlist.some(
      (allowedName) =>
        canonicalName === allowedName ||
        canonicalName.endsWith(`:${allowedName}`),
    );
  }

  /**
   * Reads the full content (metadata + body) of a skill by name.
   */
  getSkill(name: string): SkillDefinition | null {
    const lowercaseName = name.toLowerCase();
    const merged = this.getMergedSkills();
    return merged.find((s) => s.name.toLowerCase() === lowercaseName) ?? null;
  }

  /**
   * Activates a skill by name.
   *
   * @param renderedBody Optional pre-rendered body (after argument substitution
   *   + shell injection). Cached so that post-compact recovery can re-inject
   *   the rendered content instead of the raw template.
   * @param agentId Agent context identifier (defaults to 'main'). Fork-scoped
   *   keys prevent cache pollution between fork and main agent.
   */
  activateSkill(
    name: string,
    renderedBody?: string,
    agentId: string = 'main',
  ): void {
    let agentSet = this.activeSkillNames.get(agentId);
    if (!agentSet) {
      agentSet = new Set();
      this.activeSkillNames.set(agentId, agentSet);
    }
    agentSet.add(name);
    this.activatedAt.set(`${agentId}:${name}`, Date.now());
    if (renderedBody !== undefined) {
      this.renderedBodies.set(`${agentId}:${name}`, renderedBody);
    }
  }

  /**
   * Returns the cached rendered body for a skill, or undefined if not cached.
   * Used by post-compact recovery to re-inject faithfully rendered content.
   *
   * @param agentId Agent context identifier (defaults to 'main').
   */
  getRenderedBody(name: string, agentId: string = 'main'): string | undefined {
    return this.renderedBodies.get(`${agentId}:${name}`);
  }

  /**
   * Clears all invoked skill state for a specific agent. Used to clean up
   * fork-scoped cached bodies after fork execution completes.
   */
  clearInvokedSkillsForAgent(agentId: string): void {
    this.activeSkillNames.delete(agentId);
    const prefix = `${agentId}:`;
    for (const key of this.activatedAt.keys()) {
      if (key.startsWith(prefix)) {
        this.activatedAt.delete(key);
      }
    }
    for (const key of this.renderedBodies.keys()) {
      if (key.startsWith(prefix)) {
        this.renderedBodies.delete(key);
      }
    }
  }

  /**
   * Returns all active skills (model-activated or conditionally-activated)
   * together with the timestamp of most-recent activation. Used by the
   * post-compact recovery path to re-inject previously invoked skills in
   * most-recently-first order.
   */
  getActiveSkillsWithTimestamp(agentId: string = 'main'): Array<{
    skill: SkillDefinition;
    invokedAt: number;
  }> {
    const agentActiveNames =
      this.activeSkillNames.get(agentId) ?? new Set<string>();
    const activeNames = new Set<string>([
      ...agentActiveNames,
      ...this.activatedConditionalSkillNames,
    ]);
    const results: Array<{ skill: SkillDefinition; invokedAt: number }> = [];
    for (const skill of this.getMergedSkills()) {
      if (skill.disabled) continue;
      if (!activeNames.has(skill.name)) continue;
      results.push({
        skill,
        invokedAt: this.activatedAt.get(`${agentId}:${skill.name}`) ?? 0,
      });
    }
    return results;
  }

  /**
   * Checks if a skill is active.
   */
  isSkillActive(name: string, agentId: string = 'main'): boolean {
    return this.activeSkillNames.get(agentId)?.has(name) ?? false;
  }

  // ---------------------------------------------------------------------------
  // Conditional skills based on `paths` frontmatter
  // ---------------------------------------------------------------------------

  /**
   * Returns skills that have `paths` patterns defined (conditional skills).
   * These skills should only be shown to the LLM when working on matching files.
   */
  getConditionalSkills(): SkillDefinition[] {
    return this.getMergedSkills().filter(
      (s) => !s.disabled && s.paths && s.paths.length > 0,
    );
  }

  /**
   * Given a set of file paths the user/agent is operating on, returns
   * conditional skills whose `paths` patterns match at least one file.
   *
   * Uses gitignore-style matching (via the `ignore` library).
   *
   * @param filePaths Relative file paths (relative to workspace root).
   * @returns Matching conditional skills that should be activated/shown.
   */
  getMatchingConditionalSkills(filePaths: string[]): SkillDefinition[] {
    if (filePaths.length === 0) return [];

    const conditionalSkills = this.getConditionalSkills();
    if (conditionalSkills.length === 0) return [];

    const matching: SkillDefinition[] = [];

    for (const skill of conditionalSkills) {
      let ig = this.ignoreCache.get(skill.name);
      if (!ig) {
        ig = ignore().add(skill.paths!);
        this.ignoreCache.set(skill.name, ig);
      }

      const hasMatch = filePaths.some((fp) => {
        const normalized = fp.replace(/^\.?\//, '');
        return ig.ignores(normalized);
      });

      if (hasMatch) {
        matching.push(skill);
      }
    }

    return matching;
  }

  /**
   * Checks file paths against conditional skills and activates any that match.
   * Once activated, a conditional skill stays activated for the session.
   *
   * Call this from file operation tools (Read, Edit, Write, Glob) after
   * operating on files.
   *
   * @param filePaths Relative file paths (relative to workspace root).
   * @returns Names of newly activated conditional skills (empty if none).
   */
  activateConditionalSkillsForPaths(filePaths: string[]): string[] {
    const matches = this.getMatchingConditionalSkills(filePaths);
    const newlyActivated: string[] = [];

    for (const skill of matches) {
      if (!this.activatedConditionalSkillNames.has(skill.name)) {
        this.activatedConditionalSkillNames.add(skill.name);
        this.activatedAt.set(`main:${skill.name}`, Date.now());
        newlyActivated.push(skill.name);
      }
    }

    return newlyActivated;
  }

  /**
   * Returns true if the skill should be visible given the current activation
   * state. Unconditional skills (no `paths`) are always visible; conditional
   * skills are visible only after their `paths` pattern has been matched.
   */
  isConditionallyVisible(skill: SkillDefinition): boolean {
    return (
      !skill.paths ||
      skill.paths.length === 0 ||
      this.activatedConditionalSkillNames.has(skill.name)
    );
  }

  /**
   * Returns all skills that should be visible to the model:
   * unconditional skills + conditionally-activated skills, minus those
   * blocked from model invocation (disable-model-invocation) or hidden by a
   * visibility override ('off' or 'user-invocable-only'). This is the single
   * source of truth for the model-facing skill listing, so the listing and its
   * resend bookkeeping operate on the same set.
   * Callers are treated as the main session by default. Subagent callers must
   * pass `isMainSession: false` so they do not inherit an SDK session filter.
   */
  getModelVisibleSkills(
    options: { isMainSession?: boolean } = {},
  ): SkillDefinition[] {
    const isMainSession = options.isMainSession ?? true;
    return this.getMergedSkills().filter((s) => {
      if (s.disabled) return false;
      if (isFindSkillsWithMandatoryFirstStepInstruction(s)) return false;
      if (s.disableModelInvocation) return false;
      if (!this.isConditionallyVisible(s)) return false;
      const override = this.getSkillVisibilityOverride(s.name);
      if (override === 'off' || override === 'user-invocable-only') {
        return false;
      }
      if (isMainSession && !this.isSkillAllowedForMainSession(s.name)) {
        return false;
      }
      return true;
    });
  }
}
