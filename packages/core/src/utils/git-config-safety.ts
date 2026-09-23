/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

interface LocalGitConfigRisk {
  diffExternal: boolean;
  fsmonitor: boolean;
}

const NO_RISK: LocalGitConfigRisk = {
  diffExternal: false,
  fsmonitor: false,
};
const PROBE_FAILED: LocalGitConfigRisk = {
  diffExternal: true,
  fsmonitor: true,
};

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
      '^diff\\.external$|^core\\.fsmonitor$',
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

  const localValue = (key: string): string | undefined => {
    const entry = effective.get(key);
    return entry && (entry.scope === 'local' || entry.scope === 'worktree')
      ? entry.value.trim()
      : undefined;
  };
  const diffExternal = localValue('diff.external');
  const fsmonitor = localValue('core.fsmonitor');

  return {
    diffExternal: diffExternal !== undefined && diffExternal !== '',
    fsmonitor:
      fsmonitor !== undefined &&
      fsmonitor !== '' &&
      !/^(?:true|false|yes|no|on|off|0|1)$/i.test(fsmonitor),
  };
}
