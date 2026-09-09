/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
// One exception: a SLASHED name's tracking namespace is a subdirectory of
// the prefix remote's (refs/remotes/origin/staging/* lives inside
// refs/remotes/origin/*), so the post-removal sweep cannot tell the
// remote's own refs from the prefix remote's branch refs — and a
// never-configured slashed name would 404 only AFTER the converge-arm
// sweep destroyed them. The panel refuses the shape; the terminal's
// `git remote remove` remains the tool for it.
export function isRemovableRemoteName(name: string): boolean {
  return name.length > 0 && !name.includes('\0') && !name.includes('/');
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

// A bool key's effective value, answered by the host git itself:
// `--type=bool` normalizes to exactly "true"/"false". git's integer-bool
// grammar (strtoimax spelling rules, unit factors, the maybe_bool bound)
// is the host git's to answer — an in-module parse table duplicates a
// parser it cannot version-match. Not scope-flagged: fetch/push resolve the key across
// every scope, so the badge does too. `--get-all` because a multi-valued
// `remote.<name>.promisor` is ADDITIVE in git — any true entry registers
// the promisor (a `[true, false]` pair still lazy-fetches) — not
// last-value-wins. A genuine non-zero exit — an
// unparseable value, a key raced away — is false: one bad key must not
// fail the whole listing. A KILLED read is not a negative answer,
// though: it rethrows (dump stripped), like every sibling read.
async function gitConfigBool(
  cwd: string,
  key: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  try {
    const out = await runGit(
      cwd,
      ['config', '--type=bool', '--get-all', key],
      env,
    );
    return out.split('\n').some((line) => line.trim() === 'true');
  } catch (err) {
    if (isKillError(err)) {
      stripConfigDump(err);
      throw err;
    }
    return false;
  }
}

// A spawn that never produced git's answer (timeout kill, signal): not a
// value the caller may read as a negative.
function isKillError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { killed?: unknown; signal?: unknown };
  return e.killed === true || typeof e.signal === 'string';
}

interface RemoteSection {
  urls: string[];
  pushUrls: string[];
  refspecs: string[];
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
  // Apple Git labels its runtime-prefix defaults file `unknown`; the
  // records are real and git resolves them, so the verification folds
  // must see them (the listing and the sweep filter on
  // REPOSITORY_SCOPES regardless).
  'unknown',
]);
const REPOSITORY_SCOPES = new Set(['local', 'worktree']);

interface ConfigRecord {
  scope: string;
  key: string;
  value: string;
  valueless: boolean;
  // Present only when the dump was read withOrigin: the record's
  // `--show-origin` spelling (`file:<path>`, `command line`, …).
  origin?: string;
}

// The `-z --show-scope` record walk, shared by every consumer: each record
// is `scope\0key\nvalue\0` (a valueless key is `scope\0key\0`), and a bare
// scope word can never be mistaken for a key because config keys always
// carry a dot. withOrigin adds the `--show-origin` field:
// `scope\0origin\0key\nvalue\0`.
function* iterConfigRecords(
  raw: string,
  withOrigin = false,
): Generator<ConfigRecord> {
  const records = raw.split('\0');
  const stride = withOrigin ? 3 : 2;
  for (let i = 0; i < records.length; ) {
    const head = records[i] ?? '';
    const scoped = CONFIG_SCOPES.has(head);
    const entry = scoped ? (records[i + stride - 1] ?? '') : head;
    const origin = withOrigin && scoped ? records[i + 1] : undefined;
    i += scoped ? stride : 1;
    if (!scoped) continue;
    const newline = entry.indexOf('\n');
    yield {
      scope: head,
      key: newline === -1 ? entry : entry.slice(0, newline),
      value: newline === -1 ? '' : entry.slice(newline + 1),
      valueless: newline === -1,
      ...(origin === undefined ? {} : { origin }),
    };
  }
}

