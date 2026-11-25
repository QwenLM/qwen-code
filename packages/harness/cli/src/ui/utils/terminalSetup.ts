/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { useEffect, useState } from 'react';
import {
  applyEdits,
  modify,
  parse,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';
import {
  BRAND_CLI_NAME,
  homedir,
  isGnuScreen,
  isTmux,
  runLogger,
} from '@qwen-code/core';
import { terminalCapabilityManager } from './terminalCapabilityManager.js';
import { isAppleTerminal, isSSH } from './terminalUtils.js';
import { isNativeModifierDetectionAvailable } from './nativeModifierDetector.js';
import { persistentState } from '../../utils/persistentState.js';
import type { ConfirmationRequest } from '../types.js';
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';

type AddItemFn = UseHistoryManagerReturn['addItem'];

export const VSCODE_SHIFT_ENTER_SEQUENCE = '\\\r\n';
/**
 * CSI u encoding of Ctrl+Enter. VS Code's terminal cannot report the modifier
 * itself, so the keybinding sends the sequence the key parser already reads
 * as Ctrl+Enter: a newline when idle, send-now while the model responds.
 */
export const VSCODE_CTRL_ENTER_SEQUENCE = '\u001b[13;5u';

const ALTERNATE_ENTER_SEQUENCE = '\u001b\r';
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

type ConfigurableTerminal =
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'antigravity'
  | 'alacritty'
  | 'zed';

type NativeTerminal =
  | 'ghostty'
  | 'kitty'
  | 'iterm2'
  | 'wezterm'
  | 'warp'
  | 'windows-terminal';

export type DetectedTerminal =
  | ConfigurableTerminal
  | NativeTerminal
  | 'apple-terminal';

export type TerminalSetupRoute =
  | 'remote'
  | 'apple-terminal'
  | 'vscode-style'
  | 'alacritty'
  | 'zed'
  | 'native'
  | 'unknown';

export type TerminalConfigurationStatus =
  | 'configured'
  | 'not_configured'
  | 'unknown';

export interface TerminalSetupAssessment {
  route: TerminalSetupRoute;
  terminal: DetectedTerminal | null;
  terminalName: string;
  configurationStatus: TerminalConfigurationStatus;
  canConfigure: boolean;
  message: string;
  detail?: string;
}

export interface TerminalSetupResult {
  success: boolean;
  message: string;
  restartNotice?: string;
}

export interface TerminalSetupOptions {
  screenReader?: boolean;
}

interface TerminalData {
  terminalName: string;
  appName: string;
}

const VSCODE_TERMINAL_DATA: Record<
  Exclude<ConfigurableTerminal, 'alacritty' | 'zed'>,
  TerminalData
> = {
  vscode: { terminalName: 'VS Code', appName: 'Code' },
  cursor: { terminalName: 'Cursor', appName: 'Cursor' },
  windsurf: { terminalName: 'Windsurf', appName: 'Windsurf' },
  antigravity: { terminalName: 'Antigravity', appName: 'Antigravity' },
};

const NATIVE_TERMINAL_NAMES: Record<NativeTerminal, string> = {
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  iterm2: 'iTerm2',
  wezterm: 'WezTerm',
  warp: 'Warp',
  'windows-terminal': 'Windows Terminal',
};

interface Keybinding {
  key?: string;
  command?: string;
  when?: string;
  args?: { text?: string };
}

interface VSCodeInspection {
  status: TerminalConfigurationStatus;
  path: string;
  exists: boolean;
  content: string;
  keybindings: unknown[];
  detail?: string;
}

interface AlacrittyInspection {
  status: TerminalConfigurationStatus;
  path: string;
  exists: boolean;
  content: string;
  detail?: string;
}

interface ZedInspection {
  status: TerminalConfigurationStatus;
  path: string;
  exists: boolean;
  content: string;
  keymap: unknown[];
  terminalContextIndex: number | null;
  detail?: string;
}

const VSCODE_TARGET_BINDINGS: readonly Keybinding[] = [
  {
    key: 'shift+enter',
    command: 'workbench.action.terminal.sendSequence',
    when: 'terminalFocus',
    args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
  },
  {
    key: 'ctrl+enter',
    command: 'workbench.action.terminal.sendSequence',
    when: 'terminalFocus',
    args: { text: VSCODE_CTRL_ENTER_SEQUENCE },
  },
  {
    key: 'cmd+z',
    command: 'workbench.action.terminal.sendSequence',
    when: 'terminalFocus',
    args: { text: '\u001b[122;9u' },
  },
  {
    key: 'alt+z',
    command: 'workbench.action.terminal.sendSequence',
    when: 'terminalFocus',
    args: { text: '\u001b[122;3u' },
  },
  {
    key: 'shift+cmd+z',
    command: 'workbench.action.terminal.sendSequence',
    when: 'terminalFocus',
    args: { text: '\u001b[122;10u' },
  },
  {
    key: 'shift+alt+z',
    command: 'workbench.action.terminal.sendSequence',
    when: 'terminalFocus',
    args: { text: '\u001b[122;4u' },
  },
];

/**
 * Bindings earlier versions of this command installed and that a re-run now
 * upgrades in place. Keyed by the key they share with the current target.
 * Ctrl+Enter used to send the backslash-newline trick, which kept the key
 * from ever reaching the app as Ctrl+Enter.
 */
const VSCODE_SUPERSEDED_BINDINGS: readonly Keybinding[] = [
  {
    key: 'ctrl+enter',
    command: 'workbench.action.terminal.sendSequence',
    when: 'terminalFocus',
    args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKeybinding(value: unknown): value is Keybinding {
  return isRecord(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function getProcessErrorText(error: unknown): string {
  if (!isRecord(error)) return String(error);
  return [error['message'], error['stdout'], error['stderr']]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function isMissingPlistEntryError(error: unknown): boolean {
  return /(?:entry.*does not exist|does not exist.*entry)/i.test(
    getProcessErrorText(error),
  );
}

function isOurBinding(value: unknown, target: Keybinding): boolean {
  if (!isKeybinding(value)) return false;
  return (
    value.key === target.key &&
    value.command === target.command &&
    value.args?.text === target.args?.text
  );
}

function parseJsoncArray(
  content: string,
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    return { ok: false, error: 'The file contains invalid JSONC.' };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: 'The file must contain a JSON array.' };
  }
  return { ok: true, value };
}

function getFormattingOptions(content: string): FormattingOptions {
  const usesTabs = /\n\t+\S/.test(content);
  const indentMatch = content.match(/\n( +)\S/);
  return {
    insertSpaces: !usesTabs,
    tabSize: usesTabs ? 1 : Math.max(2, indentMatch?.[1].length ?? 2),
    eol: content.includes('\r\n') ? '\r\n' : '\n',
  };
}

function appendJsoncArrayValues(
  content: string,
  startIndex: number,
  values: readonly unknown[],
): string {
  let next = content;
  const formattingOptions = getFormattingOptions(content);
  values.forEach((value, offset) => {
    next = applyEdits(
      next,
      modify(next, [startIndex + offset], value, { formattingOptions }),
    );
  });
  return next;
}

async function backupFile(filePath: string): Promise<string> {
  const backupPath = `${filePath}.${randomBytes(4).toString('hex')}.bak`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

function getVSCodeStyleConfigDir(appName: string): string | null {
  if (os.platform() === 'darwin') {
    return path.join(
      homedir(),
      'Library',
      'Application Support',
      appName,
      'User',
    );
  }
  if (os.platform() === 'win32') {
    return process.env['APPDATA']
      ? path.join(process.env['APPDATA'], appName, 'User')
      : null;
  }
  return path.join(homedir(), '.config', appName, 'User');
}

function getVSCodeTerminalData(
  terminal: DetectedTerminal | null,
): TerminalData | null {
  return terminal && terminal in VSCODE_TERMINAL_DATA
    ? VSCODE_TERMINAL_DATA[
        terminal as keyof typeof VSCODE_TERMINAL_DATA
      ]
    : null;
}

export function getTerminalProgram(): DetectedTerminal | null {
  const termProgram = process.env['TERM_PROGRAM']?.toLowerCase();
  const term = process.env['TERM']?.toLowerCase();
  const askpass = process.env['VSCODE_GIT_ASKPASS_MAIN']?.toLowerCase() ?? '';

  if (process.env['CURSOR_TRACE_ID'] || askpass.includes('cursor')) {
    return 'cursor';
  }
  if (askpass.includes('windsurf')) return 'windsurf';
  if (askpass.includes('antigravity')) return 'antigravity';
  if (termProgram === 'apple_terminal') return 'apple-terminal';
  if (process.env['ZED_TERM'] || termProgram === 'zed') return 'zed';
  if (termProgram === 'alacritty' || term?.includes('alacritty')) {
    return 'alacritty';
  }
  if (termProgram === 'vscode' || process.env['VSCODE_GIT_IPC_HANDLE']) {
    return 'vscode';
  }
  if (termProgram?.includes('ghostty') || term?.includes('ghostty')) {
    return 'ghostty';
  }
  if (process.env['KITTY_WINDOW_ID'] || term?.includes('kitty')) return 'kitty';
  if (
    termProgram === 'iterm.app' ||
    process.env['__CFBundleIdentifier'] === 'com.googlecode.iterm2'
  ) {
    return 'iterm2';
  }
  if (termProgram === 'wezterm') return 'wezterm';
  if (termProgram === 'warpterminal') return 'warp';
  if (process.env['WT_SESSION']) return 'windows-terminal';
  return null;
}

let detectTerminalPromise: Promise<DetectedTerminal | null> | null = null;

async function detectTerminal(): Promise<DetectedTerminal | null> {
  if (!detectTerminalPromise) detectTerminalPromise = detectTerminalImpl();
  return detectTerminalPromise;
}

export function resetDetectTerminalCacheForTesting(): void {
  detectTerminalPromise = null;
}

async function detectTerminalImpl(): Promise<DetectedTerminal | null> {
  const envTerminal = getTerminalProgram();
  if (envTerminal) return envTerminal;

  const detectedName = terminalCapabilityManager.getTerminalName()?.toLowerCase();
  if (detectedName?.includes('ghostty')) return 'ghostty';
  if (detectedName?.includes('kitty')) return 'kitty';
  if (detectedName?.includes('wezterm')) return 'wezterm';
  if (detectedName?.includes('warp')) return 'warp';

  if (os.platform() !== 'win32') {
    try {
      const { stdout } = await execAsync('ps -o comm= -p $PPID');
      const parentName = stdout.trim().toLowerCase();
      if (parentName.includes('windsurf')) return 'windsurf';
      if (parentName.includes('antigravity')) return 'antigravity';
      if (parentName.includes('cursor')) return 'cursor';
      if (parentName.includes('zed')) return 'zed';
      if (parentName.includes('alacritty')) return 'alacritty';
      if (parentName.includes('code')) return 'vscode';
    } catch (error) {
      runLogger.debug('Parent process detection failed:', error);
    }
  }
  return null;
}

async function inspectVSCodeStyle(
  terminalName: string,
  appName: string,
): Promise<VSCodeInspection> {
  const configDir = getVSCodeStyleConfigDir(appName);
  if (!configDir) {
    return {
      status: 'unknown',
      path: '',
      exists: false,
      content: '',
      keybindings: [],
      detail: `Could not determine ${terminalName} config path because APPDATA is not set.`,
    };
  }

  const keybindingsPath = path.join(configDir, 'keybindings.json');
  let content: string;
  try {
    content = await fs.readFile(keybindingsPath, 'utf8');
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return {
        status: 'not_configured',
        path: keybindingsPath,
        exists: false,
        content: '[]\n',
        keybindings: [],
      };
    }
    return {
      status: 'unknown',
      path: keybindingsPath,
      exists: false,
      content: '',
      keybindings: [],
      detail: `Failed to read ${keybindingsPath}: ${String(error)}`,
    };
  }

  const parsed = parseJsoncArray(content);
  if (!parsed.ok) {
    return {
      status: 'unknown',
      path: keybindingsPath,
      exists: true,
      content,
      keybindings: [],
      detail: `${parsed.error} File: ${keybindingsPath}`,
    };
  }

  const shiftTarget = VSCODE_TARGET_BINDINGS[0];
  const shiftBindings = parsed.value.filter(
    (value) => isKeybinding(value) && value.key === shiftTarget.key,
  );
  if (shiftBindings.some((value) => !isOurBinding(value, shiftTarget))) {
    return {
      status: 'unknown',
      path: keybindingsPath,
      exists: true,
      content,
      keybindings: parsed.value,
      detail: `Shift+Enter is already bound differently in ${keybindingsPath}.`,
    };
  }

  return {
    status: shiftBindings.some((value) => isOurBinding(value, shiftTarget))
      ? 'configured'
      : 'not_configured',
    path: keybindingsPath,
    exists: true,
    content,
    keybindings: parsed.value,
  };
}

function getAlacrittyConfigPaths(): string[] {
  const paths: string[] = [];
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  paths.push(
    xdgConfigHome
      ? path.join(xdgConfigHome, 'alacritty', 'alacritty.toml')
      : path.join(homedir(), '.config', 'alacritty', 'alacritty.toml'),
  );
  if (os.platform() === 'win32' && process.env['APPDATA']) {
    const windowsPath = path.join(
      process.env['APPDATA'],
      'alacritty',
      'alacritty.toml',
    );
    if (!paths.includes(windowsPath)) paths.push(windowsPath);
  }
  return paths;
}

function inspectAlacrittyBinding(content: string): {
  status: TerminalConfigurationStatus;
  detail?: string;
} {
  const bindingPattern =
    /\[\[keyboard\.bindings\]\]([\s\S]*?)(?=\n\s*\[\[keyboard\.bindings\]\]|$)/g;
  let match: RegExpExecArray | null;
  while ((match = bindingPattern.exec(content))) {
    const block = match[1];
    const key = block.match(/(?:^|\n)\s*key\s*=\s*["']([^"']+)["']/)?.[1];
    const mods = block.match(/(?:^|\n)\s*mods\s*=\s*["']([^"']+)["']/)?.[1];
    if (
      key !== 'Return' ||
      !mods
        ?.split('|')
        .map((modifier) => modifier.trim())
        .includes('Shift')
    ) {
      continue;
    }
    const chars = block.match(/(?:^|\n)\s*chars\s*=\s*["']([^"']*)["']/)?.[1];
    if (chars === '\\u001B\\r') return { status: 'configured' };
    return {
      status: 'unknown',
      detail: 'Alacritty already has a different Shift+Return binding.',
    };
  }
  return { status: 'not_configured' };
}

async function inspectAlacritty(): Promise<AlacrittyInspection> {
  const paths = getAlacrittyConfigPaths();
  for (const configPath of paths) {
    try {
      const content = await fs.readFile(configPath, 'utf8');
      return {
        ...inspectAlacrittyBinding(content),
        path: configPath,
        exists: true,
        content,
      };
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) {
        return {
          status: 'unknown',
          path: configPath,
          exists: false,
          content: '',
          detail: `Failed to read ${configPath}: ${String(error)}`,
        };
      }
    }
  }
  return {
    status: 'not_configured',
    path: paths[0],
    exists: false,
    content: '',
  };
}

function getZedConfigPath(): string {
  return path.join(homedir(), '.config', 'zed', 'keymap.json');
}

function isZedTerminalContext(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value['context'] === 'Terminal';
}

function isExactZedBinding(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === 'terminal::SendText' &&
    value[1] === ALTERNATE_ENTER_SEQUENCE
  );
}

async function inspectZed(): Promise<ZedInspection> {
  const configPath = getZedConfigPath();
  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return {
        status: 'not_configured',
        path: configPath,
        exists: false,
        content: '[]\n',
        keymap: [],
        terminalContextIndex: null,
      };
    }
    return {
      status: 'unknown',
      path: configPath,
      exists: false,
      content: '',
      keymap: [],
      terminalContextIndex: null,
      detail: `Failed to read ${configPath}: ${String(error)}`,
    };
  }

  const parsed = parseJsoncArray(content);
  if (!parsed.ok) {
    return {
      status: 'unknown',
      path: configPath,
      exists: true,
      content,
      keymap: [],
      terminalContextIndex: null,
      detail: `${parsed.error} File: ${configPath}`,
    };
  }

  let terminalContextIndex: number | null = null;
  for (let index = 0; index < parsed.value.length; index++) {
    const item = parsed.value[index];
    if (!isZedTerminalContext(item)) continue;
    terminalContextIndex ??= index;
    const bindings = item['bindings'];
    if (bindings !== undefined && !isRecord(bindings)) {
      return {
        status: 'unknown',
        path: configPath,
        exists: true,
        content,
        keymap: parsed.value,
        terminalContextIndex,
        detail: `The Terminal bindings entry in ${configPath} is invalid.`,
      };
    }
    if (isRecord(bindings) && 'shift-enter' in bindings) {
      const exact = isExactZedBinding(bindings['shift-enter']);
      return {
        status: exact ? 'configured' : 'unknown',
        path: configPath,
        exists: true,
        content,
        keymap: parsed.value,
        terminalContextIndex,
        ...(exact
          ? {}
          : {
              detail: `Zed already has a different shift-enter binding in ${configPath}.`,
            }),
      };
    }
  }

  return {
    status: 'not_configured',
    path: configPath,
    exists: true,
    content,
    keymap: parsed.value,
    terminalContextIndex,
  };
}

