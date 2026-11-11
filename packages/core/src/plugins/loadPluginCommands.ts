/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { LoadedPlugin, CommandMetadata } from './types.js';
import { getLoadedPluginId } from './management/pluginDependencies.js';
import { runLogger } from '../utils/runLogger.js';
import { deriveCommandName } from '../utils/commandNamespace.js';
import type { SkillDefinition } from '@qwen-code/resource';
import { parseEffortValue } from '../utils/frontmatterParsers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A parsed plugin command definition ready for registration.
 */
export interface PluginCommandDefinition {
  /** Slash command name (no leading slash). Prefixed with `pluginName:` for plugin commands. */
  name: string;
  /**
   * Human-friendly display label sourced from frontmatter `name:`. UI surfaces
   * render `displayName ?? name`; command lookup always uses `name`.
   */
  displayName?: string;
  /** Description for autocomplete UI */
  description: string;
  /** Markdown content (the command instruction/system prompt) */
  content: string;
  /** Argument hint for UI */
  argumentHint?: string;
  /** Model override */
  model?: string;
  /** Allowed tools (query-scoped permission grant) */
  allowedTools?: string[];
  /** Execution context: 'inline' (default) or 'fork' (isolated sub-agent). */
  context: 'fork' | 'inline';
  /** The plugin that owns this command */
  pluginName: string;
  /** Plugin source (for conflict resolution / prefixing) */
  pluginSource: string;
  /** Absolute plugin root dir for branded template substitution. */
  pluginRoot: string;
  /** Canonical plugin id for branded plugin-data directory resolution. */
  pluginId: string;
  /** Description of when the model should invoke this command. */
  whenToUse?: string;
  /** Named argument definitions from frontmatter `arguments` field. */
  argNames?: string[];
  /** Effort level override (raw string, consumer parses). */
  effort?: string;
  /** When true, the model cannot invoke this command via SkillTool. */
  disableModelInvocation?: boolean;
  /** When false, command is hidden from user slash-command picker. Defaults to true. */
  userInvocable?: boolean;
  /** Agent type for forked execution (e.g. 'general-purpose'). Only meaningful with context: 'fork'. */
  agent?: string;
  /**
   * Absolute path to the source markdown file when this command is file-backed.
   * Undefined for manifest inline-content commands (where content was provided
   * directly in the plugin manifest rather than loaded from a file).
   */
  sourcePath?: string;
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser (minimal, avoids external dependency)
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  argumentHint?: string;
  model?: string;
  allowedTools?: string[];
  context?: 'fork' | 'inline';
  whenToUse?: string;
  argNames?: string[];
  effort?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  agent?: string;
}

/**
 * Parse a boolean-ish frontmatter value.
 */
function parseBooleanValue(value: string): boolean {
  const lower = value.toLowerCase();
  return lower === 'true' || lower === 'yes' || lower === '1';
}

/**
 * Parse a list value from inline array `[a, b]` form. YAML block-list
 * (`- item`) form is scanned inline by each list-valued case below.
 */
function parseInlineList(value: string): string[] | null {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return null;
}

/**
 * Simple frontmatter parser.
 * Handles `---` delimited YAML at the start of a file.
 * Supports flat scalar values, simple string arrays, and boolean-ish values.
 */
