/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { rememberPluginHookRefs } from '../hooks/hookConfigurationRef.js';
import { readFile, access, readdir, stat, realpath } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { constants } from 'node:fs';

import {
  McpServerConfigSchema,
  PluginHooksConfigSchema,
  PluginHooksSchema,
  PluginManifestSchema,
  RECOGNIZED_BUT_UNIMPLEMENTED_FIELDS,
} from './schemas.js';
import type { CommandMetadata } from './schemas.js';
import type {
  LoadedPlugin,
  PluginComponent,
  PluginError,
  PluginLoadResult,
  PluginHooksConfig,
} from './types.js';
import { formatManifestError } from './validation/manifestErrors.js';
import { debugLogger } from '../utils/debugLogger.js';
import { getErrorMessage } from '../utils/errors.js';
import { isPathContained } from '../utils/pathContainment.js';
import { runLogger } from '../utils/runLogger.js';
import { BRAND_PLUGIN_META_DIR } from '../config/brand.js';

/** Current brand first; retain the existing Claude plugin compatibility. */
export const PLUGIN_META_DIRS = [BRAND_PLUGIN_META_DIR, '.claude-plugin'] as const;

/**
 * Convention directories/files that identify a plugin.
 * Shared between discovery (hasPluginConventionContent) and validation (plugins validate).
 */
export const PLUGIN_CONVENTION_ENTRIES = [
  { path: 'commands', label: 'commands/', checkType: 'dir' as const },
  { path: 'skills', label: 'skills/', checkType: 'dir' as const },
  { path: 'agents', label: 'agents/', checkType: 'dir' as const },
  {
    path: 'hooks/hooks.json',
    label: 'hooks/hooks.json',
    checkType: 'file' as const,
    isJson: true,
  },
  { path: 'output-styles', label: 'output-styles/', checkType: 'dir' as const },
  { path: 'workflows', label: 'workflows/', checkType: 'dir' as const },
  { path: 'bin', label: 'bin/', checkType: 'dir' as const },
  {
    path: '.mcp.json',
    label: '.mcp.json',
    checkType: 'file' as const,
    isJson: true,
  },
  // Fallback for ecosystems that ship `mcp.json` (no leading dot) — same
  // contract as `.mcp.json`. Order matters for resolution: `.mcp.json` always
  // wins when both are present (see `resolveManifestMcpServers`); the two are
  // never merged.
  {
    path: 'mcp.json',
    label: 'mcp.json',
    checkType: 'file' as const,
    isJson: true,
  },
] as const;

/**
 * Convention-based MCP server config candidates, listed in priority order.
 * The first existing file wins; the rest are ignored (never merged) so a
 * single plugin can't accidentally start two batches of MCP servers.
 */
const MCP_CONVENTION_FILES = ['.mcp.json', 'mcp.json'] as const;

/**
 * Allowlisted keys for plugin manifest `settings`.
 * Only these keys are kept when merging plugin settings.
 */
const PLUGIN_SETTINGS_ALLOWLIST = new Set(['agent']);

/**
 * Check if a file or directory exists.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the plugin manifest path, checking the current brand before compatibility directories.
 * Returns the first existing path, or null if no manifest exists.
 */
