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
 *   - `diff.external`, `diff.<driver>.textconv`, `diff.<driver>.command` —
 *     diff / log / show
 *   - `core.fsmonitor` — status
 *   - `core.alternateRefsCommand` — `log --alternate-refs`
 *   - `core.pager`, `pager.<cmd>` — log / show / diff / blame on a TTY
 *   - `core.askpass`, `credential.helper`, `core.sshCommand`,
 *     `remote.<name>.proxy`, `remote.<name>.uploadpack`, `ext::` remote
 *     URLs, `protocol.<name>.allow` lifts, `core.gitProxy` — `remote
 *     show` network/transport helpers
 *   - `gpg.program` — signature verification helpers
 *   - `core.hooksPath` — redirects hook resolution; the redirected
 *     directory is probed for read-only-triggered hooks the same way as
 *     the default hooks directory
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
 *
 * Discovery mirrors git's: each ancestor is checked for a `.git` entry, and
 * the directory itself is checked as a git directory (bare repositories and
 * submodule storage dirs like `<repo>/.git/modules/<name>`, whose own
 * config git reads when it stands in one).
 *
 * The probe is synchronous (bounded stat walk + small file reads) so it can
 * be shared by the AST classifier and the synchronous regex fallback
 * without changing either API's async shape.
 *
 * Directory changes are tracked by both classifiers: a `cd`/`pushd` segment
 * moves the probe to the repository the following git segments actually run
 * in, and an unresolvable target (expansions, `~`, flag-only forms, a
 * `||`-diverged chain) downgrades later git segments the same way a dirty
 * config does.
 */

import fs from 'node:fs';
import os from 'node:os';
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
  /**
   * A directory-changing segment (`cd`/`pushd`) precedes this command and
   * its target could not be resolved statically. Downgrades git commands
   * the same way a dirty config does — the effective repo is unknown.
   */
  unknownDir?: boolean;
}

/** Bound on the upward search for the enclosing `.git`. */
const MAX_REPO_SEARCH_DEPTH = 64;

/** Config files larger than this fail closed instead of being read. */
const MAX_CONFIG_FILE_BYTES = 1 << 20; // 1 MiB

/**
 * Flat `section.key` names (lowercased — git config names are
 * case-insensitive) whose value names a program git may execute while
 * running a whitelisted read-only sub-command.
 */
