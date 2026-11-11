/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bash-specific shell provider implementation.
 * Handles command assembly with extglob disable, eval-wrapping, stdin safety,
 * CWD tracking via `pwd -P >| tmpfile`, and shell environment snapshot.
 */

import os from 'node:os';
import path, { posix as posixPath } from 'node:path';
import { quote } from 'shell-quote';

import {
  BRAND_FIXED_ENV_PREFIX,
  BRAND_TEMP_PATH_SLUG,
} from '../../config/brand.js';
import type { BuildExecCommandOptions, ShellProvider } from './shellProvider.js';
import {
  quoteShellCommand,
  shouldAddStdinRedirect,
  rewriteWindowsNullRedirect,
  singleQuoteForEval,
} from '../bash/shellQuoting.js';
import {
  createAndSaveSnapshot,
  snapshotExists,
} from '../bash/ShellSnapshot.js';
import { runLogger } from '../runLogger.js';
import { getPlatform } from '../platform.js';
import { windowsPathToPosixPath } from '../windowsPaths.js';
import { buildBashPathPolicy } from './bashPathPolicy.js';
import {
  resolveShellPrefix,
  wrapPosixShellCommand,
} from './shellPrefix.js';
import {
  getPkillSelfProtectionEnvironment,
  getPkillSelfProtectionSourceCommand,
} from './pkillSelfProtection.js';

const SHELL_AGNOSTIC_EXTGLOB_GUARD =
  '{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true';

/**
 * Returns the shell-specific command to disable extended globbing for security.
 * Prevents patterns like `+(...)` from being interpreted by the shell.
 */
function getDisableExtglobCommand(shellPath: string): string | null {
  const shellName = path.basename(shellPath).toLowerCase();
  if (shellName.startsWith('zsh')) {
    return 'setopt NO_EXTENDED_GLOB 2>/dev/null || true';
  }
  if (shellName.startsWith('bash')) {
    return 'shopt -u extglob 2>/dev/null || true';
  }
  // Unknown shell, skip extglob handling
  return null;
}

/**
 * Creates a Bash shell provider.
 *
 * Providers are memoized per shell type and shared by every session in the
 * process, so nothing session-scoped may be captured here — session inputs
 * (plugin bin paths, hook env scripts) arrive per command on
 * {@link BuildExecCommandOptions.sessionContext}.
 *
 * @param shellPath - Absolute path to the shell binary.
 * @param options - Optional configuration.
 * @param options.skipSnapshot - If true, skip shell snapshot creation.
 * @param options.signal - Optional signal used to cancel snapshot creation.
 */