export async function findManifestPath(
  pluginDir: string,
): Promise<string | null> {
  for (const metaDir of PLUGIN_META_DIRS) {
    const candidate = join(pluginDir, metaDir, 'plugin.json');
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Check if a path is a directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Load a single plugin from a directory.
 *
 * The manifest file is at: `<plugin metadata directory>/plugin.json`.
 *
 * Convention directories (commands/, agents/, skills/, hooks/, output-styles/, workflows/)
 * are auto-discovered if present.
 *
 * @param dir Absolute path to plugin directory
 * @param source Where this plugin was loaded from (e.g., "local", "flag", marketplace name)
 * @param repository Repository/marketplace identifier
 * @param options Additional options
 */
export async function loadPluginFromDirectory(
  dir: string,
  source: string,
  repository: string,
  options?: {
    /** Override enabled state */
    enabled?: boolean;
    /** Git commit SHA for version pinning */
    sha?: string;
    /** Override plugin name instead of deriving from directory basename */
    nameOverride?: string;
    /** Collect parser failures that runtime normally logs and skips. */
    collectValidationWarnings?: boolean;
  },
): Promise<
  { ok: true; plugin: LoadedPlugin } | { ok: false; error: PluginError }
> {
  const pluginDir = resolve(dir);
  const manifestPath = await findManifestPath(pluginDir);

  // Determine plugin identity: use manifest when present, convention fallback otherwise
  let manifest: ReturnType<typeof PluginManifestSchema.parse>;
  let name: string;
  let version: string;

  if (manifestPath) {
    // Manifest exists: read, validate, and use it as authoritative source
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const json = JSON.parse(raw);
      manifest = PluginManifestSchema.parse(json);
      name = options?.nameOverride || manifest.name;
      version = manifest.version ?? 'local';

      // Warn for recognized-but-unimplemented manifest fields
      if (json && typeof json === 'object') {
        for (const field of RECOGNIZED_BUT_UNIMPLEMENTED_FIELDS) {
          if (field in (json as Record<string, unknown>)) {
            runLogger.warn(
              `Plugin '${name}' (${source}) declares '${field}' but it is not yet implemented; field will be ignored.`,
            );
          }
        }
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'manifest-parse-error',
          source,
          plugin: options?.nameOverride || basename(pluginDir),
          manifestPath,
          parseError: formatManifestError(error),
        },
      };
    }
  } else {
    // No manifest: convention-based discovery (folder name = plugin name)
    name =
      options?.nameOverride ||
      basename(pluginDir).replace(/^\.+/, '') ||
      basename(pluginDir);
    version = 'local';
    manifest = { name, version, description: '' } as ReturnType<
      typeof PluginManifestSchema.parse
    >;
  }

  // Non-fatal warnings collected during loading
  const warnings: PluginError[] = [];
  const parserWarnings = options?.collectValidationWarnings ? warnings : [];

  // Discover convention directories — each resource type is mutually exclusive:
  // if the manifest declares a field, skip the convention directory for that type.
  // bin/ is purely convention-based (no manifest field) — always detected.
  const [
    hasCommandsDir,
    hasAgentsDir,
    hasSkillsDir,
    hasOutputStylesDir,
    hasWorkflowsDir,
    hooksResult,
    hasBinDir,
  ] = await Promise.all([
    !manifest.commands
      ? isDirectory(join(pluginDir, 'commands'))
      : Promise.resolve(false),
    !manifest.agents
      ? isDirectory(join(pluginDir, 'agents'))
      : Promise.resolve(false),
    !manifest.skills
      ? isDirectory(join(pluginDir, 'skills'))
      : Promise.resolve(false),
    !manifest.outputStyles
      ? isDirectory(join(pluginDir, 'output-styles'))
      : Promise.resolve(false),
    !hasManifestWorkflows(manifest)
      ? isDirectory(join(pluginDir, 'workflows'))
      : Promise.resolve(false),
    !manifest.hooks
      ? loadHooksConfig(pluginDir, name, warnings)
      : Promise.resolve(undefined),
    isDirectory(join(pluginDir, 'bin')),
  ]);

  // Resolve manifest-declared paths for each resource type
  const [
    commandsPaths,
    agentsPaths,
    skillsPaths,
    outputStylesPaths,
    workflowsPaths,
  ] = await Promise.all([
    resolveAndValidateManifestPaths(
      pluginDir,
      manifest.name,
      manifest.commands,
      'commands',
      warnings,
    ),
    resolveAndValidateManifestPaths(
      pluginDir,
      manifest.name,
      manifest.agents,
      'agents',
      warnings,
    ),
    resolveAndValidateManifestPaths(
      pluginDir,
      manifest.name,
      manifest.skills,
      'skills',
      warnings,
    ),
    resolveAndValidateManifestPaths(
      pluginDir,
      manifest.name,
      manifest.outputStyles,
      'output-styles',
      warnings,
    ),
    resolveAndValidateManifestPaths(
      pluginDir,
      manifest.name,
      manifestWorkflowPaths(manifest),
      'workflows',
      warnings,
    ),
  ]);

  // Resolve hooks: manifest hooks when declared, otherwise convention hooks already loaded above
  let finalHooks: PluginHooksConfig | undefined = hooksResult;
  if (manifest.hooks) {
    finalHooks = await resolveManifestHooks(
      pluginDir,
      manifest.hooks,
      name,
      warnings,
      manifestPath!,
    );
  }

  // Process MCP servers (convention .mcp.json + manifest declarations)
  const mcpServers = await resolveManifestMcpServers(
    pluginDir,
    manifest.mcpServers,
    name,
    parserWarnings,
  );

  // Filter settings through allowlist
  const filteredSettings = manifest.settings
    ? Object.fromEntries(
        Object.entries(manifest.settings).filter(([k]) =>
          PLUGIN_SETTINGS_ALLOWLIST.has(k),
        ),
      )
    : undefined;

  const plugin: LoadedPlugin = {
    name,
    displayName: manifest.displayName,
    manifest,
    path: pluginDir,
    source,
    repository,
    enabled: options?.enabled ?? true,
    sha: options?.sha,

    // Convention directories (only set when manifest does NOT declare the field)
    commandsPath: hasCommandsDir ? join(pluginDir, 'commands') : undefined,
    agentsPath: hasAgentsDir ? join(pluginDir, 'agents') : undefined,
    skillsPath: hasSkillsDir ? join(pluginDir, 'skills') : undefined,
    outputStylesPath: hasOutputStylesDir
      ? join(pluginDir, 'output-styles')
      : undefined,
    workflowsPath: hasWorkflowsDir ? join(pluginDir, 'workflows') : undefined,
    binPath: hasBinDir ? join(pluginDir, 'bin') : undefined,

    // Manifest-declared paths (only set when manifest declares the field)
    commandsPaths: commandsPaths?.length ? commandsPaths : undefined,
    agentsPaths: agentsPaths?.length ? agentsPaths : undefined,
    skillsPaths: skillsPaths?.length ? skillsPaths : undefined,
    outputStylesPaths: outputStylesPaths?.length
      ? outputStylesPaths
      : undefined,
    workflowsPaths: workflowsPaths?.length ? workflowsPaths : undefined,

    // Command metadata from manifest (object-mapping format)
    commandsMetadata: extractCommandsMetadata(manifest.commands),

    // Resolved configurations
    hooksConfig: finalHooks,
    mcpServers: mcpServers as LoadedPlugin['mcpServers'],
    settings:
      filteredSettings && Object.keys(filteredSettings).length > 0
        ? filteredSettings
        : undefined,

    // Non-fatal warnings
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  return { ok: true, plugin };
}

/**
 * Extract command metadata from the manifest commands field.
 * Only returns metadata when commands is in object-mapping format (Record<string, CommandMetadata>).
 * String or string[] formats are paths handled by resolveAndValidateManifestPaths.
 */
function hasManifestWorkflows(manifest: {
  workflowsPath?: string;
  workflowsPaths?: string[];
}): boolean {
  return Boolean(manifest.workflowsPath || manifest.workflowsPaths?.length);
}

function manifestWorkflowPaths(manifest: {
  workflowsPath?: string;
  workflowsPaths?: string[];
}): string[] | undefined {
  const paths = [
    ...(manifest.workflowsPath ? [manifest.workflowsPath] : []),
    ...(manifest.workflowsPaths ?? []),
  ];
  return paths.length > 0 ? paths : undefined;
}

function extractCommandsMetadata(
  commands: unknown,
): Record<string, CommandMetadata> | undefined {
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
    return undefined;
  }
  // If it's a plain object (not a string path), it's the metadata format
  return commands as Record<string, CommandMetadata>;
}

