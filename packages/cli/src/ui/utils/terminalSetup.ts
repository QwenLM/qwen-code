/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal setup utility for configuring Shift+Enter and Ctrl+Enter support.
 *
 * This module provides automatic detection and configuration of various terminal
 * emulators to support multiline input through modified Enter keys.
 *
 * Supported terminals:
 * - VS Code, Cursor, Windsurf, Trae: Configures keybindings.json
 * - Alacritty: Configures alacritty.toml keyboard bindings
 * - Zed: Configures keymap.json terminal bindings
 * - Apple Terminal: Enables "Option as Meta Key" setting
 *
 * Terminals with native support (no setup needed):
 * - Kitty, Ghostty, iTerm2, WezTerm, Warp (CSI-u / Kitty protocol)
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isKittyProtocolEnabled } from './kittyProtocolDetector.js';
import { VSCODE_SHIFT_ENTER_SEQUENCE } from './platformConstants.js';
import { t } from '../../i18n/index.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('TERMINAL_SETUP');

const execFileAsync = promisify(execFile);

// Terminals that natively support CSI-u / Kitty keyboard protocol
const NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  'iTerm.app': 'iTerm2',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
};

/**
 * Removes single-line JSON comments (// ...) from a string to allow parsing
 * VS Code style JSON files that may contain comments.
 */
function stripJsonComments(content: string): string {
  // Remove single-line comments (// ...)
  return content.replace(/^\s*\/\/.*$/gm, '');
}

export interface TerminalSetupResult {
  success: boolean;
  message: string;
  requiresRestart?: boolean;
}

type SupportedTerminal =
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'trae'
  | 'alacritty'
  | 'zed'
  | 'apple_terminal';

/**
 * Detect if we're running in a VSCode Remote SSH session.
 */
function isVSCodeRemoteSSH(): boolean {
  const askpassMain = process.env['VSCODE_GIT_ASKPASS_MAIN'] ?? '';
  const envPath = process.env['PATH'] ?? '';
  return (
    askpassMain.includes('.vscode-server') ||
    askpassMain.includes('.cursor-server') ||
    askpassMain.includes('.windsurf-server') ||
    envPath.includes('.vscode-server') ||
    envPath.includes('.cursor-server') ||
    envPath.includes('.windsurf-server')
  );
}

// Terminal detection
async function detectTerminal(): Promise<SupportedTerminal | null> {
  const termProgram = process.env['TERM_PROGRAM'];

  // Check for Apple Terminal
  if (termProgram === 'Apple_Terminal' && os.platform() === 'darwin') {
    return 'apple_terminal';
  }

  // Check VS Code and its forks - check forks first to avoid false positives
  if (
    process.env['CURSOR_TRACE_ID'] ||
    process.env['VSCODE_GIT_ASKPASS_MAIN']?.toLowerCase().includes('cursor')
  ) {
    return 'cursor';
  }
  if (
    process.env['VSCODE_GIT_ASKPASS_MAIN']?.toLowerCase().includes('windsurf')
  ) {
    return 'windsurf';
  }

  if (process.env['TERM_PRODUCT']?.toLowerCase().includes('trae')) {
    return 'trae';
  }

  // Check VS Code last since forks may also set VSCODE env vars
  if (termProgram === 'vscode' || process.env['VSCODE_GIT_IPC_HANDLE']) {
    return 'vscode';
  }

  // Check for Alacritty
  if (termProgram === 'Alacritty' || termProgram === 'alacritty') {
    return 'alacritty';
  }

  // Check for Zed
  if (termProgram === 'zed') {
    return 'zed';
  }

  // Check parent process name
  if (os.platform() !== 'win32') {
    try {
      const { stdout } = await execFileAsync('ps', [
        '-o',
        'comm=',
        '-p',
        String(process.ppid),
      ]);
      const parentName = stdout.trim();

      if (parentName.includes('windsurf') || parentName.includes('Windsurf'))
        return 'windsurf';
      if (parentName.includes('cursor') || parentName.includes('Cursor'))
        return 'cursor';
      if (parentName.includes('code') || parentName.includes('Code'))
        return 'vscode';
      if (parentName.includes('trae') || parentName.includes('Trae'))
        return 'trae';
      if (parentName.includes('alacritty') || parentName.includes('Alacritty'))
        return 'alacritty';
      if (parentName.includes('zed') || parentName.includes('Zed'))
        return 'zed';
    } catch (error) {
      debugLogger.debug('Parent process detection failed:', error);
    }
  }

  return null;
}

