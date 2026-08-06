/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Repository-local git config execution probe.
 *
 * The shell read-only classifier auto-approves whitelisted git sub-commands
 * (`status`, `diff`, `log`, ...) based purely on command text. But git can
 * execute programs that are *configured in the repository's local config*
 * while running those otherwise read-only commands:
 *
 *   - `diff.external`, `diff.<driver>.textconv` — diff / log / show
 *   - `core.fsmonitor` — status
 *   - `core.pager`, `pager.<cmd>` — log / show / diff / blame on a TTY
 *   - `core.askpass`, `credential.helper`, `core.sshCommand`,
 *     `remote.<name>.proxy`, `ext::` remote URLs — `remote show` network auth
 *   - `gpg.program` — signature verification helpers
 *
 * A `.git/config` planted by an attacker (prompt-injection chain with local
 * file write, shared workspace) could therefore turn an auto-approved
 * "read-only" command into arbitrary code execution. See issue #8575.
 *
 * Scope: repository-local config only (`.git/config`, `config.worktree`
 * where git reads it — the main checkout under `extensions.worktreeConfig`
 * and linked worktrees — and the common-dir config of linked worktrees).
 * Global/system config is the user's own deliberate setup and is not an
 * attack surface of cloned repositories — it is intentionally not probed.
 * Bare repositories (no `.git` entry in the layout) are not probed either;
 * running read-only git commands inside one is exotic enough to stay out
 * of scope.
 *
 * The probe is synchronous (bounded stat walk + small file reads) so it can
 * be shared by the AST classifier and the synchronous regex fallback
 * without changing either API's async shape.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Options accepted by the read-only classifiers. */
export interface ShellReadOnlyCheckOptions {
  /**
   * Directory the command will execute in. When provided, git commands that
   * would otherwise classify as read-only are downgraded (require
   * confirmation) if the repository-local config reachable from this
   * directory contains keys that make git execute a program.
   */
  cwd?: string;
}

/** Bound on the upward search for the enclosing `.git`. */
const MAX_REPO_SEARCH_DEPTH = 64;

/**
 * Flat `section.key` names (lowercased — git config names are
 * case-insensitive) whose value names a program git may execute while
 * running a whitelisted read-only sub-command.
 */
const PROGRAM_VALUED_KEYS = new Set([
  'core.askpass', // credential prompts (e.g. `git remote show <url>`)
  'core.fsmonitor', // fsmonitor hook command (`git status`)
  'core.pager', // pager program for log / show / diff output
  'core.sshcommand', // ssh override for authenticated remotes
  'credential.helper', // credential helpers during network auth
  'diff.external', // external diff program
  'gpg.program', // signature verification helper
]);

interface ConfigEntry {
  /** Lowercased section name. */
  section: string;
  /** Case-sensitive subsection name, if any. */
  subsection: string | null;
  /** Lowercased key name. */
  key: string;
  /** Raw value text (quotes and continuation marker left intact). */
  value: string;
}