/**
 * Check if a directory looks like a plugin (has any convention subdirectories/files).
 */
export async function hasPluginConventionContent(
  dir: string,
): Promise<boolean> {
  const conventionChecks = await Promise.all(
    PLUGIN_CONVENTION_ENTRIES.map((entry) =>
      entry.checkType === 'dir'
        ? isDirectory(join(dir, entry.path))
        : exists(join(dir, entry.path)),
    ),
  );
  return conventionChecks.some(Boolean);
}

/**
 * Whether a directory should be treated as a plugin root by the loader.
 *
 * Combines the two signals the loader actually accepts (any convention
 * directory/file OR a supported plugin manifest), so the
 * three sites that ask "is this a plugin?" can't drift apart:
 *
 *   - `loadAllPlugins` discovery (top-level + subdirectory passes)
 *   - `pluginArchiveRoot.detectSingleWrapperDir` (decide whether to strip
 *     a GitHub-style `repo-branch/` wrapper)
 */
export async function looksLikePluginRoot(dir: string): Promise<boolean> {
  if (await hasPluginConventionContent(dir)) return true;
  return (await findManifestPath(dir)) !== null;
}

/**
 * Load all plugins from a list of directories.
 *
 * Each directory may contain either:
 * - A single plugin (has convention subdirectories/files or a manifest)
 * - Multiple plugins (subdirectories that are themselves plugin directories)
 *
 * @param dirs Array of directory paths to scan
 * @param source Loading source identifier
 * @param repository Repository identifier
 */
