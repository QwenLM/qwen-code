/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants as fsConstants, rmSync } from 'node:fs';
import { access, mkdtemp, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BRAND_TEMP_PATH_SLUG,
  BRAND_FIXED_ENV_PREFIX,
} from '../../config/brand.js';
import type { ShellProvider } from './shellProvider.js';
import { getPlatform } from '../platform.js';
import { runLogger } from '../runLogger.js';

export const ENV_POWERSHELL_RESPECT_EXECUTION_POLICY = `${BRAND_FIXED_ENV_PREFIX}POWERSHELL_RESPECT_EXECUTION_POLICY`;

export type PowerShellEdition = 'core' | 'desktop';

export type PowerShellRuntime = {
  executable: string;
  edition: PowerShellEdition;
};

export class PowerShellUnavailableError extends Error {
  constructor() {
    super('PowerShell is not available on this system.');
    this.name = 'PowerShellUnavailableError';
  }
}

let runtimePromise: Promise<PowerShellRuntime | null> | null = null;

function isExplicitTrue(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

async function existingFile(filePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return null;
    await access(filePath, fsConstants.X_OK);
    return filePath;
  } catch {
    return null;
  }
}

async function findOnPath(name: string): Promise<string | null> {
  const isWindows = getPlatform() === 'windows';
  const extensions = isWindows
    ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
    : [''];
  const hasExtension = path.extname(name) !== '';
  for (const rawDirectory of (process.env['PATH'] ?? '').split(
    path.delimiter,
  )) {
    const directory = rawDirectory.replace(/^"|"$/g, '');
    if (!directory) continue;
    const candidates =
      isWindows && !hasExtension
        ? extensions.map((extension) => path.join(directory, name + extension))
        : [path.join(directory, name)];
    for (const candidate of candidates) {
      const found = await existingFile(candidate);
      if (found) return found;
    }
  }
  return null;
}

async function detectPowerShellRuntime(): Promise<PowerShellRuntime | null> {
  const pwsh = await findOnPath('pwsh');
  if (pwsh) {
    if (getPlatform() === 'linux') {
      const resolved = await realpath(pwsh).catch(() => pwsh);
      if (pwsh.startsWith('/snap/') || resolved.startsWith('/snap/')) {
        for (const candidate of [
          '/opt/microsoft/powershell/7/pwsh',
          '/usr/bin/pwsh',
        ]) {
          const nonSnap = await existingFile(candidate);
          if (!nonSnap) continue;
          const nonSnapResolved = await realpath(nonSnap).catch(() => nonSnap);
          if (
            !nonSnap.startsWith('/snap/') &&
            !nonSnapResolved.startsWith('/snap/')
          ) {
            runLogger.debug(`[powershell] Using non-Snap runtime: ${nonSnap}`);
            return { executable: nonSnap, edition: 'core' };
          }
        }
      }
    }
    return { executable: pwsh, edition: 'core' };
  }

  if (getPlatform() === 'windows') {
    const candidates = [
      process.env['ProgramFiles']
        ? path.join(process.env['ProgramFiles'], 'PowerShell', '7', 'pwsh.exe')
        : null,
      process.env['LOCALAPPDATA']
        ? path.join(
            process.env['LOCALAPPDATA'],
            'Microsoft',
            'WindowsApps',
            'pwsh.exe',
          )
        : null,
      process.env['USERPROFILE']
        ? path.join(process.env['USERPROFILE'], '.dotnet', 'tools', 'pwsh.exe')
        : null,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const found = await existingFile(candidate);
      if (found) return { executable: found, edition: 'core' };
      const linked = await realpath(candidate).catch(() => null);
      if (linked && (await existingFile(linked))) {
        return { executable: linked, edition: 'core' };
      }
    }
  }

  const windowsPowerShell = await findOnPath('powershell');
  if (windowsPowerShell) {
    return { executable: windowsPowerShell, edition: 'desktop' };
  }
  if (getPlatform() === 'windows' && process.env['SYSTEMROOT']) {
    const fallback = path.join(
      process.env['SYSTEMROOT'],
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const found = await existingFile(fallback);
    if (found) return { executable: found, edition: 'desktop' };
  }
  return null;
}

export function getPowerShellRuntime(): Promise<PowerShellRuntime | null> {
  runtimePromise ??= detectPowerShellRuntime();
  return runtimePromise;
}

export function getPowerShellCommonArgs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args = ['-NoProfile', '-NonInteractive'];
  if (!isExplicitTrue(env[ENV_POWERSHELL_RESPECT_EXECUTION_POLICY])) {
    args.push('-ExecutionPolicy', 'Bypass');
  }
  return args;
}