function parseFrontmatter(raw: string): {
  frontmatter: ParsedFrontmatter;
  body: string;
} {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: raw };
  }

  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: raw };
  }

  const yamlBlock = trimmed.slice(4, endIndex); // skip first "---\n"
  const body = trimmed.slice(endIndex + 4); // skip closing "---\n"
  const frontmatter: ParsedFrontmatter = {};
  const lines = yamlBlock.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const stripped = lines[lineIdx].trim();
    if (!stripped || stripped.startsWith('#')) continue;

    const colonIdx = stripped.indexOf(':');
    if (colonIdx === -1) continue;

    const key = stripped.slice(0, colonIdx).trim();
    let value = stripped.slice(colonIdx + 1).trim();

    // Handle quoted strings
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    switch (key) {
      case 'name':
        frontmatter.name = value;
        break;
      case 'description':
        frontmatter.description = value;
        break;
      case 'argument-hint':
      case 'argumentHint':
        if (!frontmatter.argumentHint) frontmatter.argumentHint = value;
        break;
      case 'model':
        frontmatter.model = value;
        break;
      case 'context':
        if (!frontmatter.context && (value === 'fork' || value === 'inline')) {
          frontmatter.context = value;
        }
        break;
      case 'allowed-tools':
      case 'allowedTools': {
        if (frontmatter.allowedTools) break;
        const inlineArr = parseInlineList(value);
        if (inlineArr) {
          frontmatter.allowedTools = inlineArr;
        } else if (value) {
          // Comma-separated string: "Edit, Write, Bash"
          frontmatter.allowedTools = value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          // Value is empty — check for YAML list on following lines
          const tools: string[] = [];
          for (let i = lineIdx + 1; i < lines.length; i++) {
            const l = lines[i].trim();
            if (l.startsWith('- ')) {
              tools.push(l.slice(2).replace(/^['"]|['"]$/g, ''));
            } else if (l && !l.startsWith('#')) {
              break;
            }
          }
          if (tools.length > 0) {
            frontmatter.allowedTools = tools;
          }
        }
        break;
      }
      case 'arguments': {
        if (frontmatter.argNames) break;
        const inlineArr = parseInlineList(value);
        if (inlineArr) {
          frontmatter.argNames = inlineArr;
        } else if (value) {
          // Space-separated or comma-separated
          frontmatter.argNames = value.includes(',')
            ? value.split(',').map((s) => s.trim()).filter(Boolean)
            : value.split(/\s+/).filter(Boolean);
        } else {
          // YAML list
          const args: string[] = [];
          for (let i = lineIdx + 1; i < lines.length; i++) {
            const l = lines[i].trim();
            if (l.startsWith('- ')) {
              args.push(l.slice(2).replace(/^['"]|['"]$/g, ''));
            } else if (l && !l.startsWith('#')) {
              break;
            }
          }
          if (args.length > 0) {
            frontmatter.argNames = args;
          }
        }
        break;
      }
      case 'when-to-use':
      case 'when_to_use':
      case 'whenToUse':
        if (!frontmatter.whenToUse) frontmatter.whenToUse = value;
        break;
      case 'effort':
        if (value) frontmatter.effort = value;
        break;
      case 'disable-model-invocation':
      case 'disableModelInvocation':
        if (frontmatter.disableModelInvocation === undefined) {
          frontmatter.disableModelInvocation = parseBooleanValue(value);
        }
        break;
      case 'user-invocable':
      case 'userInvocable':
        if (frontmatter.userInvocable === undefined) {
          frontmatter.userInvocable = parseBooleanValue(value);
        }
        break;
      case 'agent':
        if (value) frontmatter.agent = value;
        break;
      default:
        break;
    }
  }

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

/**
 * Recursively finds all .md files in a directory.
 */
function findMarkdownFiles(dir: string, rootDir?: string): string[] {
  const root = rootDir ?? dir;
  const results: string[] = [];

  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...findMarkdownFiles(full, root));
      } else if (entry.endsWith('.md')) {
        results.push(full);
      }
    } catch {
      // Skip unreadable entries
    }
  }
  return results;
}

/**
 * Returns true when the basename matches `SKILL.md` (case-insensitive).
 */
function isPluginSkillFile(filePath: string): boolean {
  return /^skill\.md$/i.test(basename(filePath));
}

function transformPluginSkillFiles(files: string[]): string[] {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = dirname(f);
    let bucket = byDir.get(dir);
    if (!bucket) {
      bucket = [];
      byDir.set(dir, bucket);
    }
    bucket.push(f);
  }

  const out: string[] = [];
  for (const [, dirFiles] of byDir) {
    const skill = dirFiles.find(isPluginSkillFile);
    if (skill) {
      out.push(skill);
    } else {
      out.push(...dirFiles);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads all command definitions from a single plugin.
 *
 * Sources (in order of precedence for name conflicts):
 * 1. commandsMetadata from manifest (object-mapping format)
 * 2. commandsPath (conventional commands/ directory)
 * 3. commandsPaths (additional paths declared in manifest)
 */
export function loadPluginCommands(
  plugin: LoadedPlugin,
): PluginCommandDefinition[] {
  const commands: PluginCommandDefinition[] = [];
  const seenNames = new Set<string>();

  // 1. Object-mapping commands from manifest (highest priority)
  if (plugin.commandsMetadata) {
    for (const [name, meta] of Object.entries(plugin.commandsMetadata)) {
      const def = loadCommandFromMetadata(name, meta, plugin, seenNames);
      if (def) {
        commands.push(def);
        seenNames.add(def.name);
      }
    }
  }

  // 2. Conventional commands/ directory
  if (plugin.commandsPath) {
    const defs = loadCommandsFromDirectory(plugin.commandsPath, plugin);
    for (const def of defs) {
      if (seenNames.has(def.name)) {
        runLogger.warn(
          `[plugin ${plugin.name}] command '${def.name}' collides with a higher-priority definition; skipping duplicate`,
        );
        continue;
      }
      commands.push(def);
      seenNames.add(def.name);
    }
  }

  // 3. Additional paths from manifest
  if (plugin.commandsPaths) {
    for (const cmdPath of plugin.commandsPaths) {
      // commandsPaths are already absolute (resolveManifestPaths uses
      // path.resolve). Do not re-join with plugin.path.
      const fullPath = cmdPath;
      if (!existsSync(fullPath)) continue;

      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const defs = loadCommandsFromDirectory(fullPath, plugin);
        for (const def of defs) {
          if (seenNames.has(def.name)) {
            runLogger.warn(
              `[plugin ${plugin.name}] command '${def.name}' from ${fullPath} collides with a higher-priority definition; skipping duplicate`,
            );
            continue;
          }
          commands.push(def);
          seenNames.add(def.name);
        }
      } else if (fullPath.endsWith('.md')) {
        // Single-file commandsPaths have no enclosing commands directory, so
        // there is no namespace to derive — only the bare basename.
        const leaf = basename(fullPath, '.md');
        if (!leaf) continue;
        const identity = `${plugin.name}:${leaf}`;
        const def = loadCommandFromFile(fullPath, identity, leaf, plugin);
        if (!def) continue;
        if (seenNames.has(def.name)) {
          runLogger.warn(
            `[plugin ${plugin.name}] command '${def.name}' from ${fullPath} collides with a higher-priority definition; skipping duplicate`,
          );
          continue;
        }
        commands.push(def);
        seenNames.add(def.name);
      }
    }
  }

  return commands;
}

/**
 * Memoizes `loadPluginCommands` results per plugin object so repeated calls
 * (e.g. one from `SkillManager.discoverSkills` for fork commands and one from
 * `PluginCommandLoader.loadCommands` for inline commands) reuse the same
 * filesystem walk and YAML parse work instead of re-reading every command
 * file twice during startup.
 *
 * Cache is invalidated naturally — when the plugin set is reloaded the old
 * `LoadedPlugin` objects get garbage-collected and their cache entries
 * disappear with them.
 */
const PLUGIN_COMMANDS_CACHE = new WeakMap<
  LoadedPlugin,
  PluginCommandDefinition[]
>();

function loadPluginCommandsCached(
  plugin: LoadedPlugin,
): PluginCommandDefinition[] {
  const cached = PLUGIN_COMMANDS_CACHE.get(plugin);
  if (cached) return cached;
  const fresh = loadPluginCommands(plugin);
  PLUGIN_COMMANDS_CACHE.set(plugin, fresh);
  return fresh;
}

/**
 * Loads commands from all enabled plugins.
 */
export function loadAllPluginCommands(
  plugins: LoadedPlugin[],
): PluginCommandDefinition[] {
  const commands: PluginCommandDefinition[] = [];
  for (const plugin of plugins) {
    if (plugin.enabled === false) continue;
    commands.push(...loadPluginCommandsCached(plugin));
  }
  return commands;
}

/**
 * Converts a fork-context plugin command into a `SkillDefinition` so it can
 * be registered with `SkillManager` and surfaced via `SkillCommandLoader`.
 *
 * `context: 'inline'` commands are NOT converted — they remain on the
 * lightweight `PluginCommandLoader` pipeline. Fork commands use the plugin
 * root as their skill-relative base, while manifest inline-content commands
 * retain a synthetic `location` for source reporting.
 */
function pluginCommandToSkill(
  cmd: PluginCommandDefinition,
): SkillDefinition {
  const parsedEffort =
    cmd.effort !== undefined ? parseEffortValue(cmd.effort) : undefined;
  return {
    name: cmd.name,
    displayName: cmd.displayName,
    description: cmd.description,
    body: cmd.content,
    location: cmd.sourcePath ?? join(cmd.pluginRoot, 'commands', '__inline__'),
    skillRoot: cmd.pluginRoot,
    source: 'plugin',
    pluginName: cmd.pluginName,
    pluginPath: cmd.pluginRoot,
    pluginId: cmd.pluginId,
    model: cmd.model,
    allowedTools: cmd.allowedTools?.length ? cmd.allowedTools : undefined,
    whenToUse: cmd.whenToUse,
    argumentHint: cmd.argumentHint,
    arguments: cmd.argNames?.length
      ? cmd.argNames.map((name) => ({ name }))
      : undefined,
    disableModelInvocation: cmd.disableModelInvocation,
    userInvocable: cmd.userInvocable,
    effort: parsedEffort,
    context: 'fork',
    agent: cmd.agent,
    hasUserSpecifiedDescription: true,
    kind: 'plugin-command',
  };
}

/**
 * Loads all fork-context plugin commands and converts them into
 * `SkillDefinition` records for `SkillManager` registration. Inline plugin
 * commands are filtered out — those continue to be handled directly by
 * `PluginCommandLoader`.
 */
export function loadAllPluginCommandsAsForkSkills(
  plugins: LoadedPlugin[],
): SkillDefinition[] {
  return loadAllPluginCommands(plugins)
    .filter((cmd) => cmd.context === 'fork')
    .map(pluginCommandToSkill);
}

// ---------------------------------------------------------------------------
// Internal loaders
// ---------------------------------------------------------------------------

function loadCommandsFromDirectory(
  dir: string,
  plugin: LoadedPlugin,
): PluginCommandDefinition[] {
  const allFiles = findMarkdownFiles(dir);
  const files = transformPluginSkillFiles(allFiles);
  const commands: PluginCommandDefinition[] = [];

  for (const file of files) {
    const derived = deriveCommandName({
      filePath: file,
      baseDir: dir,
      isSkillFile: isPluginSkillFile(file),
      pluginName: plugin.name,
    });
    if (!derived) {
      runLogger.warn(
        `[plugin ${plugin.name}] cannot derive command name for ${file}; skipping`,
      );
      continue;
    }
    const def = loadCommandFromFile(
      file,
      derived.identity,
      derived.displayBase,
      plugin,
    );
    if (def) {
      commands.push(def);
    }
  }

  return commands;
}

function loadCommandFromFile(
  filePath: string,
  identity: string,
  displayBase: string,
  plugin: LoadedPlugin,
): PluginCommandDefinition | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);

    if (!identity) return null;

    const frontmatterDisplayName = frontmatter.name?.trim();
    const displayName =
      frontmatterDisplayName && frontmatterDisplayName.length > 0
        ? frontmatterDisplayName
        : displayBase !== identity
          ? displayBase
          : undefined;

    const ctx = frontmatter.context ?? 'inline';

    return {
      name: identity,
      ...(displayName ? { displayName } : {}),
      description:
        frontmatter.description ?? `${plugin.name} command: ${displayBase}`,
      content: body.trim(),
      argumentHint: frontmatter.argumentHint,
      model: frontmatter.model,
      allowedTools: frontmatter.allowedTools,
      context: ctx,
      pluginName: plugin.name,
      pluginSource: plugin.source,
      pluginRoot: plugin.path,
      pluginId: getLoadedPluginId(plugin),
      whenToUse: frontmatter.whenToUse,
      argNames: frontmatter.argNames,
      effort: frontmatter.effort,
      disableModelInvocation: frontmatter.disableModelInvocation,
      userInvocable: frontmatter.userInvocable,
      agent: frontmatter.agent,
      sourcePath: filePath,
    };
  } catch {
    return null;
  }
}

