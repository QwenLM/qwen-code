/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { quote } from 'shell-quote';
import { BRAND_CLI_NAME, ENV_PID } from '../../config/brand.js';

// Keep the Qwen helper distinct from generic user-defined _cli_* functions.
const PGREP_FUNCTION_NAME = '_qwen_pgrep';

export interface PkillSelfProtectionOptions {
  readonly enabled?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly pgrepPath?: string;
  readonly procRoot?: string;
}

let runtimeEnabled = false;
let guardFilePromise: Promise<string | null> | undefined;

/** Enables the guard for the current CLI entry point. Disabled by default. */
export function setPkillSelfProtectionEnabled(enabled: boolean): void {
  runtimeEnabled = enabled;
}

function isSupported(
  shellPath: string,
  options: PkillSelfProtectionOptions,
): boolean {
  if (!(options.enabled ?? runtimeEnabled)) return false;
  if ((options.platform ?? process.platform) !== 'linux') return false;
  const shellName = path.basename(shellPath).toLowerCase();
  return shellName === 'bash' || shellName === 'zsh';
}

/**
 * Builds the narrow Linux guard installed after user shell initialization.
 * It receives expanded argv, attempts one pgrep preview, and refuses only a
 * positive match on this CLI. It deliberately does not emulate complete procps
 * option parsing: output-changing options, explicit lookups and nested shells
 * can bypass it. Stronger guarantees belong to process isolation.
 */
export function buildPkillSelfProtectionScript(
  shellPath: string,
  options: PkillSelfProtectionOptions = {},
): string | null {
  if (!isSupported(shellPath, options)) return null;

  const pgrep = options.pgrepPath
    ? `${PGREP_FUNCTION_NAME}() { ${quote([options.pgrepPath])} "$@"; }`
    : [
        `${PGREP_FUNCTION_NAME}() {`,
        '  if [ -x /usr/bin/pgrep ]; then /usr/bin/pgrep "$@";',
        '  elif [ -x /bin/pgrep ]; then /bin/pgrep "$@";',
        '  else return 127;',
        '  fi',
        '}',
      ].join('\n');
  const procRoot = quote([options.procRoot ?? '/proc']);
  return [
    '\\unalias pkill 2>/dev/null || :',
    pgrep,
    'pkill() {',
    // Pin word splitting locally: a caller-polluted IFS (IFS=, IFS='' ...)
    // would keep pgrep's multi-line pid output as a single word, so the pid
    // comparison below would never match and the guard would fail open.
    "  local IFS=$' \\t\\n'",
    '  local _qwen_skip= _qwen_eoo= _qwen_arg _qwen_pid',
    `  local _qwen_own_pid="\${${ENV_PID}:-}"`,
    '  local -a _qwen_probe=()',
    '  for _qwen_arg in "$@"; do',
    '    if [ -n "$_qwen_skip" ]; then _qwen_skip=; continue; fi',
    // After the `--` end-of-options marker every argument is a pattern, even
    // one shaped like a signal name. pgrep accepts `--` too, so forward the
    // marker itself to keep the probe argv aligned with the real pkill argv.
    '    if [ -n "$_qwen_eoo" ]; then _qwen_probe+=("$_qwen_arg"); continue; fi',
    '    if [ "$_qwen_arg" = "--" ]; then _qwen_eoo=1; _qwen_probe+=("--"); continue; fi',
    // Bash/Zsh resolve signal names case-insensitively. Strip an optional
    // `SIG` prefix before asking the shell builtin, without changing options.
    '    case "$_qwen_arg" in',
    '      --*) ;;',
    '      -[Ss][Ii][Gg][A-Za-z]*) \\builtin kill -l "${_qwen_arg#????}" >/dev/null 2>&1 && continue ;;',
    '      -?*) \\builtin kill -l "${_qwen_arg#-}" >/dev/null 2>&1 && continue ;;',
    '    esac',
    // The case above only removes signal names via `continue`; every other
    // arm ends with `;;`, which does not short-circuit, so those arguments
    // always reach the selector classification case below.
    '    case "$_qwen_arg" in',
    '      --signal) _qwen_skip=1 ;;',
    '      --signal=*|-e|--echo|-[0-9]*) ;;',
    '      -URG|-USR[12]|-PIPE|-POLL|-PROF|-PWR|-FPE) ;;',
    '      -[PUGOF]?*) _qwen_probe+=("$_qwen_arg") ;;',
    '      -[ABCDEFGHIJKLMNOPQRSTUVWXYZ][ABCDEFGHIJKLMNOPQRSTUVWXYZ0-9]*) ;;',
    '      *) _qwen_probe+=("$_qwen_arg") ;;',
    '    esac',
    '  done',
    `  if [ -n "$_qwen_own_pid" ] && [ -r ${procRoot}/"$_qwen_own_pid"/comm ]; then`,
    `    for _qwen_pid in $(${PGREP_FUNCTION_NAME} "\${_qwen_probe[@]}" 2>/dev/null); do`,
    '      if [ "$_qwen_pid" = "$_qwen_own_pid" ]; then',
    `        printf 'Refused pkill because it would terminate the %s process (pid %s). Use a narrower pattern or kill a selected pid.\\n' ${quote([BRAND_CLI_NAME])} "$_qwen_own_pid" >&2`,
    '        return 1',
    '      fi',
    '    done',
    '  fi',
    '  \\command pkill "$@"',
    '}',
  ].join('\n');
}