export async function loadAllPlugins(
  dirs: string[],
  source: string,
  repository: string,
): Promise<PluginLoadResult> {
  const enabled: LoadedPlugin[] = [];
  const disabled: LoadedPlugin[] = [];
  const errors: PluginError[] = [];

  for (const dir of dirs) {
    const resolvedDir = resolve(dir);

    if (!(await exists(resolvedDir))) {
      errors.push({
        type: 'generic-error',
        source,
        error: `Plugin directory not found: ${resolvedDir}`,
      });
      continue;
    }

    // Check if this directory itself is a plugin root.
    if (await looksLikePluginRoot(resolvedDir)) {
      const result = await loadPluginFromDirectory(
        resolvedDir,
        source,
        repository,
      );
      collectLoadResult(result, enabled, disabled, errors);
      continue;
    }

    // Otherwise, scan subdirectories for plugins
    let entries: string[];
    try {
      entries = await readdir(resolvedDir);
    } catch {
      errors.push({
        type: 'generic-error',
        source,
        error: `Cannot read directory: ${resolvedDir}`,
      });
      continue;
    }

    for (const entry of entries) {
      const subdir = join(resolvedDir, entry);
      if ((await isDirectory(subdir)) && (await looksLikePluginRoot(subdir))) {
        const result = await loadPluginFromDirectory(
          subdir,
          source,
          repository,
        );
        collectLoadResult(result, enabled, disabled, errors);
      }
    }
  }

  return { enabled, disabled, errors };
}

/**
 * Route a plugin load result into the appropriate accumulator arrays.
 */