const PROGRAM_VALUED_KEYS = new Set([
  'core.alternaterefscommand', // alternate-refs lister (`git log --alternate-refs`)
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
 * values. Understands `[section]`, `[section "subsection"]`, and the
 * deprecated `[section.subsection]` headers (including the inline
 * `[section] key = value` form), `key = value` lines, continuations, and
 * `#` / `;` comments. Includes are not resolved — `include` / `includeIf`
 * entries make the probe fail closed instead, because their targets can
 * live outside `.git` (e.g. tracked files).
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
      if (subsection === null) {
        // Deprecated `[section.subsection]` header: git splits at the
        // FIRST dot and case-folds the subsection (the quoted form is
        // case-sensitive instead). `section` is already lowercased, so
        // the slice carries both behaviors.
        const dot = section.indexOf('.');
        if (dot > 0) {
          subsection = section.slice(dot + 1);
          section = section.slice(0, dot);
        }
      }
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

/**
 * Decode a raw config value the way git does: quoted and bare segments
 * concatenate (`url = "ext::"sh` is `ext::sh` to git), and the `\b \n \t
 * \" \\` escapes apply inside quoted segments. Returns `null` when the
 * value cannot be decoded (unbalanced quote, other escape) — callers fail
 * closed on it.
 */
function decodeGitConfigValue(raw: string): string | null {
  const value = raw.trim();
  let decoded = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (!quoted) {
      if (char === '"') {
        quoted = true;
      } else {
        decoded += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = false;
    } else if (char === '\\') {
      switch (value[++i]) {
        case 'b':
          decoded += '\b';
          break;
        case 'n':
          decoded += '\n';
          break;
        case 't':
          decoded += '\t';
          break;
        case '"':
          decoded += '"';
          break;
        case '\\':
          decoded += '\\';
          break;
        default:
          return null;
      }
    } else {
      decoded += char;
    }
  }
  return quoted ? null : decoded;
}

/** True when any entry names a program git would execute. */
function entriesMayExecutePrograms(entries: ConfigEntry[]): boolean {
  for (const entry of entries) {
    const value = decodeGitConfigValue(entry.value);

    // `url.<base>.insteadOf` rewrites remote URLs before connecting; an
    // ext:: rewrite target executes a program. Checked before the
    // empty-value skip: git treats an EMPTY insteadOf as a match-all
    // rewrite prefix. Git decodes subsection escapes first (`\x` → `x`),
    // so over-approximate by dropping backslashes before comparing.
    if (
      entry.section === 'url' &&
      entry.subsection !== null &&
      entry.key === 'insteadof' &&
      entry.subsection.replace(/\\/g, '').startsWith('ext::')
    ) {
      return true;
    }

    // `protocol.allow` / `protocol.ext.allow` lifts the default block on
    // the program transport — any value that is not definitely `never`
    // enables it, and a command-line ext:: URL passed to a whitelisted
    // command then executes a program.
    if (
      entry.section === 'protocol' &&
      entry.key === 'allow' &&
      (entry.subsection === null || entry.subsection === 'ext') &&
      value?.toLowerCase() !== 'never'
    ) {
      return true;
    }

    if (value === '') continue;

    // Include targets can live outside `.git` (e.g. files tracked in the
    // working tree), so flag them instead of resolving them.
    if (entry.section === 'include' || entry.section === 'includeif') {
      return true;
    }

    if (entry.subsection === null) {
      // `[pager] <cmd> = <program>` overrides live in the flat section.
      if (entry.section === 'pager') {
        // true/false enable or disable paging without naming a program.
        if (value !== null && /^(?:true|false)$/i.test(value)) continue;
        return true;
      }
      const name = `${entry.section}.${entry.key}`;
      if (!PROGRAM_VALUED_KEYS.has(name)) continue;
      // core.fsmonitor true/false selects the built-in daemon or disables
      // monitoring; core.pager true/false disables paging or falls back to
      // $PAGER — neither executes a repo-config-supplied program.
      if (
        (name === 'core.fsmonitor' || name === 'core.pager') &&
        value !== null &&
        /^(?:true|false)$/i.test(value)
      ) {
        continue;
      }
      return true;
    }

    switch (entry.section) {
      case 'diff':
        if (entry.key === 'textconv' || entry.key === 'command') return true;
        break;
      case 'credential':
        if (entry.key === 'helper') return true;
        break;
      case 'gpg':
        if (entry.key === 'program') return true;
        break;
      case 'remote':
        if (
          entry.key === 'proxy' ||
          entry.key === 'uploadpack' ||
          entry.key === 'receivepack'
        ) {
          return true;
        }
        if (entry.key === 'url' && (value === null || /^ext::/.test(value))) {
          return true;
        }
        break;
      case 'filter':
        // `git diff` cleans worktree content through the configured filter
        // when comparing against the index — no flag needed.
        if (
          entry.key === 'clean' ||
          entry.key === 'smudge' ||
          entry.key === 'process'
        ) {
          return true;
        }
        break;
      case 'pager':
        // Dotted `[pager.<cmd>]` headers only reach this branch via the
        // dot-form split above; keep the flat-section catch-all's verdict.
        return true;
      default:
        break;
    }
  }
  return false;
}

/**
 * Hooks that fire while whitelisted read-only commands run: an index
 * refresh runs `post-index-change`, and `git status` consults
 * `fsmonitor-watchman` when monitoring is hook-based.
 */
const READ_ONLY_TRIGGERED_HOOKS = ['post-index-change', 'fsmonitor-watchman'];

function hooksMayExecutePrograms(hooksDir: string): boolean {
  for (const hook of READ_ONLY_TRIGGERED_HOOKS) {
    try {
      fs.accessSync(path.join(hooksDir, hook), fs.constants.X_OK);
      return true;
    } catch {
      // Hook absent or not executable.
    }
  }
  return false;
}

/**
 * Collect the directories `core.hooksPath` entries redirect hook
 * resolution to, resolved the way git does: a leading `~` expands to the
 * user's home, and relative paths anchor at `root` — the worktree root
 * for repositories found through a `.git` entry, the git dir itself when
 * the probe stands in one. An empty value disables hooks entirely and
 * contributes nothing. Returns `null` when a value cannot be decoded or
 * resolved — callers fail closed.
 */
function hooksPathDirectories(
  entries: ConfigEntry[],
  root: string,
): string[] | null {
  const dirs: string[] = [];
  for (const entry of entries) {
    if (
      entry.section !== 'core' ||
      entry.subsection !== null ||
      entry.key !== 'hookspath'
    ) {
      continue;
    }
    const value = decodeGitConfigValue(entry.value);
    if (value === null) return null;
    if (value === '') continue; // git runs no hooks at all
    let expanded = value;
    if (expanded.startsWith('~')) {
      // git expands `~` and `~/...` to the user's home; `~user` lookups
      // cannot be reproduced here.
      if (expanded.length > 1 && expanded[1] !== '/') return null;
      expanded = path.join(os.homedir(), expanded.slice(1));
    }
    dirs.push(
      path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded),
    );
  }
  return dirs;
}

function worktreeConfigEnabled(entries: ConfigEntry[]): boolean {
  let enabled = false;
  for (const entry of entries) {
    if (
      entry.section === 'extensions' &&
      entry.subsection === null &&
      entry.key === 'worktreeconfig'
    ) {
      const value = decodeGitConfigValue(entry.value);
      // Git also accepts hexadecimal integers and k/m/g suffixes. Treat
      // anything except its definite false forms as enabled (fail closed).
      enabled =
        value === null ||
        !/^(?:false|no|off|[+-]?(?:0+|0x0+)[kmg]?)$/i.test(value);
    }
  }
  return enabled;
}

/**
 * git's primary discovery rule: a directory that holds a HEAD file plus
 * objects and refs/packed-refs is itself a git directory (is_git_directory
 * in setup.c) — a bare repository, or a submodule's storage dir like
 * `<repo>/.git/modules/<name>` whose own config git reads while standing
 * in it. git also accepts a HEAD-plus-commondir pair (linked-worktree
 * admin directories — and attacker-shaped stand-ins), so mirror that.
 */
function isGitDirectory(dir: string): boolean {
  try {
    if (!fs.statSync(path.join(dir, 'HEAD')).isFile()) return false;
    try {
      if (fs.statSync(path.join(dir, 'commondir')).isFile()) return true;
    } catch {
      // No commondir — fall through to the objects/refs requirement.
    }
    if (!fs.statSync(path.join(dir, 'objects')).isDirectory()) return false;
    try {
      if (fs.statSync(path.join(dir, 'refs')).isDirectory()) return true;
    } catch {
      // No refs dir — packed-refs alone also qualifies.
    }
    return fs.statSync(path.join(dir, 'packed-refs')).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the repository-local config files for the repo enclosing `cwd`:
 *
 *   - `.git` directory → `.git/config`
 *   - `.git` file (`gitdir: <path>`, linked worktree or submodule) →
 *     `<gitdir>/config`, `<gitdir>/config.worktree`, and the common dir's
 *     `config` when a `commondir` file marks a linked worktree.
 *   - `cwd` itself (or an ancestor) is a git directory → its `config`, the
 *     commondir `config` when present, and `config.worktree`.
 *
 * Also reports the directory relative `core.hooksPath` values resolve
 * against — git anchors them at the worktree root (the directory holding
 * the `.git` entry); when the probe stands in a git directory itself, the
 * git dir stands in.
 *
 * Throws when the search cannot conclude (unreadable pointer, search depth
 * exhausted) — the caller converts that into "may execute programs".
 */
function findLocalGitConfigFiles(cwd: string): {
  files: string[];
  hooksPathRoot: string;
} {
  let dir = path.resolve(cwd);
  try {
    // git resolves the physical cwd; a symlink between the execution
    // directory and the repo root must not send the walk up the link's
    // ancestors instead of the target's.
    dir = fs.realpathSync(dir);
  } catch {
    // Absent/unresolvable path — keep the logical form.
  }

  for (let depth = 0; ; depth++) {
    if (depth >= MAX_REPO_SEARCH_DEPTH) {
      // git's discovery has no depth cap: exhausting the budget before
      // reaching the filesystem root is "repository unknown", not "no
      // repository" — fail closed.
      throw new Error('repository search depth exhausted');
    }

    const gitPath = path.join(dir, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(gitPath);
    } catch {
      // No `.git` here; check the directory itself, then walk up.
    }

    if (stat) {
      if (stat.isDirectory()) {
        // With extensions.worktreeConfig enabled, git also reads
        // `config.worktree` for the MAIN worktree — probe both. A
        // `commondir` file redirects the common config git reads, so
        // probe the pointed-to directory's config as well.
        const files = [path.join(gitPath, 'config')];
        try {
          const commonDir = fs
            .readFileSync(path.join(gitPath, 'commondir'), 'utf8')
            .trim();
          if (commonDir) {
            files.push(path.join(path.resolve(gitPath, commonDir), 'config'));
          }
        } catch {
          // No commondir — the repo's own config is the common config.
        }
        files.push(path.join(gitPath, 'config.worktree'));
        return { files, hooksPathRoot: dir };
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
        return { files, hooksPathRoot: dir };
      }
    }

    if (isGitDirectory(dir)) {
      const files = [path.join(dir, 'config')];
      try {
        const commonDir = fs
          .readFileSync(path.join(dir, 'commondir'), 'utf8')
          .trim();
        if (commonDir) {
          files.push(path.join(path.resolve(dir, commonDir), 'config'));
        }
      } catch {
        // No commondir — the git dir's own config is the common config.
      }
      files.push(path.join(dir, 'config.worktree'));
      return { files, hooksPathRoot: dir };
    }

    const parent = path.dirname(dir);
    // Reached the filesystem root — no repo.
    if (parent === dir) return { files: [], hooksPathRoot: dir };
    dir = parent;
  }
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
    const hooksDirs = new Set<string>();
    const { files, hooksPathRoot } = findLocalGitConfigFiles(cwd);
    for (const file of files) {
      if (path.basename(file) === 'config') {
        hooksDirs.add(path.join(path.dirname(file), 'hooks'));
      }
      if (file.endsWith('config.worktree') && !readWorktreeConfig) continue;
      try {
        if (fs.statSync(file).size > MAX_CONFIG_FILE_BYTES) {
          return true; // implausibly large config — fail closed
        }
      } catch {
        // stat can race with the read below; fall through.
      }
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
      const redirectedHooksDirs = hooksPathDirectories(entries, hooksPathRoot);
      if (redirectedHooksDirs === null) return true; // fail closed
      for (const dir of redirectedHooksDirs) hooksDirs.add(dir);
      readWorktreeConfig ||= worktreeConfigEnabled(entries);
    }
    for (const hooksDir of hooksDirs) {
      if (hooksMayExecutePrograms(hooksDir)) return true;
    }
    return false;
  } catch {
    return true; // unexpected probe failure — fail closed
  }
}