/**
 * List the remotes configured in the repository's own editable scope — the
 * `local` config plus, where `extensions.worktreeConfig` enables it, the
 * per-worktree `config.worktree`. This is the panel's manage surface: each
 * row is the repository-scope section `git remote remove` will edit, NOT
 * git's full cross-scope resolution (a same-name section split across
 * global and local resolves fetch/push across both in git, but only the
 * repository half is listed or mutable here). `git config --local` alone
 * is NARROWER than that scope: an `include.path` entry in `.git/config`
 * contributes keys git still labels `local`, and worktree remotes live in
 * a separate file, so a `--local` read under-lists, dead-ends `git remote
 * add` (git's duplicate check sees the included name), and lets `git
 * remote remove` report success over a split section whose included half
 * survives. Reading `--list --show-scope` and filtering on the scope
 * field covers every repository-owned record while keeping inherited
 * `global`/`system` remotes out (git cannot remove those either).
 * Reading config rather than `git remote` + `get-url` also keeps the
 * listing immune to insteadOf rewriting and complete for multi-valued
 * urls. The listing itself is one git process; a `promisor`-carrying
 * section costs one extra `--type=bool` read per name (the bool grammar
 * is host-version-dependent, so the value is not parsed in-module), and
 * those sections are rare (partial clones only).
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
  // A promisor record at ANY scope marks the section: git registers
  // promisor remotes cross-scope, and the badge read below resolves the
  // same way — a local remote whose promisor key lives in the global
  // config still feeds a partial clone, and removing it still loses it.
  const promisorNames = new Set<string>();
  for (const record of iterConfigRecords(raw)) {
    const { scope, key, value } = record;
    if (!key.startsWith('remote.')) continue;
    const rest = key.slice('remote.'.length);
    const dot = rest.lastIndexOf('.');
    // `remote.<name>.<subkey>`: the subkey is always the last component.
    if (dot <= 0) continue;
    const name = rest.slice(0, dot);
    const sub = rest.slice(dot + 1);
    if (sub === 'promisor') promisorNames.add(name);
    if (!REPOSITORY_SCOPES.has(scope)) continue;
    let section = sections.get(name);
    if (!section) {
      section = {
        urls: [],
        pushUrls: [],
        refspecs: [],
        otherSettings: 0,
      };
      sections.set(name, section);
    }
    if (sub === 'url') section.urls.push(value);
    else if (sub === 'pushurl') section.pushUrls.push(value);
    else if (sub === 'fetch') section.refspecs.push(value);
    else if (sub === 'partialclonefilter') section.partialCloneFilter = value;
    else if (sub === 'promisor') {
      // Not an "other" setting — it drives the badge via promisorNames.
    } else section.otherSettings += 1;
  }
  const remotes: GitRemoteInfo[] = [];
  for (const [name, section] of sections) {
    const fetchUrl = section.urls[0] ?? '';
    remotes.push({
      name,
      fetchUrl,
      pushUrl: section.pushUrls[0] ?? fetchUrl,
      extraFetchUrls: Math.max(0, section.urls.length - 1),
      // With no pushurl key git pushes to EVERY url, so the push fan-out
      // falls back to the url list — `git remote -v` reports all of
      // them, and the badge must not under-report what a removal loses.
      extraPushUrls: Math.max(
        0,
        (section.pushUrls.length > 0
          ? section.pushUrls.length
          : section.urls.length) - 1,
      ),
      promisor: promisorNames.has(name)
        ? await gitConfigBool(cwd, `remote.${name}.promisor`, env)
        : false,
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
  // git's remote family WRITES (the duplicate check, the section edit)
  // only the repository scope (local, include-sourced, worktree), while
  // fetch/push RESOLVE the name across every scope: the duplicate check
  // is blind to an inherited section, and the panel's own Add would
  // silently create a same-name collision with one, which git then
  // resolves from records the panel does not show (a multi-valued url
  // pushes to both). Refuse up front — a deliberate shadow belongs to
  // the terminal, not to a 200 from here.
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
  // git's rm mutates BEFORE it can fail: it deletes the tracking refs
  // and unsets the pointing branches' keys first, then dies renaming a
  // section held in a file it cannot write. A section held in an
  // include.path'd file is scope-labeled `local`, so the scope reads
  // cannot tell it apart — only the record ORIGINS can. Refuse up front,
  // before anything is destroyed; the post-removal gates stay as the
  // backstop for everything the pre-flight cannot foresee.
  if (await remoteSectionHasIncludedOrigin(cwd, name, env)) {
    // No name in the message: sendGitError classifies on message text,
    // and a config-chosen name could carry a keyword another branch
    // claims.
    throw new Error('remote section lives in an included config file');
  }
  // Snapshot the branches pointing at `name` BEFORE git rm unsets the
  // local-scope keys: a branch whose `remote` key lives at local scope
  // but whose `merge`/`pushRemote` keys are worktree-scoped is otherwise
  // unattributable post-removal.
  const pointed = await pointingBranches(cwd, name, env);
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
    const detail = execDetail(removeError);
    // git echoes a config-chosen refspec value verbatim inside its fatal
    // line, and that value can carry a real newline — so the completion
    // phrase is matched at a line start, and a fatal parse failure must
    // NEVER read as the completion signal: git died before mutating, the
    // row stayed, and the refusal has its own classifier answer
    // (remote_config_unparsable), which the completion would bury.
    const completed =
      !/^(?:error|fatal): invalid refspec/m.test(detail) &&
      /^(?:error|fatal): Could not remove config section/m.test(detail) &&
      (await removeWorktreeScopeSection(cwd, name, env));
    if (!completed) {
      if (
        /^(?:error|fatal): No such remote: /m.test(detail) &&
        (await remoteSectionScopes(cwd, name, env)).size === 0
      ) {
        // The section is already gone — an earlier attempt died after
        // removing it but before finishing the cleanup, so a retry
        // would otherwise dead-end here. Converge the cleanup (upstream
        // keys AND the orphaned tracking refs a refspec-less removal
        // leaves), then surface git's answer.
        await deleteRemoteTrackingRefs(cwd, name, env);
        await unsetUpstreamKeys(cwd, pointed, name, env);
        // Same narrowing as the main path: inert merge survivors do not
        // refuse.
        if (
          (await upstreamKeysToSweep(cwd, pointed, name, env)).some(
            (k) => k.fixedValue !== undefined,
          )
        ) {
          throw new Error('remote still configured after removal');
        }
      }
      throw removeError;
    }
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
  // git's rm deletes the remote-tracking refs only through a fetch
  // refspec it can parse: a refspec-less section (`git remote add
  // --mirror=push`, or a hand-unset fetch key) exits 0 — or fails at the
  // section write — leaving refs/remotes/<name>/* orphaned with no
  // remote left to prune them, and the branch picker keeps listing the
  // phantom group. Sweep the namespace now that the removal is
  // certified, and re-verify — a surviving ref refuses rather than
  // certifying the phantom group.
  await deleteRemoteTrackingRefs(cwd, name, env);
  if ((await remoteTrackingRefs(cwd, name, env)).length > 0) {
    throw new Error('remote still configured after removal');
  }
  // git's rm unsets the pointing branches' branch.<b>.remote/merge and
  // pushRemote keys — but only in the file it can write, so keys held in
  // config.worktree survive every removal (not just worktree-section
  // ones) into a dangling `branch.<b>.remote = <gone>` the next pull
  // fatals on. Clear them now that the removal is certified — a refused
  // removal above never reaches this point.
  await unsetUpstreamKeys(cwd, pointed, name, env);
  // Re-verify only the VALUE-MATCHED keys: a merge key is unset
  // best-effort, but a survivor resolves to "." and is inert (the same
  // doctrine the surviving-keys gate follows), so an include-held merge
  // key the sweep cannot edit must not refuse a completed removal.
  if (
    (await upstreamKeysToSweep(cwd, pointed, name, env)).some(
      (k) => k.fixedValue !== undefined,
    )
  ) {
    throw new Error('remote still configured after removal');
  }
  // The same keys held outside .git/config survive too, into the
  // identical dangling state: an include.path'd file (scope-local), or
  // an inherited global/system file (a shadowing local copy git's rm
  // unsets can even UNMASK a same-valued inherited record). Those files
  // are outside what this module will edit, so a survivor must REFUSE,
  // not be swept.
  if (await survivingUpstreamKeys(cwd, name, pointed, env)) {
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

// The spellings a path can carry between git and the filesystem: git
// prints `--show-origin` paths relative to the worktree TOPLEVEL when
// they sit beneath it, absolute and NOT symlink-resolved otherwise;
// rev-parse answers relative to the passed cwd or absolute. Canonicalize to the resolved absolute path plus its realpath
// (fixtures live under a symlinked TMPDIR), forward slashes throughout —
// git prints those even on Windows.
async function pathSpellings(cwd: string, file: string): Promise<Set<string>> {
  const resolved = path.resolve(cwd, file).replace(/\\/g, '/');
  const spellings = new Set([resolved]);
  try {
    spellings.add((await fs.promises.realpath(resolved)).replace(/\\/g, '/'));
  } catch {
    // config.worktree need not exist.
  }
  return spellings;
}

// The two config files a removal can edit — the common config and the
// per-worktree config.worktree — in every spelling a dump may name them.
async function editableConfigSpellings(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<Set<string>> {
  const [gitDir, commonDir] = await Promise.all([
    runGit(cwd, ['rev-parse', '--git-dir'], env),
    runGit(cwd, ['rev-parse', '--git-common-dir'], env),
  ]);
  const spellings = await pathSpellings(
    cwd,
    path.join(path.resolve(cwd, commonDir.trim()), 'config'),
  );
  for (const spelling of await pathSpellings(
    cwd,
    path.join(path.resolve(cwd, gitDir.trim()), 'config.worktree'),
  )) {
    spellings.add(spelling);
  }
  return spellings;
}

// The base `--show-origin` relative paths resolve against: git chdirs to
// the worktree toplevel during setup and prints relative to THAT, not to
// the daemon-supplied cwd (a subdir of the worktree). `--show-toplevel`
// fails for a bare repo — no chdir happens there, so the cwd is the base.
async function repoTopLevel(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  try {
    return (await runGit(cwd, ['rev-parse', '--show-toplevel'], env)).trim();
  } catch (err) {
    // A killed probe is not a bare-repo answer: read with the wrong base
    // it would refuse every removal from a subdir cwd.
    if (isKillError(err)) {
      stripConfigDump(err);
      throw err;
    }
    return cwd;
  }
}

// Whether any repository-scope `remote.<name>.*` record's ORIGIN is a file
// other than the two a removal can edit — which only an include.path'd
// file produces (inherited scopes are filtered out by the scope field;
// command-scope records are not file-backed and not repository-scope).
async function remoteSectionHasIncludedOrigin(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await runGit(
      cwd,
      ['config', '--list', '--show-origin', '--show-scope', '-z'],
      env,
    );
  } catch (err) {
    if (isNoMatchConfigError(err)) return false;
    stripConfigDump(err);
    throw err;
  }
  const [editable, originBase] = await Promise.all([
    editableConfigSpellings(cwd, env),
    repoTopLevel(cwd, env),
  ]);
  const prefix = `remote.${name}.`;
  for (const record of iterConfigRecords(raw, true)) {
    if (!REPOSITORY_SCOPES.has(record.scope)) continue;
    const { key, origin } = record;
    if (!key.startsWith(prefix)) continue;
    // Section identity, not prefix: a sibling remote whose name extends
    // this one (`a.b` next to `a`) must not count as a record of `a`.
    const rest = key.slice('remote.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0 || rest.slice(0, dot) !== name) continue;
    if (origin === undefined || !origin.startsWith('file:')) return true;
    let editableOrigin = false;
    // Relative origins are printed against the worktree TOPLEVEL (git
    // chdirs during setup), not the passed cwd, which may be a subdir.
    for (const spelling of await pathSpellings(originBase, origin.slice(5))) {
      if (editable.has(spelling)) {
        editableOrigin = true;
        break;
      }
    }
    if (!editableOrigin) return true;
  }
  return false;
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
  for (const record of iterConfigRecords(raw)) {
    const { scope, key } = record;
    if (!key.startsWith(prefix)) continue;
    // Section identity, not prefix: a sibling remote whose name extends
    // this one (`a.b` next to `a`) must not count as a local copy of `a`.
    const rest = key.slice('remote.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot > 0 && rest.slice(0, dot) === name) scopes.add(scope);
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

interface UpstreamKey {
  scope: 'local' | 'worktree';
  key: string;
  // Present for remote/pushRemote/pushDefault keys: only the entries
  // whose value is the removed remote may go (a multi-valued key can
  // also point at a surviving remote), via --fixed-value.
  fixedValue?: string;
}

interface PointingBranches {
  // Branches whose effective `branch.<b>.remote` is the removed remote —
  // git's rm unsets their remote/merge keys, and their pushRemote when it
  // points at the removed remote.
  fetch: Set<string>;
  // Branches whose effective `branch.<b>.pushRemote` is the removed
  // remote — git unsets that key independently of the remote match; the
  // branch's merge key belongs to its surviving FETCH upstream and stays.
  push: Set<string>;
  // The effective pre-removal `remote.pushDefault` across ALL scopes, so
  // the unmask gate can tell "the sweep unset a shadowing copy" (this
  // pointed at the removed remote) from "a dangling inherited value was
  // always there" (not this removal's to refuse).
  pushDefault: string | undefined;
}

// The branches linked to `name` by fetch or push upstream config,
// resolved the way git does: worktree scope beats local, and the LAST
// value within each wins. Read BEFORE `git remote remove` — git unsets
// the local-scope keys itself, so attribution must be captured up front.
async function pointingBranches(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<PointingBranches> {
  let raw: string;
  try {
    raw = await runGit(cwd, ['config', '--list', '--show-scope', '-z'], env);
  } catch (err) {
    stripConfigDump(err);
    throw err;
  }
  const local = new Map<string, string>();
  const worktree = new Map<string, string>();
  let pushDefault: string | undefined;
  for (const record of iterConfigRecords(raw)) {
    const { scope, key, value } = record;
    // The dump is in scope order: the last record wins, every scope
    // included — the way `git push` resolves the default.
    if (key === 'remote.pushdefault') pushDefault = value;
    if (scope !== 'local' && scope !== 'worktree') continue;
    if (!key.startsWith('branch.')) continue;
    const rest = key.slice('branch.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) continue;
    const sub = rest.slice(dot + 1);
    if (sub !== 'remote' && sub !== 'pushremote') continue;
    (scope === 'worktree' ? worktree : local).set(
      `${rest.slice(0, dot)}.${sub}`,
      value,
    );
  }
  const pointed: PointingBranches = {
    fetch: new Set(),
    push: new Set(),
    pushDefault,
  };
  for (const key2 of new Set([...local.keys(), ...worktree.keys()])) {
    // Map.set keeps the LAST value per scope, then worktree beats local.
    if ((worktree.get(key2) ?? local.get(key2)) !== name) continue;
    const branch = key2.slice(0, key2.lastIndexOf('.'));
    (key2.endsWith('.remote') ? pointed.fetch : pointed.push).add(branch);
  }
  return pointed;
}

// The upstream keys to clear for the pre-removal snapshot, across the
// repository's OWN editable scopes (local + worktree): git's rm unsets
// them only in the file it can write and SKIPS multi-valued keys with a
// warning — so keys held in config.worktree, and multi-valued local
// keys, survive every removal into a dangling `branch.<b>.remote =
// <gone>`. Fetch-pointed branches lose their remote (by value), their
// merge (git unsets it whenever the remote matches), and their
// pushRemote (by value); push-pointed branches lose only their
// pushRemote (by value) — their merge key belongs to the surviving fetch
// upstream. Plus a `remote.pushDefault` resolving to the removed remote.
// A key with SEVERAL values contributes only the matching entries
// (--fixed-value).
async function upstreamKeysToSweep(
  cwd: string,
  pointed: PointingBranches,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<UpstreamKey[]> {
  let raw: string;
  try {
    raw = await runGit(cwd, ['config', '--list', '--show-scope', '-z'], env);
  } catch (err) {
    // Same dump guard as the listing and scope reads (`--list` exits 0 on
    // empty, so any failure here must abort, not read as "no keys").
    stripConfigDump(err);
    throw err;
  }
  // Per scope, per key: ALL values — a multi-valued key's non-last entry
  // naming the removed remote is residue to sweep even when the
  // effective (last) value points at a surviving remote.
  const byScope = new Map<'local' | 'worktree', Map<string, string[]>>();
  for (const record of iterConfigRecords(raw)) {
    if (record.scope !== 'local' && record.scope !== 'worktree') continue;
    let byKey = byScope.get(record.scope);
    if (!byKey) {
      byKey = new Map();
      byScope.set(record.scope, byKey);
    }
    const list = byKey.get(record.key) ?? [];
    list.push(record.value);
    byKey.set(record.key, list);
  }
  const keys: UpstreamKey[] = [];
  for (const [scope, byKey] of byScope) {
    for (const branch of pointed.fetch) {
      if ((byKey.get(`branch.${branch}.remote`) ?? []).includes(name)) {
        keys.push({ scope, key: `branch.${branch}.remote`, fixedValue: name });
      }
      if (byKey.has(`branch.${branch}.merge`)) {
        keys.push({ scope, key: `branch.${branch}.merge` });
      }
      if ((byKey.get(`branch.${branch}.pushremote`) ?? []).includes(name)) {
        keys.push({
          scope,
          key: `branch.${branch}.pushremote`,
          fixedValue: name,
        });
      }
    }
    for (const branch of pointed.push) {
      if ((byKey.get(`branch.${branch}.pushremote`) ?? []).includes(name)) {
        keys.push({
          scope,
          key: `branch.${branch}.pushremote`,
          fixedValue: name,
        });
      }
    }
    if ((byKey.get('remote.pushdefault') ?? []).includes(name)) {
      keys.push({ scope, key: 'remote.pushdefault', fixedValue: name });
    }
  }
  return keys;
}

// The remote-tracking refs under refs/remotes/<name>/ — the trailing
// slash keeps a dotted sibling's namespace (`refs/remotes/a.b/`) out of
// a removal of `a`.
async function remoteTrackingRefs(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await runGit(
      cwd,
      ['for-each-ref', '--format=%(refname)', `refs/remotes/${name}/`],
      env,
    );
  } catch (err) {
    // for-each-ref exits 0 on empty, so any failure here must abort,
    // not read as "no refs" — the caller's verification is fail-closed.
    stripConfigDump(err);
    throw err;
  }
  return raw.split('\n').filter((line) => line !== '');
}

// Delete every refs/remotes/<name>/* entry, best-effort per ref: the
// caller's re-verification decides whether a survivor certifies or
// refuses.
async function deleteRemoteTrackingRefs(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  for (const ref of await remoteTrackingRefs(cwd, name, env)) {
    try {
      // --no-deref: a symbolic ref under the namespace is deleted as
      // itself — dereferencing would delete its TARGET (a local branch
      // the sweep must never touch), which is what git's own rm does
      // with REF_NO_DEREF.
      await runGit(cwd, ['update-ref', '--no-deref', '-d', ref], env);
    } catch {
      // Re-verified by the caller: a ref that survives (a killed delete,
      // a concurrent fetch re-adding it) must not be certified as
      // cleaned.
    }
  }
}

// Whether any upstream key still RESOLVES to the removed remote after
// the certified removal. Records are folded with git's own effective
// semantics — the dump is in scope order and the last value wins — so a
// record shadowed by a higher-precedence scope pointing at a SURVIVING
// remote never refuses, while an include-held (scope-local) or inherited
// (global/system) record that nothing shadows does. Both live in files
// this module will not edit, so refusal is the only answer. Merge keys
// are ignored: a merge-only survivor resolves to "." and is inert.
//
// The pointed snapshot also gates the UNMASK case: git's rm unsets the
// editable record a pointed branch resolved through, so a shadowed
// inherited record surfaces — and when THAT names a remote with no
// section anywhere (removed earlier, or never existed here), the branch
// is left dangling all the same. Only snapshot-pointed entries are
// checked: the snapshot proves their value WAS the removed remote
// (branches AND the pushDefault resolution), so a changed value is the
// removal's doing; a pre-existing dangling upstream elsewhere (or a
// dangling pushDefault the removal never shadowed) is not this
// removal's to refuse.
async function survivingUpstreamKeys(
  cwd: string,
  name: string,
  pointed: PointingBranches,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await runGit(cwd, ['config', '--list', '--show-scope', '-z'], env);
  } catch (err) {
    // Same dump guard as the listing and scope reads (`--list` exits 0 on
    // empty, so any failure here must abort, not read as "no survivor").
    stripConfigDump(err);
    throw err;
  }
  const lastValue = new Map<string, string>();
  const sectionNames = new Set<string>();
  for (const record of iterConfigRecords(raw)) {
    lastValue.set(record.key, record.value);
    if (!record.key.startsWith('remote.')) continue;
    const rest = record.key.slice('remote.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot > 0) sectionNames.add(rest.slice(0, dot));
  }
  for (const [key, value] of lastValue) {
    if (value !== name) continue;
    if (key === 'remote.pushdefault') return true;
    if (!key.startsWith('branch.')) continue;
    const rest = key.slice('branch.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) continue;
    const sub = rest.slice(dot + 1);
    if (sub === 'remote' || sub === 'pushremote') return true;
  }
  for (const branch of pointed.fetch) {
    const value = lastValue.get(`branch.${branch}.remote`);
    if (
      value !== undefined &&
      value !== name &&
      !isSectionlessUpstream(value) &&
      !sectionNames.has(value)
    ) {
      return true;
    }
  }
  for (const branch of pointed.push) {
    const value = lastValue.get(`branch.${branch}.pushremote`);
    if (
      value !== undefined &&
      value !== name &&
      !isSectionlessUpstream(value) &&
      !sectionNames.has(value)
    ) {
      return true;
    }
  }
  // The same unmask shape for `remote.pushDefault`: only when the
  // pre-removal snapshot saw it resolve to the removed remote (an
  // editable copy git's rm or the sweep unset) does a surfaced
  // sectionless value blame this removal.
  if (pointed.pushDefault === name) {
    const value = lastValue.get('remote.pushdefault');
    if (
      value !== undefined &&
      value !== name &&
      !isSectionlessUpstream(value) &&
      !sectionNames.has(value)
    ) {
      return true;
    }
  }
  return false;
}

// Values git resolves WITHOUT a remote section: the local repository
// (`.`), anything carrying a `:` — a URL (`https:…`, `ssh:…`) or the
// scp-like `[user@]host:path` — and local PATHS (`/abs`, `./rel`,
// `a/b`): git decides the transport from the shape, so an unmasked one
// is a valid upstream, not a dangling remote name. Only consulted when
// no `remote.<value>.*` section exists, so a section whose name happens
// to contain a colon or slash still wins first. A bare word is the one
// remaining class — and the dangling-remote-name shape the gate refuses.
function isSectionlessUpstream(value: string): boolean {
  return value === '.' || value.includes(':') || value.includes('/');
}

// Unset every upstreamKeysToSweep entry, best-effort per key: the
// caller's re-verification decides whether a surviving key certifies or
// refuses.
async function unsetUpstreamKeys(
  cwd: string,
  pointed: PointingBranches,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  for (const { scope, key, fixedValue } of await upstreamKeysToSweep(
    cwd,
    pointed,
    name,
    env,
  )) {
    try {
      await runGit(
        cwd,
        fixedValue === undefined
          ? ['config', `--${scope}`, '--unset-all', key]
          : [
              'config',
              `--${scope}`,
              '--fixed-value',
              '--unset-all',
              key,
              fixedValue,
            ],
        env,
      );
    } catch {
      // Re-verified by the caller: a key that survives (a killed unset, a
      // concurrent re-add) must not be certified as cleaned.
    }
  }
}
