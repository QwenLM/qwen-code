/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Detects coding agents on the user's PATH that qwen-live can drive as ACP
 * backends. Each agent is probed with `--version` (cheap, non-blocking);
 * the ACP handshake itself is left to the daemon's preflight.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface DetectedAgent {
  /** Display name for the prompt. */
  label: string;
  /** Backend name for config.json (matches the name pattern). */
  name: string;
  /** Resolved command to spawn the agent. */
  command: string;
  /** Args to enter ACP mode. */
  args: string[];
  /** Detected version string (may be empty). */
  version: string;
  /** Environment variables the agent needs (e.g. CODEX_PATH). */
  env?: Record<string, string>;
}

/** Agent definitions: how to detect + how to launch in ACP mode. */
const AGENT_SPECS: ReadonlyArray<{
  label: string;
  name: string;
  binary: string;
  acpArgs: string[];
  /** If true, the agent itself is the ACP server. If false, use npx adapter. */
  native: boolean;
  /** Adapter package for non-native agents. */
  adapterPackage?: string;
  /** Env to pass through for non-native agents. */
  envKey?: string;
}> = [
  {
    label: 'Qoder CLI',
    name: 'qodercli',
    binary: 'qodercli',
    acpArgs: ['--acp'],
    native: true,
  },
  {
    label: 'Qwen Code',
    name: 'qwen',
    binary: 'qwen',
    acpArgs: ['--acp'],
    native: true,
  },
  {
    label: 'Gemini CLI',
    name: 'gemini',
    binary: 'gemini',
    acpArgs: ['--experimental-acp'],
    native: true,
  },
  {
    label: 'Claude Code',
    name: 'claude',
    binary: 'claude',
    acpArgs: ['-y', '@agentclientprotocol/claude-agent-acp'],
    native: false,
    adapterPackage: '@agentclientprotocol/claude-agent-acp',
  },
  {
    label: 'Codex',
    name: 'codex',
    binary: 'codex',
    acpArgs: ['-y', '@agentclientprotocol/codex-acp'],
    native: false,
    adapterPackage: '@agentclientprotocol/codex-acp',
    envKey: 'CODEX_PATH',
  },
];

/**
 * Resolve a command name to an absolute path on the PATH.
 * Returns undefined if not found. Supports PATHEXT on Windows.
 */
function findExecutable(command: string): string | undefined {
  // Absolute or relative path — return as-is if it exists.
  if (command.includes('/') || command.includes('\\')) {
    try {
      accessSync(command);
      return command;
    } catch {
      return undefined;
    }
  }
  const pathEnv = process.env['PATH'] ?? '';
  const pathExt = process.env['PATHEXT'];
  const extensions = pathExt ? pathExt.split(';') : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      try {
        const stat = statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        /* not found, continue */
      }
    }
  }
  return undefined;
}

/**
 * Probe a binary with `--version` (3s timeout). Returns the trimmed
 * stdout, or undefined if the probe failed.
 */
function probeVersion(binary: string): string | undefined {
  const resolved = findExecutable(binary);
  if (!resolved) return undefined;
  try {
    const result = spawnSync(resolved, ['--version'], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    });
    if (result.status === 0) {
      return (result.stdout || result.stderr || '').trim().split('\n')[0];
    }
    // Some CLIs exit non-zero on --version but still print to stderr.
    const fallback = (result.stderr || '').trim().split('\n')[0];
    return fallback || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect all supported coding agents installed on the current machine.
 * Returns an array of DetectedAgent, ordered by the spec priority
 * (qodercli first, then qwen, gemini, claude, codex).
 */
export function detectAgents(): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const spec of AGENT_SPECS) {
    const version = probeVersion(spec.binary);
    if (!version) continue;
    if (spec.native) {
      const resolved = findExecutable(spec.binary);
      if (!resolved) continue;
      found.push({
        label: spec.label,
        name: spec.name,
        command: resolved,
        args: spec.acpArgs,
        version,
      });
    } else {
      // Non-native: use npx to run the adapter. The binary itself
      // (claude/codex) must be on PATH for the adapter to find it.
      const resolved = findExecutable(spec.binary);
      if (!resolved) continue;
      const npx = findExecutable('npx') ?? 'npx';
      found.push({
        label: spec.label,
        name: spec.name,
        command: npx,
        args: spec.acpArgs,
        version,
        ...(spec.envKey ? { env: { [spec.envKey]: resolved } } : {}),
      });
    }
  }
  return found;
}