async function runCommand(command: string, args: readonly string[]) {
  return execFileAsync(command, [...args], { encoding: 'utf8' });
}

function getAppleTerminalPlistPath(): string {
  return path.join(
    homedir(),
    'Library',
    'Preferences',
    'com.apple.Terminal.plist',
  );
}

async function getAppleTerminalProfiles(): Promise<string[]> {
  const [defaultProfile, startupProfile] = await Promise.all([
    runCommand('defaults', [
      'read',
      'com.apple.Terminal',
      'Default Window Settings',
    ]),
    runCommand('defaults', [
      'read',
      'com.apple.Terminal',
      'Startup Window Settings',
    ]),
  ]);
  const profiles = [defaultProfile.stdout.trim(), startupProfile.stdout.trim()];
  if (profiles.some((profile) => !profile)) {
    throw new Error('Could not read the Terminal.app default profiles.');
  }
  return [...new Set(profiles)];
}

function escapePlistBuddySegment(segment: string): string {
  return segment.replaceAll("'", "\\'");
}

function getOptionAsMetaPlistKey(profile: string): string {
  return `:'Window Settings':'${escapePlistBuddySegment(profile)}':useOptionAsMetaKey`;
}

function getAudibleBellPlistKey(profile: string): string {
  return `:'Window Settings':'${escapePlistBuddySegment(profile)}':Bell`;
}

