/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

interface LocalGitConfigRisk {
  diffExternal: boolean;
  diffDriverCommand: boolean;
  diffDriverTextconv: boolean;
  fsmonitor: boolean;
  worktreeFilter: boolean;
  pager: boolean;
  signatureVerifier: boolean;
  promisorRemote: boolean;
}

const NO_RISK: LocalGitConfigRisk = {
  diffExternal: false,
  diffDriverCommand: false,
  diffDriverTextconv: false,
  fsmonitor: false,
  worktreeFilter: false,
  pager: false,
  signatureVerifier: false,
  promisorRemote: false,
};
const PROBE_FAILED: LocalGitConfigRisk = {
  diffExternal: true,
  diffDriverCommand: true,
  diffDriverTextconv: true,
  fsmonitor: true,
  worktreeFilter: true,
  pager: true,
  signatureVerifier: true,
  promisorRemote: true,
};

const DIFF_DRIVER_COMMAND_KEY_PATTERN = String.raw`^diff\..*\.command$`;
const DIFF_DRIVER_TEXTCONV_KEY_PATTERN = String.raw`^diff\..*\.textconv$`;
const FILTER_CLEAN_KEY_PATTERN = String.raw`^filter\..*\.clean$`;
const FILTER_PROCESS_KEY_PATTERN = String.raw`^filter\..*\.process$`;
const PAGER_COMMAND_KEY_PATTERN = String.raw`^pager\..*$`;
const GPG_FORMAT_PROGRAM_KEY_PATTERN = String.raw`^gpg\..*\.program$`;
const PROMISOR_REMOTE_KEY_PATTERN = String.raw`^remote\..*\.promisor$`;
const PARTIAL_CLONE_FILTER_KEY_PATTERN =
  String.raw`^remote\..*\.partialclonefilter$`;

// Keep this as a list of simple Git-supported key regexes. In particular, do
// not use JavaScript-only constructs such as non-capturing groups: this value
// is passed directly to `git config --get-regexp`.
const LOCAL_GIT_CONFIG_RISK_KEY_PATTERN = [
  String.raw`^diff\.external$`,
  String.raw`^core\.fsmonitor$`,
  DIFF_DRIVER_COMMAND_KEY_PATTERN,
  DIFF_DRIVER_TEXTCONV_KEY_PATTERN,
  FILTER_CLEAN_KEY_PATTERN,
  FILTER_PROCESS_KEY_PATTERN,
  String.raw`^core\.pager$`,
  PAGER_COMMAND_KEY_PATTERN,
  String.raw`^log\.showsignature$`,
  String.raw`^gpg\.program$`,
  GPG_FORMAT_PROGRAM_KEY_PATTERN,
  String.raw`^extensions\.partialclone$`,
  PROMISOR_REMOTE_KEY_PATTERN,
  PARTIAL_CLONE_FILTER_KEY_PATTERN,
].join('|');

const DIFF_DRIVER_COMMAND_KEY = new RegExp(
  DIFF_DRIVER_COMMAND_KEY_PATTERN,
  'i',
);
const DIFF_DRIVER_TEXTCONV_KEY = new RegExp(
  DIFF_DRIVER_TEXTCONV_KEY_PATTERN,
  'i',
);
const FILTER_CLEAN_KEY = new RegExp(FILTER_CLEAN_KEY_PATTERN, 'i');
const FILTER_PROCESS_KEY = new RegExp(FILTER_PROCESS_KEY_PATTERN, 'i');
const PAGER_COMMAND_KEY = new RegExp(PAGER_COMMAND_KEY_PATTERN, 'i');
const GPG_FORMAT_PROGRAM_KEY = new RegExp(
  GPG_FORMAT_PROGRAM_KEY_PATTERN,
  'i',
);
const PROMISOR_REMOTE_KEY = new RegExp(PROMISOR_REMOTE_KEY_PATTERN, 'i');
const PARTIAL_CLONE_FILTER_KEY = new RegExp(
  PARTIAL_CLONE_FILTER_KEY_PATTERN,
  'i',
);

