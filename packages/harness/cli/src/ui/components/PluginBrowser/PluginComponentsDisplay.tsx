/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PluginComponentsDisplay — Shows individual resource names for a plugin.
 *
 * Reads the plugin's command, agent, and skill directories asynchronously
 * to display the exact names of each resource, rather than just a flat
 * "Commands, Skills, MCP Servers (2)" summary.
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  FRONTMATTER_REGEX,
  deriveCommandName,
  type LoadedPlugin,
} from '@qwen-code/core';
import { theme } from '../../semantic-colors.js';

// ---------------------------------------------------------------------------
// Directory reading helpers
// ---------------------------------------------------------------------------

/**
 * Reads .md file base names from a directory (non-recursive by default).
 * Used for agents which follow the `<name>.md` convention.
 * When `recursive` is true, also scans subdirectories (used for output styles).
 */
async function getBaseFileNames(
  dirPath: string,
  options?: { recursive?: boolean },
): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        names.push(path.basename(entry.name, '.md'));
      } else if (entry.isDirectory() && options?.recursive) {
        const nested = await getBaseFileNames(
          path.join(dirPath, entry.name),
          options,
        );
        names.push(...nested);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Scans a command directory recursively and returns namespaced command names
 * derived from the file path (e.g. `commands/foo/bar.md` → `foo:bar`). Matches
 * the identity scheme used by the slash menu.
 */
async function getCommandNamesFromDir(
  baseDir: string,
  currentDir: string = baseDir,
): Promise<string[]> {
  try {
    const entries = await readdir(currentDir, { withFileTypes: true });
    const names: string[] = [];
    const mdFiles = entries.filter(
      (e) => e.isFile() && e.name.endsWith('.md'),
    );
    const skillEntry = mdFiles.find((e) => /^skill\.md$/i.test(e.name));
    // Mirror runtime suppression: SKILL.md hides sibling .md files in the
    // same directory; subdirectories are unaffected.
    const mdToProcess = skillEntry ? [skillEntry] : mdFiles;
    for (const entry of mdToProcess) {
      const full = path.join(currentDir, entry.name);
      const derived = deriveCommandName({
        filePath: full,
        baseDir,
        isSkillFile: /^skill\.md$/i.test(entry.name),
      });
      if (derived) names.push(derived.displayBase);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = await getCommandNamesFromDir(
          baseDir,
          path.join(currentDir, entry.name),
        );
        names.push(...nested);
      }
    }
    return names;
  } catch {
    return [];
  }
}

async function getSkillNameFromFile(
  filePath: string,
  fallbackName: string,
): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const match = content.match(FRONTMATTER_REGEX);
    if (match) {
      const nameMatch = match[1].match(/^name:\s*(.+)$/m);
      if (nameMatch) {
        return nameMatch[1].trim().replace(/^["'](.+)["']$/, '$1');
      }
    }
  } catch {
    // Fall through to fallback
  }
  return fallbackName;
}

/**
 * Reads skill names from a skills directory.
 * Supports two patterns:
 * 1. Direct: SKILL.md at the top level — parses frontmatter for the real name
 * 2. Subdirectory: each subdirectory containing SKILL.md uses the directory name
 */