const SECTION_HEADER = /^([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*$/;

/**
 * Minimal git config parser: enough to identify section/key pairs and raw
 * values. Understands `[section]` and `[section "subsection"]` headers,
 * `key = value` lines, and `#` / `;` comments. Does not resolve includes —
 * an attacker who can write an include target can write `.git/config`
 * directly, so includes add no attack surface beyond a direct write.
 */
function parseGitConfig(content: string): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  let section = '';
  let subsection: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    if (line.startsWith('[')) {
      const close = line.indexOf(']');
      if (close < 0) continue;
      const match = line.slice(1, close).trim().match(SECTION_HEADER);
      if (!match) continue;
      section = match[1]!.toLowerCase();
      subsection = match[2] ?? null;
      continue;
    }

    if (!section) continue;
    const eq = line.indexOf('=');
    const key = (eq < 0 ? line : line.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : line.slice(eq + 1).trim();
    if (!key) continue;
    entries.push({ section, subsection, key, value });
  }

  return entries;
}

/** Strip a trailing line-continuation marker and surrounding quotes. */
function normalizeValue(raw: string): string {
  let value = raw.trim();
  if (value.endsWith('\\')) value = value.slice(0, -1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value;
}

/** True when any entry names a program git would execute. */
function entriesMayExecutePrograms(entries: ConfigEntry[]): boolean {
  for (const entry of entries) {
    const value = normalizeValue(entry.value);
    if (value === '') continue;

    if (entry.subsection === null) {
      // `[pager] <cmd> = <program>` overrides live in the flat section.
      if (entry.section === 'pager') return true;
      const name = `${entry.section}.${entry.key}`;
      if (!PROGRAM_VALUED_KEYS.has(name)) continue;
      // core.fsmonitor true/false selects the built-in daemon or disables
      // monitoring — neither executes an external program.
      if (name === 'core.fsmonitor' && /^(?:true|false)$/i.test(value)) {
        continue;
      }
      return true;
    }

    switch (entry.section) {
      case 'diff':
        if (entry.key === 'textconv') return true;
        break;
      case 'credential':
        if (entry.key === 'helper') return true;
        break;
      case 'gpg':
        if (entry.key === 'program') return true;
        break;
      case 'remote':
        if (entry.key === 'proxy') return true;
        if (entry.key === 'url' && /^ext::/.test(value)) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

/**
 * Locate the repository-local config files for the repo enclosing `cwd`:
 *
 *   - `.git` directory → `.git/config`
 *   - `.git` file (`gitdir: <path>`, linked worktree or submodule) →
 *     `<gitdir>/config`, `<gitdir>/config.worktree`, and the common dir's
 *     `config` when a `commondir` file marks a linked worktree.
 */
function findLocalGitConfigFiles(cwd: string): string[] {
  let dir = path.resolve(cwd);

  for (let depth = 0; depth < MAX_REPO_SEARCH_DEPTH; depth++) {
    const gitPath = path.join(dir, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(gitPath);
    } catch {
      // No `.git` here; walk up.
    }

    if (stat) {
      if (stat.isDirectory()) {
        // With extensions.worktreeConfig enabled, git also reads
        // `config.worktree` for the MAIN worktree — probe both.
        return [
          path.join(gitPath, 'config'),
          path.join(gitPath, 'config.worktree'),
        ];
      }
      if (stat.isFile()) {
        let pointer: string;
        try {
          pointer = fs.readFileSync(gitPath, 'utf8');
        } catch {
          // `.git` exists but cannot be read — fail closed (the outer
          // catch converts this into "may execute programs").
          throw new Error(`unreadable git pointer file: ${gitPath}`);
        }
        const match = pointer.match(/^\s*gitdir:\s*(.+?)\s*$/m);
        if (!match) return [];
        const gitDir = path.resolve(dir, match[1]!);
        const files = [
          path.join(gitDir, 'config'),
          path.join(gitDir, 'config.worktree'),
        ];
        try {
          const commonDir = fs
            .readFileSync(path.join(gitDir, 'commondir'), 'utf8')
            .trim();
          if (commonDir) {
            files.push(path.join(path.resolve(gitDir, commonDir), 'config'));
          }
        } catch {
          // Submodule git dir (no commondir) — the two paths above suffice.
        }
        return files;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return [];
}

/**
 * True when the repository-local git config reachable from `cwd` contains
 * keys that make git execute a program while running a whitelisted
 * read-only sub-command.
 *
 * Fail-closed: a config file that exists but cannot be read (or any
 * unexpected probe error) reports `true` so the command is confirmed
 * instead of auto-approved.
 */
export function gitConfigMayExecutePrograms(cwd: string | undefined): boolean {
  if (!cwd) return false;

  try {
    for (const file of findLocalGitConfigFiles(cwd)) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        return true; // exists but unreadable — fail closed
      }
      if (entriesMayExecutePrograms(parseGitConfig(content))) return true;
    }
    return false;
  } catch {
    return true; // unexpected probe failure — fail closed
  }
}