async function getMacOSMajorVersion(): Promise<number | null> {
  try {
    const result = await runCommand('sw_vers', ['-productVersion']);
    const major = Number.parseInt(result.stdout.trim().split('.')[0] ?? '', 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

async function isAppleProfileOptionAsMeta(profile: string): Promise<boolean> {
  try {
    const result = await runCommand('/usr/libexec/PlistBuddy', [
      '-c',
      `Print ${getOptionAsMetaPlistKey(profile)}`,
      getAppleTerminalPlistPath(),
    ]);
    const value = result.stdout.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(value)) return true;
    if (['false', '0', 'no'].includes(value)) return false;
    throw new Error(
      `Unexpected useOptionAsMetaKey value for Terminal.app profile "${profile}": ${result.stdout}`,
    );
  } catch (error) {
    if (isMissingPlistEntryError(error)) return false;
    throw error;
  }
}

async function isAppleProfileAudibleBellDisabled(
  profile: string,
): Promise<boolean> {
  try {
    const result = await runCommand('/usr/libexec/PlistBuddy', [
      '-c',
      `Print ${getAudibleBellPlistKey(profile)}`,
      getAppleTerminalPlistPath(),
    ]);
    const value = result.stdout.trim().toLowerCase();
    if (['false', '0', 'no'].includes(value)) return true;
    if (['true', '1', 'yes'].includes(value)) return false;
    throw new Error(
      `Unexpected Bell value for Terminal.app profile "${profile}": ${result.stdout}`,
    );
  } catch (error) {
    if (isMissingPlistEntryError(error)) return false;
    throw error;
  }
}

async function inspectAppleTerminal(
  options: TerminalSetupOptions,
): Promise<TerminalSetupAssessment> {
  try {
    const profiles = await getAppleTerminalProfiles();
    const macOSMajorVersion = await getMacOSMajorVersion();
    const optionAsMetaRequired = (macOSMajorVersion ?? 0) < 27;
    const [optionAsMetaConfigured, audibleBellDisabled] = await Promise.all([
      optionAsMetaRequired
        ? Promise.all(profiles.map(isAppleProfileOptionAsMeta)).then((values) =>
            values.every(Boolean),
          )
        : Promise.resolve(true),
      options.screenReader
        ? Promise.resolve(true)
        : Promise.all(profiles.map(isAppleProfileAudibleBellDisabled)).then(
            (values) => values.every(Boolean),
          ),
    ]);
    const configured = optionAsMetaConfigured && audibleBellDisabled;
    return {
      route: 'apple-terminal',
      terminal: 'apple-terminal',
      terminalName: 'Terminal.app',
      configurationStatus: configured ? 'configured' : 'not_configured',
      canConfigure: true,
      message: configured
        ? 'No Terminal.app changes needed.'
        : 'Terminal.app can enable the recommended terminal settings.',
    };
  } catch (error) {
    return {
      route: 'apple-terminal',
      terminal: 'apple-terminal',
      terminalName: 'Terminal.app',
      configurationStatus: 'unknown',
      canConfigure: true,
      message: 'Could not inspect Terminal.app preferences.',
      detail: String(error),
    };
  }
}

function nativeAssessment(
  terminal: DetectedTerminal | null,
  terminalName: string,
): TerminalSetupAssessment {
  return {
    route: 'native',
    terminal,
    terminalName,
    configurationStatus: 'configured',
    canConfigure: false,
    message: `${terminalName} supports modified Enter keys without additional configuration.`,
  };
}

export async function assessTerminalSetup(
  options: TerminalSetupOptions = {},
): Promise<TerminalSetupAssessment> {
  if (isTmux() || isGnuScreen() || isSSH()) {
    return {
      route: 'remote',
      terminal: null,
      terminalName: isSSH() ? 'the remote session' : 'the terminal multiplexer',
      configurationStatus: 'unknown',
      canConfigure: false,
      message:
        'Terminal setup must be run directly in the local terminal, outside tmux, screen, or SSH.',
    };
  }

  const terminal = await detectTerminal();
  if (
    terminal === 'apple-terminal' &&
    os.platform() === 'darwin' &&
    isAppleTerminal()
  ) {
    return inspectAppleTerminal(options);
  }

  if (terminalCapabilityManager.canDistinguishModifiedEnter()) {
    const name =
      terminal && terminal in NATIVE_TERMINAL_NAMES
        ? NATIVE_TERMINAL_NAMES[terminal as NativeTerminal]
        : terminalCapabilityManager.getTerminalName() || 'This terminal';
    return nativeAssessment(terminal, name);
  }

  if (terminal && terminal in NATIVE_TERMINAL_NAMES) {
    return nativeAssessment(
      terminal,
      NATIVE_TERMINAL_NAMES[terminal as NativeTerminal],
    );
  }

  const vscodeData = getVSCodeTerminalData(terminal);
  if (vscodeData) {
    const inspection = await inspectVSCodeStyle(
      vscodeData.terminalName,
      vscodeData.appName,
    );
    return {
      route: 'vscode-style',
      terminal,
      terminalName: vscodeData.terminalName,
      configurationStatus: inspection.status,
      canConfigure: true,
      message:
        inspection.status === 'configured'
          ? `${vscodeData.terminalName} terminal keybindings are already configured.`
          : `${vscodeData.terminalName} can install recommended terminal keybindings for multiline input and Undo/Redo.`,
      detail: inspection.detail,
    };
  }

  if (terminal === 'alacritty') {
    const inspection = await inspectAlacritty();
    return {
      route: 'alacritty',
      terminal,
      terminalName: 'Alacritty',
      configurationStatus: inspection.status,
      canConfigure: true,
      message:
        inspection.status === 'configured'
          ? 'Alacritty Shift+Enter is already configured.'
          : 'Alacritty can install a Shift+Enter keybinding for multiline input.',
      detail: inspection.detail,
    };
  }

  if (terminal === 'zed') {
    const inspection = await inspectZed();
    return {
      route: 'zed',
      terminal,
      terminalName: 'Zed',
      configurationStatus: inspection.status,
      canConfigure: true,
      message:
        inspection.status === 'configured'
          ? 'Zed Shift+Enter is already configured.'
          : 'Zed can install a Shift+Enter keybinding for multiline input.',
      detail: inspection.detail,
    };
  }

  return {
    route: 'unknown',
    terminal,
    terminalName: terminalCapabilityManager.getTerminalName() || 'this terminal',
    configurationStatus: 'unknown',
    canConfigure: false,
    message:
      'Automatic terminal setup is not available here. Use Ctrl+J or backslash followed by Enter to insert a newline.',
  };
}

function syncInstalledState(assessment: TerminalSetupAssessment): void {
  if (assessment.configurationStatus === 'unknown') return;
  const configured = assessment.configurationStatus === 'configured';
  if (assessment.route === 'apple-terminal') {
    persistentState.set('optionAsMetaKeyInstalled', configured);
  } else if (
    assessment.route === 'vscode-style' ||
    assessment.route === 'alacritty' ||
    assessment.route === 'zed'
  ) {
    persistentState.set('shiftEnterKeyBindingInstalled', configured);
  }
}

async function configureVSCodeStyle(
  terminalName: string,
  appName: string,
): Promise<TerminalSetupResult> {
  const inspection = await inspectVSCodeStyle(terminalName, appName);
  if (inspection.status === 'unknown') {
    return {
      success: false,
      message:
        inspection.detail || `Could not inspect ${terminalName} keybindings.`,
    };
  }

  const skipped: string[] = [];
  const additions: Keybinding[] = [];
  const replacements: Array<{ index: number; binding: Keybinding }> = [];
  for (const target of VSCODE_TARGET_BINDINGS) {
    if (inspection.keybindings.some((value) => isOurBinding(value, target))) {
      continue;
    }
    const supersededIndex = inspection.keybindings.findIndex((value) =>
      VSCODE_SUPERSEDED_BINDINGS.some(
        (superseded) =>
          superseded.key === target.key && isOurBinding(value, superseded),
      ),
    );
    if (supersededIndex !== -1) {
      replacements.push({ index: supersededIndex, binding: target });
      continue;
    }
    const conflict = inspection.keybindings.some(
      (value) => isKeybinding(value) && value.key === target.key,
    );
    if (conflict) skipped.push(target.key || 'unknown');
    else additions.push(target);
  }

  if (additions.length === 0 && replacements.length === 0) {
    return {
      success: true,
      message: `${terminalName} Shift+Enter is configured.${
        skipped.length > 0
          ? ` Existing bindings were left unchanged: ${skipped.join(', ')}.`
          : ''
      }\nFile: ${inspection.path}`,
    };
  }

  let backupPath: string | undefined;
  try {
    await fs.mkdir(path.dirname(inspection.path), { recursive: true });
    if (inspection.exists) backupPath = await backupFile(inspection.path);
  } catch (error) {
    return {
      success: false,
      message: `Could not back up ${terminalName} keybindings. No changes were made.\nFile: ${inspection.path}\nError: ${String(error)}`,
    };
  }

  // Replace in place first: it keeps the array length, so the append
  // offset below stays valid.
  let nextContent = inspection.content;
  const formattingOptions = getFormattingOptions(inspection.content);
  for (const { index, binding } of replacements) {
    nextContent = applyEdits(
      nextContent,
      modify(nextContent, [index], binding, { formattingOptions }),
    );
  }
  nextContent = appendJsoncArrayValues(
    nextContent,
    inspection.keybindings.length,
    additions,
  );
  const configuredKeys = [
    ...replacements.map(({ binding }) => binding.key),
    ...additions.map((binding) => binding.key),
  ];
  try {
    await fs.writeFile(inspection.path, nextContent, 'utf8');
    return {
      success: true,
      message: `Configured ${configuredKeys.join(', ')} in ${terminalName}.${
        skipped.length > 0
          ? ` Existing bindings were left unchanged: ${skipped.join(', ')}.`
          : ''
      }\nFile: ${inspection.path}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to write ${terminalName} keybindings.\nFile: ${inspection.path}${
        backupPath ? `\nBackup: ${backupPath}` : ''
      }\nError: ${String(error)}`,
    };
  }
}

async function refreshApplePreferences(): Promise<void> {
  try {
    await runCommand('killall', ['cfprefsd']);
  } catch (error) {
    runLogger.debug('Could not refresh Terminal.app preference cache:', error);
  }
}

async function restoreApplePreferences(backupPath: string): Promise<boolean> {
  try {
    await runCommand('defaults', ['import', 'com.apple.Terminal', backupPath]);
    await refreshApplePreferences();
    return true;
  } catch (error) {
    runLogger.warn('Failed to restore Terminal.app preferences:', error);
    return false;
  }
}

async function setAppleTerminalBoolean(
  plistPath: string,
  key: string,
  value: boolean,
): Promise<void> {
  try {
    await runCommand('/usr/libexec/PlistBuddy', [
      '-c',
      `Add ${key} bool ${value}`,
      plistPath,
    ]);
  } catch {
    await runCommand('/usr/libexec/PlistBuddy', [
      '-c',
      `Set ${key} ${value}`,
      plistPath,
    ]);
  }
}

async function configureAppleTerminal(
  options: TerminalSetupOptions,
): Promise<TerminalSetupResult> {
  const macOSMajorVersion = await getMacOSMajorVersion();
  const optionAsMetaRequired = (macOSMajorVersion ?? 0) < 27;
  const audibleBellChangeRequired = !options.screenReader;

  if (!optionAsMetaRequired && !audibleBellChangeRequired) {
    return {
      success: true,
      message:
        'No Terminal.app changes needed.\nShift+Return already enters a newline on this macOS version, and screen-reader mode leaves the audible bell setting unchanged.',
    };
  }

  const plistPath = getAppleTerminalPlistPath();
  const backupPath = `${plistPath}.${randomBytes(4).toString('hex')}.bak`;
  try {
    await runCommand('defaults', [
      'export',
      'com.apple.Terminal',
      backupPath,
    ]);
    await fs.stat(backupPath);
  } catch (error) {
    return {
      success: false,
      message: `Could not back up Terminal.app preferences. No changes were made.\nBackup: ${backupPath}\nError: ${String(error)}`,
    };
  }

  try {
    const profiles = await getAppleTerminalProfiles();
    for (const profile of profiles) {
      if (optionAsMetaRequired) {
        await setAppleTerminalBoolean(
          plistPath,
          getOptionAsMetaPlistKey(profile),
          true,
        );
      }
      if (audibleBellChangeRequired) {
        await setAppleTerminalBoolean(
          plistPath,
          getAudibleBellPlistKey(profile),
          false,
        );
      }
    }
    await refreshApplePreferences();
    const changes = [
      ...(optionAsMetaRequired
        ? ['- Enabled "Use Option as Meta key"']
        : []),
      ...(audibleBellChangeRequired
        ? ['- Disabled the audible bell']
        : [
            '- Left the audible bell setting unchanged (screen-reader mode uses it)',
          ]),
    ];
    return {
      success: true,
      message: [
        'Configured Terminal.app settings:',
        ...changes,
        ...(isNativeModifierDetectionAvailable()
          ? ['Shift+Return will now enter a newline.']
          : [
              'Ctrl+J or backslash followed by Return enters a newline; native Shift+Return detection is unavailable.',
            ]),
        'Option+Enter will now enter a newline.',
      ].join('\n'),
      restartNotice:
        'You must restart Terminal.app for the changes to take effect.',
    };
  } catch (error) {
    const restored = await restoreApplePreferences(backupPath);
    return {
      success: false,
      message: restored
        ? `Failed to configure Terminal.app. Preferences were restored from backup.\nError: ${String(error)}`
        : `Failed to configure Terminal.app and automatic restore failed.\nRun: defaults import com.apple.Terminal ${backupPath}\nError: ${String(error)}`,
    };
  }
}

async function configureAlacritty(): Promise<TerminalSetupResult> {
  const inspection = await inspectAlacritty();
  if (inspection.status === 'configured') {
    return {
      success: true,
      message: `Alacritty Shift+Enter is already configured.\nFile: ${inspection.path}`,
    };
  }
  if (inspection.status === 'unknown') {
    return {
      success: false,
      message: inspection.detail || 'Could not inspect the Alacritty config.',
    };
  }

  let backupPath: string | undefined;
  try {
    await fs.mkdir(path.dirname(inspection.path), { recursive: true });
    if (inspection.exists) backupPath = await backupFile(inspection.path);
  } catch (error) {
    return {
      success: false,
      message: `Could not back up the Alacritty config. No changes were made.\nFile: ${inspection.path}\nError: ${String(error)}`,
    };
  }

  let content = inspection.content;
  if (content && !content.endsWith('\n')) content += '\n';
  if (content) content += '\n';
  content +=
    '[[keyboard.bindings]]\n' +
    'key = "Return"\n' +
    'mods = "Shift"\n' +
    'chars = "\\u001B\\r"\n';
  try {
    await fs.writeFile(inspection.path, content, 'utf8');
    return {
      success: true,
      message: `Installed the Alacritty Shift+Enter keybinding.\nFile: ${inspection.path}`,
      restartNotice:
        'You may need to restart Alacritty for the changes to take effect.',
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to write the Alacritty config.\nFile: ${inspection.path}${
        backupPath ? `\nBackup: ${backupPath}` : ''
      }\nError: ${String(error)}`,
    };
  }
}

async function configureZed(): Promise<TerminalSetupResult> {
  const inspection = await inspectZed();
  if (inspection.status === 'configured') {
    return {
      success: true,
      message: `Zed Shift+Enter is already configured.\nFile: ${inspection.path}`,
    };
  }
  if (inspection.status === 'unknown') {
    return {
      success: false,
      message: inspection.detail || 'Could not inspect the Zed keymap.',
    };
  }

  let backupPath: string | undefined;
  try {
    await fs.mkdir(path.dirname(inspection.path), { recursive: true });
    if (inspection.exists) backupPath = await backupFile(inspection.path);
  } catch (error) {
    return {
      success: false,
      message: `Could not back up the Zed keymap. No changes were made.\nFile: ${inspection.path}\nError: ${String(error)}`,
    };
  }

  const formattingOptions = getFormattingOptions(inspection.content);
  const nextContent =
    inspection.terminalContextIndex !== null
      ? applyEdits(
          inspection.content,
          modify(
            inspection.content,
            [inspection.terminalContextIndex, 'bindings', 'shift-enter'],
            ['terminal::SendText', ALTERNATE_ENTER_SEQUENCE],
            { formattingOptions },
          ),
        )
      : appendJsoncArrayValues(
          inspection.content,
          inspection.keymap.length,
          [
            {
              context: 'Terminal',
              bindings: {
                'shift-enter': ['terminal::SendText', ALTERNATE_ENTER_SEQUENCE],
              },
            },
          ],
        );

  try {
    await fs.writeFile(inspection.path, nextContent, 'utf8');
    return {
      success: true,
      message: `Installed the Zed Shift+Enter keybinding.\nFile: ${inspection.path}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to write the Zed keymap.\nFile: ${inspection.path}${
        backupPath ? `\nBackup: ${backupPath}` : ''
      }\nError: ${String(error)}`,
    };
  }
}

export async function terminalSetup(
  options: TerminalSetupOptions = {},
): Promise<TerminalSetupResult> {
  const assessment = await assessTerminalSetup(options);
  syncInstalledState(assessment);

  if (
    assessment.configurationStatus === 'configured' &&
    assessment.route !== 'vscode-style' &&
    assessment.route !== 'apple-terminal'
  ) {
    return { success: true, message: assessment.message };
  }
  if (
    assessment.configurationStatus === 'unknown' &&
    assessment.route !== 'apple-terminal'
  ) {
    return {
      success: assessment.route === 'remote' || assessment.route === 'unknown',
      message: assessment.detail
        ? `${assessment.message}\n${assessment.detail}`
        : assessment.message,
    };
  }

  let result: TerminalSetupResult;
  if (assessment.route === 'apple-terminal') {
    result = await configureAppleTerminal(options);
  } else if (assessment.route === 'vscode-style') {
    const terminalData = getVSCodeTerminalData(assessment.terminal);
    result = terminalData
      ? await configureVSCodeStyle(
          terminalData.terminalName,
          terminalData.appName,
        )
      : { success: false, message: 'Could not resolve terminal metadata.' };
  } else if (assessment.route === 'alacritty') {
    result = await configureAlacritty();
  } else if (assessment.route === 'zed') {
    result = await configureZed();
  } else {
    result = { success: true, message: assessment.message };
  }

  if (result.success) {
    syncInstalledState({
      ...assessment,
      configurationStatus: 'configured',
    });
  }
  return result;
}

function getConsentMessage(
  assessment: TerminalSetupAssessment,
  options: TerminalSetupOptions,
): string {
  if (assessment.route === 'apple-terminal') {
    return `Use ${BRAND_CLI_NAME}'s terminal setup?\n\nFor the optimal coding experience, enable the recommended settings for your terminal: ${
      options.screenReader
        ? 'Option+Enter for newlines'
        : 'Option+Enter for newlines and no audible bell'
    }`;
  }
  if (assessment.route === 'vscode-style') {
    return `${BRAND_CLI_NAME} can configure multiline input and Undo/Redo terminal shortcuts in ${assessment.terminalName}. Configure them now?`;
  }
  return `${BRAND_CLI_NAME} can configure Shift+Enter in ${assessment.terminalName}. Configure it now?`;
}

function requestTerminalSetupConsent(
  prompt: string,
  setConfirmationRequest: (value: ConfirmationRequest | null) => void,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const close = (confirmed: boolean) => {
      setConfirmationRequest(null);
      resolve(confirmed);
    };
    setConfirmationRequest({
      prompt,
      confirmLabel: 'Yes, use recommended settings',
      cancelLabel: 'No, maybe later',
      hideTitle: true,
      onConfirm: close,
      onCancel: () => close(false),
    });
  });
}

function getTerminalSetupTip(
  assessment: TerminalSetupAssessment | null,
): string | undefined {
  if (
    !assessment ||
    !assessment.canConfigure ||
    assessment.configurationStatus !== 'not_configured'
  ) {
    return undefined;
  }
  return assessment.route === 'apple-terminal'
    ? 'Run /terminal-setup to enable convenient terminal integration like Option + Enter for new line and more'
    : 'Run /terminal-setup to enable recommended terminal shortcuts';
}

export function formatTerminalSetupResultMessage(
  result: TerminalSetupResult,
): string {
  return result.restartNotice
    ? `${result.message}\n\n${result.restartNotice}`
    : result.message;
}

export async function shouldPromptForTerminalSetup(): Promise<boolean> {
  const assessment = await assessTerminalSetup();
  return (
    assessment.canConfigure &&
    assessment.configurationStatus === 'not_configured'
  );
}

interface UseTerminalSetupPromptParams {
  addConfirmUpdateExtensionRequest: (
    request: ConfirmationRequest | null,
  ) => void;
  addItem: AddItemFn;
  screenReader?: boolean;
}

export interface UseTerminalSetupPromptResult {
  assessment: TerminalSetupAssessment | null;
  terminalSetupTip?: string;
}

export function useTerminalSetupPrompt({
  addConfirmUpdateExtensionRequest,
  addItem,
  screenReader = false,
}: UseTerminalSetupPromptParams): UseTerminalSetupPromptResult {
  const [assessment, setAssessment] =
    useState<TerminalSetupAssessment | null>(null);

  useEffect(() => {
    let cancelled = false;

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      const options = { screenReader };
      const nextAssessment = await assessTerminalSetup(options);
      if (cancelled) return;
      syncInstalledState(nextAssessment);
      setAssessment(nextAssessment);

      const hasBeenPrompted = persistentState.get('terminalSetupPromptShown');
      if (
        hasBeenPrompted ||
        !nextAssessment.canConfigure ||
        nextAssessment.configurationStatus !== 'not_configured'
      ) {
        return;
      }

      persistentState.set('terminalSetupPromptShown', true);
      const confirmed = await requestTerminalSetupConsent(
        getConsentMessage(nextAssessment, options),
        addConfirmUpdateExtensionRequest,
      );
      if (!confirmed || cancelled) return;

      const result = await terminalSetup(options);
      if (cancelled) return;
      if (result.success) {
        setAssessment({
          ...nextAssessment,
          configurationStatus: 'configured',
        });
      }
      addItem(
        {
          type: result.success ? 'info' : 'error',
          text: formatTerminalSetupResultMessage(result),
        },
        Date.now(),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [addConfirmUpdateExtensionRequest, addItem, screenReader]);

  return {
    assessment,
    terminalSetupTip: getTerminalSetupTip(assessment),
  };
}
