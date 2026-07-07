/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Type-safe async wrappers for iTerm2 it2 CLI commands.
 *
 * The it2 CLI talks to iTerm2's Python API. We use it2 directly and avoid
 * AppleScript to match the Team design spec.
 */

import { execCommand, isCommandAvailable } from '../../utils/shell-utils.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('ITERM_IT2');

// ─── Helpers ────────────────────────────────────────────────────

async function it2Result(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  debugLogger.info(`it2 ${args.join(' ')}`);
  const result = await execCommand('it2', args, {
    preserveOutputOnError: true,
  });
  if (result.code !== 0 && result.stderr.trim()) {
    debugLogger.error(`it2 error: ${result.stderr.trim()}`);
  }
  return result;
}

async function it2(args: string[]): Promise<string> {
  const result = await it2Result(args);
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim();
    throw new Error(message || 'it2 command failed');
  }
  return result.stdout;
}

function parseCreatedPaneId(output: string): string {
  const match = output.match(/Created new pane:\s*(\S+)/);
  if (!match?.[1]) {
    throw new Error(`Unable to parse it2 split output: ${output.trim()}`);
  }
  return match[1];
}

// ─── Installation & Verification ───────────────────────────────

export function isIt2Available(): boolean {
  return isCommandAvailable('it2').available;
}

async function tryInstallIt2(
  command: string,
  args: string[],
): Promise<boolean> {
  if (!isCommandAvailable(command).available) return false;
  const result = await execCommand(command, args, {
    preserveOutputOnError: true,
  });
  return result.code === 0;
}

export async function ensureIt2Installed(): Promise<void> {
  if (isIt2Available()) return;

  const installers: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'uv', args: ['tool', 'install', 'it2'] },
    { cmd: 'pipx', args: ['install', 'it2'] },
    { cmd: 'pip', args: ['install', '--user', 'it2'] },
  ];

  for (const installer of installers) {
    const installed = await tryInstallIt2(installer.cmd, installer.args);
    if (installed && isIt2Available()) return;
  }

  throw new Error(
    'it2 is not installed. Install it2 via "uv tool install it2", "pipx install it2", or "pip install --user it2".',
  );
}

export async function verifyITerm(): Promise<void> {
  await ensureIt2Installed();

  const result = await it2Result(['session', 'list']);
  if (result.code === 0) return;

  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (
    combined.includes('api') ||
    combined.includes('python') ||
    combined.includes('connection refused') ||
    combined.includes('not enabled')
  ) {
    throw new Error(
      'iTerm2 Python API not enabled. Enable it in iTerm2 → Settings → General → Magic → Enable Python API, then restart iTerm2.',
    );
  }

  throw new Error(
    `it2 session list failed: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

// ─── Public API ─────────────────────────────────────────────────

export async function itermSplitPane(sessionId?: string): Promise<string> {
  const args = ['session', 'split', '-v'];
  if (sessionId) {
    args.push('-s', sessionId);
  }
  const output = await it2(args);
  return parseCreatedPaneId(output);
}

export async function itermRunCommand(
  sessionId: string,
  command: string,
): Promise<void> {
  await it2(['session', 'run', '-s', sessionId, command]);
}

export async function itermFocusSession(sessionId: string): Promise<void> {
  await it2(['session', 'focus', sessionId]);
}

export async function itermSendText(
  sessionId: string,
  text: string,
): Promise<void> {
  await it2(['session', 'send', '-s', sessionId, text]);
}

export async function itermCloseSession(sessionId: string): Promise<void> {
  await it2(['session', 'close', '-s', sessionId]);
}
