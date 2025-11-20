#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude-to-Qwen CLI Adapter
 * Translates Claude Code CLI commands and arguments to Qwen Code equivalents
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs/promises';

// Get command line arguments, excluding node and script name
const args = process.argv.slice(2);

// Function to load configuration
async function loadAdapterConfig(configPath) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  if (!configPath) {
    configPath = join(scriptDir, '..', 'config', 'claude-adapter-config.json');
  }

  try {
    await fs.access(configPath);
    const configContent = await fs.readFile(configPath, 'utf8');
    return JSON.parse(configContent);
  } catch (_error) {
    // If config file doesn't exist in config subdirectory, try root
    try {
      const rootConfigPath = join(
        scriptDir,
        '..',
        'claude-adapter-config.json',
      );
      await fs.access(rootConfigPath);
      const configContent = await fs.readFile(rootConfigPath, 'utf8');
      return JSON.parse(configContent);
    } catch (_rootError) {
      // If neither config file exists, return default mappings
      return {
        argumentMappings: {
          '--print': ['-p'],
          '--allowed-tools': ['--allowed-tools'],
          '--permission-mode': ['--approval-mode'],
          '--model': ['-m'],
          '--session-id': ['--session-id'],
          '--settings': ['--settings'],
          '--allowedTools': ['--allowed-tools'],
          '--disallowedTools': ['--exclude-tools'],
          '--include-partial-messages': ['--all-files'],
          '--debug': ['--debug'],
          '--verbose': ['--debug'],
          '--yolo': ['--approval-mode', 'yolo'],
          '--allow-dangerously-skip-permissions': [
            '--dangerously-skip-permissions',
          ],
          '--dangerously-skip-permissions': ['--dangerously-skip-permissions'],
          '--include-directories': ['--include-directories'],
          '--continue': ['--continue'],
          '--resume': ['--resume'],
          '--output-format': ['--output-format'],
          '--input-format': ['--input-format'],
          '--mcp-config': ['--mcp-config'],
          '--append-system-prompt': ['--append-system-prompt'],
          '--replay-user-messages': ['--replay-user-messages'],
          '--fork-session': ['--fork-session'],
          '--fallback-model': ['--fallback-model'],
          '--add-dir': ['--add-dir'],
        },
        toolNameMappings: {
          Write: 'write_file',
          Edit: 'replace',
          Bash: 'run_shell_command',
          Read: 'read_file',
          Grep: 'grep',
          Glob: 'glob',
          Ls: 'ls',
          WebSearch: 'web_search',
          WebFetch: 'web_fetch',
          TodoWrite: 'todo_write',
          NotebookEdit: 'edit_notebook',
        },
      };
    }
  }
}

// Function to transform arguments
function transformArguments(args, mappings) {
  const transformedArgs = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    // Check if this is a known mapping
    if (mappings.argumentMappings && mappings.argumentMappings[arg]) {
      // Add the mapped arguments
      transformedArgs.push(...mappings.argumentMappings[arg]);
    }
    // Handle --allowedTools and --disallowedTools with comma-separated values
    else if (arg === '--allowedTools' || arg === '--allowed-tools') {
      transformedArgs.push('--allowed-tools');
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i++; // Move to value
        const tools = args[i].split(',').map((tool) => {
          // Map individual tools from Claude names to Qwen names if mapping exists
          if (mappings.toolNameMappings && mappings.toolNameMappings[tool]) {
            return mappings.toolNameMappings[tool];
          }
          return tool;
        });
        transformedArgs.push(tools.join(','));
      }
    } else if (arg === '--disallowedTools' || arg === '--disallowed-tools') {
      transformedArgs.push('--exclude-tools');
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i++; // Move to value
        const tools = args[i].split(',').map((tool) => {
          // Map individual tools from Claude names to Qwen names if mapping exists
          if (mappings.toolNameMappings && mappings.toolNameMappings[tool]) {
            return mappings.toolNameMappings[tool];
          }
          return tool;
        });
        transformedArgs.push(tools.join(','));
      }
    }
    // Handle positional arguments and other non-mapped arguments
    else {
      transformedArgs.push(arg);
    }

    i++;
  }

  return transformedArgs;
}

// Find start.js path relative to this script
const scriptDir = dirname(fileURLToPath(import.meta.url));
const startJsPath = join(scriptDir, '..', 'scripts', 'start.js');

// Main execution
async function main() {
  // Check for help flags first to provide Claude-compatible help
  if (args.includes('-h') || args.includes('--help')) {
    displayHelp();
    process.exit(0);
  }

  try {
    // Load configuration
    const config = await loadAdapterConfig();

    // Transform arguments
    const transformedArgs = transformArguments(args, config);

    // Add the start.js path as the first argument to node
    const nodeArgs = [startJsPath, ...transformedArgs];

    // Spawn the Qwen CLI with transformed arguments
    const qwenProcess = spawn('node', nodeArgs, {
      stdio: 'inherit',
      cwd: join(scriptDir, '..'),
    });

    qwenProcess.on('error', (err) => {
      console.error('Failed to start Qwen CLI:', err.message);
      process.exit(1);
    });

    qwenProcess.on('close', (code) => {
      process.exit(code || 0);
    });
  } catch (error) {
    console.error('Error in Claude-to-Qwen adapter:', error.message);
    process.exit(1);
  }
}

// Display Claude-compatible help information
function displayHelp() {
  console.log(`Usage: qwen-alt [options] [command] [prompt]

Claude-Compatible CLI for Qwen Code - starts an interactive session by default, use -p/--print for non-interactive output

Arguments:
  prompt                                            Your prompt

Options:
  -d, --debug [filter]                              Enable debug mode with optional category filtering (e.g., "api,hooks" or "!statsig,!file")
  --verbose                                         Override verbose mode setting from config
  -p, --print                                       Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when Claude is run with the -p mode. Only use this flag in directories you trust.
  --output-format <format>                          Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming) (choices: "text", "json", "stream-json")
  --include-partial-messages                        Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)
  --input-format <format>                           Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input) (choices: "text", "stream-json")
  --dangerously-skip-permissions                    Bypass all permission checks. Recommended only for sandboxes with no internet access.
  --allowedTools, --allowed-tools <tools...>        Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")
  --disallowedTools, --disallowed-tools <tools...>  Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")
  --append-system-prompt <prompt>                   Append a system prompt to the default system prompt
  --permission-mode <mode>                          Permission mode to use for the session (choices: "acceptEdits", "bypassPermissions", "default", "plan")
  --model <model>                                   Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-5-20250929').
  --settings <file-or-json>                         Path to a settings JSON file or a JSON string to load additional settings from
  --add-dir <directories...>                        Additional directories to allow tool access to
  -v, --version                                     Output the version number
  -h, --help                                        Display help for command

Commands:
  mcp                                               Configure and manage MCP servers

Examples:
    qwen-alt -p "Explain this codebase"
    qwen-alt --allowed-tools read_file,write_file "Modify the user service"
    qwen-alt --permission-mode yolo "Perform changes without asking"

Visit https://github.com/Independent-AI-Labs/qwen-code for more information.`);
}

// Run the adapter
main();