// Backup file helper
async function backupFile(filePath: string): Promise<void> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.backup.${timestamp}`;
    await fs.copyFile(filePath, backupPath);
  } catch (error) {
    debugLogger.warn(`Failed to create backup of ${filePath}:`, error);
  }
}

// Helper function to get VS Code-style config directory
function getVSCodeStyleConfigDir(appName: string): string | null {
  const platform = os.platform();

  if (platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      appName,
      'User',
    );
  } else if (platform === 'win32') {
    if (!process.env['APPDATA']) {
      return null;
    }
    return path.join(process.env['APPDATA'], appName, 'User');
  } else {
    return path.join(os.homedir(), '.config', appName, 'User');
  }
}

// Generic VS Code-style terminal configuration
async function configureVSCodeStyle(
  terminalName: string,
  appName: string,
): Promise<TerminalSetupResult> {
  // Check if we're running in a VSCode Remote SSH session
  if (isVSCodeRemoteSSH()) {
    return {
      success: false,
      message:
        t(
          'Cannot install keybindings from a remote {{terminalName}} session.',
          { terminalName },
        ) +
        '\n\n' +
        t(
          '{{terminalName}} keybindings must be installed on your local machine, not the remote server.',
          { terminalName },
        ) +
        '\n\n' +
        t('To install the Shift+Enter keybinding:') +
        '\n' +
        t(
          '1. Open {{terminalName}} on your local machine (not connected to remote)',
          { terminalName },
        ) +
        '\n' +
        t(
          '2. Open the Command Palette (Cmd/Ctrl+Shift+P) → "Preferences: Open Keyboard Shortcuts (JSON)"',
        ) +
        '\n' +
        t('3. Add this keybinding (the file must be a JSON array):') +
        '\n\n' +
        JSON.stringify(
          [
            {
              key: 'shift+enter',
              command: 'workbench.action.terminal.sendSequence',
              args: { text: '\\u001b\\r' },
              when: 'terminalFocus',
            },
          ],
          null,
          2,
        ),
    };
  }

  const configDir = getVSCodeStyleConfigDir(appName);

  if (!configDir) {
    return {
      success: false,
      message: t(
        'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.',
        { terminalName },
      ),
    };
  }

  const keybindingsFile = path.join(configDir, 'keybindings.json');

  try {
    await fs.mkdir(configDir, { recursive: true });

    let keybindings: unknown[] = [];
    try {
      const content = await fs.readFile(keybindingsFile, 'utf8');
      await backupFile(keybindingsFile);
      try {
        const cleanContent = stripJsonComments(content);
        const parsedContent = JSON.parse(cleanContent);
        if (!Array.isArray(parsedContent)) {
          return {
            success: false,
            message:
              t(
                '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.',
                { terminalName },
              ) +
              '\n' +
              t('File: {{file}}', { file: keybindingsFile }),
          };
        }
        keybindings = parsedContent;
      } catch (parseError) {
        return {
          success: false,
          message:
            t(
              'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.',
              { terminalName },
            ) +
            '\n' +
            t('File: {{file}}', { file: keybindingsFile }) +
            '\n' +
            t('Error: {{error}}', { error: String(parseError) }),
        };
      }
    } catch {
      // File doesn't exist, will create new one
    }

    const shiftEnterBinding = {
      key: 'shift+enter',
      command: 'workbench.action.terminal.sendSequence',
      when: 'terminalFocus',
      args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
    };

    const ctrlEnterBinding = {
      key: 'ctrl+enter',
      command: 'workbench.action.terminal.sendSequence',
      when: 'terminalFocus',
      args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
    };

    // Check if our specific bindings already exist (idempotency)
    const hasOurShiftEnter = keybindings.some((kb) => {
      const binding = kb as {
        command?: string;
        args?: { text?: string };
        key?: string;
      };
      return (
        binding.key === 'shift+enter' &&
        binding.command === 'workbench.action.terminal.sendSequence' &&
        binding.args?.text === VSCODE_SHIFT_ENTER_SEQUENCE
      );
    });

    const hasOurCtrlEnter = keybindings.some((kb) => {
      const binding = kb as {
        command?: string;
        args?: { text?: string };
        key?: string;
      };
      return (
        binding.key === 'ctrl+enter' &&
        binding.command === 'workbench.action.terminal.sendSequence' &&
        binding.args?.text === VSCODE_SHIFT_ENTER_SEQUENCE
      );
    });

    if (hasOurShiftEnter && hasOurCtrlEnter) {
      return {
        success: true,
        message: t('{{terminalName}} keybindings already configured.', {
          terminalName,
        }),
      };
    }

    // Check if DIFFERENT shift+enter or ctrl+enter bindings already exist (conflict)
    const existingShiftEnter =
      !hasOurShiftEnter &&
      keybindings.find((kb) => {
        const binding = kb as { key?: string };
        return binding.key === 'shift+enter';
      });

    const existingCtrlEnter =
      !hasOurCtrlEnter &&
      keybindings.find((kb) => {
        const binding = kb as { key?: string };
        return binding.key === 'ctrl+enter';
      });

    if (existingShiftEnter || existingCtrlEnter) {
      const messages: string[] = [];
      if (existingShiftEnter) {
        messages.push('- ' + t('Shift+Enter binding already exists'));
      }
      if (existingCtrlEnter) {
        messages.push('- ' + t('Ctrl+Enter binding already exists'));
      }
      return {
        success: false,
        message:
          t(
            'Existing keybindings detected. Will not modify to avoid conflicts.',
          ) +
          '\n' +
          messages.join('\n') +
          '\n' +
          t('Please check and modify manually if needed: {{file}}', {
            file: keybindingsFile,
          }),
      };
    }

    if (!hasOurShiftEnter) keybindings.unshift(shiftEnterBinding);
    if (!hasOurCtrlEnter) keybindings.unshift(ctrlEnterBinding);

    await fs.writeFile(keybindingsFile, JSON.stringify(keybindings, null, 4));
    return {
      success: true,
      message:
        t('Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.', {
          terminalName,
        }) +
        '\n' +
        t('Modified: {{file}}', { file: keybindingsFile }),
      requiresRestart: true,
    };
  } catch (error) {
    return {
      success: false,
      message:
        t('Failed to configure {{terminalName}}.', { terminalName }) +
        '\n' +
        t('File: {{file}}', { file: keybindingsFile }) +
        '\n' +
        t('Error: {{error}}', { error: String(error) }),
    };
  }
}

// Alacritty configuration
async function configureAlacritty(): Promise<TerminalSetupResult> {
  const ALACRITTY_KEYBINDING = `[[keyboard.bindings]]
