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
 *     `remote.<name>.proxy`, `ext::` remote URLs, `core.gitProxy` —
 *     `remote show` network/transport helpers
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
 *
 * Known limitation: a compound command that `cd`s into a DIFFERENT
 * repository before running git (e.g. `cd ../other-repo && git status`)
 * is probed against the tool's own cwd, so the other repo's config is not
 * checked. `cd` within the same repository resolves to the same config and
 * is covered.
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
  'core.gitproxy', // git:// transport proxy (`git remote show git://…`)
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
  /** Raw value text (quotes left intact). */
  value: string;
}

const SECTION_HEADER = /^([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*$/;

/**
 * Minimal git config parser: enough to identify section/key pairs and raw
 * values. Understands `[section]` and `[section "subsection"]` headers
 * (including the inline `[section] key = value` form), `key = value` lines,
 * continuations, and `#` / `;` comments. Includes are not resolved —
 * `include` / `includeIf` entries make the probe fail closed instead,
 * because their targets can live outside `.git` (e.g. tracked files).
 */
function parseGitConfig(content: string): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  let section = '';
  let subsection: string | null = null;

  const recordEntry = (text: string): void => {
    const eq = text.indexOf('=');
    const key = (eq < 0 ? text : text.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : text.slice(eq + 1).trim();
    if (!key) return;
    entries.push({ section, subsection, key, value });
  };
  const lines: string[] = [];
  let continued = '';

  for (const rawLine of content.split(/\r?\n/)) {
    const line = continued + rawLine;
    let quoted = false;
    let escaped = false;
    let comment = line.length;
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (!quoted && (char === '#' || char === ';')) {
        comment = i;
        break;
      }
    }
    const logicalContent = line.slice(0, comment);
    let trailingBackslashes = 0;
    while (
      logicalContent[logicalContent.length - 1 - trailingBackslashes] === '\\'
    ) {
      trailingBackslashes++;
    }
    if (trailingBackslashes % 2 === 1) {
      continued = logicalContent.slice(0, -1);
    } else {
      lines.push(logicalContent);
      continued = '';
    }
  }
  if (continued) lines.push(continued);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    if (line.startsWith('[')) {
      const close = line.indexOf(']');
      if (close < 0) continue; // unclosed header — git aborts config load
      const match = line.slice(1, close).trim().match(SECTION_HEADER);
      if (!match) {
        // Valid to git but opaque here (e.g. `]` inside a quoted
        // subsection) — fail closed.
        throw new Error('unrecognized git config section header');
      }
      section = match[1]!.toLowerCase();
      subsection = match[2] ?? null;
      // Inline form: `[section] key = value` on the same line.
      const rest = line.slice(close + 1).trim();
      if (rest) recordEntry(rest);
      continue;
    }

    if (!section) continue;
    recordEntry(line);
  }

  return entries;
}

/** Strip surrounding quotes from a raw config value. */
function normalizeValue(raw: string): string {
  let value = raw.trim();
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

    // Include targets can live outside `.git` (e.g. files tracked in the
    // working tree), so flag them instead of resolving them.
    if (entry.section === 'include' || entry.section === 'includeif') {
      return true;
    }

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

function worktreeConfigEnabled(entries: ConfigEntry[]): boolean {
  let enabled = false;
  for (const entry of entries) {
    if (
      entry.section === 'extensions' &&
      entry.subsection === null &&
      entry.key === 'worktreeconfig'
    ) {
      const value = normalizeValue(entry.value);
      // Git also accepts hexadecimal integers and k/m/g suffixes. Treat
      // anything except its definite false forms as enabled (fail closed).
      enabled = !/^(?:false|no|off|[+-]?(?:0+|0x0+)[kmg]?)$/i.test(value);
    }
  }
  return enabled;
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
        if (!match) {
          // Unparseable pointer — fail closed like the unreadable case.
          throw new Error(`unparseable git pointer file: ${gitPath}`);
        }
        const gitDir = path.resolve(dir, match[1]!);
        const files = [path.join(gitDir, 'config')];
        try {
          const commonDir = fs
            .readFileSync(path.join(gitDir, 'commondir'), 'utf8')
            .trim();
          if (commonDir) {
            files[0] = path.join(path.resolve(gitDir, commonDir), 'config');
          }
        } catch {
          // Submodule git dir (no commondir) — the two paths above suffice.
        }
        files.push(path.join(gitDir, 'config.worktree'));
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
    let readWorktreeConfig = false;
    for (const file of findLocalGitConfigFiles(cwd)) {
      if (file.endsWith('config.worktree') && !readWorktreeConfig) continue;
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        return true; // exists but unreadable — fail closed
      }
      const entries = parseGitConfig(content);
      if (entriesMayExecutePrograms(entries)) return true;
      readWorktreeConfig ||= worktreeConfigEnabled(entries);
    }
    return false;
  } catch {
    return true; // unexpected probe failure — fail closed
  }
}