const BOOLEAN_VALUE = /^(?:true|false|yes|no|on|off|0|1)$/i;
const TRUE_VALUE = /^(?:true|yes|on|1)$/i;

export function getLocalGitConfigRisk(cwd: string): LocalGitConfigRisk {
  try {
    if (!statSync(cwd).isDirectory()) return NO_RISK;
  } catch {
    return NO_RISK;
  }

  const result = spawnSync(
    'git',
    [
      '-C',
      cwd,
      'config',
      '--includes',
      '--show-scope',
      '--null',
      '--get-regexp',
      LOCAL_GIT_CONFIG_RISK_KEY_PATTERN,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 1000,
      windowsHide: true,
    },
  );

  if (result.status === 1) return NO_RISK;
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return PROBE_FAILED;
  }

  const effective = new Map<string, { scope: string; value: string }>();
  const fields = result.stdout.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const entry = fields[i + 1]!;
    const newline = entry.indexOf('\n');
    if (newline < 0) return PROBE_FAILED;
    effective.set(entry.slice(0, newline), {
      scope: fields[i]!,
      value: entry.slice(newline + 1),
    });
  }

  const effectiveValue = (key: string): string | undefined =>
    effective.get(key)?.value.trim();
  const localValue = (key: string): string | undefined => {
    const entry = effective.get(key);
    return entry && (entry.scope === 'local' || entry.scope === 'worktree')
      ? entry.value.trim()
      : undefined;
  };
  const hasLocalValueMatching = (pattern: RegExp): boolean =>
    [...effective.keys()].some(
      (key) => pattern.test(key) && (localValue(key) ?? '') !== '',
    );
  const hasLocalNonBooleanValueMatching = (pattern: RegExp): boolean =>
    [...effective.keys()].some((key) => {
      if (!pattern.test(key)) return false;
      const value = localValue(key) ?? '';
      return value !== '' && !BOOLEAN_VALUE.test(value);
    });
  const hasLocalTrueValueMatching = (pattern: RegExp): boolean =>
    [...effective.keys()].some((key) => {
      if (!pattern.test(key)) return false;
      return TRUE_VALUE.test(localValue(key) ?? '');
    });

  const diffExternal = localValue('diff.external');
  const fsmonitor = localValue('core.fsmonitor');
  const corePager = localValue('core.pager') ?? '';
  const localGpgProgram = localValue('gpg.program');
  const hasLocalGpgProgram =
    (localGpgProgram ?? '') !== '' ||
    hasLocalValueMatching(GPG_FORMAT_PROGRAM_KEY);
  const logShowSignature = effectiveValue('log.showsignature') ?? '';
  const partialCloneExtension = localValue('extensions.partialclone') ?? '';

  return {
    diffExternal: diffExternal !== undefined && diffExternal !== '',
    diffDriverCommand: hasLocalValueMatching(DIFF_DRIVER_COMMAND_KEY),
    diffDriverTextconv: hasLocalValueMatching(DIFF_DRIVER_TEXTCONV_KEY),
    fsmonitor:
      fsmonitor !== undefined &&
      fsmonitor !== '' &&
      !BOOLEAN_VALUE.test(fsmonitor),
    worktreeFilter:
      hasLocalValueMatching(FILTER_CLEAN_KEY) ||
      hasLocalValueMatching(FILTER_PROCESS_KEY),
    pager:
      (corePager !== '' && !BOOLEAN_VALUE.test(corePager)) ||
      hasLocalNonBooleanValueMatching(PAGER_COMMAND_KEY),
    signatureVerifier:
      hasLocalGpgProgram && TRUE_VALUE.test(logShowSignature),
    promisorRemote:
      partialCloneExtension !== '' ||
      hasLocalTrueValueMatching(PROMISOR_REMOTE_KEY) ||
      hasLocalValueMatching(PARTIAL_CLONE_FILTER_KEY),
  };
}
