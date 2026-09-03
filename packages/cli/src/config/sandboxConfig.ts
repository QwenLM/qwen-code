/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SandboxConfig } from '@qwen-code/qwen-code-core/config/config.js';
import { FatalSandboxError } from '@qwen-code/qwen-code-core/utils/errors.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import commandExists from 'command-exists';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import { getPackageJson } from '../utils/package.js';
import type { Settings } from './settings.js';

// This is a stripped-down version of the CliArgs interface from config.ts
// to avoid circular dependencies.
interface SandboxCliArgs {
  sandbox?: boolean | string;
  sandboxImage?: string;
}

const VALID_SANDBOX_COMMANDS: ReadonlyArray<SandboxConfig['command']> = [
  'docker',
  'podman',
  'sandbox-exec',
];

function isSandboxCommand(value: string): value is SandboxConfig['command'] {
  return (VALID_SANDBOX_COMMANDS as readonly string[]).includes(value);
}

// A healthy `docker version` answers in roughly 200-500ms, so this is already
// an order of magnitude of headroom. Keeping it tight matters because a wedged
// daemon blocks startup for the full cap.
const SANDBOX_PROBE_TIMEOUT_MS = 5_000;

// `loadSandboxConfig` runs twice on a sandboxed startup — once for the sandbox
// hop and once inside loadCliConfig — so selection is entered more than once
// per process. Cache each command's probe outcome so a runtime is contacted at
// most once; otherwise the wedged-daemon-then-fallback case pays the timeout
// twice. Daemon state changing mid-startup is not worth serving. Mirrors the
// ripgrep health cache (`ripgrepUtils.ts`).
const probeCache = new Map<SandboxConfig['command'], string | undefined>();

/** Clears the per-process probe cache so tests stay hermetic. */
export function resetSandboxProbeCacheForTest(): void {
  probeCache.clear();
}

/**
 * Confirms that a sandbox command can actually run, not merely that it is on
 * PATH. A present container CLI is not a usable one: Docker Desktop may be
 * stopped, the daemon may be unreachable, or the user may not be in the
 * `docker` group. `version` is the cheapest command that still contacts the
 * daemon, so it fails exactly when the runtime would fail later.
 *
 * `sandbox-exec` is a kernel facility rather than a daemon-backed client, so
 * its presence on PATH is already sufficient.
 *
 * @returns The failure output when the command cannot run, or undefined when it
 *          is usable. The result is cached per command for the process.
 */
function probeSandboxCommand(
  command: SandboxConfig['command'],
): string | undefined {
  if (command === 'sandbox-exec') {
    return undefined;
  }
  if (probeCache.has(command)) {
    return probeCache.get(command);
  }
  const failure = runSandboxProbe(command);
  probeCache.set(command, failure);
  return failure;
}

