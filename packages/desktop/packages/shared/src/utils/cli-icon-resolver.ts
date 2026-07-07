/**
 * CLI Tool Icon Resolver
 *
 * Parses bash command strings to detect known CLI tools (git, npm, docker, etc.)
 * and resolves their display name + icon for turn card rendering.
 *
 * The mapping lives in ~/.craft-agent/tool-icons/tool-icons.json alongside the
 * icon files, so users can customize tools and icons.
 *
 * Command parsing handles:
 * - Simple commands: `git status`
 * - Environment variable prefixes: `NODE_ENV=prod npm run build`
 * - Chained commands: `git add . && npm publish`
 * - Pipes: `git log | head -10`
 * - Prefix commands: `sudo docker ps`, `time npm test`
 * - Path prefixes: `/usr/local/bin/node` → `node`
 * - Relative paths: `./node_modules/.bin/jest` → `jest`
 */

import { existsSync } from 'fs';
import { join, basename } from 'path';
import { parse as shellParse } from 'shell-quote';
import { encodeIconToDataUrl } from './icon-encoder.ts';
import { readJsonFileSync } from './files.ts';

// ============================================
// Types
// ============================================

export interface ToolIconEntry {
  /** Unique tool identifier, e.g. "git" */
  id: string;
  /** Human-readable name shown in UI, e.g. "Git" */
  displayName: string;
  /** Icon filename in the same directory as tool-icons.json, e.g. "git.ico" */
  icon: string;
  /** CLI command names that map to this tool, e.g. ["git"] */
  commands: string[];
}

export interface ToolIconConfig {
  /** Schema version for forward compatibility */
  version: number;
  /** Array of tool definitions */
  tools: ToolIconEntry[];
}

export interface ToolIconMatch {
  /** Tool identifier */
  id: string;
  /** Display name for the UI */
  displayName: string;
  /** Base64-encoded data URL of the icon, ready for <img src="..."> */
  iconDataUrl: string;
}

// ============================================
// Command Parsing
// ============================================

/**
 * Commands that act as transparent prefixes — they run another command,
 * so we skip them and look at the next token for the actual tool name.
 */
const PREFIX_COMMANDS = new Set([
  'sudo', 'time', 'nice', 'nohup', 'env', 'timeout',
  'strace', 'ltrace', 'ionice', 'taskset', 'watch',
  'caffeinate', // macOS
]);

/**
 * Checks if a token is an environment variable assignment (e.g. FOO=bar).
 * These appear before the command name and should be skipped.
 */
function isEnvAssignment(token: string): boolean {
  // Must contain '=' and start with a letter or underscore (valid env var name)
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * Splits a bash command string into individual sub-commands.
 * Splits on &&, ||, ;, and | operators while respecting quoted strings.
 *
 * Returns array of trimmed sub-command strings.
 */
export function splitCommands(commandStr: string): string[] {
  const commands: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < commandStr.length) {
    const char = commandStr[i];
    const next = commandStr[i + 1];

    // Track quote state (skip escaped quotes inside double quotes)
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      i++;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      // Don't toggle on escaped quotes
      if (i > 0 && commandStr[i - 1] === '\\') {
        current += char;
        i++;
        continue;
      }
      inDoubleQuote = !inDoubleQuote;
      current += char;
      i++;
      continue;
    }

    // Only split when outside quotes
    if (!inSingleQuote && !inDoubleQuote) {
      // && operator
      if (char === '&' && next === '&') {
        if (current.trim()) commands.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      // || operator
      if (char === '|' && next === '|') {
        if (current.trim()) commands.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      // | pipe (single, not ||)
      if (char === '|') {
        if (current.trim()) commands.push(current.trim());
        current = '';
        i++;
        continue;
      }
      // ; separator
      if (char === ';') {
        if (current.trim()) commands.push(current.trim());
        current = '';
        i++;
        continue;
      }
    }

    current += char;
    i++;
  }

  // Don't forget the last command
  if (current.trim()) {
    commands.push(current.trim());
  }

  return commands;
}

/**
 * Extracts the command name from a single sub-command string.
 * Strips env var prefixes, transparent prefix commands (sudo, time, etc.),
 * and path prefixes (/usr/local/bin/node → node).
 *
 * Also handles shell wrapper patterns like `/bin/zsh -lc 'git status'` by
 * extracting and recursively parsing the inner command.
 *
 * Returns the bare command name, or undefined if none found.
 */
export function extractCommandName(subCommand: string): string | undefined {
  // Use shell-quote for proper tokenization (handles quotes, escapes, etc.)
  // shell-quote doesn't support all bash syntax (e.g. ${var%pattern} suffix matching)
  // and throws on unsupported constructs — gracefully bail out on parse failures
  let parsed: ReturnType<typeof shellParse>;
  try {
    parsed = shellParse(subCommand);
  } catch {
    return undefined;
  }

  // Filter to string tokens only (shell-quote can return operator objects)
  const tokens = parsed.filter((t): t is string => typeof t === 'string');

  let idx = 0;

  // Skip environment variable assignments at the start
  while (idx < tokens.length && isEnvAssignment(tokens[idx]!)) {
    idx++;
  }

  // Skip transparent prefix commands (sudo, time, etc.)
  // Also handle cases like `sudo -u root docker ps` by skipping flags after prefix
  while (idx < tokens.length) {
    const token = tokens[idx]!;
    const cmdName = basename(token);

    if (PREFIX_COMMANDS.has(cmdName)) {
      idx++;
      // Skip any flags that follow the prefix command (e.g. sudo -u root)
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        idx++;
      }
      // For 'timeout' and similar, skip the numeric argument
      if (cmdName === 'timeout' && idx < tokens.length && /^\d+/.test(tokens[idx]!)) {
        idx++;
      }
      continue;
    }

    // Check for shell wrapper: bash/zsh/sh with -c flag
    if (['bash', 'zsh', 'sh'].includes(cmdName)) {
      // Look for -c or combined flag like -lc in remaining tokens
      const remaining = tokens.slice(idx + 1);
      const cFlagIdx = remaining.findIndex(t => t === '-c' || (t.startsWith('-') && t.includes('c')));

      if (cFlagIdx !== -1 && cFlagIdx + 1 < remaining.length) {
        // The argument after -c/-lc is the inner command - recursively parse it
        const innerCommand = remaining[cFlagIdx + 1];
        if (innerCommand) {
          return extractCommandName(innerCommand);
        }
      }
    }

    break;
  }

  if (idx >= tokens.length) {
    return undefined;
  }

  const rawCommand = tokens[idx]!;

  // Strip path prefix: /usr/local/bin/node → node, ./node_modules/.bin/jest → jest
  return basename(rawCommand);
}

