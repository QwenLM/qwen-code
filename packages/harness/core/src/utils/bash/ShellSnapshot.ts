/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell environment snapshot system.
 *
 * Captures the user's shell environment (functions, aliases, shell options,
 * PATH) once at startup. Subsequent commands `source` the snapshot file
 * instead of running as a login shell, avoiding repeated `.bashrc`/`.zshrc`
 * initialization overhead.
 *
 * Also injects tool integrations (ripgrep alias/function) so that the user's
 * shell commands can transparently use the bundled/vendor tools.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { mkdir, stat, unlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { quote } from 'shell-quote';
import { runLogger } from '../runLogger.js';
import { BRAND_FIXED_ENV_PREFIX } from '../../config/brand.js';
import { getConfigHomeDir } from '../paths.js';
import { getPlatform } from '../platform.js';
import { killProcessGroup } from '../process-utils.js';
import { ripgrepCommand } from '../ripgrep.js';
import { windowsPathToPosixPath } from '../windowsPaths.js';
import { ShellErrorDiagnostics } from '../shell/shellDiagnostics.js';

export const SNAPSHOT_SLOW_THRESHOLD_MS = 10_000;
export const SNAPSHOT_HARD_TIMEOUT_MS = 90_000;

/**
 * Returns the shell config file path for the given shell.
 */
function getConfigFile(shellPath: string): string {
  const fileName = shellPath.includes('zsh')
    ? '.zshrc'
    : shellPath.includes('bash')
      ? '.bashrc'
      : '.profile';
  return path.join(os.homedir(), fileName);
}

/**
 * Checks if a file exists.
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getPhaseMarker(markerToken: string, phase: string): string {
  return `builtin printf '\\n${markerToken}:${phase}\\n'`;
}

/**
 * Generates user-specific snapshot content (functions, options, aliases).
 * This content is derived from the user's shell configuration file.
 */
function getUserSnapshotContent(
  configFile: string,
  markerToken: string,
  captureFile: string,
): string {
  const isZsh = configFile.endsWith('.zshrc');
  const quotedCaptureFile = captureFile.replace(/'/g, "'\\''");

  let content = '';

  // User functions
  if (isZsh) {
    content += `
      ${getPhaseMarker(markerToken, 'functions_start')}
      echo "# Functions" >> "$SNAPSHOT_FILE"

      # Force autoload all functions first
      typeset -f > /dev/null 2>&1

      # Get user function names - filter completion functions (single underscore prefix)
      # but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)
      typeset +f | grep -vE '^_[^_]' | while read func; do
        typeset -f "$func" >> "$SNAPSHOT_FILE"
      done
      ${getPhaseMarker(markerToken, 'functions_done')}
    `;
  } else {
    content += `
      ${getPhaseMarker(markerToken, 'functions_start')}
      echo "# Functions" >> "$SNAPSHOT_FILE"

      # Force autoload all functions first
      declare -f > /dev/null 2>&1

      # Get user function names - filter completion functions (single underscore prefix)
      # but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init).
      # Bash's declare -f output is directly sourceable, so write it verbatim instead
      # of starting a base64 process for every function during capture and restore.
      # Capture builtin output in a temporary file so the reader stays in this shell;
      # process substitution would fork a child shell on Git Bash.
      builtin compgen -A function >| '${quotedCaptureFile}'
      while IFS= builtin read -r func; do
        [[ "$func" =~ ^_[^_] ]] && continue
        builtin declare -f "$func"
      done < '${quotedCaptureFile}' >> "$SNAPSHOT_FILE"
      ${getPhaseMarker(markerToken, 'functions_done')}
    `;
  }

  // Shell options
  if (isZsh) {
    content += `
      ${getPhaseMarker(markerToken, 'shell_options_start')}
      echo "# Shell Options" >> "$SNAPSHOT_FILE"
      setopt | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"
      ${getPhaseMarker(markerToken, 'shell_options_done')}
    `;
  } else {
    content += `
      ${getPhaseMarker(markerToken, 'shell_options_start')}
      echo "# Shell Options" >> "$SNAPSHOT_FILE"

      # shopt and SHELLOPTS are provided by Bash itself. Avoid grep/awk/head
      # pipelines here: process startup is disproportionately expensive in
      # some Git Bash environments.
      builtin shopt -p >> "$SNAPSHOT_FILE"
      snapshot_saved_ifs="$IFS"
      IFS=:
      for snapshot_option in $SHELLOPTS; do
        builtin printf 'set -o %s\\n' "$snapshot_option"
      done >> "$SNAPSHOT_FILE"
      IFS="$snapshot_saved_ifs"
      unset snapshot_saved_ifs snapshot_option

      echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"
      ${getPhaseMarker(markerToken, 'shell_options_done')}
    `;
  }

  // User aliases
  if (isZsh) {
    content += `
      ${getPhaseMarker(markerToken, 'aliases_start')}
      echo "# Aliases" >> "$SNAPSHOT_FILE"
      alias | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"
      ${getPhaseMarker(markerToken, 'aliases_done')}
    `;
  } else {
    content += `
      ${getPhaseMarker(markerToken, 'aliases_start')}
      echo "# Aliases" >> "$SNAPSHOT_FILE"

      # alias is a Bash builtin. Read its sourceable output in one Bash
      # process instead of starting grep/sed/head for a few lines of text.
      builtin alias -p >| '${quotedCaptureFile}'
      snapshot_alias_count=0
      while IFS= builtin read -r snapshot_alias_definition; do
        # Filter out winpty aliases on Windows to avoid "stdin is not a tty".
        if { [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; } &&
          [[ "$snapshot_alias_definition" == *"='winpty "* ]]; then
          continue
        fi
        builtin printf 'alias -- %s\\n' "\${snapshot_alias_definition#alias }"
        snapshot_alias_count=$((snapshot_alias_count + 1))
        ((snapshot_alias_count >= 1000)) && break
      done < '${quotedCaptureFile}' >> "$SNAPSHOT_FILE"
      : >| '${quotedCaptureFile}'
      unset snapshot_alias_count snapshot_alias_definition

      ${getPhaseMarker(markerToken, 'aliases_done')}
    `;
  }

  return content;
}

// ── Tool shell integrations ──────────────────────────────────────────────

/**
 * Creates a shell function that invokes `binaryPath` with a specific argv[0].
 * This uses the bun-internal ARGV0 dispatch trick: the bun binary checks its
 * argv[0] and runs the embedded tool (rg) that matches.
 */
function createArgv0ShellFunction(
  funcName: string,
  argv0: string,
  binaryPath: string,
): string {
  const quotedPath = quote([binaryPath]);
  return [
    `function ${funcName} {`,
    '  if [[ -n $ZSH_VERSION ]]; then',
    `    ARGV0=${argv0} ${quotedPath} "$@"`,
    '  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then',
    `    ARGV0=${argv0} ${quotedPath} "$@"`,
    '  elif [[ $BASHPID != $$ ]]; then',
    `    exec -a ${argv0} ${quotedPath} "$@"`,
    '  else',
    `    (exec -a ${argv0} ${quotedPath} "$@")`,
    '  fi',
    '}',
  ].join('\n');
}

/**
 * Creates ripgrep shell integration (alias or function).
 * When bundled (argv0 mode), produces a shell function; otherwise a simple alias.
 */
export function createRipgrepShellIntegration(): {
  type: 'alias' | 'function';
  snippet: string;
} {
  const rgCommand = ripgrepCommand();

  // For embedded ripgrep (bun-internal), we need a shell function that sets argv0
  if (rgCommand.argv0) {
    return {
      type: 'function',
      snippet: createArgv0ShellFunction(
        'rg',
        rgCommand.argv0,
        rgCommand.rgPath,
      ),
    };
  }

  // For regular ripgrep, use a simple alias target
  const quotedPath = quote([rgCommand.rgPath]);
  const quotedArgs = rgCommand.rgArgs.map((arg) => quote([arg]));
  const aliasTarget =
    rgCommand.rgArgs.length > 0
      ? `${quotedPath} ${quotedArgs.join(' ')}`
      : quotedPath;

  return { type: 'alias', snippet: aliasTarget };
}

/**
 * Generates tool-specific snapshot content (ripgrep integration, PATH).
 * This content is always included regardless of user configuration.
 */
function getToolsSnapshotContent(markerToken: string): string {
  const rgIntegration = createRipgrepShellIntegration();

  let content = '';

  // Check if rg is available, if not create an alias/function to bundled ripgrep.
  // We use a subshell to unalias rg before checking, so that user aliases like
  // `alias rg='rg --smart-case'` don't shadow the real binary check.
  content += `
      ${getPhaseMarker(markerToken, 'tool_integrations_start')}
      # Check for rg availability
      echo "# Check for rg availability" >> "$SNAPSHOT_FILE"
      echo "if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then" >> "$SNAPSHOT_FILE"
  `;

  if (rgIntegration.type === 'function') {
    // For embedded ripgrep, write the function definition using heredoc
    content += `
      cat >> "$SNAPSHOT_FILE" << 'RIPGREP_FUNC_END'
  ${rgIntegration.snippet}
RIPGREP_FUNC_END
    `;
  } else {
    // For regular ripgrep, write a simple alias
    const escapedSnippet = rgIntegration.snippet.replace(/'/g, "'\\''");
    content += `
      echo '  alias rg='"'${escapedSnippet}'" >> "$SNAPSHOT_FILE"
    `;
  }

  content += `
      echo "fi" >> "$SNAPSHOT_FILE"
      ${getPhaseMarker(markerToken, 'tool_integrations_done')}
      ${getPhaseMarker(markerToken, 'path_start')}
  `;

  if (getPlatform() === 'windows') {
    // Windows: keep shell-internal PATH capture.
    // /proc/$$/cmdline does not exist on Windows, so the original bug
    // does not apply. The login shell also sets up MSYS2 runtime paths
    // (/usr/bin, /bin) that may not be in the parent process's PATH.
    content += `

      # Add PATH to the file (captured from login shell — already POSIX format)
      builtin printf 'export PATH=%q\\n' "$PATH" >> "$SNAPSHOT_FILE"
  `;
  } else {
    // macOS/Linux: capture from parent process to avoid /proc/$$/cmdline corruption.
    const envPath = process.env['PATH'] || '';
    let delimiter: string;
    do {
      delimiter = `PATH_END_${Math.random().toString(36).substring(2, 18)}`;
    } while (envPath.includes(delimiter));
    const quotedPath = quote([envPath]);

    content += `

      # Add PATH (from parent process, not shell-internal $PATH)
      cat >> "$SNAPSHOT_FILE" << '${delimiter}'
export PATH=${quotedPath}
${delimiter}
  `;
  }

  content += `
      ${getPhaseMarker(markerToken, 'path_done')}
  `;

  return content;
}

/**
 * Creates the shell script for capturing environment.
 */
function getSnapshotScript(
  shellPath: string,
  snapshotFilePath: string,
  configFileExists: boolean,
  markerToken: string,
): string {
  const configFile = getConfigFile(shellPath);
  const isZsh = configFile.endsWith('.zshrc');

  // On Windows, convert native paths to POSIX format for use inside bash.
  // e.g., C:\Users\foo\.qwen\snapshots\... → /c/Users/foo/.qwen/...
  const isWindows = getPlatform() === 'windows';
  const shellSnapshotPath = isWindows
    ? windowsPathToPosixPath(snapshotFilePath)
    : snapshotFilePath;
  const shellConfigFile = isWindows
    ? windowsPathToPosixPath(configFile)
    : configFile;

  // Generate the user content and tools content
  const userContent = configFileExists
    ? getUserSnapshotContent(
        configFile,
        markerToken,
        `${shellSnapshotPath}.capture`,
      )
    : !isZsh
      ? // Manually force alias expansion in bash when no config file
        'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"'
      : '';
  const toolsContent = getToolsSnapshotContent(markerToken);

  // Shell-quote the snapshot path (already in POSIX format on Windows)
  const quotedSnapshotPath = shellSnapshotPath.replace(/'/g, "'\\''");

  const script = `SNAPSHOT_FILE='${quotedSnapshotPath}'
      ${getPhaseMarker(markerToken, 'shell_ready')}
      ${
        configFileExists
          ? `${getPhaseMarker(markerToken, 'config_source_start')}
      source "${shellConfigFile}" < /dev/null
      ${getPhaseMarker(markerToken, 'config_source_done')}`
          : `${getPhaseMarker(markerToken, 'config_source_skipped')}
      # No user config file to source`
      }

      # Create/clear the snapshot file
      ${getPhaseMarker(markerToken, 'snapshot_file_start')}
      echo "# Snapshot file" >| "$SNAPSHOT_FILE"

      # Unset all aliases to avoid conflicts with functions
      echo "# Unset all aliases to avoid conflicts with functions" >> "$SNAPSHOT_FILE"
      echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"
      ${getPhaseMarker(markerToken, 'snapshot_file_done')}

      ${userContent}

      ${toolsContent}

      # Verify snapshot was created
      ${getPhaseMarker(markerToken, 'verify_start')}
      if [ ! -f "$SNAPSHOT_FILE" ]; then
        echo "Error: Snapshot file was not created at $SNAPSHOT_FILE" >&2
        exit 1
      fi
      ${getPhaseMarker(markerToken, 'verify_done')}
    `;

  return script;
}

/**
 * Returns the directory for snapshot files.
 * Defaults to `<config-root>/shell-snapshots/`.
 * Can be overridden for testing.
 */
let _snapshotsDir: string | undefined;

export function setSnapshotsDir(dir: string): void {
  _snapshotsDir = dir;
}

export function getSnapshotsDir(): string {
  if (_snapshotsDir) return _snapshotsDir;
  return path.join(getConfigHomeDir(), 'shell-snapshots');
}

/** Test helper — reset the snapshots directory. */
export function _resetSnapshotsDirForTest(): void {
  _snapshotsDir = undefined;
}

/**
 * Creates and saves a shell environment snapshot by loading the user's
 * shell configuration.
 *
 * This function:
 * 1. Identifies the user's shell config file (.zshrc, .bashrc, etc.)
 * 2. Creates a temporary script that sources this configuration
 * 3. Captures functions, shell options, aliases, and PATH
 * 4. Saves the snapshot to a file that can be sourced by subsequent commands
 *
 * @param binShell - Path to the shell binary.
 * @returns Promise resolving to the snapshot file path, or undefined on failure.
 */
export async function createAndSaveSnapshot(
  binShell: string,
  options?: {
    signal?: AbortSignal;
  },
): Promise<string | undefined> {
  if (options?.signal?.aborted) {
    return undefined;
  }

  const shellType = binShell.includes('zsh')
    ? 'zsh'
    : binShell.includes('bash')
      ? 'bash'
      : 'sh';

  try {
    const configFile = getConfigFile(binShell);
    const configFileExists = await pathExists(configFile);

    // Create unique snapshot path with timestamp and random ID
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);
    const snapshotsDir = getSnapshotsDir();
    const shellSnapshotPath = path.join(
      snapshotsDir,
      `snapshot-${shellType}-${timestamp}-${randomId}.sh`,
    );
    const shellSnapshotCapturePath = `${shellSnapshotPath}.capture`;

    runLogger.debug(
      `[ShellSnapshot] creating snapshot: shell=${binShell}, type=${shellType}, ` +
        `configExists=${configFileExists}, path=${shellSnapshotPath}`,
    );

    // Ensure snapshots directory exists
    await mkdir(snapshotsDir, { recursive: true });

    const markerToken = `__${BRAND_FIXED_ENV_PREFIX}SNAPSHOT_PHASE_${randomId}__`;
    const snapshotScript = getSnapshotScript(
      binShell,
      shellSnapshotPath,
      configFileExists,
      markerToken,
    );

    const startedAt = Date.now();

    return await new Promise((resolve) => {
      let child: ChildProcess | undefined;
      let completed = false;
      let abortRequested = false;
      let slowThresholdReached = false;
      let hardTimeoutReached = false;
      let hardTimeoutAt: number | undefined;
      let childExitAt: number | undefined;
      let childCloseAt: number | undefined;
      let markerRemainder = '';
      const stderrDiagnostics = new ShellErrorDiagnostics();

      const phaseTimings: Array<{
        phase: string;
        elapsedMs: number;
      }> = [{ phase: 'spawn_requested', elapsedMs: 0 }];
      const seenPhases = new Set(['spawn_requested']);

      const recordPhase = (phase: string) => {
        if (seenPhases.has(phase)) {
          return;
        }
        seenPhases.add(phase);
        phaseTimings.push({
          phase,
          elapsedMs: Date.now() - startedAt,
        });
      };

      const parsePhaseMarkers = (output: string | Buffer) => {
        const text = markerRemainder + output.toString();
        const markerPattern = new RegExp(`${markerToken}:([a-z_]+)`, 'g');
        for (const match of text.matchAll(markerPattern)) {
          if (match[1]) {
            recordPhase(match[1]);
          }
        }
        markerRemainder = text.slice(-(markerToken.length + 64));
      };

      const formatPhaseTimings = () =>
        phaseTimings
          .map(({ phase, elapsedMs }) => `${phase}@${elapsedMs}`)
          .join('>');

      const formatProgress = (now: number) => {
        const lastPhase = phaseTimings.at(-1) ?? phaseTimings[0];
        const lastPhaseAt = startedAt + lastPhase.elapsedMs;
        return (
          `last_phase=${lastPhase.phase}, ` +
          `phase_elapsed_ms=${now - lastPhaseAt}, ` +
          `phases=${formatPhaseTimings()}`
        );
      };

      const cleanupFailedSnapshot = async (): Promise<void> => {
        await deleteSnapshot(shellSnapshotCapturePath);
        await deleteSnapshot(shellSnapshotPath);
      };

      const terminateProcessTree = async (
        signal: NodeJS.Signals,
      ): Promise<boolean | undefined> => {
        const pid = child?.pid;
        if (pid === undefined) {
          return child?.kill(signal);
        }

        let fallbackKillResult: boolean | undefined;
        try {
          await killProcessGroup({
            pid,
            signal,
            isLeaderExited: () =>
              childExitAt !== undefined ||
              child?.exitCode != null ||
              child?.signalCode != null,
          });
        } finally {
          // Preserve the leader fallback even when tree termination rejects.
          // The caller still logs that the process tree could not be stopped.
          fallbackKillResult =
            childExitAt === undefined ? child?.kill(signal) : undefined;
        }
        return fallbackKillResult;
      };

      const slowTimer = setTimeout(() => {
        const now = Date.now();
        slowThresholdReached = true;
        runLogger.warn(
          `[ShellSnapshot] slow: duration_ms=${now - startedAt}, ` +
            `timer_delay_ms=${Math.max(
              0,
              now - startedAt - SNAPSHOT_SLOW_THRESHOLD_MS,
            )}, ` +
            `${formatProgress(now)}, child_pid=${child?.pid ?? 'unknown'}, ` +
            `shell=${binShell}, configFile=${configFile}`,
        );
      }, SNAPSHOT_SLOW_THRESHOLD_MS);

      const hardTimeout = setTimeout(() => {
        if (completed) {
          return;
        }
        const now = Date.now();
        hardTimeoutReached = true;
        hardTimeoutAt = now;
        runLogger.warn(
          `[ShellSnapshot] hard timeout reached: duration_ms=${now - startedAt}, ` +
            `timer_delay_ms=${Math.max(
              0,
              now - startedAt - SNAPSHOT_HARD_TIMEOUT_MS,
            )}, ` +
            `${formatProgress(now)}, child_pid=${child?.pid ?? 'unknown'}`,
        );
        runLogger.warn(
          `[ShellSnapshot] hard timeout kill requested: ` +
            `duration_ms=${Date.now() - startedAt}, ` +
            `child_pid=${child?.pid ?? 'unknown'}, ` +
            'kill_strategy=process_tree',
        );
        // Preserve the fail-open contract even if process-tree termination
        // never produces a child close event (observed with Git Bash on Windows).
        void finish(undefined);
        void terminateProcessTree('SIGKILL')
          .then((fallbackKillResult) => {
            runLogger.warn(
              `[ShellSnapshot] hard timeout kill completed: ` +
                `duration_ms=${Date.now() - startedAt}, ` +
                `child_pid=${child?.pid ?? 'unknown'}, ` +
                `fallback_kill_result=${String(fallbackKillResult)}`,
            );
          })
          .catch((error: unknown) => {
            runLogger.warn(
              `[ShellSnapshot] hard timeout kill failed: ` +
                `duration_ms=${Date.now() - startedAt}, ` +
                `child_pid=${child?.pid ?? 'unknown'}, ` +
                `error_name=${error instanceof Error ? error.name : 'unknown'}`,
            );
          })
          .finally(() => {
            // The child may write again between the initial fail-open cleanup
            // and process-tree termination completing.
            void cleanupFailedSnapshot();
          });
      }, SNAPSHOT_HARD_TIMEOUT_MS);

      const onAbort = () => {
        if (completed) {
          return;
        }
        abortRequested = true;
        // Snapshot creation is optional. Settle independently of process
        // termination so a missing child close cannot block the provider.
        void finish(undefined);
        void terminateProcessTree('SIGTERM')
          .catch((error: unknown) => {
            runLogger.warn(
              `[ShellSnapshot] abort kill failed: ` +
                `duration_ms=${Date.now() - startedAt}, ` +
                `child_pid=${child?.pid ?? 'unknown'}, ` +
                `error_name=${error instanceof Error ? error.name : 'unknown'}`,
            );
          })
          .finally(() => {
            void cleanupFailedSnapshot();
          });
      };

      const clearWatchers = () => {
        clearTimeout(slowTimer);
        clearTimeout(hardTimeout);
        options?.signal?.removeEventListener('abort', onAbort);
      };

      const finish = async (result: string | undefined): Promise<void> => {
        if (completed) {
          return;
        }
        completed = true;
        clearWatchers();
        if (!result) {
          runLogger.warn(
            `[ShellSnapshot] fallback=login_shell, ${formatProgress(Date.now())}, ` +
              stderrDiagnostics.summary(),
          );
        }
        await deleteSnapshot(shellSnapshotCapturePath);
        if (!result) {
          await deleteSnapshot(shellSnapshotPath);
        }
        resolve(result);
      };

      if (options?.signal?.aborted) {
        abortRequested = true;
        void finish(undefined);
        return;
      }

      let spawnError: Error | undefined;

      const completeSnapshot = async (
        code: number | null,
        signal: NodeJS.Signals | null,
      ): Promise<void> => {
        const completedAt = Date.now();
        const durationMs = completedAt - startedAt;
        const processTiming =
          `child_exit_ms=${
            childExitAt === undefined ? 'pending' : childExitAt - startedAt
          }, ` +
          `child_close_ms=${
            childCloseAt === undefined ? 'pending' : childCloseAt - startedAt
          }, ` +
          `timeout_to_completion_ms=${
            hardTimeoutAt === undefined ? 'n/a' : completedAt - hardTimeoutAt
          }`;
        const failed =
          spawnError !== undefined ||
          code !== 0 ||
          signal !== null ||
          abortRequested ||
          hardTimeoutReached;

        if (failed) {
          const outcome = abortRequested
            ? 'cancelled'
            : hardTimeoutReached
              ? 'timeout'
              : 'failed';
          runLogger.warn(
            `[ShellSnapshot] ${outcome}: duration_ms=${durationMs}, ` +
              `${formatProgress(completedAt)}, ${processTiming}, ` +
              `error_name=${spawnError?.name ?? 'Error'}`,
          );
          runLogger.warn(
            `[ShellSnapshot] error details: code=${String(code)}, ` +
              `signal=${String(signal)}, killed=${String(child?.killed)}, ` +
              `shell=${binShell}, configFile=${configFile}, ` +
              `configExists=${configFileExists}`,
          );
          await finish(undefined);
          return;
        }

        try {
          const snapshotStat = await stat(shellSnapshotPath);
          if (snapshotStat.size > 0) {
            const logSuccess = slowThresholdReached
              ? runLogger.log.bind(runLogger)
              : runLogger.debug.bind(runLogger);
            logSuccess(
              `[ShellSnapshot] success: duration_ms=${durationMs}, ` +
                `${formatProgress(completedAt)}, ${processTiming}, ` +
                `path=${shellSnapshotPath}, size_bytes=${snapshotStat.size}`,
            );
            registerSnapshotCleanup(shellSnapshotPath);
            await finish(shellSnapshotPath);
            return;
          }

          runLogger.warn(
            `[ShellSnapshot] failed: duration_ms=${durationMs}, ` +
              'reason=empty_snapshot',
          );
        } catch {
          runLogger.warn(
            `[ShellSnapshot] failed: duration_ms=${durationMs}, ` +
              'reason=stat_failed',
          );
        }
        await finish(undefined);
      };

      try {
        child = spawn(binShell, ['-c', '-l', snapshotScript], {
          env: {
            ...process.env,
            SHELL: binShell,
            GIT_EDITOR: 'true',
          },
          windowsHide: true,
          detached: getPlatform() !== 'windows',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        runLogger.warn(
          `[ShellSnapshot] failed: duration_ms=${Date.now() - startedAt}, ` +
            `error_name=${error instanceof Error ? error.name : 'unknown'}, ` +
            `error_code=${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}`,
        );
        void finish(undefined);
        return;
      }

      recordPhase('process_spawned');
      child.stdout?.on('data', parsePhaseMarkers);
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrDiagnostics.append(chunk);
      });
      child.once('error', (error) => {
        spawnError = error;
        runLogger.warn(
          `[ShellSnapshot] spawn failed: error_code=${(error as NodeJS.ErrnoException).code ?? 'unknown'}`,
        );
      });
      child.once('exit', (code, signal) => {
        const now = Date.now();
        childExitAt = now;
        const message =
          `[ShellSnapshot] child exit: duration_ms=${now - startedAt}, ` +
          `timeout_to_exit_ms=${
            hardTimeoutAt === undefined ? 'n/a' : now - hardTimeoutAt
          }, code=${String(code)}, signal=${String(signal)}, ` +
          `${formatProgress(now)}, child_pid=${child?.pid ?? 'unknown'}`;
        if (hardTimeoutReached) {
          runLogger.warn(message);
        } else {
          runLogger.debug(message);
        }
      });
      child.once('close', (code, signal) => {
        const now = Date.now();
        childCloseAt = now;
        clearTimeout(slowTimer);
        clearTimeout(hardTimeout);
        const message =
          `[ShellSnapshot] child close: duration_ms=${now - startedAt}, ` +
          `timeout_to_close_ms=${
            hardTimeoutAt === undefined ? 'n/a' : now - hardTimeoutAt
          }, code=${String(code)}, signal=${String(signal)}, ` +
          `${formatProgress(now)}, child_pid=${child?.pid ?? 'unknown'}`;
        if (hardTimeoutReached) {
          runLogger.warn(message);
        } else {
          runLogger.debug(message);
        }
        void completeSnapshot(code, signal);
      });

      if (options?.signal?.aborted) {
        onAbort();
      } else {
        options?.signal?.addEventListener('abort', onAbort, { once: true });
      }
    });
  } catch {
    return undefined;
  }
}

/**
 * Deletes a snapshot file. Call on CLI exit for cleanup.
 */
export async function deleteSnapshot(snapshotPath: string): Promise<void> {
  try {
    await unlink(snapshotPath);
  } catch {
    // File may already be deleted
  }
}

/**
 * Registers a process exit handler that deletes the given snapshot file.
 * This ensures user environment data does not linger on disk after the
 * CLI session ends.
 */
const registeredSnapshots = new Set<string>();

export function registerSnapshotCleanup(snapshotPath: string): void {
  if (registeredSnapshots.has(snapshotPath)) return;
  registeredSnapshots.add(snapshotPath);
  const handler = () => {
    try {
      unlinkSync(snapshotPath);
    } catch {
      // Ignore — file may already be deleted or process dying.
    }
  };
  process.once('exit', handler);
}

/**
 * Checks if a snapshot file still exists (for invalidation detection).
 */
export async function snapshotExists(snapshotPath: string): Promise<boolean> {
  return pathExists(snapshotPath);
}
