/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { watch as watchFs, type FSWatcher } from 'chokidar';
import { parse as parseYaml } from '../utils/yaml-parser.js';
import * as yaml from 'yaml';
import type {
  SkillConfig,
  SkillLevel,
  ListSkillsOptions,
  SkillValidationResult,
  SkillHooksSettings,
} from './types.js';
import {
  SkillError,
  SkillErrorCode,
  parseModelField,
  parsePathsField,
  validateSkillName,
} from './types.js';
import type { Config } from '../config/config.js';
import { validateConfig } from './skill-load.js';
import { validateSymlinkTarget } from './symlinkScope.js';
import {
  SkillActivationRegistry,
  splitConditionalSkills,
} from './skill-activation.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { normalizeContent } from '../utils/textUtils.js';
import {
  QWEN_DIR,
  SKILL_PROVIDER_CONFIG_DIRS,
  Storage,
} from '../config/storage.js';
import {
  HookEventName,
  HookType,
  type HookDefinition,
  type CommandHookConfig,
  type HttpHookConfig,
} from '../hooks/types.js';

const debugLogger = createDebugLogger('SKILL_MANAGER');
const SKILLS_CONFIG_DIR = 'skills';
const SKILL_MANIFEST_FILE = 'SKILL.md';

// Skills have a fixed layout (<skill-name>/SKILL.md), so depth 2 is enough to
// detect any change. This keeps chokidar out of heavy subtrees like node_modules
// that would otherwise exhaust file descriptors (see #3289).
export const WATCHER_MAX_DEPTH = 2;

// Reject special file types (sockets, FIFOs, devices) that cannot be watched
// and would error with EOPNOTSUPP, plus .git directories.
export function watcherIgnored(
  filePath: string,
  stats?: fsSync.Stats,
): boolean {
  if (stats && !stats.isFile() && !stats.isDirectory()) return true;
  return filePath.split(path.sep).includes('.git');
}

/**
 * Manages skill configurations stored as directories containing SKILL.md files.
 * Provides discovery, parsing, validation, and caching for skills.
 */
export class SkillManager {
  private skillsCache: Map<SkillLevel, SkillConfig[]> | null = null;
  // Listeners may be sync or async; the type matches `addChangeListener`
  // so future async listeners get checked instead of relying on the
  // `Promise.resolve().then(listener)` runtime adapter to swallow the
  // mismatch silently.
  private readonly changeListeners: Set<() => void | Promise<void>> = new Set();
  private parseErrors: Map<string, SkillError> = new Map();
  private readonly watchers: Map<string, FSWatcher> = new Map();
  private watchStarted = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly bundledSkillsDir: string;
  private activationRegistry: SkillActivationRegistry | null = null;

