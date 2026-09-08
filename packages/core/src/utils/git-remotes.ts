/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isValidRefName } from './gitDirect.js';
import { runGit } from './git-branches.js';

export interface GitRemoteInfo {
  name: string;
  /** First configured `remote.<name>.url`; empty when the section has none. */
  fetchUrl: string;
  /** First configured pushurl, falling back to `fetchUrl` when absent. */
  pushUrl: string;
  /** Configured fetch URLs beyond the first (multi-fetch remotes). */
  extraFetchUrls: number;
  /** Configured push URLs beyond the first (mirror-push remotes). */
  extraPushUrls: number;
  /** `remote.<name>.promisor` is set: the remote feeds a partial clone. */
  promisor: boolean;
  /** `remote.<name>.partialclonefilter` value when configured. */
  partialCloneFilter?: string;
  /** Any configured fetch refspec differs from git's add-time default. */
  customRefspec: boolean;
  /**
   * Count of other `remote.<name>.*` settings (proxy, mirror, tagopt, …)
   * that removal destroys and re-adding cannot restore.
   */
  otherSettings: number;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// The write-gate class for invisible characters, in lockstep with the
// web-shell display sanitizer: C0/C1 controls, format characters and the
// Default_Ignorable set (the Tag block U+E0000-E0FFF, Hangul fillers and
// friends are zero-width zero-ink), plus the line/paragraph separators
// which are not ignorable but still break rendered text. Derived from
// Unicode properties rather than a hand list — the set grows with Unicode,
// so an enumeration always has an unlisted corner. Space is deliberately
// NOT here: local-path remotes may contain it.
const INVISIBLE_CHARS =
  /[\u2028\u2029\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

// git's transport-helper form `<name>::<arg>` runs `git-remote-<name>` at
// connect time. Unknown helper names default to `protocol.allow = user`,
// and even the pinned ones (`ext`, `fd`) can be re-enabled from config
// FILES and GIT_ALLOW_PROTOCOL, which no per-invocation env scrubbing can
// remove — so the write path rejects the form. The scheme charset follows
// git's transport-name form with no letter-first rule (`7z::archive` runs
// `git-remote-7z` like any other helper). Anchored at the start so an IPv6
// literal (`ssh://git@[::1]/repo.git`) or an scp-like path is unaffected:
// only a scheme immediately followed by `::` matches.
const EXECUTING_HELPER_URL = /^[A-Za-z0-9][A-Za-z0-9_.+-]*::/;

/**
 * Whether `name` is acceptable for `git remote add`. Git applies its refname
 * rules to `refs/remotes/<name>/*`, so the branch predicate is the right
 * base; on top of it reject `/` (a remote is a single config subsection as
 * git writes it), a leading `-`, and invisible characters (a name that
 * renders identically to an existing remote is a deletion-spoofing surface).
 */
export function isValidRemoteName(name: string): boolean {
  return (
    isValidRefName(name) &&
    !name.includes('/') &&
    !name.startsWith('-') &&
    !INVISIBLE_CHARS.test(name)
  );
}

/**
 * Whether `url` is safe to pass to `git remote add`. Git accepts almost any
 * non-empty string (https/ssh/scp-like/local paths), so this guards the exec
 * vector (leading `-`), the transport-helper form, the display surface
 * (invisible characters) and rejects blanks.
 */
export function isValidRemoteUrl(url: string): boolean {
  return (
    url.length > 0 &&
    !url.startsWith('-') &&
    !EXECUTING_HELPER_URL.test(url) &&
    !CONTROL_CHARS.test(url) &&
    !INVISIBLE_CHARS.test(url)
  );
}

// Removal targets a remote git already has configured, so it must not be
// stricter than git itself: a hand-edited `.git/config` can hold names the
// add predicate rejects (leading `-`, spaces, control characters, invisible
// characters), and the panel is the only in-product way to clean them up.
// The exec vector is guarded by `--` on the argv, not by rejecting names.
// Every listed row passes this predicate (a config key is never empty and
// never carries a NUL), though git may still refuse the removal itself —
// e.g. a configured fetch refspec it cannot parse dies before mutating
// anything, and the route classifies that 409 remote_config_unparsable.
export function isRemovableRemoteName(name: string): boolean {
  return name.length > 0 && !name.includes('\0');
}

function isNoMatchConfigError(err: unknown): boolean {
  // A config read exits 1 with NO output when nothing matches: a repository
  // with no remotes, not a failure. (`--list` exits 0 instead, so the empty
  // list normally comes from the scope filter in fetchGitRemotes; this
  // shape is the guard for a read that answers like the old `--get-regexp`.)
  // A killed or failed spawn also carries empty output, so key on git's
  // documented exit code and the absence of a kill signal — otherwise a
  // timed-out read would answer 200 with an empty list.
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    stdout?: unknown;
    stderr?: unknown;
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  return (
    e.code === 1 &&
    e.killed !== true &&
    typeof e.signal !== 'string' &&
    e.stdout === '' &&
    e.stderr === ''
  );
}

function defaultRefspec(name: string): string {
  return `+refs/heads/*:refs/remotes/${name}/*`;
}

// git's config booleans: a valueless key is true; false/no/off/0 are false;
// an EMPTY value (`key =`) is false too — only the valueless spelling means
// true. Integers follow git's own grammar (strtoumax base 0 — decimal,
// `0x` hex, leading-0 octal — with an optional k/m/g unit factor, no
// padding): anything git's parser does not consume (`1e1`, `08`, quoted
// `" 1 "`) makes git die at read time, so the listing certifies neither
// true nor false beyond what git itself would read.
function gitIntegerValue(value: string): number | null {
  const m = /^([+-]?)(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)([kmg]?)$/.exec(value);
  if (!m) return null;
  const digits = m[2];
  const radix = digits.startsWith('0x')
    ? 16
    : digits.length > 1 && digits.startsWith('0')
      ? 8
      : 10;
  const factor =
    m[3] === 'k'
      ? 1024
      : m[3] === 'm'
        ? 1024 ** 2
        : m[3] === 'g'
          ? 1024 ** 3
          : 1;
  return (m[1] === '-' ? -1 : 1) * parseInt(digits, radix) * factor;
}

function isGitBoolTrue(value: string, valueless: boolean): boolean {
  if (valueless) return true;
  const v = value.toLowerCase();
  if (v.trim() === '') return false;
  if (v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === 'no' || v === 'off') return false;
  const n = gitIntegerValue(v);
  return n !== null && n !== 0;
}

// The config dump's stdout can carry every scope's records — global and
// system URLs, credential helpers, identities — and the route forwards
// error text to the client, so it must not leave this module (git's
// diagnostics live on stderr, which stays). Runs AFTER the no-match
// discrimination: blanking stdout earlier would turn an exit-1-with-dump
// failure into a false no-match.
function stripConfigDump(err: unknown): void {
  if (err && typeof err === 'object' && 'stdout' in err) {
    (err as { stdout: unknown }).stdout = '';
  }
}

interface RemoteSection {
  urls: string[];
  pushUrls: string[];
  refspecs: string[];
  promisor: boolean;
  partialCloneFilter?: string;
  otherSettings: number;
}

// git's `config --list --show-scope` scope words; only the two the
// repository itself owns are listed (see fetchGitRemotes).
const CONFIG_SCOPES = new Set([
  'system',
  'global',
  'local',
  'worktree',
  'command',
]);
const REPOSITORY_SCOPES = new Set(['local', 'worktree']);

/**
 * List the remotes configured in the repository's own editable scope — the
 * `local` config plus, where `extensions.worktreeConfig` enables it, the
 * per-worktree `config.worktree` — which is what git's own remote commands
 * resolve against inside the repository. `git config --local` alone is
 * NARROWER than that scope: an `include.path` entry in `.git/config`
 * contributes keys git still labels `local`, and worktree remotes live in a
 * separate file, so a `--local` read under-lists, dead-ends `git remote add`
 * (git's duplicate check sees the included name), and lets `git remote
 * remove` report success over a split section whose included half survives.
 * Reading `--list --show-scope` and filtering on the scope field covers
 * every repository-owned record while keeping inherited `global`/`system`
 * remotes out (git cannot remove those either). Reading config rather than
 * `git remote` + `get-url` also keeps the listing immune to insteadOf
 * rewriting, complete for multi-valued urls, and free of the per-name spawn
 * fan-out — one git process for the whole listing.
 *
 * Records are read NUL-framed (`-z`): a config value may contain an escaped
 * newline, which the line-oriented form prints across two lines, and a
 * subsection name may contain spaces, which a space-delimited key/value
 * split mis-parses. Under `-z --show-scope` each record is
 * `scope\0key\nvalue\0` (a valueless key is `scope\0key\0`), so the scope,
 * key and value boundaries are all unambiguous.
 */
export async function fetchGitRemotes(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitRemoteInfo[]> {
  // Probe first: outside a repository `git config --list` fails with texts
  // that vary by version, while rev-parse carries git's canonical
  // "not a git repository" message the route classifier keys on.
  await runGit(cwd, ['rev-parse', '--git-dir'], env);
  let raw: string;
  try {
    raw = await runGit(cwd, ['config', '--list', '--show-scope', '-z'], env);
  } catch (err) {
    if (isNoMatchConfigError(err)) return [];
    stripConfigDump(err);
    throw err;
  }
  const sections = new Map<string, RemoteSection>();
  const records = raw.split('\0');
  for (let i = 0; i < records.length; ) {
    // The scope field is its own NUL-terminated record; a valueless key is
    // a record without a newline, and config keys always carry a dot, so a
    // bare scope word can never be mistaken for one.
    const head = records[i] ?? '';
    const scoped = CONFIG_SCOPES.has(head);
    const entry = scoped ? (records[i + 1] ?? '') : head;
    i += scoped ? 2 : 1;
    if (!scoped || !REPOSITORY_SCOPES.has(head)) continue;
    const newline = entry.indexOf('\n');
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? '' : entry.slice(newline + 1);
    if (!key.startsWith('remote.')) continue;
    const rest = key.slice('remote.'.length);
    const dot = rest.lastIndexOf('.');
    // `remote.<name>.<subkey>`: the subkey is always the last component.
    if (dot <= 0) continue;
    const name = rest.slice(0, dot);
    const sub = rest.slice(dot + 1);
    let section = sections.get(name);
    if (!section) {
      section = {
        urls: [],
        pushUrls: [],
        refspecs: [],
        promisor: false,
        otherSettings: 0,
      };
      sections.set(name, section);
    }
    if (sub === 'url') section.urls.push(value);
    else if (sub === 'pushurl') section.pushUrls.push(value);
    else if (sub === 'fetch') section.refspecs.push(value);
    else if (sub === 'promisor')
      section.promisor = isGitBoolTrue(value, newline === -1);
    else if (sub === 'partialclonefilter') section.partialCloneFilter = value;
    else section.otherSettings += 1;
  }
  const remotes: GitRemoteInfo[] = [];
  for (const [name, section] of sections) {
    const fetchUrl = section.urls[0] ?? '';
    remotes.push({
      name,
      fetchUrl,
      pushUrl: section.pushUrls[0] ?? fetchUrl,
      extraFetchUrls: Math.max(0, section.urls.length - 1),
      extraPushUrls: Math.max(0, section.pushUrls.length - 1),
      promisor: section.promisor,
      ...(section.partialCloneFilter === undefined
        ? {}
        : { partialCloneFilter: section.partialCloneFilter }),
      customRefspec: section.refspecs.some(
        (refspec) => refspec !== defaultRefspec(name),
      ),
      otherSettings: section.otherSettings,
    });
  }
  return remotes;
}

/**
 * Add a remote and return the fresh list. Throws when the name or URL fails
 * validation, or when git rejects the add (e.g. duplicate name).
 */
export async function gitRemoteAdd(
  cwd: string,
  name: string,
  url: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitRemoteInfo[]> {
  const trimmedUrl = url.trim();
  if (!isValidRemoteName(name)) {
    throw new Error(`invalid remote name: ${name}`);
  }
  if (!isValidRemoteUrl(trimmedUrl)) {
    throw new Error('invalid remote url');
  }
  // Probe repository-ness first, before the inherited-scope pre-flight:
  // outside a repository the scope read exits 0 with the inherited config,
  // so a same-named global remote would otherwise surface the shadow
  // refusal (409) where git's canonical not-a-repository answer (404)
  // belongs — the same ordering fetchGitRemotes keeps with its probe.
  await runGit(cwd, ['rev-parse', '--git-dir'], env);
  // git's remote family resolves only the repository scope (local,
  // include-sourced, worktree), so the duplicate check is blind to an
  // inherited section: the panel's own Add would silently create a
  // same-name collision with one, and git then resolves fetch/push from
  // records the panel does not show (a multi-valued url pushes to both).
  // Refuse up front — a deliberate shadow belongs to the terminal, not to
  // a 200 from here.
  const existing = await remoteSectionScopes(cwd, name, env);
  for (const scope of existing) {
    if (scope !== 'local' && scope !== 'worktree') {
      throw new Error('remote already configured in an inherited scope');
    }
  }
  // `--` terminates options so a config-held name can never read as a flag.
  await runGit(cwd, ['remote', 'add', '--', name, trimmedUrl], env);
  return fetchGitRemotes(cwd, env);
}

/**
 * Remove a remote (and its remote-tracking refs, per git semantics) and
 * return the fresh list. Throws when git reports no such remote, or when the
 * section survives the removal (an included config file git will not edit).
 */
export async function gitRemoteRemove(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitRemoteInfo[]> {
  if (!isRemovableRemoteName(name)) {
    throw new Error('invalid remote name');
  }
  let removeError: unknown = null;
  try {
    await runGit(cwd, ['remote', 'remove', '--', name], env);
  } catch (err) {
    removeError = err;
  }
  // git edits only .git/config: a section held in the per-worktree
  // config.worktree survives `git remote remove` with "Could not remove
  // config section" AFTER git has already deleted the tracking refs and
  // upstream keys, so every retry would repeat the destruction. Complete
  // the removal in the scope git could not write.
  if (removeError !== null) {
    const completed =
      /could not remove config section/i.test(execDetail(removeError)) &&
      (await removeWorktreeScopeSection(cwd, name, env));
    if (!completed) throw removeError;
  }
  let remotes = await fetchGitRemotes(cwd, env);
  if (remotes.some((remote) => remote.name === name)) {
    // git exited 0 over a split section (an included config file, or a
    // worktree half): finish the worktree half when that is where the
    // survivor lives, then verify again.
    if (await removeWorktreeScopeSection(cwd, name, env)) {
      remotes = await fetchGitRemotes(cwd, env);
    }
  }
  if (remotes.some((remote) => remote.name === name)) {
    // No name in the message: sendGitError classifies on message text, and
    // a config-chosen name could carry a keyword another branch claims.
    throw new Error('remote still configured after removal');
  }
  // The repository-scope listing cannot see a same-name survivor in an
  // inherited scope, but git still resolves it — fetch/push keep reaching
  // the remote the panel just said was removed. Verify resolution too.
  if ((await remoteSectionScopes(cwd, name, env)).size > 0) {
    throw new Error('remote still configured after removal');
  }
  return remotes;
}

function execDetail(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const stdout = typeof e.stdout === 'string' ? e.stdout : '';
    const stderr = typeof e.stderr === 'string' ? e.stderr : '';
    if (stdout || stderr) return `${stdout}\n${stderr}`;
    return typeof e.message === 'string' ? e.message : String(err);
  }
  return String(err);
}

// The config scopes holding `remote.<name>.*` records, from the same scoped
// read the listing uses.
async function remoteSectionScopes(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<Set<string>> {
  const scopes = new Set<string>();
  let raw: string;
  try {
    raw = await runGit(cwd, ['config', '--list', '--show-scope', '-z'], env);
  } catch (err) {
    // The verification gates below use an empty answer in fail-OPEN
    // polarity ("no survivor"), so only a true no-match may be read as
    // empty: a killed or failed read must surface, or the add pre-flight
    // and the removal verification would certify past their own guard.
    if (isNoMatchConfigError(err)) return scopes;
    stripConfigDump(err);
    throw err;
  }
  const prefix = `remote.${name}.`;
  const records = raw.split('\0');
  for (let i = 0; i < records.length; ) {
    const head = records[i] ?? '';
    const scoped = CONFIG_SCOPES.has(head);
    const entry = scoped ? (records[i + 1] ?? '') : head;
    i += scoped ? 2 : 1;
    if (!scoped) continue;
    const newline = entry.indexOf('\n');
    const key = newline === -1 ? entry : entry.slice(0, newline);
    if (!key.startsWith(prefix)) continue;
    // Section identity, not prefix: a sibling remote whose name extends
    // this one (`a.b` next to `a`) must not count as a local copy of `a`.
    const rest = key.slice('remote.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot > 0 && rest.slice(0, dot) === name) scopes.add(head);
  }
  return scopes;
}

// `git remote remove` cannot edit a per-worktree config.worktree; finish
// such a removal there. Gated on the survivor living ONLY at worktree
// scope: without extensions.worktreeConfig the `--worktree` selector
// silently means `--local`, a local-scope survivor is the included-config
// case that must keep answering remote_still_configured, and a survivor in
// any OTHER scope (global/system/command) is git's own resolution surface
// the caller's scope-complete check must still see.
async function removeWorktreeScopeSection(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const scopes = await remoteSectionScopes(cwd, name, env);
  if (scopes.size !== 1 || !scopes.has('worktree')) return false;
  try {
    await runGit(
      cwd,
      ['config', '--worktree', '--remove-section', `remote.${name}`],
      env,
    );
  } catch {
    return false;
  }
  return true;
}