function collectLoadResult(
  result:
    | { ok: true; plugin: LoadedPlugin }
    | { ok: false; error: PluginError },
  enabled: LoadedPlugin[],
  disabled: LoadedPlugin[],
  errors: PluginError[],
): void {
  if (result.ok) {
    if (result.plugin.enabled) {
      enabled.push(result.plugin);
    } else {
      disabled.push(result.plugin);
    }
    if (result.plugin.warnings) {
      errors.push(...result.plugin.warnings);
    }
  } else {
    errors.push(result.error);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve manifest-declared paths (string or string[]) to absolute paths.
 */
function resolveManifestPaths(
  pluginDir: string,
  paths: string | string[] | Record<string, unknown> | undefined,
): string[] {
  if (!paths) return [];

  if (typeof paths === 'string') {
    return [resolve(pluginDir, paths)];
  }

  if (Array.isArray(paths)) {
    return paths.map((p) => resolve(pluginDir, p));
  }

  // Object-mapping format (for commands) — don't resolve, the metadata handles it
  return [];
}

/**
 * Resolve manifest-declared paths and validate that each exists. Both files
 * and directories are accepted; downstream loaders decide how to interpret
 * each entry.
 *
 * Containment is checked lexically on the declared path only. A manifest may
 * not write `../outside`, but a path
 * inside the plugin that happens to be a symlink to somewhere else is fine:
 * linking component sources into a plugin is a supported layout, and the
 * plugin author controls the link either way.
 */
async function resolveAndValidateManifestPaths(
  pluginDir: string,
  pluginName: string,
  paths: string | string[] | Record<string, unknown> | undefined,
  component: PluginComponent,
  errors: PluginError[],
): Promise<string[]> {
  const resolved = resolveManifestPaths(pluginDir, paths);
  if (resolved.length === 0) return [];

  const absolutePluginDir = resolve(pluginDir);
  const results = await Promise.all(
    resolved.map(async (fullPath) => {
      if (!isPathContained(fullPath, absolutePluginDir)) {
        return {
          ok: false as const,
          fullPath,
          reason: 'outside-plugin-root' as const,
        };
      }
      try {
        await stat(fullPath);
        return { ok: true as const, fullPath };
      } catch {
        return {
          ok: false as const,
          fullPath,
          reason: 'not-found' as const,
        };
      }
    }),
  );

  const validated: string[] = [];
  for (const r of results) {
    if (r.ok) {
      validated.push(r.fullPath);
    } else if (r.reason === 'outside-plugin-root') {
      errors.push({
        type: 'component-load-failed',
        source: 'manifest',
        plugin: pluginName,
        component,
        path: r.fullPath,
        reason: 'Path resolves outside the plugin root',
      });
    } else {
      errors.push({
        type: 'path-not-found',
        source: 'manifest',
        plugin: pluginName,
        path: r.fullPath,
        component,
      });
    }
  }
  return validated;
}

/**
 * Load hooks configuration from the conventional hooks/hooks.json file.
 *
 * Plugin hooks.json MUST use the wrapped format:
 *   { description?: string, hooks: { PreToolUse: [...], ... } }
 *
 * This is aligned with the reference project's PluginHooksSchema.
 * Non-plugin hooks (in settings.json) use the bare format directly.
 *
 * On validation failure, logs a warning and returns undefined (plugin still loads).
 */
async function loadHooksConfig(
  pluginDir: string,
  pluginName: string,
  warnings: PluginError[],
): Promise<PluginHooksConfig | undefined> {
  const hooksJsonPath = join(pluginDir, 'hooks', 'hooks.json');

  if (!(await exists(hooksJsonPath))) {
    return undefined;
  }
  return loadHooksFromFile(
    hooksJsonPath,
    pluginDir,
    pluginName,
    warnings,
    true,
  );
}

/**
 * Resolve manifest-declared hooks (can be inline config, path to JSON, or array of both).
 * Uses realpath-based deduplication to avoid loading the same file twice.
 */
async function resolveManifestHooks(
  pluginDir: string,
  hooks: unknown,
  pluginName: string,
  warnings: PluginError[],
  manifestPath: string,
): Promise<PluginHooksConfig | undefined> {
  if (!hooks) return undefined;

  // If it's a string, treat as path to JSON file
  if (typeof hooks === 'string') {
    return loadHooksFromFile(
      resolve(pluginDir, hooks),
      pluginDir,
      pluginName,
      warnings,
    );
  }

  // If it's an array, merge all entries with dedup
  if (Array.isArray(hooks)) {
    let merged: PluginHooksConfig = {};
    const loadedPaths = new Set<string>();
    for (const [index, entry] of hooks.entries()) {
      let config: PluginHooksConfig | undefined;
      if (typeof entry === 'string') {
        const filePath = resolve(pluginDir, entry);
        // Deduplicate by realpath
        let normalizedPath: string;
        try {
          normalizedPath = await realpath(filePath);
        } catch {
          normalizedPath = filePath;
        }
        if (loadedPaths.has(normalizedPath)) {
          debugLogger.warn(
            `[Plugin Loader] Skipping duplicate hooks file: ${entry}`,
          );
          continue;
        }
        loadedPaths.add(normalizedPath);
        config = await loadHooksFromFile(
          filePath,
          pluginDir,
          pluginName,
          warnings,
        );
      } else {
        config = parseHooksConfig(entry, `plugin:${resolve(manifestPath)}#manifest.hooks[${index}]`);
      }
      if (config) {
        merged = mergeHooksConfig(merged, config) ?? merged;
      }
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  // Otherwise treat as inline hooks config
  return parseHooksConfig(hooks, `plugin:${resolve(manifestPath)}#manifest.hooks`);
}

/**
 * Load hooks from a JSON file path.
 */
async function loadHooksFromFile(
  filePath: string,
  pluginDir: string,
  pluginName: string,
  warnings: PluginError[],
  wrapped = false,
): Promise<PluginHooksConfig | undefined> {
  try {
    const canonicalPluginDir = await realpath(pluginDir);
    const canonicalFilePath = await realpath(filePath);
    if (!isPathContained(canonicalFilePath, canonicalPluginDir)) {
      warnings.push({
        type: 'component-load-failed',
        source: 'manifest',
        plugin: pluginName,
        component: 'hooks',
        path: filePath,
        reason: 'Path resolves outside the plugin root',
      });
      return undefined;
    }

    const raw = await readFile(canonicalFilePath, 'utf-8');
    const json = JSON.parse(raw);
    const result = wrapped
      ? PluginHooksSchema.safeParse(json)
      : PluginHooksConfigSchema.safeParse(json.hooks ?? json);
    if (result.success) {
      const config = (wrapped ? result.data.hooks : result.data) as PluginHooksConfig;
      rememberPluginHookRefs(config, `plugin:${resolve(filePath)}`);
      return config;
    }
    const reason = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    warnings.push({
      type: 'hook-load-failed',
      source: wrapped ? 'convention' : 'manifest',
      plugin: pluginName,
      hookPath: filePath,
      reason,
    });
    debugLogger.warn(
      `[Plugin Loader] hooks file ${filePath}: validation failed: ${reason}`,
    );
    return undefined;
  } catch (error) {
    const reason = getErrorMessage(error);
    warnings.push({
      type: 'hook-load-failed',
      source: wrapped ? 'convention' : 'manifest',
      plugin: pluginName,
      hookPath: filePath,
      reason,
    });
    debugLogger.warn(
      `[Plugin Loader] hooks file ${filePath}: parse error: ${reason}`,
    );
    return undefined;
  }
}

/**
 * Parse an inline hooks configuration object.
 */
function parseHooksConfig(data: unknown, source: string): PluginHooksConfig | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const result = PluginHooksConfigSchema.safeParse(data);
  if (!result.success) return undefined;
  rememberPluginHookRefs(result.data, source);
  return result.data as PluginHooksConfig;
}

/**
 * Merge two hooks configs, concatenating hook arrays for the same event.
 */
function mergeHooksConfig(
  a: PluginHooksConfig | undefined,
  b: PluginHooksConfig | undefined,
): PluginHooksConfig | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;

  const merged: PluginHooksConfig = { ...a };
  for (const [key, hooks] of Object.entries(b)) {
    const eventKey = key as keyof PluginHooksConfig;
    const existing = merged[eventKey] ?? [];
    merged[eventKey] = [...existing, ...(hooks ?? [])] as typeof existing;
  }
  return merged;
}

/**
 * Resolve manifest-declared MCP servers.
 * Can be inline config, path to JSON, or array of both.
 *
 * Convention fallback: when the manifest does not exhaustively declare MCP
 * servers, we read the first existing file from `MCP_CONVENTION_FILES`
 * (`.mcp.json` then `mcp.json`). The two convention files are **never merged**
 * — picking only one prevents an ecosystem-portability plugin from
 * accidentally launching two batches of identical servers. Manifest entries
 * still win on key conflict (existing behaviour preserved).
 */
async function resolveManifestMcpServers(
  pluginDir: string,
  mcpServers: unknown,
  pluginName: string,
  warnings: PluginError[],
): Promise<Record<string, unknown> | undefined> {
  // First existing candidate wins (no merge). `loadMcpServersFromFile`
  // returns `undefined` on missing file OR unparseable JSON, so a malformed
  // `.mcp.json` quietly degrades to "no convention servers" while still
  // leaving `mcp.json` untried — that's intentional ("found-but-broken still
  // wins") so we don't accidentally launch the fallback's server set.
  let conventionServers: Record<string, unknown> | undefined;
  for (const candidate of MCP_CONVENTION_FILES) {
    const candidatePath = join(pluginDir, candidate);
    if (!(await exists(candidatePath))) continue;
    conventionServers = await loadMcpServersFromFile(
      candidatePath,
      pluginDir,
      pluginName,
      warnings,
      'convention',
    );
    break;
  }

  let manifestServers: Record<string, unknown> | undefined;

  if (mcpServers) {
    if (typeof mcpServers === 'string') {
      // Path to JSON file
      manifestServers = await loadMcpServersFromFile(
        resolve(pluginDir, mcpServers),
        pluginDir,
        pluginName,
        warnings,
        'manifest',
      );
    } else if (Array.isArray(mcpServers)) {
      manifestServers = {};
      for (const entry of mcpServers) {
        let servers: Record<string, unknown> | undefined;
        if (typeof entry === 'string') {
          servers = await loadMcpServersFromFile(
            resolve(pluginDir, entry),
            pluginDir,
            pluginName,
            warnings,
            'manifest',
          );
        } else if (typeof entry === 'object' && entry !== null) {
          servers = entry as Record<string, unknown>;
        }
        if (servers) {
          Object.assign(manifestServers, servers);
        }
      }
    } else if (typeof mcpServers === 'object' && mcpServers !== null) {
      manifestServers = mcpServers as Record<string, unknown>;
    }
  }

  // Merge convention + manifest servers
  if (!conventionServers && !manifestServers) return undefined;
  const merged = {
    ...(conventionServers ?? {}),
    ...(manifestServers ?? {}),
  };

  // Validate all merged entries against the Zod schema.
  validateMcpServerEntries(merged, pluginName, warnings);

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Validate MCP server entries in-place against the Zod schema.
 * Drops entries with type errors (e.g. command: 123, args: "not-array").
 */
function validateMcpServerEntries(
  servers: Record<string, unknown>,
  pluginName: string,
  warnings: PluginError[],
): void {
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    const result = McpServerConfigSchema.safeParse(serverConfig);
    if (!result.success) {
      warnings.push({
        type: 'mcp-config-invalid',
        source: 'plugin',
        plugin: pluginName,
        serverName,
        validationError: result.error.message,
      });
      debugLogger.warn(
        `[resolveManifestMcpServers] Skipping invalid MCP server "${serverName}": ${result.error.message}`,
      );
      delete servers[serverName];
    }
  }
}

/**
 * Load MCP server configs from a JSON file.
 */
async function loadMcpServersFromFile(
  filePath: string,
  pluginDir: string,
  pluginName: string,
  warnings: PluginError[],
  source: 'convention' | 'manifest',
): Promise<Record<string, unknown> | undefined> {
  try {
    const canonicalPluginDir = await realpath(pluginDir);
    const canonicalFilePath = await realpath(filePath);
    if (!isPathContained(canonicalFilePath, canonicalPluginDir)) {
      warnings.push({
        type: 'component-load-failed',
        source,
        plugin: pluginName,
        component: 'mcp-servers',
        path: filePath,
        reason: 'Path resolves outside the plugin root',
      });
      return undefined;
    }
    const raw = await readFile(canonicalFilePath, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    return (json['mcpServers'] ?? json) as Record<string, unknown>;
  } catch (error) {
    warnings.push({
      type: 'component-load-failed',
      source,
      plugin: pluginName,
      component: 'mcp-servers',
      path: filePath,
      reason: getErrorMessage(error),
    });
    return undefined;
  }
}