/**
 * Creates the sourceable guard file lazily. The command argv contains only its
 * path; the multiline function body never becomes part of /proc/$$/cmdline.
 */
async function ensurePkillSelfProtectionFile(
  shellPath: string,
  options: PkillSelfProtectionOptions = {},
): Promise<string | null> {
  const script = buildPkillSelfProtectionScript(shellPath, options);
  if (!script) return null;

  if (guardFilePromise) {
    const cachedPath = await guardFilePromise;
    if (cachedPath) return cachedPath;
    guardFilePromise = undefined;
  }

  guardFilePromise = (async () => {
    try {
      // Keep the public core entry point lightweight: snapshot storage and
      // diagnostic logging are loaded only when a managed shell first needs
      // the Linux guard.
      const { getSnapshotsDir, registerSnapshotCleanup } = await import(
        '../bash/ShellSnapshot.js'
      );
      const directory = getSnapshotsDir();
      await mkdir(directory, { recursive: true });
      const randomId = crypto.randomBytes(8).toString('hex');
      const filePath = path.join(
        directory,
        `pkill-guard-${process.pid}-${randomId}.sh`,
      );
      await writeFile(filePath, `${script}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      registerSnapshotCleanup(filePath);
      return filePath;
    } catch (error) {
      try {
        const { runLogger } = await import('../runLogger.js');
        runLogger.warn(
          `[pkillSelfProtection] failed to create guard file: ${String(error)}`,
        );
      } catch {
        // The guard is best-effort; logging initialization must not block the
        // user command when the runtime is already partially unavailable.
      }
      return null;
    }
  })();

  return guardFilePromise;
}

/** Returns a single-line command that loads the guard into a managed shell. */
export async function getPkillSelfProtectionSourceCommand(
  shellPath: string,
  options: PkillSelfProtectionOptions = {},
): Promise<string | null> {
  const filePath = await ensurePkillSelfProtectionFile(shellPath, options);
  return filePath
    ? `{ source ${quote([filePath])} 2>/dev/null || true; }`
    : null;
}

/** Returns the trusted parent pid environment for a supported managed shell. */
export function getPkillSelfProtectionEnvironment(
  shellPath: string,
  options: PkillSelfProtectionOptions = {},
): Record<string, string> {
  return isSupported(shellPath, options)
    ? { [ENV_PID]: String(process.pid) }
    : {};
}

/** Test helper — forget the cached guard path. */
export function _resetPkillSelfProtectionForTest(): void {
  guardFilePromise = undefined;
}