  constructor(private readonly config: Config) {
    this.bundledSkillsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'bundled',
    );
  }

  /**
   * Adds a listener that will be called when skills change. Listeners may
   * return a Promise, which `notifyChangeListeners` will await before
   * resolving — callers (e.g. `matchAndActivateByPath`) can therefore wait
   * for downstream consumers like `SkillTool.refreshSkills()` to apply the
   * updated state before continuing.
   * @returns A function to remove the listener.
   */
  addChangeListener(listener: () => void | Promise<void>): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Notifies all registered change listeners and awaits any returned
   * promises. Sync listeners resolve immediately; async listeners (e.g.
   * `SkillTool.refreshSkills`) hold the activation pipeline until their
   * downstream tool descriptions are refreshed, eliminating the race where
   * a system-reminder announces a skill before the model can actually see
   * it in `<available_skills>`.
   *
   * Listeners run in parallel via `Promise.allSettled`. They're
   * independent reads (each rebuilds its own derived state from the
   * shared registry); serializing them used to make `matchAndActivateByPaths`
   * scale linearly with the number of registered listeners — a real
   * cost since per-subagent SkillTool instances each register one.
   * `allSettled` (not `Promise.all`) so a single listener throwing
   * still lets the others finish.
   */
  private async notifyChangeListeners(): Promise<void> {
    // Cap each listener at 30s. Without this, a hung listener (e.g.
    // `SkillTool.refreshSkills` → `setTools()` blocked on a network
    // call inside the gemini client) would permanently stall
    // `matchAndActivateByPaths` and `refreshCache`. The activation
    // registry itself has already been mutated synchronously in the
    // caller, so dropping a slow listener after the timeout is the
    // best-effort behavior — the listener can still finish later, it
    // just no longer holds up the activation reminder.
    const TIMEOUT_MS = 30_000;
    const withTimeout = (p: Promise<unknown>): Promise<unknown> => {
      // Capture the timer handle in the outer scope so the `.finally`
      // can clear it once the race settles. Without the clear, every
      // listener-wins-the-race case leaves a 30s pending timer behind:
      // `unref()` keeps it from blocking process exit but vitest's
      // open-handle diagnostic and any tooling that snapshots the active
      // handle set still see the pile-up under high-frequency activation.
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(
          () => reject(new Error(`listener timeout after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        );
        if (
          typeof timerId === 'object' &&
          timerId !== null &&
          'unref' in timerId
        ) {
          (timerId as { unref: () => void }).unref();
        }
      });
      return Promise.race([p, timeoutPromise]).finally(() => {
        if (timerId !== undefined) clearTimeout(timerId);
      });
    };
    const results = await Promise.allSettled(
      Array.from(this.changeListeners).map((listener) =>
        withTimeout(Promise.resolve().then(listener)),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        debugLogger.warn(
          'Skill change listener threw an error:',
          result.reason,
        );
      }
    }
  }

  /**
   * Gets any parse errors that occurred during skill loading.
   * @returns Map of skill paths to their parse errors.
   */
  getParseErrors(): Map<string, SkillError> {
    return new Map(this.parseErrors);
  }

  /**
   * Lists all available skills.
   *
   * @param options - Filtering options
   * @returns Array of skill configurations
   */
  async listSkills(options: ListSkillsOptions = {}): Promise<SkillConfig[]> {
    debugLogger.debug(
      `Listing skills${options.level ? ` at level: ${options.level}` : ''}${options.force ? ' (forced refresh)' : ''}`,
    );
    const skills: SkillConfig[] = [];
    const seenNames = new Set<string>();

    const levelsToCheck: SkillLevel[] = options.level
      ? [options.level]
      : ['project', 'user', 'extension', 'bundled'];

    // Check if we should use cache or force refresh
    const shouldUseCache = !options.force && this.skillsCache !== null;

    // Initialize cache if it doesn't exist or we're forcing a refresh
    if (!shouldUseCache) {
      debugLogger.debug('Cache miss or force refresh, reloading skills');
      await this.refreshCache();
    } else {
      debugLogger.debug('Using cached skills');
    }

    // Collect skills from each level (precedence: project > user > extension > bundled)
    for (const level of levelsToCheck) {
      const levelSkills = this.skillsCache?.get(level) || [];
      debugLogger.debug(
        `Processing ${levelSkills.length} ${level} level skills`,
      );

      for (const skill of levelSkills) {
        // Skip if we've already seen this name (precedence: project > user > extension > bundled)
        if (seenNames.has(skill.name)) {
          debugLogger.debug(
            `Skipping duplicate skill: ${skill.name} (${level})`,
          );
          continue;
        }

        skills.push(skill);
        seenNames.add(skill.name);
      }
    }

    // Sort by name for consistent ordering
    skills.sort((a, b) => a.name.localeCompare(b.name));

    debugLogger.info(`Listed ${skills.length} unique skills`);
    return skills;
  }

  /**
   * Loads a skill configuration by name.
   * If level is specified, only searches that level.
   * If level is omitted, searches in precedence order: project > user > extension > bundled.
   *
   * @param name - Name of the skill to load
   * @param level - Optional level to limit search to
   * @returns SkillConfig or null if not found
   */
  async loadSkill(
    name: string,
    level?: SkillLevel,
  ): Promise<SkillConfig | null> {
    debugLogger.debug(
      `Loading skill: ${name}${level ? ` at level: ${level}` : ''}`,
    );

    if (level) {
      const skill = await this.findSkillByNameAtLevel(name, level);
      if (skill) {
        debugLogger.debug(`Found skill ${name} at ${level} level`);
      } else {
        debugLogger.debug(`Skill ${name} not found at ${level} level`);
      }
      return skill;
    }

    // Try project level first
    const projectSkill = await this.findSkillByNameAtLevel(name, 'project');
    if (projectSkill) {
      debugLogger.debug(`Found skill ${name} at project level`);
      return projectSkill;
    }

    // Try user level
    const userSkill = await this.findSkillByNameAtLevel(name, 'user');
    if (userSkill) {
      debugLogger.debug(`Found skill ${name} at user level`);
      return userSkill;
    }

    // Try extension level
    const extensionSkill = await this.findSkillByNameAtLevel(name, 'extension');
    if (extensionSkill) {
      debugLogger.debug(`Found skill ${name} at extension level`);
      return extensionSkill;
    }

    // Try bundled level (lowest precedence)
    const bundledSkill = await this.findSkillByNameAtLevel(name, 'bundled');
    if (bundledSkill) {
      debugLogger.debug(`Found skill ${name} at bundled level`);
    } else {
      debugLogger.debug(
        `Skill ${name} not found at any level (checked: project, user, extension, bundled)`,
      );
    }
    return bundledSkill;
  }

  /**
   * Loads a skill with its full content, ready for runtime use.
   * This includes loading additional files from the skill directory.
   *
   * @param name - Name of the skill to load
   * @param level - Optional level to limit search to
   * @returns SkillConfig or null if not found
   */
  async loadSkillForRuntime(
    name: string,
    level?: SkillLevel,
  ): Promise<SkillConfig | null> {
    debugLogger.debug(
      `Loading skill for runtime: ${name}${level ? ` at level: ${level}` : ''}`,
    );
    const skill = await this.loadSkill(name, level);
    if (!skill) {
      debugLogger.debug(`Skill not found for runtime: ${name}`);
      return null;
    }

    debugLogger.info(
      `Skill loaded for runtime: ${name} from ${skill.filePath}`,
    );
    return skill;
  }

  /**
   * Validates a skill configuration.
   *
   * @param config - Configuration to validate
   * @returns Validation result
   */
  validateConfig(config: Partial<SkillConfig>): SkillValidationResult {
    return validateConfig(config);
  }

  /**
   * Refreshes the skills cache by loading all skills from disk.
   */
  async refreshCache(): Promise<void> {
    debugLogger.info('Refreshing skills cache...');
    const skillsCache = new Map<SkillLevel, SkillConfig[]>();
    this.parseErrors.clear();

    const levels: SkillLevel[] = ['project', 'user', 'extension', 'bundled'];

    // Use allSettled so an unrecoverable error at one level (e.g. a hung
    // FS, a permission denial, an OS-level enoent on a removed config dir)
    // does not nuke the other three. Each level's own internal loop is
    // already error-isolated per skill — this guard catches errors that
    // bubble up to the level boundary.
    const settled = await Promise.allSettled(
      levels.map(async (level) => {
        const levelSkills = await this.listSkillsAtLevel(level);
        debugLogger.debug(`Loaded ${levelSkills.length} ${level} level skills`);
        return [level, levelSkills] as const;
      }),
    );

    let totalSkills = 0;
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        const [level, levelSkills] = result.value;
        skillsCache.set(level, levelSkills);
        totalSkills += levelSkills.length;
      } else {
        debugLogger.warn(
          `Failed to load ${levels[i]} level skills:`,
          result.reason,
        );
      }
    }

    this.skillsCache = skillsCache;

    // Rebuild the activation registry so that newly added/removed `paths:`
    // frontmatter takes effect. Prior activations do not carry across reloads.
    //
    // Two filters apply before a skill enters the registry:
    //
    // 1. Cross-level dedup with the same precedence as `listSkills()`
    //    (project > user > extension > bundled). Without this, a shadowed
    //    copy's `paths` glob can flip the visible (higher-precedence) skill
    //    of the same name to "active", even when the touched file does not
    //    match the visible skill's own globs.
    //
    // 2. Drop `disable-model-invocation` skills. They are hidden from the
    //    SkillTool listing entirely, so allowing path activation would only
    //    emit a misleading "<skill> is now available" reminder for a skill
    //    the model cannot then invoke.
    const seenForActivation = new Set<string>();
    const eligibleForActivation: SkillConfig[] = [];
    for (const level of levels) {
      for (const skill of skillsCache.get(level) ?? []) {
        if (seenForActivation.has(skill.name)) continue;
        seenForActivation.add(skill.name);
        if (skill.disableModelInvocation) continue;
        eligibleForActivation.push(skill);
      }
    }
    const { conditional } = splitConditionalSkills(eligibleForActivation);
    // Surface picomatch compile failures via parseErrors so a malformed
    // `paths:` glob shows up in `getParseErrors()` (and downstream
    // `/skills` UI) instead of only landing in debug logs. Otherwise
    // an author who wrote `src/***/file.tsx` sees a permanent "gated
    // by path-based activation" error with no actionable diagnostic.
    this.activationRegistry = new SkillActivationRegistry(
      conditional,
      this.config.getProjectRoot(),
      (skill, pattern, error) => {
        this.parseErrors.set(
          `${skill.filePath}#paths[${pattern}]`,
          new SkillError(
            `Invalid glob in "paths": ${pattern} — ${error.message}`,
            SkillErrorCode.INVALID_CONFIG,
            skill.name,
          ),
        );
      },
    );

    debugLogger.info(
      `Skills cache refreshed: ${totalSkills} total skills loaded ` +
        `(${conditional.length} conditional)`,
    );
    await this.notifyChangeListeners();
  }

  /**
   * Whether the given skill is currently eligible to appear in the SkillTool
   * listing. Unconditional skills are always eligible; conditional skills
   * become eligible only after a tool invocation touches a file matching
   * their `paths:` globs.
   */
  isSkillActive(skill: SkillConfig): boolean {
    if (!skill.paths || skill.paths.length === 0) return true;
    return this.activationRegistry?.isActivated(skill.name) ?? false;
  }

  /**
   * Activate any conditional skills whose `paths:` globs match `filePath`.
   * Returns the names of skills newly activated by this call. When at least
   * one skill activates, change listeners are notified and awaited — so by
   * the time this method resolves, downstream consumers (notably
   * `SkillTool.refreshSkills` updating the model-facing tool description)
   * have applied the new state. Callers can therefore announce the
   * activation in the same turn without racing against a stale tool list.
   *
   * The activation registry reference is captured at call entry; if a
   * concurrent `refreshCache` rebuilds the registry mid-call, this
   * invocation finishes against the registry it started with, so a
   * returned name is consistent with the listener state that's about to
   * be observed.
   */
  async matchAndActivateByPath(filePath: string): Promise<string[]> {
    return this.matchAndActivateByPaths([filePath]);
  }

  /**
   * Batch variant of {@link matchAndActivateByPath}: activate skills for
   * an array of file paths and fire change listeners exactly once across
   * all of them. Used by `coreToolScheduler` so a single tool call that
   * names N paths (e.g. ripGrep with multiple `paths:` entries) does not
   * trigger N successive `SkillTool.refreshSkills` /
   * `geminiClient.setTools()` round-trips.
   */
  async matchAndActivateByPaths(
    filePaths: readonly string[],
  ): Promise<string[]> {
    const registry = this.activationRegistry;
    if (!registry || filePaths.length === 0) return [];
    const newlyAcrossPaths = new Set<string>();
    for (const filePath of filePaths) {
      for (const name of registry.matchAndConsume(filePath)) {
        newlyAcrossPaths.add(name);
      }
    }
    if (newlyAcrossPaths.size > 0) {
      await this.notifyChangeListeners();
    }
    return Array.from(newlyAcrossPaths);
  }

  /** Names of all conditional skills activated so far (read-only snapshot). */
  getActivatedSkillNames(): ReadonlySet<string> {
    return this.activationRegistry?.getActivatedNames() ?? new Set();
  }

  /**
   * Starts watching skill directories for changes.
   */
  async startWatching(): Promise<void> {
    if (this.watchStarted) {
      debugLogger.debug('Skill watching already started, skipping');
      return;
    }

    if (this.config.getBareMode()) {
      debugLogger.info(
        'Bare mode enabled; refreshing skill cache without starting watchers',
      );
      await this.refreshCache();
      return;
    }

    debugLogger.info('Starting skill directory watchers...');
    this.watchStarted = true;
    await this.ensureUserSkillsDir();
    await this.refreshCache();
    this.updateWatchersFromCache();
    debugLogger.info('Skill directory watchers started');
  }

  /**
   * Stops watching skill directories for changes.
   */
  stopWatching(): void {
    debugLogger.info('Stopping skill directory watchers...');
    for (const watcher of this.watchers.values()) {
      void watcher.close().catch((error) => {
        debugLogger.warn('Failed to close skills watcher:', error);
      });
    }
    this.watchers.clear();
    this.watchStarted = false;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    debugLogger.info('Skill directory watchers stopped');
  }

  /**
   * Parses a SKILL.md file and returns the configuration.
   *
   * @param filePath - Path to the SKILL.md file
   * @param level - Storage level
   * @returns SkillConfig
   * @throws SkillError if parsing fails
   */
  parseSkillFile(filePath: string, level: SkillLevel): Promise<SkillConfig> {
    return this.parseSkillFileInternal(filePath, level);
  }

  /**
   * Internal implementation of skill file parsing.
   */
  private async parseSkillFileInternal(
    filePath: string,
    level: SkillLevel,
  ): Promise<SkillConfig> {
    let content: string;

    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      debugLogger.error(
        `Failed to read skill file ${filePath}: ${errorMessage}`,
      );
      const skillError = new SkillError(
        `Failed to read skill file: ${errorMessage}`,
        SkillErrorCode.FILE_ERROR,
      );
      this.parseErrors.set(filePath, skillError);
      throw skillError;
    }

    return this.parseSkillContent(content, filePath, level);
  }

  /**
   * Parses skill content from a string.
   *
   * @param content - File content
   * @param filePath - File path for error reporting
   * @param level - Storage level
   * @returns SkillConfig
   * @throws SkillError if parsing fails
   */
  parseSkillContent(
    content: string,
    filePath: string,
    level: SkillLevel,
  ): SkillConfig {
    try {
      const normalizedContent = normalizeContent(content);

      // Split frontmatter and content
      const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;
      const match = normalizedContent.match(frontmatterRegex);

      if (!match) {
        throw new Error('Invalid format: missing YAML frontmatter');
      }

      const [, frontmatterYaml, body] = match;

      // Parse YAML frontmatter
      const frontmatter = parseYaml(frontmatterYaml) as Record<string, unknown>;

      // Extract required fields
      const nameRaw = frontmatter['name'];
      const descriptionRaw = frontmatter['description'];

      if (nameRaw == null || nameRaw === '') {
        throw new Error('Missing "name" in frontmatter');
      }

      if (descriptionRaw == null || descriptionRaw === '') {
        throw new Error('Missing "description" in frontmatter');
      }

      // Convert to strings
      const name = String(nameRaw);
      // Reject unsafe names early — the value flows into the SkillTool
      // description, schema enums, and the path-activation
      // <system-reminder>, all of which the model treats as trusted text.
      validateSkillName(name);
      const description = String(descriptionRaw);

      // Extract optional fields
      const allowedToolsRaw = frontmatter['allowedTools'] as
        | unknown[]
        | undefined;
      let allowedTools: string[] | undefined;

      if (allowedToolsRaw !== undefined) {
        if (Array.isArray(allowedToolsRaw)) {
          allowedTools = allowedToolsRaw.map(String);
        } else {
          throw new Error('"allowedTools" must be an array');
        }
      }

      // Extract hooks configuration
      // Use full YAML parser for hooks as they have nested structures
      let hooks: SkillHooksSettings | undefined;
      if (frontmatterYaml.includes('hooks:')) {
        // Re-parse with full YAML parser to get nested hooks structure
        const fullFrontmatter = yaml.parse(frontmatterYaml) as Record<
          string,
          unknown
        >;
        const hooksRaw = fullFrontmatter['hooks'] as
          | Record<string, unknown>
          | undefined;
        if (hooksRaw !== undefined) {
          hooks = this.parseHooksConfig(hooksRaw);
        }
      }

      // Set skillRoot to the directory containing SKILL.md
      const skillRoot = path.dirname(filePath);
      // Extract optional model field
      const model = parseModelField(frontmatter);

      // Extract argument-hint, when_to_use, and disable-model-invocation
      const argumentHint =
        typeof frontmatter['argument-hint'] === 'string'
          ? frontmatter['argument-hint']
          : undefined;
      const whenToUse =
        typeof frontmatter['when_to_use'] === 'string'
          ? frontmatter['when_to_use']
          : undefined;
      const disableModelInvocationRaw = frontmatter['disable-model-invocation'];
      const disableModelInvocation =
        disableModelInvocationRaw === true ||
        disableModelInvocationRaw === 'true'
          ? true
          : undefined;

      // Optional `paths` frontmatter: glob patterns that gate when this skill
      // is offered to the model (conditional skill).
      const paths = parsePathsField(frontmatter);

      const config: SkillConfig = {
        name,
        description,
        allowedTools,
        hooks,
        skillRoot,
        argumentHint,
        model,
        level,
        filePath,
        body: body.trim(),
        whenToUse,
        disableModelInvocation,
        paths,
      };

      // Validate the parsed configuration
      const validation = this.validateConfig(config);
      if (!validation.isValid) {
        throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
      }

      debugLogger.debug(
        `Successfully parsed skill: ${name} (${level}) from ${filePath}`,
      );
      return config;
    } catch (error) {
      const skillError = new SkillError(
        `Failed to parse skill file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        SkillErrorCode.PARSE_ERROR,
      );
      this.parseErrors.set(filePath, skillError);
      throw skillError;
    }
  }

  /**
   * Parses hooks configuration from frontmatter.
   *
   * @param hooksRaw - Raw hooks object from frontmatter
   * @returns Parsed SkillHooksSettings
   */
  private parseHooksConfig(
    hooksRaw: Record<string, unknown>,
  ): SkillHooksSettings {
    const hooks: SkillHooksSettings = {};

    // Get valid hook event names
    const validEvents = Object.values(HookEventName);

    for (const [eventName, matchersRaw] of Object.entries(hooksRaw)) {
      // Validate event name
      if (!validEvents.includes(eventName as HookEventName)) {
        debugLogger.warn(`Unknown hook event: ${eventName}, skipping`);
        continue;
      }

      // Parse matchers array
      if (!Array.isArray(matchersRaw)) {
        debugLogger.warn(`Hooks for ${eventName} must be an array, skipping`);
        continue;
      }

      const matchers: HookDefinition[] = [];
      for (const matcherRaw of matchersRaw) {
        if (typeof matcherRaw !== 'object' || matcherRaw === null) {
          debugLogger.warn(`Invalid matcher in ${eventName}, skipping`);
          continue;
        }

        const matcher = matcherRaw as Record<string, unknown>;
        const hookDef = this.parseHookMatcher(matcher);
        if (hookDef) {
          matchers.push(hookDef);
        }
      }

      if (matchers.length > 0) {
        hooks[eventName as HookEventName] = matchers;
      }
    }

    return hooks;
  }

  /**
   * Parses a single hook matcher configuration.
   *
   * @param matcher - Raw matcher object
   * @returns HookDefinition or null if invalid
   */
  private parseHookMatcher(
    matcher: Record<string, unknown>,
  ): HookDefinition | null {
    const matcherPattern = matcher['matcher'] as string | undefined;
    const hooksRaw = matcher['hooks'] as unknown[] | undefined;

    if (!hooksRaw || !Array.isArray(hooksRaw)) {
      debugLogger.warn('Matcher missing hooks array, skipping');
      return null;
    }

    const hooks: Array<CommandHookConfig | HttpHookConfig> = [];

    for (const hookRaw of hooksRaw) {
      if (typeof hookRaw !== 'object' || hookRaw === null) {
        continue;
      }

      const hook = hookRaw as Record<string, unknown>;
      const hookType = hook['type'] as string;

      if (hookType === 'command') {
        const commandHook: CommandHookConfig = {
          type: HookType.Command,
          command: hook['command'] as string,
          timeout: hook['timeout'] as number | undefined,
          statusMessage: hook['statusMessage'] as string | undefined,
          shell: hook['shell'] as 'bash' | 'powershell' | undefined,
        };
        hooks.push(commandHook);
      } else if (hookType === 'http') {
        const httpHook: HttpHookConfig = {
          type: HookType.Http,
          url: hook['url'] as string,
          headers: hook['headers'] as Record<string, string> | undefined,
          allowedEnvVars: hook['allowedEnvVars'] as string[] | undefined,
          timeout: hook['timeout'] as number | undefined,
          statusMessage: hook['statusMessage'] as string | undefined,
        };
        hooks.push(httpHook);
      } else {
        debugLogger.warn(`Unknown hook type: ${hookType}, skipping`);
      }
    }

    if (hooks.length === 0) {
      return null;
    }

    return {
      matcher: matcherPattern,
      hooks,
    };
  }

  /**
   * Gets the base directory for skills at a specific level.
   *
   * @param level - Storage level
   * @returns Absolute directory paths
   */
  getSkillsBaseDirs(level: SkillLevel): string[] {
    switch (level) {
      case 'project':
        return SKILL_PROVIDER_CONFIG_DIRS.map((v) =>
          path.join(this.config.getProjectRoot(), v, SKILLS_CONFIG_DIR),
        );
      case 'user':
        return SKILL_PROVIDER_CONFIG_DIRS.map((v) =>
          v === QWEN_DIR
            ? path.join(Storage.getGlobalQwenDir(), SKILLS_CONFIG_DIR)
            : path.join(os.homedir(), v, SKILLS_CONFIG_DIR),
        );
      case 'bundled':
        return [this.bundledSkillsDir];
      case 'extension':
        throw new Error(
          'Extension skills do not have a base directory; they are loaded from active extensions.',
        );
      default:
        throw new Error(`Unknown skill level: ${level as string}`);
    }
  }

  /**
   * Lists skills at a specific level.
   *
   * @param level - Storage level to scan
   * @returns Array of skill configurations
   */
  private async listSkillsAtLevel(level: SkillLevel): Promise<SkillConfig[]> {
    if (this.config.getBareMode()) {
      debugLogger.debug(`Skipping ${level} level skills in bare mode`);
      return [];
    }

    const projectRoot = this.config.getProjectRoot();
    const homeDir = os.homedir();
    const isHomeDirectory = path.resolve(projectRoot) === path.resolve(homeDir);

    // If project level is requested but project root is same as home directory,
    // return empty array to avoid conflicts between project and global skills
    if (level === 'project' && isHomeDirectory) {
      debugLogger.debug(
        'Skipping project-level skills: project root is home directory',
      );
      return [];
    }

    if (level === 'extension') {
      const extensions = this.config.getActiveExtensions();
      const skills: SkillConfig[] = [];
      for (const extension of extensions) {
        extension.skills?.forEach((skill) => {
          skills.push({ ...skill, extensionName: extension.name });
        });
      }
      debugLogger.debug(
        `Loaded ${skills.length} extension-level skills from ${extensions.length} extensions`,
      );
      return skills;
    }

    if (level === 'bundled') {
      const bundledDir = this.bundledSkillsDir;
      if (!fsSync.existsSync(bundledDir)) {
        debugLogger.warn(
          `Bundled skills directory not found: ${bundledDir}. This may indicate an incomplete installation.`,
        );
        return [];
      }
      debugLogger.debug(`Loading bundled skills from: ${bundledDir}`);
      const skills = await this.loadSkillsFromDir(bundledDir, 'bundled');
      debugLogger.debug(`Loaded ${skills.length} bundled skills`);
      return skills;
    }

    // Iterate provider directories in PROVIDER_CONFIG_DIRS order.
    // The first directory that contains a skill with a given name wins,
    // so the order defines implicit precedence (.qwen > .agent > .cursor > ...).
    // Load in parallel but fold sequentially to preserve precedence.
    const baseDirs = this.getSkillsBaseDirs(level);
    const perDirSkills = await Promise.all(
      baseDirs.map((baseDir) => {
        debugLogger.debug(`Loading ${level} level skills from: ${baseDir}`);
        return this.loadSkillsFromDir(baseDir, level);
      }),
    );
    const skills: SkillConfig[] = [];
    const seenNames = new Set<string>();
    for (let i = 0; i < baseDirs.length; i++) {
      const baseDir = baseDirs[i];
      for (const skill of perDirSkills[i]) {
        if (seenNames.has(skill.name)) {
          debugLogger.debug(
            `Skipping duplicate skill at ${level} level: ${skill.name} from ${baseDir}`,
          );
          continue;
        }
        seenNames.add(skill.name);
        skills.push(skill);
      }
    }
    debugLogger.debug(`Loaded ${skills.length} ${level} level skills`);
    return skills;
  }

  async loadSkillsFromDir(
    baseDir: string,
    level: SkillLevel,
  ): Promise<SkillConfig[]> {
    debugLogger.debug(`Loading skills from directory: ${baseDir}`);
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      debugLogger.debug(`Found ${entries.length} entries in ${baseDir}`);

      // The returned `loaded` array preserves entries order via Promise.all,
      // but `parseSkillFileInternal` writes into `this.parseErrors` as each
      // promise settles, so the Map's insertion order reflects parse-finish
      // order, not on-disk order. Today the only consumer iterates without
      // any ordering assumption (`tools/skill.ts`); preserve that contract.
      const loaded = await Promise.all(
        entries.map(async (entry) => {
          const isDirectory = entry.isDirectory();
          const isSymlink = entry.isSymbolicLink();

          if (!isDirectory && !isSymlink) {
            debugLogger.warn(`Skipping non-directory entry: ${entry.name}`);
            return null;
          }

          const skillDir = path.join(baseDir, entry.name);

          // For symlinks, verify the target (a) resolves and (b) is a
          // directory. Shared with `skill-load.ts` so the two parsers
          // stay in sync. Targets pointing outside `baseDir` are
          // allowed — see `symlinkScope.ts` for the rationale.
          if (isSymlink) {
            const check = await validateSymlinkTarget(skillDir);
            if (!check.ok) {
              if (check.reason === 'not-directory') {
                debugLogger.warn(
                  `Skipping symlink ${entry.name} that does not point to a directory`,
                );
              } else {
                debugLogger.warn(
                  `Skipping invalid symlink ${entry.name}: ${check.error instanceof Error ? check.error.message : 'Unknown error'}`,
                );
              }
              return null;
            }
          }

          const skillManifest = path.join(skillDir, SKILL_MANIFEST_FILE);

          try {
            await fs.access(skillManifest);
            return await this.parseSkillFileInternal(skillManifest, level);
          } catch (error) {
            if (error instanceof SkillError) {
              debugLogger.error(
                `Failed to parse skill at ${skillDir}: ${error.message}`,
              );
            } else {
              debugLogger.debug(
                `No valid SKILL.md found in ${skillDir}, skipping`,
              );
            }
            return null;
          }
        }),
      );

      return loaded.filter((s): s is SkillConfig => s !== null);
    } catch (error) {
      // Directory doesn't exist or can't be read
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      debugLogger.debug(
        `Cannot read skills directory ${baseDir}: ${errorMessage}`,
      );
      return [];
    }
  }

  /**
   * Finds a skill by name at a specific level.
   *
   * @param name - Name of the skill to find
   * @param level - Storage level to search
   * @returns SkillConfig or null if not found
   */
  private async findSkillByNameAtLevel(
    name: string,
    level: SkillLevel,
  ): Promise<SkillConfig | null> {
    await this.ensureLevelCache(level);

    const levelSkills = this.skillsCache?.get(level) || [];

    // Find the skill with matching name
    return levelSkills.find((skill) => skill.name === name) || null;
  }

  /**
   * Ensures the cache is populated for a specific level without loading other levels.
   */
  private async ensureLevelCache(level: SkillLevel): Promise<void> {
    if (!this.skillsCache) {
      this.skillsCache = new Map<SkillLevel, SkillConfig[]>();
    }

    if (!this.skillsCache.has(level)) {
      const levelSkills = await this.listSkillsAtLevel(level);
      this.skillsCache.set(level, levelSkills);
    }
  }

  // Only watch project and user skill directories for changes.
  // Bundled skills are immutable (shipped with the package) and extension
  // skills are managed by the extension system, so neither needs watching.
  private updateWatchersFromCache(): void {
    if (this.config.getBareMode()) {
      return;
    }

    const watchTargets = new Set<string>(
      (['project', 'user'] as const)
        .map((level) => this.getSkillsBaseDirs(level))
        .reduce((acc, baseDirs) => acc.concat(baseDirs), [])
        .filter((baseDir) => fsSync.existsSync(baseDir)),
    );

    for (const existingPath of this.watchers.keys()) {
      if (!watchTargets.has(existingPath)) {
        void this.watchers
          .get(existingPath)
          ?.close()
          .catch((error) => {
            debugLogger.warn(
              `Failed to close skills watcher for ${existingPath}:`,
              error,
            );
          });
        this.watchers.delete(existingPath);
      }
    }

    for (const watchPath of watchTargets) {
      if (this.watchers.has(watchPath)) {
        continue;
      }

      try {
        const watcher = watchFs(watchPath, {
          ignoreInitial: true,
          ignored: watcherIgnored,
          depth: WATCHER_MAX_DEPTH,
        })
          .on('all', () => {
            this.scheduleRefresh();
          })
          .on('error', (error) => {
            debugLogger.warn(`Skills watcher error for ${watchPath}:`, error);
          });
        this.watchers.set(watchPath, watcher);
      } catch (error) {
        debugLogger.warn(
          `Failed to watch skills directory at ${watchPath}:`,
          error,
        );
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshCache().then(() => this.updateWatchersFromCache());
    }, 150);
  }

  private async ensureUserSkillsDir(): Promise<void> {
    const baseDir = path.join(Storage.getGlobalQwenDir(), SKILLS_CONFIG_DIR);
    try {
      await fs.mkdir(baseDir, { recursive: true });
    } catch (error) {
      debugLogger.warn(
        `Failed to create user skills directory at ${baseDir}:`,
        error,
      );
    }
  }
}
