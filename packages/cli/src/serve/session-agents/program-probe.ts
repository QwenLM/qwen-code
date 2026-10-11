/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Which agent programs this machine can run (Host enrollment
 * and the local runtime both advertise the result).
 *
 * qwen is always available: it is this process. claude and codex are looked
 * up on PATH (or at `QWEN_AGENT_CLAUDE_PATH` / `QWEN_AGENT_CODEX_PATH`), asked
 * for `--version` with a 10s bound, and compared with `MIN_PROGRAM_VERSIONS`
 * (Multica server/pkg/agent/version.go, internal/daemon/agents_probe.go).
 * Results are cached for 60s per environment.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  MIN_PROGRAM_VERSIONS,
  type HostProgramProbe,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { CLAUDE_PATH_ENV } from './adapters/claude-cli.js';
import { CODEX_PATH_ENV } from './adapters/codex-app-server.js';

export const PROGRAM_PROBE_CACHE_MS = 60_000;
export const PROGRAM_VERSION_TIMEOUT_MS = 10_000;

type ProbedProgram = 'claude' | 'codex';

const PROGRAMS: ReadonlyArray<{ program: ProbedProgram; envVar: string }> = [
  { program: 'claude', envVar: CLAUDE_PATH_ENV },
  { program: 'codex', envVar: CODEX_PATH_ENV },
];

export interface ProbeAgentProgramsOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seams. */
  runVersion?: (executable: string, env: NodeJS.ProcessEnv) => Promise<string>;
  isExecutable?: (file: string) => boolean;
  platform?: NodeJS.Platform;
  now?: () => number;
}

function defaultIsExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of `name` on `env.PATH`, honouring `PATHEXT` on Windows
 * (where an npm CLI is `claude.cmd`). A name with a path separator is
 * resolved as given.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (file: string) => boolean = defaultIsExecutable,
): string | undefined {
  // PATHEXT first, bare name last (as cmd.exe does): npm puts an
  // extension-less `sh` script beside `claude.cmd`, and that script cannot
  // be executed on Windows.
  const extensions =
    platform === 'win32'
      ? [
          ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter(Boolean),
          '',
        ]
      : [''];
  // Windows file names are case-insensitive, so PATHEXT's case is fine.
  const withExtensions = (base: string) => extensions.map((ext) => base + ext);
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
    const base = isAbsolute(name) ? name : resolve(name);
    return withExtensions(base).find(isExecutable);
  }
  const pathKey =
    platform === 'win32'
      ? (Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH')
      : 'PATH';
  for (const dir of (env[pathKey] ?? '').split(
    platform === 'win32' ? ';' : delimiter,
  )) {
    if (!dir) continue;
    const found = withExtensions(join(dir, name)).find(isExecutable);
    if (found) return found;
  }
  return undefined;
}

function defaultRunVersion(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
  return new Promise((resolvePromise, reject) => {
    execFile(
      shim ? `"${executable}"` : executable,
      ['--version'],
      {
        env,
        timeout: PROGRAM_VERSION_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
        shell: shim,
        maxBuffer: 64 * 1024,
      },
      (error, stdout) => {
        // The answer may be complete even if the CLI left a pipe open
        // (Multica `salvageProbeAnswer`); a recognisable version wins.
        if (error && !parseSemver(String(stdout))) reject(error);
        else resolvePromise(String(stdout));
      },
    );
  });
}

type Semver = [number, number, number];

export function parseSemver(text: string): Semver | undefined {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function lessThan(a: Semver, b: Semver): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}

/** The first line carrying a version, else the trimmed output. */
function versionLine(output: string): string {
  for (const line of output.split('\n')) {
    if (parseSemver(line)) return line.trim();
  }
  return output.trim();
}

async function probeOne(
  program: ProbedProgram,
  envVar: string,
  options: Required<Omit<ProbeAgentProgramsOptions, 'now'>>,
): Promise<HostProgramProbe> {
  const { env } = options;
  const override = env[envVar]?.trim();
  const executable = findOnPath(
    override || program,
    env,
    options.platform,
    options.isExecutable,
  );
  if (!executable) {
    return {
      program,
      available: false,
      reason: override
        ? `${envVar}=${override} is not an executable file.`
        : `${program} was not found on PATH.`,
    };
  }
  let output: string;
  try {
    output = await options.runVersion(executable, env);
  } catch (error) {
    return {
      program,
      available: false,
      reason: `${program} --version failed: ${(error as Error).message}`,
    };
  }
  const version = versionLine(output);
  const detected = parseSemver(version);
  const minimum = parseSemver(MIN_PROGRAM_VERSIONS[program])!;
  if (!detected) {
    // TODO(multi-agent): an unparsable version is treated as available, so
    // an unusual build is not locked out; revisit if old CLIs slip through.
    return { program, available: true, ...(version ? { version } : {}) };
  }
  if (lessThan(detected, minimum)) {
    return {
      program,
      version,
      available: false,
      reason: `${program} ${detected.join('.')} is below the minimum ${MIN_PROGRAM_VERSIONS[program]}; please upgrade.`,
    };
  }
  return { program, version, available: true };
}

const cache = new Map<
  string,
  { at: number; result: Promise<HostProgramProbe[]> }
>();

function cacheKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify([
    env['PATH'] ?? env['Path'] ?? '',
    env['PATHEXT'] ?? '',
    ...PROGRAMS.map(({ envVar }) => env[envVar] ?? ''),
  ]);
}

/** Probes qwen, claude and codex; cached for {@link PROGRAM_PROBE_CACHE_MS}. */
export function probeAgentPrograms(
  options: ProbeAgentProgramsOptions = {},
): Promise<HostProgramProbe[]> {
  const env = options.env ?? process.env;
  const now = (options.now ?? Date.now)();
  const key = cacheKey(env);
  const hit = cache.get(key);
  if (hit && now - hit.at < PROGRAM_PROBE_CACHE_MS) return hit.result;
  const resolved = {
    env,
    runVersion: options.runVersion ?? defaultRunVersion,
    isExecutable: options.isExecutable ?? defaultIsExecutable,
    platform: options.platform ?? process.platform,
  };
  const result = Promise.all(
    PROGRAMS.map(({ program, envVar }) => probeOne(program, envVar, resolved)),
  ).then((probes): HostProgramProbe[] => [
    { program: 'qwen', available: true },
    ...probes,
  ]);
  cache.set(key, { at: now, result });
  // A rejected probe (it should not reject) must not stick for 60s.
  result.catch(() => cache.delete(key));
  return result;
}

/** Test seam: forget cached probes. */
export function clearAgentProgramProbeCache(): void {
  cache.clear();
}

/** Executable to run for a program: the env override, else the bare name. */
export function agentProgramExecutable(
  program: ProbedProgram,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envVar = PROGRAMS.find((entry) => entry.program === program)!.envVar;
  const override = env[envVar]?.trim();
  if (override) return override;
  // Resolve on PATH so a Windows `.cmd` shim is spawned through a shell.
  return findOnPath(program, env);
}