function loadCommandFromMetadata(
  name: string,
  meta: CommandMetadata,
  plugin: LoadedPlugin,
  seenNames: Set<string>,
): PluginCommandDefinition | null {
  let content: string;
  let fileFrontmatter: ParsedFrontmatter = {};
  let fullPath: string | undefined;

  if (meta.content) {
    content = meta.content;
  } else if (meta.source) {
    fullPath = join(plugin.path, meta.source);
    try {
      const raw = readFileSync(fullPath, 'utf-8');
      const parsed = parseFrontmatter(raw);
      content = parsed.body.trim();
      fileFrontmatter = parsed.frontmatter;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const commandName = `${plugin.name}:${name}`;

  // Skip duplicate manifest keys (real same-key collisions; no sanitization
  // collapse anymore since we no longer rewrite characters).
  if (seenNames.has(commandName)) {
    runLogger.warn(
      `[plugin ${plugin.name}] manifest key '${name}' collides with existing '${commandName}'; skipping`,
    );
    return null;
  }

  // Manifest metadata fields override file frontmatter; default to 'inline'
  const ctx: 'fork' | 'inline' =
    meta.context ?? fileFrontmatter.context ?? 'inline';

  return {
    name: commandName,
    description: meta.description ?? fileFrontmatter.description ?? `${plugin.name} command: ${name}`,
    content: content.trim(),
    argumentHint: meta.argumentHint ?? fileFrontmatter.argumentHint,
    model: meta.model ?? fileFrontmatter.model,
    allowedTools: meta.allowedTools ?? fileFrontmatter.allowedTools,
    context: ctx,
    pluginName: plugin.name,
    pluginSource: plugin.source,
    pluginRoot: plugin.path,
    pluginId: getLoadedPluginId(plugin),
    whenToUse: fileFrontmatter.whenToUse,
    argNames: meta.arguments ?? fileFrontmatter.argNames,
    effort: meta.effort ?? fileFrontmatter.effort,
    disableModelInvocation: fileFrontmatter.disableModelInvocation,
    userInvocable: fileFrontmatter.userInvocable,
    agent: meta.agent ?? fileFrontmatter.agent,
    ...(fullPath ? { sourcePath: fullPath } : {}),
  };
}
