/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Type-safe async wrappers for tmux CLI commands.
 *
 * All functions use `execCommand('tmux', [...args])` from shell-utils,
 * avoiding shell injection by passing arguments as arrays (execFile).
 */

import { execCommand, isCommandAvailable } from '../../utils/shell-utils.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('TMUX_CMD');

/**
 * Information about a tmux pane, parsed from `list-panes`.
 */
export interface TmuxPaneInfo {
  /** Pane ID (e.g., '%0', '%1') */
  paneId: string;
  /** Whether the pane's process has exited */
  dead: boolean;
  /** Exit status of the pane's process (only valid when dead=true) */
  deadStatus: number;
}

/**
 * Information about a tmux window.
 */
export interface TmuxWindowInfo {
  /** Window name */
  name: string;
  /** Window ID (e.g., '@1') */
  id: string;
}

/**
 * Minimum tmux version required for split-pane support.
 */
const MIN_TMUX_VERSION = '3.0';

// ─── Helpers ────────────────────────────────────────────────────

async function tmuxResult(
  args: string[],
  serverName?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const fullArgs = serverName ? ['-L', serverName, ...args] : args;
  debugLogger.info(`tmux ${fullArgs.join(' ')}`);
  const result = await execCommand('tmux', fullArgs, {
    preserveOutputOnError: true,
  });
  if (result.code !== 0 && result.stderr.trim()) {
    debugLogger.error(`tmux error: ${result.stderr.trim()}`);
  }
  return result;
}