function runSandboxProbe(
  command: SandboxConfig['command'],
): string | undefined {
  try {
    const result = spawnSync(command, ['version'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: SANDBOX_PROBE_TIMEOUT_MS,
    });
    if (result.error) {
      return result.error.message;
    }
    if (result.status === 0) {
      return undefined;
    }
    const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
    const firstLine = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    // The runtime's own output reaches a FatalSandboxError message, so strip
    // ANSI/control characters from that untrusted string before it hits the
    // terminal. Check for emptiness AFTER stripping: a line that is only
    // control characters strips to '', which is falsy — return that and the
    // caller reads the broken runtime as usable, the very bug this guards.
    const stripped = firstLine ? stripAnsiAndControl(firstLine).trim() : '';
    return stripped || `'${command} version' exited with ${result.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function getSandboxCommand(
  sandbox?: boolean | string,
): SandboxConfig['command'] | '' {
  // If the SANDBOX env var is set, we're already inside the sandbox.
  if (process.env['SANDBOX']) {
    return '';
  }

  // note environment variable takes precedence over argument (from command line or settings)
  const environmentConfiguredSandbox =
    process.env['QWEN_SANDBOX']?.toLowerCase().trim() ?? '';
  sandbox =
    environmentConfiguredSandbox?.length > 0
      ? environmentConfiguredSandbox
      : sandbox;
  if (sandbox === '1' || sandbox === 'true') sandbox = true;
  else if (sandbox === '0' || sandbox === 'false' || !sandbox) sandbox = false;

  if (sandbox === false) {
    return '';
  }

  // An explicitly named command can come from QWEN_SANDBOX, --sandbox, or
  // tools.sandbox in settings. Naming the wrong one sends the user looking in
  // a place they never configured, so only claim the env var when it won.
  const sandboxSource =
    environmentConfiguredSandbox.length > 0 ? ' (from QWEN_SANDBOX)' : '';

  if (typeof sandbox === 'string' && sandbox) {
    if (!isSandboxCommand(sandbox)) {
      throw new FatalSandboxError(
        `Invalid sandbox command '${sandbox}'. Must be one of ${VALID_SANDBOX_COMMANDS.join(
          ', ',
        )}`,
      );
    }
    // confirm that specified command exists
    if (commandExists.sync(sandbox)) {
      // An explicit choice is never silently overridden — but it is still
      // probed, so the failure names the runtime instead of surfacing later as
      // an opaque container error.
      const failure = probeSandboxCommand(sandbox);
      if (failure) {
        throw new FatalSandboxError(
          `Sandbox command '${sandbox}'${sandboxSource} is installed but cannot run: ${failure}`,
        );
      }
      return sandbox;
    }
    throw new FatalSandboxError(
      `Missing sandbox command '${sandbox}'${sandboxSource}`,
    );
  }

  // look for seatbelt, docker, or podman, in that order
  // for container-based sandboxing, require sandbox to be enabled explicitly
  const candidates: Array<SandboxConfig['command']> = [];
  if (os.platform() === 'darwin' && commandExists.sync('sandbox-exec')) {
    candidates.push('sandbox-exec');
  }
  if (sandbox === true) {
    candidates.push('docker', 'podman');
  }

  // Selecting on presence alone would stop at an installed-but-unusable
  // runtime and leave a working one below it unreachable, so each candidate is
  // probed and the first one that actually runs wins.
  let firstFailure: { command: string; detail: string } | undefined;
  for (const candidate of candidates) {
    if (!commandExists.sync(candidate)) {
      continue;
    }
    const failure = probeSandboxCommand(candidate);
    if (!failure) {
      return candidate;
    }
    firstFailure ??= { command: candidate, detail: failure };
  }

  // throw an error if user requested sandbox but no command was found
  if (sandbox === true) {
    // Sandboxing can be switched on by the env var, by --sandbox, or by
    // settings, so these messages name the env var only when it was the one
    // that enabled it — same reasoning as sandboxSource above.
    const enabledLabel = sandboxSource
      ? 'QWEN_SANDBOX is true'
      : 'Sandbox is enabled';
    const specifyHint = sandboxSource
      ? 'specify command in QWEN_SANDBOX'
      : 'specify command via --sandbox or QWEN_SANDBOX';
    // Report the runtime that actually broke rather than a generic
    // "nothing installed", which would send the user down the wrong path.
    if (firstFailure) {
      throw new FatalSandboxError(
        `${enabledLabel} and '${firstFailure.command}' is installed but cannot run: ` +
          `${firstFailure.detail}; start it, try another installed runtime, or ${specifyHint}`,
      );
    }
    throw new FatalSandboxError(
      `${enabledLabel} but failed to determine command for sandbox; ` +
        `install docker or podman or ${specifyHint}`,
    );
  }

  return '';
}

export async function loadSandboxConfig(
  settings: Settings,
  argv: SandboxCliArgs,
): Promise<SandboxConfig | undefined> {
  const sandboxOption = argv.sandbox ?? settings.tools?.sandbox;
  const command = getSandboxCommand(sandboxOption);

  const packageJson = await getPackageJson();
  const image =
    argv.sandboxImage ??
    process.env['QWEN_SANDBOX_IMAGE'] ??
    settings.tools?.sandboxImage ??
    packageJson?.config?.sandboxImageUri;

  return command && image ? { command, image } : undefined;
}
