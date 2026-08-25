/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

export interface LocalGitConfigRisk {
  diffExternal: boolean;
  fsmonitor: boolean;
  /**
   * Any other repository-local key that makes an ordinary read verb execute a
   * program the command line never names: a `textconv` diff driver or a
   * `diff.<driver>.command` reached through `.gitattributes`, a clean/smudge
   * filter, any signature program (`gpg.program`, `gpg.ssh.program`,
   * `gpg.x509.program`), a transport or credential program (`core.sshCommand`,
   * `core.askPass`, `core.gitProxy`, `credential.helper`,
   * `remote.<name>.uploadpack`/`receivepack`), the pager family
   * (`core.pager`, `pager.<cmd>`), or an alias whose value git re-parses as a
   * program or as global options.
   *
   * Consumed only where a *vouched wrapper* is treated as a possible git
   * frontend. Literal `git` keeps the two checks above unchanged on purpose:
   * `git lfs install --local` writes `filter.lfs.clean`, so keying literal
   * `git diff` to this flag would downgrade it in a large share of real
   * checkouts. Closing that gap for literal git is a separate change.
   */
  helperProgram: boolean;
}

const NO_RISK: LocalGitConfigRisk = {
  diffExternal: false,
  fsmonitor: false,
  helperProgram: false,
};
const PROBE_FAILED: LocalGitConfigRisk = {
  diffExternal: true,
  fsmonitor: true,
  helperProgram: true,
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
      // Kept in one string because `git config --get-regexp` takes a single
      // pattern; every branch is anchored so a longer key cannot match by
      // accident. `--show-scope` output is filtered to local/worktree below,
      // so a user's global `core.pager = delta` never trips this.
      //
      // Every key literal is LOWERCASE on purpose: git normalises the section
      // and name parts of a config key, so `core.sshCommand` comes back out of
      // `--get-regexp` as `core.sshcommand` and a camelCase branch here would
      // simply never fire. Only subsection parts keep their case, and those are
      // matched with `.*`.
      '^diff\\.external$|^core\\.fsmonitor$|^diff\\..*\\.(textconv|command)$' +
        '|^filter\\..*\\.(clean|smudge|process)$|^gpg\\..*program$|^gpg\\.program$' +
        '|^core\\.(sshcommand|askpass|gitproxy|pager|hookspath)$' +
        '|^credential\\.(.+\\.)?helper$' +
        '|^remote\\..*\\.(uploadpack|receivepack)$|^pager\\..*$|^alias\\.',
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

  let helperProgram = false;
  for (const [key, entry] of effective) {
    if (entry.scope !== 'local' && entry.scope !== 'worktree') continue;
    const value = entry.value.trim();
    if (value === '') continue;
    // Lowercased because git normalises the section and name parts of a config
    // key: it hands back `core.sshcommand`, never `core.sshCommand`, so a
    // camelCase comparison here would never fire. Normalised once rather than
    // spelled twice, so this layer and the probe pattern cannot drift apart.
    const name = key.toLowerCase();
    // Git runs an alias through the shell when it starts with `!`, and
    // re-parses it in global-option context when it starts with `-` — so
    // `[alias] sync = -c diff.external=./evil.sh diff` executes a program
    // with no `!` anywhere. Over-refusing a dash-leading benign alias is the
    // right direction for a fail-closed gate.
    if (name.startsWith('alias.')) {
      helperProgram ||= value.startsWith('!') || value.startsWith('-');
      continue;
    }
    if (
      /^diff\..*\.(?:textconv|command)$/.test(name) ||
      /^filter\..*\.(?:clean|smudge|process)$/.test(name) ||
      /^gpg\.(?:program|.*\.program)$/.test(name) ||
      /^remote\..*\.(?:uploadpack|receivepack)$/.test(name) ||
      /^pager\..+$/.test(name) ||
      /^credential\.(?:.+\.)?helper$/.test(name) ||
      name === 'core.sshcommand' ||
      name === 'core.askpass' ||
      name === 'core.gitproxy' ||
      name === 'core.pager' ||
      // `core.hooksPath` points git at a hook directory the checkout ships;
      // `post-index-change` fires when `git status` refreshes the index.
      name === 'core.hookspath'
    ) {
      helperProgram = true;
    }
  }

  return {
    diffExternal: diffExternal !== undefined && diffExternal !== '',
    fsmonitor:
      fsmonitor !== undefined &&
      fsmonitor !== '' &&
      !/^(?:true|false|yes|no|on|off|0|1)$/i.test(fsmonitor),
    helperProgram,
  };
}