key = "Return"
mods = "Shift"
chars = "\\u001B\\r"

[[keyboard.bindings]]
key = "Return"
mods = "Control"
chars = "\\u001B\\r"`;

  // Get Alacritty config file paths in order of preference
  const configPaths: string[] = [];
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  if (xdgConfigHome) {
    configPaths.push(path.join(xdgConfigHome, 'alacritty', 'alacritty.toml'));
  } else {
    configPaths.push(
      path.join(os.homedir(), '.config', 'alacritty', 'alacritty.toml'),
    );
  }

  if (os.platform() === 'win32') {
    const appData = process.env['APPDATA'];
    if (appData) {
      configPaths.push(path.join(appData, 'alacritty', 'alacritty.toml'));
    }
  }

  let configPath: string | null = null;
  let configContent = '';
  let configExists = false;

  for (const p of configPaths) {
    try {
      configContent = await fs.readFile(p, 'utf8');
      configPath = p;
      configExists = true;
      break;
    } catch {
      // File doesn't exist, try next
    }
  }

  if (!configPath) {
    configPath = configPaths[0] ?? null;
  }
  if (!configPath) {
    return {
      success: false,
      message: t('No valid config path found for Alacritty.'),
    };
  }

  try {
    if (configExists) {
      // Check if our own binding is already present (idempotency)
      if (
        configContent.includes('chars = "\\u001B\\r"') &&
        configContent.includes('mods = "Shift"') &&
        configContent.includes('key = "Return"')
      ) {
        return {
          success: true,
          message: t('Alacritty keybindings already configured.'),
        };
      }
      // Check for a different existing Shift+Return binding (conflict)
      if (
        configContent.includes('mods = "Shift"') &&
        configContent.includes('key = "Return"')
      ) {
        return {
          success: false,
          message:
            t(
              'Found existing Alacritty Shift+Enter key binding. Remove it to continue.',
            ) +
            '\n' +
            t('File: {{file}}', { file: configPath }),
        };
      }
      await backupFile(configPath);
    } else {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
    }

    let updatedContent = configContent;
    if (configContent && !configContent.endsWith('\n')) {
      updatedContent += '\n';
    }
    updatedContent += '\n' + ALACRITTY_KEYBINDING + '\n';

    await fs.writeFile(configPath, updatedContent, 'utf8');
    return {
      success: true,
      message:
        t('Added Shift+Enter and Ctrl+Enter keybindings to Alacritty.') +
        '\n' +
        t('Modified: {{file}}', { file: configPath }),
      requiresRestart: true,
    };
  } catch (error) {
    return {
      success: false,
      message:
        t('Failed to configure Alacritty.') +
        '\n' +
        t('Error: {{error}}', { error: String(error) }),
    };
  }
}

// Zed configuration
async function configureZed(): Promise<TerminalSetupResult> {
  const zedDir = path.join(os.homedir(), '.config', 'zed');
  const keymapPath = path.join(zedDir, 'keymap.json');

  try {
    await fs.mkdir(zedDir, { recursive: true });

    let keymapContent = '[]';
    let fileExists = false;
    try {
      keymapContent = await fs.readFile(keymapPath, 'utf8');
      fileExists = true;
    } catch {
      // File doesn't exist
    }

    if (fileExists) {
      // Check if our own binding is already present (idempotency)
      if (
        keymapContent.includes('shift-enter') &&
        keymapContent.includes('terminal::SendText')
      ) {
        return {
          success: true,
          message: t('Zed keybindings already configured.'),
        };
      }
      // Check for a different existing shift-enter binding (conflict)
      if (keymapContent.includes('shift-enter')) {
        return {
          success: false,
          message:
            t(
              'Found existing Zed Shift+Enter key binding. Remove it to continue.',
            ) +
            '\n' +
            t('File: {{file}}', { file: keymapPath }),
        };
      }
      await backupFile(keymapPath);
    }

    let keymap: Array<{
      context?: string;
      bindings: Record<string, string | string[]>;
    }>;
    try {
      keymap = JSON.parse(keymapContent);
      if (!Array.isArray(keymap)) {
        keymap = [];
      }
    } catch {
      // Invalid JSON in existing keymap — don't overwrite, return an error
      if (fileExists) {
        return {
          success: false,
          message:
            t(
              'Zed keymap.json contains invalid JSON. Please fix it manually.',
            ) +
            '\n' +
            t('File: {{file}}', { file: keymapPath }),
        };
      }
      keymap = [];
    }

    keymap.push({
      context: 'Terminal',
      bindings: {
        'shift-enter': ['terminal::SendText', '\u001b\r'],
      },
    });

    await fs.writeFile(keymapPath, JSON.stringify(keymap, null, 2) + '\n');
    return {
      success: true,
      message:
        t('Added Shift+Enter keybinding to Zed.') +
        '\n' +
        t('Modified: {{file}}', { file: keymapPath }),
    };
  } catch (error) {
    return {
      success: false,
      message:
        t('Failed to configure Zed.') +
        '\n' +
        t('Error: {{error}}', { error: String(error) }),
    };
  }
}

// Helper to run PlistBuddy commands safely (no shell interpolation)
const TERMINAL_PLIST_PATH = path.join(
  os.homedir(),
  'Library',
  'Preferences',
  'com.apple.Terminal.plist',
);

async function plistBuddyCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync('/usr/libexec/PlistBuddy', [
      '-c',
      command,
      TERMINAL_PLIST_PATH,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function enableOptionAsMetaForProfile(
  profileName: string,
): Promise<boolean> {
  // Reject profile names with control characters that could break PlistBuddy
  const hasControlChars = [...profileName].some(
    (ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f,
  );
  if (hasControlChars) {
    debugLogger.warn(
      `Skipping profile with control characters: ${profileName}`,
    );
    return false;
  }
  // Escape backslashes first, then single quotes for PlistBuddy key path syntax
  const escaped = profileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // Try Add first (in case the key doesn't exist), then Set as fallback
  const addOk = await plistBuddyCommand(
    `Add :'Window Settings':'${escaped}':useOptionAsMetaKey bool true`,
  );
  if (!addOk) {
    return plistBuddyCommand(
      `Set :'Window Settings':'${escaped}':useOptionAsMetaKey true`,
    );
  }
  return true;
}

// Apple Terminal configuration - enable "Option as Meta Key"
async function configureAppleTerminal(): Promise<TerminalSetupResult> {
  try {
    // Create a backup of the plist before modifying
    await backupFile(TERMINAL_PLIST_PATH);

    // Read the current default profile (uses execFileAsync to avoid shell)
    const { stdout: defaultProfile } = await execFileAsync('defaults', [
      'read',
      'com.apple.Terminal',
      'Default Window Settings',
    ]);
    const profileName = defaultProfile.trim();
    if (!profileName) {
      return {
        success: false,
        message: t('Failed to read default Terminal.app profile.'),
      };
    }

    const defaultOk = await enableOptionAsMetaForProfile(profileName);
    if (!defaultOk) {
      return {
        success: false,
        message:
          t(
            'Failed to enable Option as Meta Key for Terminal.app profile: {{profile}}',
            { profile: profileName },
          ) +
          '\n' +
          t('File: {{file}}', { file: TERMINAL_PLIST_PATH }),
      };
    }

    // Also try the startup profile if different
    try {
      const { stdout: startupProfile } = await execFileAsync('defaults', [
        'read',
        'com.apple.Terminal',
        'Startup Window Settings',
      ]);
      const startupName = startupProfile.trim();
      if (startupName && startupName !== profileName) {
        await enableOptionAsMetaForProfile(startupName);
      }
    } catch {
      // Non-critical: couldn't read startup profile
    }

    // Flush preferences cache
    await execFileAsync('killall', ['cfprefsd']).catch(() => {
      // Non-critical
    });

    return {
      success: true,
      message:
        t('Configured Terminal.app:') +
        '\n' +
        t('- Enabled "Use Option as Meta Key"') +
        '\n\n' +
        t('Option+Enter will now insert a newline.') +
        '\n' +
        t(
          'Shift+Enter also works via native modifier detection (no restart needed).',
        ),
      requiresRestart: true,
    };
  } catch (error) {
    return {
      success: false,
      message:
        t('Failed to configure Terminal.app.') +
        '\n' +
        t('Error: {{error}}', { error: String(error) }),
    };
  }
}

// Terminal-specific configuration functions

async function configureVSCode(): Promise<TerminalSetupResult> {
  return configureVSCodeStyle('VS Code', 'Code');
}

async function configureCursor(): Promise<TerminalSetupResult> {
  return configureVSCodeStyle('Cursor', 'Cursor');
}

async function configureWindsurf(): Promise<TerminalSetupResult> {
  return configureVSCodeStyle('Windsurf', 'Windsurf');
}

async function configureTrae(): Promise<TerminalSetupResult> {
  return configureVSCodeStyle('Trae', 'Trae');
}

/**
 * Main terminal setup function that detects and configures the current terminal.
 */
export async function terminalSetup(): Promise<TerminalSetupResult> {
  // Check if terminal already has optimal keyboard support
  if (isKittyProtocolEnabled()) {
    const termProgram = process.env['TERM_PROGRAM'] ?? '';
    const termName = NATIVE_CSIU_TERMINALS[termProgram] ?? 'your terminal';
    return {
      success: true,
      message: t(
        'Shift+Enter is natively supported in {{termName}}. No configuration needed.',
        { termName },
      ),
    };
  }

  const terminal = await detectTerminal();

  if (!terminal) {
    const termName = process.env['TERM_PROGRAM'] ?? 'your current terminal';
    return {
      success: false,
      message:
        t('Terminal "{{termName}}" is not supported by automatic setup.', {
          termName,
        }) +
        '\n\n' +
        t(
          'You can still use backslash (\\) + Enter to add newlines, or Ctrl+Enter / Ctrl+J.',
        ) +
        '\n\n' +
        t('Supported terminals:') +
        '\n' +
        t('  IDE: VS Code, Cursor, Windsurf, Trae, Zed') +
        '\n' +
        t('  Terminal: Alacritty, Apple Terminal') +
        '\n' +
        t('  Native support: iTerm2, WezTerm, Ghostty, Kitty, Warp'),
    };
  }

  switch (terminal) {
    case 'vscode':
      return configureVSCode();
    case 'cursor':
      return configureCursor();
    case 'windsurf':
      return configureWindsurf();
    case 'trae':
      return configureTrae();
    case 'alacritty':
      return configureAlacritty();
    case 'zed':
      return configureZed();
    case 'apple_terminal':
      return configureAppleTerminal();
    default:
      return {
        success: false,
        message: t('Terminal "{{terminal}}" is not supported yet.', {
          terminal,
        }),
      };
  }
}