async function getSkillDirNames(dirPath: string): Promise<string[]> {
  try {
    const directSkillPath = path.join(dirPath, 'SKILL.md');
    try {
      const st = await stat(directSkillPath);
      if (st.isFile()) {
        const name = await getSkillNameFromFile(
          directSkillPath,
          path.basename(dirPath),
        );
        return [name];
      }
    } catch {
      // No direct SKILL.md — fall through to scan subdirs
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    const skillNames: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const skillFilePath = path.join(dirPath, entry.name, 'SKILL.md');
        try {
          const st = await stat(skillFilePath);
          if (st.isFile()) {
            skillNames.push(entry.name);
          }
        } catch {
          // No SKILL.md in this directory — skip
        }
      }
    }
    return skillNames;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Resolved component names
// ---------------------------------------------------------------------------

interface ResolvedComponents {
  commands: string[];
  agents: string[];
  skills: string[];
  hooks: string[];
  mcpServers: string[];
  outputStyles: string[];
}

/**
 * Collect all directory paths for a given resource type.
 */
function collectPaths(
  plugin: LoadedPlugin,
  conventionPath: string | undefined,
  manifestPaths: string[] | undefined,
): string[] {
  const paths: string[] = [];
  if (conventionPath) paths.push(conventionPath);
  if (manifestPaths) {
    for (const p of manifestPaths) {
      const fullPath = path.isAbsolute(p) ? p : path.join(plugin.path, p);
      if (!paths.includes(fullPath)) {
        paths.push(fullPath);
      }
    }
  }
  return paths;
}

/**
 * Asynchronously resolve all component names for a plugin.
 */
async function resolveComponents(
  plugin: LoadedPlugin,
): Promise<ResolvedComponents> {
  const result: ResolvedComponents = {
    commands: [],
    agents: [],
    skills: [],
    hooks: [],
    mcpServers: [],
    outputStyles: [],
  };

  // Commands: read .md files from command directories with namespacing
  const cmdPaths = collectPaths(
    plugin,
    plugin.commandsPath,
    plugin.commandsPaths,
  );
  for (const dir of cmdPaths) {
    const names = await getCommandNamesFromDir(dir);
    for (const n of names) {
      if (!result.commands.includes(n)) result.commands.push(n);
    }
  }

  // Also include metadata-defined commands
  if (plugin.commandsMetadata) {
    for (const name of Object.keys(plugin.commandsMetadata)) {
      if (!result.commands.includes(name)) result.commands.push(name);
    }
  }

  // Agents: read .md files from agent directories
  const agentPaths = collectPaths(
    plugin,
    plugin.agentsPath,
    plugin.agentsPaths,
  );
  for (const dir of agentPaths) {
    const names = await getBaseFileNames(dir);
    for (const n of names) {
      if (!result.agents.includes(n)) result.agents.push(n);
    }
  }

  // Skills
  const skillPaths = collectPaths(
    plugin,
    plugin.skillsPath,
    plugin.skillsPaths,
  );
  for (const dir of skillPaths) {
    const names = await getSkillDirNames(dir);
    for (const n of names) {
      if (!result.skills.includes(n)) result.skills.push(n);
    }
  }

  // Hooks: from hooksConfig keys
  if (plugin.hooksConfig) {
    result.hooks = Object.keys(plugin.hooksConfig);
  }

  // MCP Servers: from mcpServers keys
  if (plugin.mcpServers) {
    result.mcpServers = Object.keys(plugin.mcpServers);
  }

  // Output Styles: read .md files from output-styles directories (recursive)
  const outputStylePaths = collectPaths(
    plugin,
    plugin.outputStylesPath,
    plugin.outputStylesPaths,
  );
  for (const dir of outputStylePaths) {
    const names = await getBaseFileNames(dir, { recursive: true });
    for (const n of names) {
      if (!result.outputStyles.includes(n)) result.outputStyles.push(n);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface PluginComponentsDisplayProps {
  plugin: LoadedPlugin;
}

/**
 * Renders a detailed list of all resource names provided by a plugin.
 *
 * Uses `useEffect` to asynchronously read directories. Displays a loading
 * indicator while resolving, then shows each resource type with individual
 * names as a comma-joined list.
 */
export function PluginComponentsDisplay({
  plugin,
}: PluginComponentsDisplayProps): React.JSX.Element | null {
  const [components, setComponents] = useState<ResolvedComponents | null>(null);

  useEffect(() => {
    let cancelled = false;
    void resolveComponents(plugin).then((resolved) => {
      if (!cancelled) setComponents(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [plugin]);

  if (!components) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Loading components...</Text>
      </Box>
    );
  }

  // Check if there are any components at all
  const hasAny =
    components.commands.length > 0 ||
    components.agents.length > 0 ||
    components.skills.length > 0 ||
    components.hooks.length > 0 ||
    components.mcpServers.length > 0 ||
    components.outputStyles.length > 0;

  if (!hasAny) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.text.primary} bold>
        Components:
      </Text>
      {components.commands.length > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>Commands: {components.commands.join(', ')}</Text>
        </Box>
      )}
      {components.agents.length > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>Agents: {components.agents.join(', ')}</Text>
        </Box>
      )}
      {components.skills.length > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>Skills: {components.skills.join(', ')}</Text>
        </Box>
      )}
      {components.hooks.length > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>Hooks: {components.hooks.join(', ')}</Text>
        </Box>
      )}
      {components.mcpServers.length > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>MCP Servers: {components.mcpServers.join(', ')}</Text>
        </Box>
      )}
      {components.outputStyles.length > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>
            Output Styles: {components.outputStyles.join(', ')}
          </Text>
        </Box>
      )}
    </Box>
  );
}