async function tmux(args: string[], serverName?: string): Promise<string> {
  const result = await tmuxResult(args, serverName);
  if (result.code !== 0) {
    throw new Error(
      `tmux ${args[0]} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

function parseVersion(versionStr: string): number[] {
  // "tmux 3.4" → [3, 4]
  const match = versionStr.match(/(\d+)\.(\d+)/);
  if (!match) return [0, 0];
  return [parseInt(match[1]!, 10), parseInt(match[2]!, 10)];
}

function isVersionAtLeast(current: string, minimum: string): boolean {
  const [curMajor = 0, curMinor = 0] = parseVersion(current);
  const [minMajor = 0, minMinor = 0] = parseVersion(minimum);
  if (curMajor !== minMajor) return curMajor > minMajor;
  return curMinor >= minMinor;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Check if tmux is available on the system.
 */
export function isTmuxAvailable(): boolean {
  return isCommandAvailable('tmux').available;
}

/**
 * Get tmux version string (e.g., "tmux 3.4").
 */
export async function tmuxVersion(): Promise<string> {
  const output = await tmux(['-V']);
  return output.trim();
}

/**
 * Verify tmux is available and meets minimum version requirement.
 *
 * @throws Error if tmux is not available or version is too old.
 */
export async function verifyTmux(): Promise<void> {
  if (!isTmuxAvailable()) {
    throw new Error(
      'tmux is not installed. Install tmux (version 3.0+) for split-pane mode.',
    );
  }

  const version = await tmuxVersion();
  if (!isVersionAtLeast(version, MIN_TMUX_VERSION)) {
    throw new Error(
      `tmux version ${MIN_TMUX_VERSION}+ required for split-pane mode (found: ${version}).`,
    );
  }
}

/**
 * Get the current tmux session name (when running inside tmux).
 */
export async function tmuxCurrentSession(): Promise<string> {
  const output = await tmux(['display-message', '-p', '#{session_name}']);
  return output.trim();
}

/**
 * Get the current tmux pane ID (when running inside tmux).
 */
export async function tmuxCurrentPaneId(): Promise<string> {
  const output = await tmux(['display-message', '-p', '#{pane_id}']);
  return output.trim();
}

/**
 * Get the current tmux window target (session:window_index).
 */
export async function tmuxCurrentWindowTarget(): Promise<string> {
  const output = await tmux([
    'display-message',
    '-p',
    '#{session_name}:#{window_index}',
  ]);
  return output.trim();
}

/**
 * Check if a tmux session exists.
 */
export async function tmuxHasSession(
  name: string,
  serverName?: string,
): Promise<boolean> {
  const result = await tmuxResult(['has-session', '-t', name], serverName);
  return result.code === 0;
}

/**
 * List windows in a session.
 */
export async function tmuxListWindows(
  sessionName: string,
  serverName?: string,
): Promise<TmuxWindowInfo[]> {
  const output = await tmux(
    ['list-windows', '-t', sessionName, '-F', '#{window_name} #{window_id}'],
    serverName,
  );
  const windows: TmuxWindowInfo[] = [];
  for (const line of output.trim().split('\n')) {
    if (!line.trim()) continue;
    const [name, id] = line.trim().split(/\s+/, 2);
    if (!name || !id) continue;
    windows.push({ name, id });
  }
  return windows;
}

/**
 * Check if a tmux window exists within a session.
 */
export async function tmuxHasWindow(
  sessionName: string,
  windowName: string,
  serverName?: string,
): Promise<boolean> {
  const windows = await tmuxListWindows(sessionName, serverName);
  return windows.some((w) => w.name === windowName);
}

/**
 * Create a new detached tmux session.
 */
export async function tmuxNewSession(
  name: string,
  opts?: { cols?: number; rows?: number; windowName?: string },
  serverName?: string,
): Promise<void> {
  const args = ['new-session', '-d', '-s', name];
  if (opts?.windowName) args.push('-n', opts.windowName);
  if (opts?.cols) args.push('-x', String(opts.cols));
  if (opts?.rows) args.push('-y', String(opts.rows));
  await tmux(args, serverName);
}

/**
 * Create a new window in an existing session.
 */
export async function tmuxNewWindow(
  targetSession: string,
  windowName: string,
  serverName?: string,
): Promise<void> {
  // -t session: (with trailing colon) means "create window in this session"
  // -t session (without colon) means "create at window index = session", which fails if index exists
  await tmux(
    ['new-window', '-t', `${targetSession}:`, '-n', windowName],
    serverName,
  );
}

/**
 * Split a window/pane and return the new pane ID.
 *
 * @param target - Target pane/window (e.g., session:window or pane ID)
 * @param opts.horizontal - Split horizontally (left/right) if true, vertically (top/bottom) if false
 * @param opts.percent - Size of the new pane as a percentage (e.g., 70 for 70%)
 * @param opts.command - Shell command to execute directly in the new pane.
 *   When provided, the command becomes the pane's process (not a shell),
 *   so `#{pane_dead}` is set when the command exits.
 * @returns The pane ID of the newly created pane (e.g., '%5')
 */
export async function tmuxSplitWindow(
  target: string,
  opts?: { horizontal?: boolean; percent?: number; command?: string },
  serverName?: string,
): Promise<string> {
  const args = ['split-window', '-t', target];
  if (opts?.horizontal) {
    args.push('-h');
  }
  if (opts?.percent !== undefined) {
    args.push('-l', `${opts.percent}%`);
  }
  // -P -F: print new pane info in the specified format
  args.push('-P', '-F', '#{pane_id}');
  if (opts?.command) {
    args.push(opts.command);
  }
  const output = await tmux(args, serverName);
  return output.trim();
}

/**
 * Send keys to a tmux pane.
 *
 * @param paneId - Target pane ID
 * @param keys - Keys to send
 * @param opts.literal - If true, use -l flag (send keys literally, don't interpret)
 */
export async function tmuxSendKeys(
  paneId: string,
  keys: string,
  opts?: { literal?: boolean; enter?: boolean },
  serverName?: string,
): Promise<void> {
  const args = ['send-keys', '-t', paneId];
  if (opts?.literal) {
    args.push('-l');
  }
  args.push(keys);
  if (opts?.enter) {
    args.push('Enter');
  }
  await tmux(args, serverName);
}

/**
 * Select (focus) a tmux pane.
 */
export async function tmuxSelectPane(
  paneId: string,
  serverName?: string,
): Promise<void> {
  await tmux(['select-pane', '-t', paneId], serverName);
}

/**
 * Set a pane title.
 */
export async function tmuxSelectPaneTitle(
  paneId: string,
  title: string,
  serverName?: string,
): Promise<void> {
  await tmux(['select-pane', '-t', paneId, '-T', title], serverName);
}

/**
 * Set a pane border style via select-pane -P.
 */
export async function tmuxSelectPaneStyle(
  paneId: string,
  style: string,
  serverName?: string,
): Promise<void> {
  await tmux(['select-pane', '-t', paneId, '-P', style], serverName);
}

/**
 * Set the layout for a target window.
 *
 * @param target - Target window (e.g., session:window)
 * @param layout - Layout name: 'tiled', 'even-horizontal', 'even-vertical', etc.
 */
export async function tmuxSelectLayout(
  target: string,
  layout: string,
  serverName?: string,
): Promise<void> {
  await tmux(['select-layout', '-t', target, layout], serverName);
}

/**
 * Capture the content of a pane (including ANSI escape codes).
 *
 * @returns The captured pane content as a string.
 */
export async function tmuxCapturePaneContent(
  paneId: string,
  serverName?: string,
): Promise<string> {
  // -p: output to stdout, -e: include escape sequences
  return await tmux(['capture-pane', '-t', paneId, '-p', '-e'], serverName);
}

/**
 * List panes in a target window/session and return parsed info.
 *
 * @param target - Target window (e.g., session:window)
 * @returns Array of pane information.
 */
export async function tmuxListPanes(
  target: string,
  serverName?: string,
): Promise<TmuxPaneInfo[]> {
  const output = await tmux(
    [
      'list-panes',
      '-t',
      target,
      '-F',
      '#{pane_id} #{pane_dead} #{pane_dead_status}',
    ],
    serverName,
  );
  return parseTmuxListPanes(output);
}

/**
 * Parse the output of `tmux list-panes -F '#{pane_id} #{pane_dead} #{pane_dead_status}'`.
 */
export function parseTmuxListPanes(output: string): TmuxPaneInfo[] {
  const panes: TmuxPaneInfo[] = [];
  for (const line of output.trim().split('\n')) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    panes.push({
      paneId: parts[0]!,
      dead: parts[1] === '1',
      deadStatus: parts[2] ? parseInt(parts[2], 10) : 0,
    });
  }
  return panes;
}

/**
 * Set a tmux option on a target pane/window.
 */
export async function tmuxSetOption(
  target: string,
  option: string,
  value: string,
  serverName?: string,
): Promise<void> {
  await tmux(['set-option', '-t', target, option, value], serverName);
}

/**
 * Respawn a pane with a new command.
 *
 * Kills the current process in the pane and starts a new one.
 * The command becomes the pane's direct process, so `#{pane_dead}`
 * is set when the command exits.
 *
 * @param paneId - Target pane ID
 * @param command - Shell command to execute
 */
export async function tmuxRespawnPane(
  paneId: string,
  command: string,
  serverName?: string,
): Promise<void> {
  await tmux(['respawn-pane', '-k', '-t', paneId, command], serverName);
}

/**
 * Break a pane into a target session (detaches from current window).
 */
export async function tmuxBreakPane(
  paneId: string,
  targetSession: string,
  serverName?: string,
): Promise<void> {
  await tmux(['break-pane', '-s', paneId, '-t', targetSession], serverName);
}

/**
 * Join a pane into a target window.
 */
export async function tmuxJoinPane(
  paneId: string,
  target: string,
  serverName?: string,
): Promise<void> {
  await tmux(['join-pane', '-s', paneId, '-t', target], serverName);
}

/**
 * Kill a tmux pane.
 */
export async function tmuxKillPane(
  paneId: string,
  serverName?: string,
): Promise<void> {
  await tmux(['kill-pane', '-t', paneId], serverName);
}

/**
 * Resize a tmux pane.
 *
 * @param paneId - Target pane ID
 * @param opts.height - Height (number for lines, or string like '50%')
 * @param opts.width - Width (number for columns, or string like '50%')
 */
export async function tmuxResizePane(
  paneId: string,
  opts: { height?: number | string; width?: number | string },
  serverName?: string,
): Promise<void> {
  const args = ['resize-pane', '-t', paneId];
  if (opts.height !== undefined) {
    args.push('-y', String(opts.height));
  }
  if (opts.width !== undefined) {
    args.push('-x', String(opts.width));
  }
  await tmux(args, serverName);
}

/**
 * Kill a tmux session.
 */
export async function tmuxKillSession(
  name: string,
  serverName?: string,
): Promise<void> {
  await tmux(['kill-session', '-t', name], serverName);
}

/**
 * Kill a tmux window.
 */
export async function tmuxKillWindow(
  target: string,
  serverName?: string,
): Promise<void> {
  await tmux(['kill-window', '-t', target], serverName);
}

/**
 * Get the first pane ID of a target window.
 */
export async function tmuxGetFirstPaneId(
  target: string,
  serverName?: string,
): Promise<string> {
  const output = await tmux(
    ['list-panes', '-t', target, '-F', '#{pane_id}'],
    serverName,
  );
  const firstLine = output.trim().split('\n')[0];
  if (!firstLine) {
    throw new Error(`No panes found in target: ${target}`);
  }
  return firstLine.trim();
}