/**
 * Extracts all command names from a bash command string.
 * Handles chained commands (&&, ||, ;) and pipes (|).
 *
 * @param commandStr - Full bash command string, e.g. "git add . && npm publish"
 * @returns Array of command names in order, e.g. ["git", "npm"]
 */
export function extractCommandNames(commandStr: string): string[] {
  if (!commandStr || !commandStr.trim()) {
    return [];
  }

  const subCommands = splitCommands(commandStr);
  const names: string[] = [];

  for (const sub of subCommands) {
    const name = extractCommandName(sub);
    if (name) {
      names.push(name);
    }
  }

  return names;
}

// ============================================
// Config Loading
// ============================================

const TOOL_ICONS_JSON = 'tool-icons.json';

/**
 * Loads tool icon config from a directory containing tool-icons.json.
 *
 * @param toolIconsDir - Path to the tool-icons directory (e.g. ~/.craft-agent/tool-icons/)
 * @returns Parsed config or null if missing/invalid
 */
export function loadToolIconConfig(toolIconsDir: string): ToolIconConfig | null {
  try {
    const configPath = join(toolIconsDir, TOOL_ICONS_JSON);
    if (!existsSync(configPath)) {
      return null;
    }
    const config = readJsonFileSync<ToolIconConfig>(configPath);

    // Basic validation
    if (!config.tools || !Array.isArray(config.tools)) {
      return null;
    }

    return config;
  } catch {
    return null;
  }
}

// ============================================
// Resolution
// ============================================

/**
 * Builds a lookup map from command name → tool entry for fast resolution.
 * Called once per config load, not per command.
 */
function buildCommandMap(config: ToolIconConfig): Map<string, ToolIconEntry> {
  const map = new Map<string, ToolIconEntry>();
  for (const tool of config.tools) {
    for (const cmd of tool.commands) {
      // First mapping wins (if there are duplicates)
      if (!map.has(cmd)) {
        map.set(cmd, tool);
      }
    }
  }
  return map;
}

/**
 * Resolves a bash command string to a tool icon match.
 *
 * Parses the command to extract CLI tool names, then checks each against
 * the tool-icons.json mapping. Returns the first tool that has a valid icon file.
 *
 * @param commandStr - Full bash command string, e.g. "git add . && npm publish"
 * @param toolIconsDir - Path to ~/.craft-agent/tool-icons/ containing tool-icons.json and icon files
 * @returns Match with displayName and base64 iconDataUrl, or undefined if no match
 */
export function resolveToolIcon(
  commandStr: string,
  toolIconsDir: string
): ToolIconMatch | undefined {
  const config = loadToolIconConfig(toolIconsDir);
  if (!config) {
    return undefined;
  }

  const commandMap = buildCommandMap(config);
  const commandNames = extractCommandNames(commandStr);

  // Scan all commands in order, return the first one with a valid icon
  for (const cmdName of commandNames) {
    const tool = commandMap.get(cmdName);
    if (!tool) continue;

    // Resolve icon file path (icon filename is relative to toolIconsDir)
    const iconPath = join(toolIconsDir, tool.icon);
    const iconDataUrl = encodeIconToDataUrl(iconPath);

    if (iconDataUrl) {
      return {
        id: tool.id,
        displayName: tool.displayName,
        iconDataUrl,
      };
    }
  }

  return undefined;
}