export async function createBashShellProvider(
  shellPath: string,
  options?: {
    skipSnapshot?: boolean;
    signal?: AbortSignal;
  },
): Promise<ShellProvider> {
  let snapshotFilePath: string | undefined;
  let snapshotValidated = false;
  const extglobCmd = getDisableExtglobCommand(shellPath);
  const isWindows = getPlatform() === 'windows';

  if (!options?.skipSnapshot) {
    // Provider creation waits for the snapshot. Startup prewarming and the
    // first command share this provider promise through Shell.resolveProvider,
    // so user shell initialization is never duplicated.
    snapshotFilePath = await createAndSaveSnapshot(shellPath, {
      signal: options?.signal,
    }).catch(() => undefined);
  }

  runLogger.debug(
    `[bashProvider] created: shell=${shellPath}, snapshot=${snapshotFilePath ?? 'none'}`,
  );

  return {
    type: 'bash',
    shellPath,
    detached: true,

    async buildExecCommand(
      command: string,
      opts: BuildExecCommandOptions,
    ) {
      // Check snapshot validity — if the file was deleted, fall back to login shell.
      // Once invalidated, don't re-check on subsequent calls.
      if (snapshotFilePath && !snapshotValidated) {
        const exists = await snapshotExists(snapshotFilePath);
        if (!exists) {
          runLogger.warn(
            `[bashProvider] snapshot invalidated (file deleted): ${snapshotFilePath}`,
          );
          snapshotFilePath = undefined;
        } else {
          snapshotValidated = true;
        }
      }

      // Compute CWD file path for pwd tracking.
      // On Windows, we maintain two paths:
      //   - shellCwdFilePath: POSIX format for use inside bash (pwd -P >| ...)
      //   - cwdFilePath: native Windows format for Node.js readFileSync/unlinkSync
      const tmpDir = os.tmpdir();
      const shellTmpDir = isWindows ? windowsPathToPosixPath(tmpDir) : tmpDir;
      const cwdFileName = `${BRAND_TEMP_PATH_SLUG}-${opts.id}-cwd`;
      // POSIX path for the bash command string
      const shellCwdFilePath = isWindows
        ? posixPath.join(shellTmpDir, cwdFileName)
        : path.join(tmpDir, cwdFileName);
      // Native path for Node.js file I/O
      const cwdFilePath = path.join(tmpDir, cwdFileName);

      // Normalize the command
      const normalizedCommand = rewriteWindowsNullRedirect(command);

      // Determine stdin redirect strategy
      const addStdinRedirect = shouldAddStdinRedirect(normalizedCommand);

      // Quote the command for eval
      const quotedCommand = addStdinRedirect
        ? singleQuoteForEval(normalizedCommand) + ' < /dev/null'
        : quoteShellCommand(normalizedCommand, false);

      // Assemble command parts
      const commandParts: string[] = [];
      const stages: string[] = [];
      let nextLine = 1;
      const addPart = (stage: string, script: string) => {
        const lastLine = nextLine + script.split('\n').length - 1;
        stages.push(`${stage}:${nextLine}-${lastLine}`);
        nextLine = lastLine;
        commandParts.push(script);
      };

      // Source the snapshot if available
      if (snapshotFilePath) {
        const finalPath = isWindows
          ? windowsPathToPosixPath(snapshotFilePath)
          : snapshotFilePath;
        const quotedPath = finalPath.replace(/'/g, "'\\''");
        addPart('snapshot', `{ source '${quotedPath}' 2>/dev/null || true; }`);
      }

      // Source session environment variables (from hooks, etc.). Read from the
      // calling session's context, never from provider-creation-time state:
      // this provider is memoized per shell type and shared by every session.
      const sessionScript = await opts.sessionContext?.getSessionEnvScript();
      if (sessionScript) {
        addPart('session_env', sessionScript);
      }

      // Resolve per command after the asynchronous session environment step
      // so updates made while it is pending affect this execution.
      const shellPrefix = resolveShellPrefix();

      // Re-apply Bash tool PATH policy after snapshot/session env. Those
      // scripts can reset PATH, but config/plugin bin priority must stay
      // deterministic for user-facing Bash commands. Plugin bin paths come from
      // the calling session's Config so concurrent sessions never share them.
      const pathPolicy = buildBashPathPolicy({
        configEnv: process.env,
        pluginBinPaths: opts.sessionContext?.getPluginBinPaths() ?? [],
        isWindows,
        includeExistingShellPath: true,
      });
      const env: Record<string, string> = {};
      if (shellPrefix && pathPolicy.exportCommand) {
        // An external prefix may clear inherited environment (e.g. sudo or a
        // remote runner). Preserve its existing self-contained command contract.
        addPart('path', pathPolicy.exportCommand);
      } else if (pathPolicy.path) {
        // Keep dynamic PATH data out of Windows command-line quoting. Resolve
        // it per execution (not provider state) so concurrent calls and plugin
        // updates cannot overwrite each other's environment.
        const bashPathPrefixEnv = `__${BRAND_FIXED_ENV_PREFIX}BASH_PATH_PREFIX`;
        env[bashPathPrefixEnv] = pathPolicy.path;
        addPart(
          'path',
          `export PATH="\${${bashPathPrefixEnv}:+$${bashPathPrefixEnv}:}$PATH"`,
        );
      }

      // Disable extended globbing for security
      const disableExtglobCommand = shellPrefix
        ? SHELL_AGNOSTIC_EXTGLOB_GUARD
        : extglobCmd;
      if (disableExtglobCommand) {
        // Limit fail-open to this guard: a bare || true also swallows failures
        // in earlier &&-joined session/PATH setup.
        addPart('extglob', `{ ${disableExtglobCommand}; }`);
      }

      // Load after user-controlled initialization so aliases and functions
      // cannot replace the runtime guard. Keep the function body in a file so
      // /proc/$$/cmdline contains only this short source command.
      // A configured prefix owns command parsing, so its shell capabilities
      // are unknown. Preserve compatibility by keeping this guard best-effort.
      const pkillProtection = shellPrefix
        ? null
        : await getPkillSelfProtectionSourceCommand(shellPath);
      if (pkillProtection) {
        addPart('pkill', pkillProtection);
      }

      // The eval-wrapped command
      addPart('eval', `eval ${quotedCommand}`);

      // CWD tracking: write pwd to temp file after command
      addPart('cwd', `pwd -P >| ${quote([shellCwdFilePath])}`);

      // Do not add newlines: some shell setup scripts read /proc/$$/cmdline
      // line by line to identify the running shell. Ranges can overlap because
      // multiple wrapper stages share a line; they are not execution markers.
      const assembledCommand = commandParts.join(' && ');
      const commandString = shellPrefix
        ? wrapPosixShellCommand(assembledCommand, shellPrefix)
        : assembledCommand;

      return {
        commandString,
        cwdFilePath,
        env,
        diagnostics:
          `snapshot=${Boolean(snapshotFilePath)}, login=${!snapshotFilePath}, ` +
          `prefix=${Boolean(shellPrefix)}, wrapper_lines=${stages.join(',')}, ` +
          `command_bytes=${Buffer.byteLength(normalizedCommand)}, ` +
          `non_ascii=${/[\u0080-\uffff]/.test(normalizedCommand)}, ` +
          `crlf=${normalizedCommand.includes('\r\n')}, stdin_redirect=${addStdinRedirect}, ` +
          `path_prefix_bytes=${Buffer.byteLength(pathPolicy.path ?? '')}`,
      };
    },

    getSpawnArgs(commandString: string): string[] {
      const skipLoginShell = snapshotFilePath !== undefined;
      return ['-c', ...(skipLoginShell ? [] : ['-l']), commandString];
    },

    async getEnvironmentOverrides(
      _command: string,
    ): Promise<Record<string, string>> {
      const protectionEnvironment = resolveShellPrefix()
        ? {}
        : getPkillSelfProtectionEnvironment(shellPath);
      // On Windows, Git Bash (MSYS2) may not inherit the console codepage
      // (especially when spawned headlessly via Remote Control). Explicitly
      // set locale env vars to ensure UTF-8 output encoding.
      if (isWindows) {
        return {
          ...protectionEnvironment,
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        };
      }
      return protectionEnvironment;
    },
  };
}