export function quotePowerShellSingleQuotedLiteral(
  value: string,
  label = 'value',
): string {
  const unsafeQuote = /[\u2018-\u201F]/u.exec(value);
  if (unsafeQuote) {
    const codePoint = unsafeQuote[0]
      .codePointAt(0)!
      .toString(16)
      .toUpperCase()
      .padStart(4, '0');
    throw new Error(
      `Cannot safely quote ${label} in a PowerShell single-quoted string literal: it contains U+${codePoint}`,
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** Declarations must stay first; skip whitespace and comments without executing input. */
function powerShellLeadingSource(command: string): string {
  let index = 0;
  while (index < command.length) {
    if (/[\s;]/u.test(command[index])) {
      index++;
      continue;
    }
    if (command.startsWith('<#', index)) {
      let depth = 1;
      index += 2;
      while (index < command.length && depth > 0) {
        if (command.startsWith('<#', index)) {
          depth++;
          index += 2;
        } else if (command.startsWith('#>', index)) {
          depth--;
          index += 2;
        } else index++;
      }
      continue;
    }
    if (command[index] === '#') {
      while (index < command.length && !/[\r\n]/u.test(command[index])) index++;
      continue;
    }
    break;
  }
  return command.slice(index);
}

export function powerShellRequiresLeadingPosition(command: string): boolean {
  const source = powerShellLeadingSource(command);
  return (
    /^(?:using\s+(?:namespace|module|assembly)\b|param\s*\(|(?:begin|process|end|clean|dynamicparam)\s*\{)/iu.test(
      source,
    ) ||
    (/^\[\w/u.test(source) && !/^\[[\w.]+\]::/u.test(source))
  );
}

/** Keep using declarations at script scope when wrapping a declaration body. */
function splitPowerShellUsingHeader(command: string): [string, string] {
  let offset = 0;
  while (true) {
    const rest = powerShellLeadingSource(command.slice(offset));
    const start = command.length - rest.length;
    if (!/^using\s+(?:namespace|module|assembly)\b/iu.test(rest))
      return [command.slice(0, offset), command.slice(offset)];
    let quote: 'single' | 'double' | undefined;
    let nesting = 0;
    let comments = 0;
    let index = start;
    for (; index < command.length; index++) {
      const char = command[index];
      if (comments) {
        if (command.startsWith('<#', index)) {
          comments++;
          index++;
        } else if (command.startsWith('#>', index)) {
          comments--;
          index++;
        }
        continue;
      }
      const singleQuote = /['\u2018-\u201B]/u.test(char);
      const doubleQuote = /["\u201C-\u201F]/u.test(char);
      if (char === '`' && quote !== 'single') {
        index +=
          command[index + 1] === '\r' && command[index + 2] === '\n' ? 2 : 1;
        continue;
      }
      if (quote) {
        if (
          (quote === 'single' && singleQuote) ||
          (quote === 'double' && doubleQuote)
        ) {
          const next = command[index + 1] ?? '';
          if (
            (quote === 'single' && /['\u2018-\u201B]/u.test(next)) ||
            (quote === 'double' && /["\u201C-\u201F]/u.test(next))
          )
            index++;
          else quote = undefined;
        }
        continue;
      }
      if (singleQuote || doubleQuote) {
        quote = singleQuote ? 'single' : 'double';
        continue;
      }
      if (command.startsWith('<#', index)) {
        comments = 1;
        index++;
        continue;
      }
      if (char === '#') {
        while (index < command.length && !/[\r\n]/u.test(command[index]))
          index++;
        if (!nesting) break;
        continue;
      }
      if ('([{'.includes(char)) nesting++;
      else if (')]}'.includes(char)) nesting--;
      if (nesting === 0 && /[;\r\n]/u.test(char)) break;
    }
    offset = Math.min(index + 1, command.length);
    if (offset === command.length) return [command, ''];
  }
}

const outputDefaults = `try { $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8' } catch {}
if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {
  try { $OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}
  if ($null -ne $PSStyle) { try { $PSStyle.OutputRendering = 'PlainText' } catch {} }
}
`;

export async function createPowerShellProvider(
  runtime?: PowerShellRuntime,
): Promise<ShellProvider> {
  const resolvedRuntime = runtime ?? (await getPowerShellRuntime());
  if (!resolvedRuntime) throw new PowerShellUnavailableError();

  return {
    type: 'powershell',
    shellPath: resolvedRuntime.executable,
    detached: false,
    cwdFileContentPathStyle: 'native',

    async buildExecCommand(command) {
      const tempDirectory = await mkdtemp(
        path.join(os.tmpdir(), `${BRAND_TEMP_PATH_SLUG}-powershell-`),
      );
      const cwdFilePath = path.join(tempDirectory, 'cwd');
      const cleanup = () => {
        try {
          rmSync(tempDirectory, { recursive: true, force: true });
        } catch (error) {
          runLogger.warn(
            '[powershell] Failed to clean temporary directory',
            error,
          );
        }
      };
      try {
        const quotedCwdPath = quotePowerShellSingleQuotedLiteral(
          cwdFilePath,
          'the temporary CWD path',
        );
        const suffix = `
; $_ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }
; (Get-Location).Path | Out-File -FilePath ${quotedCwdPath} -Encoding utf8 -NoNewline
; if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $host.SetShouldExit($_ec) } else { exit $_ec }`;
        // Named blocks cannot be followed by ordinary script statements. Invoke
        // declarations once in their own script block, then collect status/CWD.
        const [usingHeader, executableBody] =
          splitPowerShellUsingHeader(command);
        const body = usingHeader
          ? usingHeader +
            outputDefaults +
            (powerShellRequiresLeadingPosition(executableBody)
              ? `\n& {\n${executableBody}\n}`
              : executableBody)
          : powerShellRequiresLeadingPosition(command)
            ? outputDefaults + `& {\n${command}\n}`
            : outputDefaults + command;
        return { commandString: body + suffix, cwdFilePath, cleanup };
      } catch (error) {
        cleanup();
        throw error;
      }
    },

    getSpawnArgs(commandString) {
      return [...getPowerShellCommonArgs(), '-Command', commandString];
    },

    async getEnvironmentOverrides() {
      const overrides: Record<string, string> = {};
      if (process.env['PYTHONIOENCODING'] === undefined)
        overrides['PYTHONIOENCODING'] = 'utf-8:surrogateescape';
      if (
        process.env['NO_COLOR'] === undefined &&
        process.env['FORCE_COLOR'] === undefined
      )
        overrides['NO_COLOR'] = '1';
      return overrides;
    },
  };
}

/** @internal test-only */
export function _resetPowerShellRuntimeForTest(): void {
  runtimePromise = null;
}

/** @internal test-only */
export function _setPowerShellRuntimeForTest(
  runtime: PowerShellRuntime | null,
): void {
  runtimePromise = Promise.resolve(runtime);
}
