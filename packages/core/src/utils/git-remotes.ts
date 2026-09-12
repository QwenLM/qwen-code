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
// `git-remote-7z` like any other helper) AND admits the EMPTY name
// (`::sh -c id` execs a PATH-resolved `git-remote-` with the payload as
// argv — git's grammar accepts it, so the gate must too). Anchored at the
// start so an IPv6 literal (`ssh://git@[::1]/repo.git`) or an scp-like
// path is unaffected: only a scheme immediately followed by `::` matches.
const EXECUTING_HELPER_URL = /^[A-Za-z0-9_.+-]*::/;

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
  // section held in a file it cannot write — and over a SPLIT section
  // (the name also configured in an inherited scope) it exits 0 after
  // destroying the local half while the inherited survivor keeps the
  // name resolving. Refuse up front, before anything is destroyed, when
  // any record of the section lives outside the two files a removal
  // edits; the post-removal gates stay as the backstop for everything
  // the pre-flight cannot foresee.
  const sectionBlock = await remoteSectionRemovalBlock(cwd, name, env);
  // No name in either message: sendGitError classifies on message text,
  // and a config-chosen name could carry a keyword another branch
  // claims.
  if (sectionBlock === 'inherited') {
    throw new Error('remote already configured in an inherited scope');
  }
  if (sectionBlock === 'included') {
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
    // git can die AFTER deleting the tracking refs and unsetting the
    // pointing branch keys (a stale ref lock, a worktree-section write
    // failure): roll the local backups back HERE, above the !completed
    // throw and the converge classification, so no refusal that follows
    // a mutation can skip the rollback — a retry would re-read its
    // snapshot from the already-destroyed config. The restore rewrites
    // only MISSING keys, so it is a no-op where git mutated nothing
    // (invalid refspec) and where the converge arm's keys still stand
    // or the snapshot is empty. A wedged repo pays the restore read's
    // timeout before the refusal surfaces — rollback outranks latency
    // here, and a killed restore read rethrows rather than letting the
    // original error surface un-rolled-back.
    await restoreLocalUpstreamBackups(cwd, pointed, name, env);
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
        // A sectionless upstream VALUE (`.`, a URL, a path, a scp-like
        // `host:path`) is admitted by the lenient name predicate, and a
        // repo whose branch tracks such a value holds LIVE config a
        // value-matched sweep would destroy over a 404. The skip trades
        // away one residual: git accepts a colon-bearing (or `.`/`/`-
        // shaped) SECTION name too, so a hand-made sectionless-named
        // remote whose first-attempt cleanup died mid-sweep converges
        // nothing on retry — accepted because the two states
        // (never-sectioned live upstream vs orphaned-by-failed-removal)
        // are indistinguishable once the section is gone, and sweeping
        // risks the live one.
        // Pure string test, ahead of the scope read: no spawn for a
        // name git resolves without a section.
        !isSectionlessUpstream(name) &&
        (await remoteSectionScopes(cwd, name, env)).size === 0 &&
        // Bare words are distinguishable post-hoc: a name git still
        // RESOLVES without any config section (an insteadOf alias —
        // probed to fail no-such-remote with nothing touched) is a live
        // upstream too — the sweep must not run over git's 404. (A legacy
        // `$GIT_DIR/remotes|branches` file resolves the same probe but
        // never reaches this arm: git's own rm fails it with "Could not
        // remove config section".) Fail-closed: a blind resolver read
        // throws rather than sweeping.
        !(await remoteStillResolves(cwd, name, env)) &&
        // A bare word naming a DIRECTORY repo inside the worktree is a
        // live local-path upstream (git resolves the path transport),
        // which the resolver never sees — `--get-url` echoes the name
        // verbatim without consulting the filesystem (probed). Probe
        // the path before sweeping.
        !(await bareWordResolvesAsRepoPath(cwd, name, env)) &&
        // A `url.<base>.pushInsteadOf = <prefix>` alias keeps a bare
        // name resolving PUSH-side (the `gh:` pattern) while nothing
        // fetch-side answers it — no resolver probe can see it (git has
        // no push-side equivalent), so the dump itself answers. A
        // prefix over-match skips the sweep: the safe polarity.
        !(await pushInsteadOfAliases(cwd, env)).some((alias) =>
          name.startsWith(alias),
        )
      ) {
        // The section is already gone — an earlier attempt died after
        // removing it but before finishing the cleanup, so a retry
        // would otherwise dead-end here. Converge the cleanup (upstream
        // keys AND the orphaned tracking refs a refspec-less removal
        // leaves), then surface git's answer. The bare-ref exclusion: a
        // namespace-less top-level `refs/remotes/<name>` can be live
        // state of a name that was never configured (a remote-HEAD
        // symbolic ref, a flat fetch layout's unslashed branch ref) —
        // sweeping it would destroy it over a 404. Accepted residuals:
        // a FORMERLY configured name's bare-ref residue is orphaned by
        // the exclusion (an earlier attempt removed the section and
        // died mid-cleanup; the two states are indistinguishable once
        // the section is gone, and sweeping risks the live one — same
        // trade as the sectionless-name residual below), and a flat
        // layout's SLASHED branch refs (`refs/remotes/release/1.0`)
        // stay namespace refs of the never-configured prefix, sweepable
        // as before.
        await deleteRemoteTrackingRefs(cwd, name, env, false);
        // Same re-verify the certify path runs: the sweep is
        // best-effort per ref, so a surviving ref (a stale lock) must
        // refuse, not converge to a 404 that abandons the phantom
        // namespace with no remote left to prune it. The bare-ref
        // exclusion applies here too, or the deliberately skipped live
        // ref would read as a survivor and turn the 404 into a 409.
        if ((await remoteTrackingRefs(cwd, name, env, false)).length > 0) {
          throw new Error('remote still configured after removal');
        }
        await unsetUpstreamKeys(cwd, pointed, name, env);
        await sweepSiblingWorktreeKeys(cwd, name, env);
        // Same resolution check as the main path: an inert survivor
        // does not refuse.
        if (await sweptUpstreamResolving(cwd, pointed, name, env)) {
          throw new Error('remote still configured after removal');
        }
      }
      throw removeError;
    }
  }
  // git rm's effective-value match can also delete a LOCAL [branch <b>]
  // section whose shadowed copy named a SURVIVING remote (a
  // worktree-scope record shadowed it): the branch's effective upstream
  // was the removed remote, but the user's local config held a fallback
  // git had no business destroying. Restore those records IMMEDIATELY —
  // above every post-destruction gate, so a later refusal cannot skip
  // the rollback of git's own collateral damage (the restored values
  // name surviving remotes, so no downstream gate or sweep can claim
  // them).
  await restoreLocalUpstreamBackups(cwd, pointed, name, env);
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
  // inherited scope — or one git resolves from OUTSIDE config entirely
  // (a legacy $GIT_DIR/remotes/<name> file, branches/<name>, an
  // insteadOf alias) — but git still resolves it: fetch/push keep
  // reaching the remote the panel just said was removed. Two checks,
  // because each sees a different survivor: the all-scope section read
  // is the backstop for an inherited record the pre-flight could not
  // see (a concurrent inherited edit racing in after its read, or its
  // no-match fall-through), and git's own resolver catches the
  // non-config sources — `ls-remote --get-url` expands the name without
  // contacting the remote and echoes the input verbatim only when
  // nothing answers it.
  if (
    (await remoteSectionScopes(cwd, name, env)).size > 0 ||
    (await remoteStillResolves(cwd, name, env))
  ) {
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
  // Re-verify by RESOLUTION, not presence: an entry that survived the
  // sweep (a lock, an include-held file) refuses only when it still
  // resolves to the removed name — a residue shadowed by a
  // surviving-remote record is inert (the same doctrine the
  // surviving-keys gate follows), and a merge survivor resolves to "."
  // regardless.
  if (await sweptUpstreamResolving(cwd, pointed, name, env)) {
    throw new Error('remote still configured after removal');
  }
  // Linked worktrees each carry their own config.worktree — invisible
  // to every read above, which all run the INVOKING worktree's scope
  // chain. A sibling's key naming the removed remote dangles in the
  // same repository; sweep it the same way.
  await sweepSiblingWorktreeKeys(cwd, name, env);
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

// The pre-removal section refusal, answered from ONE all-scope
// origin-annotated dump:
// - 'inherited': a `remote.<name>.*` record lives OUTSIDE the repository
//   scopes (global/system/unknown/command) WHILE the section also has a
//   repository-scope record. git rm would destroy the local half, the
//   tracking refs and the pointing branches' keys first and the
//   inherited survivor would keep the name resolving — the same refusal
//   gitRemoteAdd runs as a pre-flight, mirrored here ahead of the
//   destruction instead of after it. A section with ONLY inherited
//   records has no repository half to destroy, so it falls through to
//   git's own no-such-remote 404 — the answer the client's stale-row
//   convergence keys on (a phantom row after an out-of-band removal
//   re-reads and clears; a 409 would stick).
// - 'included': a repository-scope record's ORIGIN is a file other than
//   the two a removal can edit — which only an include.path'd file
//   produces (it is scope-labeled `local`, so the scope field cannot
//   tell it apart; only the record origins can).
// The repository-ness ordering comes from the reads below: the config
// dump exits 0 outside a repository (with the inherited config), but
// the `rev-parse` probes inside editableConfigSpellings throw there
// BEFORE any record is inspected, so git's canonical not-a-repository
// answer keeps winning over these refusals (the add path pins the same
// ordering at git-remotes.test.ts:411).
async function remoteSectionRemovalBlock(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<'inherited' | 'included' | null> {
  let raw: string;
  try {
    raw = await runGit(
      cwd,
      ['config', '--list', '--show-origin', '--show-scope', '-z'],
      env,
    );
  } catch (err) {
    if (isNoMatchConfigError(err)) return null;
    stripConfigDump(err);
    throw err;
  }
  const [editable, originBase] = await Promise.all([
    editableConfigSpellings(cwd, env),
    repoTopLevel(cwd, env),
  ]);
  let included = false;
  let inheritedSeen = false;
  let repoRecordSeen = false;
  const prefix = `remote.${name}.`;
  for (const record of iterConfigRecords(raw, true)) {
    const { scope, key, origin } = record;
    if (!key.startsWith(prefix)) continue;
    // Section identity, not prefix: a sibling remote whose name extends
    // this one (`a.b` next to `a`) must not count as a record of `a`.
    const rest = key.slice('remote.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0 || rest.slice(0, dot) !== name) continue;
    if (!REPOSITORY_SCOPES.has(scope)) {
      inheritedSeen = true;
      continue;
    }
    repoRecordSeen = true;
    if (origin === undefined || !origin.startsWith('file:')) {
      included = true;
      continue;
    }
    let editableOrigin = false;
    // Relative origins are printed against the worktree TOPLEVEL (git
    // chdirs during setup), not the passed cwd, which may be a subdir.
    for (const spelling of await pathSpellings(originBase, origin.slice(5))) {
      if (editable.has(spelling)) {
        editableOrigin = true;
        break;
      }
    }
    if (!editableOrigin) included = true;
  }
  // The inherited refusal protects the DESTRUCTION case — a repository
  // half existing to be destroyed. Nothing repository-scoped means
  // nothing to destroy: fall through to git's own no-such-remote.
  if (repoRecordSeen && inheritedSeen) return 'inherited';
  return included ? 'included' : null;
}

// Whether git still RESOLVES the name after the section is gone — the
// certification the config-record checks cannot give: a legacy
// $GIT_DIR/remotes/<name> file (a tarball-era or hand-made clone) keeps
// the remote fetchable with no config record at all. `--get-url` is
// documented not to contact the remote. Fail-closed on any failure —
// a blind read is not a negative answer.
async function remoteStillResolves(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['ls-remote', '--get-url', '--', name], env);
    // git echoes an unanswered name VERBATIM plus exactly one trailing
    // LF — strip only that terminator: a config-held name may itself
    // carry edge whitespace (or a trailing CR), which the lenient
    // removal predicate admits.
    return (out.endsWith('\n') ? out.slice(0, -1) : out) !== name;
  } catch (err) {
    stripConfigDump(err);
    throw err;
  }
}

// Whether a bare-word name resolves as a local transport upstream (a
// same-named directory repo or bundle file): git's `ls-remote --get-url`
// resolver never consults the filesystem, so the path leg needs its own
// answer — asked of git itself, not re-implemented. The converge arm
// asks this for the removed NAME; the unmask gate asks it for upstream
// VALUES (configured upstreams the snapshot proves were in force — not
// a coincidental directory). The name-keyed certification gate must NOT
// ask it (a coincidental same-named directory must not make a
// configured remote unremovable). Fail-closed like the resolver's: a
// kill rethrows; a non-repository answer is simply false.
async function bareWordResolvesAsRepoPath(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  // git's own transport answers: a same-named directory repo OR a
  // bundle file at the worktree toplevel (setup chdirs there, so the
  // base needs no derivation — probed from a subdirectory cwd). A
  // `--resolve-git-dir` model misses bundles (git sniffs the bundle
  // magic, extension-independent) and needs the base by hand. No
  // `--exit-code`: a ref-less repo exits 2 and would read as
  // unresolved. Only bare words reach this probe and insteadOf aliases
  // are answered by the resolver probes ahead of it, so no network.
  // Fail-closed: a kill rethrows stripped; any other failure is false.
  try {
    await runGit(cwd, ['ls-remote', '--', name], env);
    return true;
  } catch (err) {
    if (isKillError(err)) {
      stripConfigDump(err);
      throw err;
    }
    return false;
  }
}

// The `url.*.pushInsteadOf` alias VALUES (the prefixes users type —
// the `gh:` pattern) from the all-scope dump. Push-side aliasing is
// invisible to every resolver probe: `ls-remote --get-url` is
// fetch-side only and git has no push-side `--get-url` (probed:
// `ls-remote --push` exits 129), so the config record is the only
// answer. Fail-closed: a read failure throws rather than answering
// "no aliases".
async function pushInsteadOfAliases(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await runGit(cwd, ['config', '--list', '--show-scope', '-z'], env);
  } catch (err) {
    stripConfigDump(err);
    throw err;
  }
  const out: string[] = [];
  for (const record of iterConfigRecords(raw)) {
    // An empty value would prefix-match EVERY name (`startsWith('')`),
    // making the converge arm unreachable and the unmask push arms
    // never-refusing — the opposite of both gates' polarity.
    if (
      record.value &&
      record.key.startsWith('url.') &&
      record.key.endsWith('.pushinsteadof')
    ) {
      out.push(record.value);
    }
  }
  return out;
}

// Whether git RESOLVES a bare-word upstream value — the unmask gate's
// question, which "some `remote.<value>.*` record exists" answers wrong
// in both polarities: a URL-less section (a bare `[remote "foo"] proxy =
// …`) puts the name in the record set while resolving NOTHING, and a
// legacy `$GIT_DIR/remotes/<name>` file resolves with no record at all.
// Only the bare-word class reaches this probe — `.`, URLs and paths
// short-circuit through isSectionlessUpstream first. Fail-closed toward
// refusal: a read that cannot answer (other than a kill, which
// propagates) counts as unresolved.
async function remoteNameResolves(
  cwd: string,
  value: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['ls-remote', '--get-url', '--', value], env);
    // Same echo rule as remoteStillResolves: the unanswered name comes
    // back verbatim plus exactly one trailing LF.
    return (out.endsWith('\n') ? out.slice(0, -1) : out) !== value;
  } catch (err) {
    if (isKillError(err)) {
      stripConfigDump(err);
      throw err;
    }
    return false;
  }
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
  // Per-pointed-branch LOCAL-scope upstream records (value lists). git
  // rm's effective-value match deletes the whole local [branch <b>]
  // section even when the shadowed local copy named a SURVIVING remote
  // — restoring that copy needs its pre-removal values.
  localBackup: Map<
    string,
    { remote?: string[]; merge?: string[]; pushremote?: string[] }
  >;
  // The local-scope `remote.pushDefault` value list: git rm's
  // handle_push_default writes the common config when the EFFECTIVE
  // value matched, destroying a shadowed local copy naming a survivor.
  pushDefaultBackup: string[] | undefined;
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
  const local = new Map<string, string[]>();
  const worktree = new Map<string, string[]>();
  let pushDefault: string | undefined;
  let pushDefaultBackup: string[] | undefined;
  const collect = (m: Map<string, string[]>, key: string, value: string) => {
    const list = m.get(key) ?? [];
    list.push(value);
    m.set(key, list);
  };
  for (const record of iterConfigRecords(raw)) {
    const { scope, key, value } = record;
    // The dump is in scope order: the last record wins, every scope
    // included — the way `git push` resolves the default.
    if (key === 'remote.pushdefault') {
      pushDefault = value;
      if (scope === 'local') {
        pushDefaultBackup = pushDefaultBackup ?? [];
        pushDefaultBackup.push(value);
      }
    }
    if (scope !== 'local' && scope !== 'worktree') continue;
    if (!key.startsWith('branch.')) continue;
    const rest = key.slice('branch.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) continue;
    const sub = rest.slice(dot + 1);
    if (sub !== 'remote' && sub !== 'pushremote' && sub !== 'merge') continue;
    collect(
      scope === 'worktree' ? worktree : local,
      `${rest.slice(0, dot)}.${sub}`,
      value,
    );
  }
  const pointed: PointingBranches = {
    fetch: new Set(),
    push: new Set(),
    pushDefault,
    localBackup: new Map(),
    pushDefaultBackup,
  };
  const lastOf = (m: Map<string, string[]>, key: string) => m.get(key)?.at(-1);
  for (const key2 of new Set([...local.keys(), ...worktree.keys()])) {
    if (key2.endsWith('.merge')) continue;
    // The last value per scope wins, then worktree beats local.
    if ((lastOf(worktree, key2) ?? lastOf(local, key2)) !== name) continue;
    const branch = key2.slice(0, key2.lastIndexOf('.'));
    (key2.endsWith('.remote') ? pointed.fetch : pointed.push).add(branch);
    const backup: {
      remote?: string[];
      merge?: string[];
      pushremote?: string[];
    } = {};
    for (const sub of ['remote', 'merge', 'pushremote'] as const) {
      const values = local.get(`${branch}.${sub}`);
      if (values !== undefined) backup[sub] = values;
    }
    pointed.localBackup.set(branch, backup);
  }
  return pointed;
}

// The upstream keys to clear for the pre-removal snapshot, across the
// repository's OWN editable scopes (local + worktree): git's rm unsets
// them only in the file it can write and SKIPS multi-valued keys with a
// warning — so keys held in config.worktree, and multi-valued local
// keys, survive every removal into a dangling `branch.<b>.remote =
// <gone>`. Fetch-pointed branches lose their remote (by value), their
// merge (only when the same scope's remote key holds no entry naming a
// SURVIVING remote — otherwise the branch keeps its upstream and the
// merge half stays), and their pushRemote (by value); push-pointed
// branches lose only their pushRemote (by value) — their merge key
// belongs to the surviving fetch upstream. Plus a `remote.pushDefault`
// with an entry naming the removed remote (value-matched like the rest —
// git's rm skips a multi-valued pushDefault with a warning too). And
// independently of the snapshot:
// ANY branch.<b>.remote/pushRemote entry value-matched to the removed
// remote goes — a multi-valued key's non-effective entry is residue
// whose later surfacing would dangle. A key with SEVERAL values
// contributes only the matching entries (--fixed-value).
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
  const seen = new Set<string>();
  const pushKey = (key: UpstreamKey): void => {
    // Escaped, not a literal byte: a raw NUL in the source makes grep
    // and ripgrep treat the whole module as binary.
    const id = `${key.scope}\u0000${key.key}`;
    if (!seen.has(id)) {
      seen.add(id);
      keys.push(key);
    }
  };
  for (const [scope, byKey] of byScope) {
    for (const branch of pointed.fetch) {
      if ((byKey.get(`branch.${branch}.remote`) ?? []).includes(name)) {
        pushKey({ scope, key: `branch.${branch}.remote`, fixedValue: name });
      }
      // The merge key pairs with the branch's remote key in the same
      // scope: sweep it only when that key has no entry naming a
      // SURVIVING remote — otherwise the branch still has its upstream
      // here and the merge half must stay. A scope with no remote key
      // at all is sweepable (the worktree-merge/local-remote shape).
      const remoteValues = byKey.get(`branch.${branch}.remote`);
      if (
        (remoteValues === undefined ||
          remoteValues.every((value) => value === name)) &&
        byKey.has(`branch.${branch}.merge`)
      ) {
        pushKey({ scope, key: `branch.${branch}.merge` });
      }
      if ((byKey.get(`branch.${branch}.pushremote`) ?? []).includes(name)) {
        pushKey({
          scope,
          key: `branch.${branch}.pushremote`,
          fixedValue: name,
        });
      }
    }
    for (const branch of pointed.push) {
      if ((byKey.get(`branch.${branch}.pushremote`) ?? []).includes(name)) {
        pushKey({
          scope,
          key: `branch.${branch}.pushremote`,
          fixedValue: name,
        });
      }
    }
    if ((byKey.get('remote.pushdefault') ?? []).includes(name)) {
      pushKey({ scope, key: 'remote.pushdefault', fixedValue: name });
    }
    // A multi-valued key's non-effective entry naming the removed remote
    // is residue even when the branch's EFFECTIVE upstream is a surviving
    // remote — sweep by value, independent of the pointed snapshot.
    for (const [key, values] of byKey) {
      if (!key.startsWith('branch.')) continue;
      const rest = key.slice('branch.'.length);
      const dot = rest.lastIndexOf('.');
      if (dot <= 0) continue;
      const sub = rest.slice(dot + 1);
      if (sub !== 'remote' && sub !== 'pushremote') continue;
      if (values.includes(name)) {
        pushKey({ scope, key, fixedValue: name });
      }
    }
  }
  return keys;
}

// The remote-tracking refs OWNED by the removed name. A ref under
// refs/remotes/ belongs to the remote whose name is its LONGEST prefix
// at a '/' boundary — `refs/remotes/a/b/main` is remote `a/b`'s, not
// `a`'s — so a string-prefix sweep would destroy a configured slashed
// sibling's refs. The exact ref `refs/remotes/<name>` (a
// single-destination fetch leaves it) is the remote's own ON THE
// CERTIFY PATH; the no-such-remote converge arm excludes it from the
// RESULT (includeBareRef false): there a namespace-less top-level ref
// can be live state (a remote-HEAD symbolic ref, a flat fetch layout's
// `refs/remotes/main`), not rm residue. The exclusion never touches the
// longest-prefix RESOLUTION — a bare ref exactly owned by a configured
// slashed sibling must keep that owner, or it falls through to the
// shorter prefix and is swept over a 404.
// Ownership resolves against the configured set PLUS the removed name:
// at sweep time the section is gone, but its namespace is still being
// swept.
async function remoteTrackingRefs(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
  includeBareRef = true,
): Promise<string[]> {
  let refsRaw: string;
  let namesRaw: string;
  try {
    [refsRaw, namesRaw] = await Promise.all([
      runGit(
        cwd,
        ['for-each-ref', '--format=%(refname)', 'refs/remotes/'],
        env,
      ),
      runGit(cwd, ['remote'], env),
    ]);
  } catch (err) {
    // for-each-ref exits 0 on empty, so any failure here must abort,
    // not read as "no refs" — the caller's verification is fail-closed.
    stripConfigDump(err);
    throw err;
  }
  const owners = [...namesRaw.split('\n').filter(Boolean), name];
  return refsRaw
    .split('\n')
    .filter((ref) => ref !== '')
    .filter((ref) => {
      if (owningRemote(ref, owners) !== name) return false;
      // The converge arm excludes the removed name's own namespace-less
      // top-level ref (live state for a never-configured name), but the
      // ownership resolution above must stay WHOLE: suppressing the
      // bare-ref candidate inside it would let a bare ref exactly owned
      // by a CONFIGURED slashed sibling (`refs/remotes/a/b` is remote
      // `a/b`'s) fall through to the shorter prefix and be swept over
      // a 404.
      return includeBareRef || ref !== `refs/remotes/${name}`;
    });
}

function owningRemote(ref: string, names: string[]): string | undefined {
  let best: string | undefined;
  for (const n of names) {
    const prefix = `refs/remotes/${n}`;
    if (ref !== prefix && !ref.startsWith(`${prefix}/`)) continue;
    if (best === undefined || n.length > best.length) best = n;
  }
  return best;
}

// Delete every remote-tracking ref OWNED by the removed name (see
// remoteTrackingRefs for the ownership rule), best-effort per ref: the
// caller's re-verification decides whether a survivor certifies or
// refuses.
async function deleteRemoteTrackingRefs(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
  includeBareRef = true,
): Promise<void> {
  for (const ref of await remoteTrackingRefs(cwd, name, env, includeBareRef)) {
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

// The config records of one worktree's config.worktree file, read from
// that worktree (`--worktree` alone reads exactly that scope when
// extensions.worktreeConfig is on).
async function worktreeScopeRecords(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<Map<string, string[]>> {
  let raw: string;
  try {
    raw = await runGit(cwd, ['config', '--worktree', '--list', '-z'], env);
  } catch (err) {
    // extensions.worktreeConfig on but no config.worktree file yet: the
    // worktree scope is empty. git reports that as a missing-file fatal;
    // anything else (a kill, a parse failure) is not a negative answer.
    const detail =
      err && typeof err === 'object'
        ? String(
            (err as { stderr?: unknown }).stderr ??
              (err as { message?: unknown }).message ??
              '',
          )
        : '';
    // Without extensions.worktreeConfig there IS no worktree scope to
    // read: git refuses the selector outright.
    if (
      /unable to read config file.*No such file/s.test(detail) ||
      /--worktree cannot be used/s.test(detail)
    ) {
      return new Map();
    }
    stripConfigDump(err);
    throw err;
  }
  const byKey = new Map<string, string[]>();
  for (const entry of raw.split('\0')) {
    if (entry === '') continue;
    const newline = entry.indexOf('\n');
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? '' : entry.slice(newline + 1);
    const list = byKey.get(key) ?? [];
    list.push(value);
    byKey.set(key, list);
  }
  return byKey;
}

// Sweep the upstream keys naming the removed remote from every LINKED
// worktree's config.worktree: the invoking worktree's reads never see
// those files, so a sibling's key would dangle in the same repository.
// Fail-closed per worktree: a killed or failed read/write refuses the
// certification rather than silently skipping a sibling.
async function sweepSiblingWorktreeKeys(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  let listed: string;
  try {
    listed = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'], env);
  } catch (err) {
    stripConfigDump(err);
    throw err;
  }
  let topSpellings: Set<string> | undefined;
  // `-z` terminates every FIELD (record separator = an empty field), so
  // a path carrying a literal newline stays intact.
  const records: string[][] = [];
  let lines: string[] = [];
  for (const field of listed.split('\0')) {
    if (field === '') {
      if (lines.length > 0) records.push(lines);
      lines = [];
    } else {
      lines.push(field);
    }
  }
  if (lines.length > 0) records.push(lines);
  for (const record of records) {
    const first = record[0] ?? '';
    if (!first.startsWith('worktree ')) continue;
    const wt = first.slice('worktree '.length);
    // A `prunable` record's directory is gone (deleted out of band): no
    // git process can run from it, and `git worktree prune` deletes its
    // admin dir. Skipping is not the fail-closed exemption — nothing is
    // readable there.
    if (
      record.some((line) => line === 'prunable' || line.startsWith('prunable '))
    )
      continue;
    // The invoking worktree is already swept by the main path. The
    // toplevel read is lazy: no siblings, no extra spawn.
    if (topSpellings === undefined) {
      topSpellings = await pathSpellings(cwd, await repoTopLevel(cwd, env));
    }
    const wtSpellings = await pathSpellings(cwd, wt);
    if ([...wtSpellings].some((spelling) => topSpellings!.has(spelling))) {
      continue;
    }
    let byKey: Map<string, string[]>;
    try {
      byKey = await worktreeScopeRecords(wt, env);
    } catch (err) {
      stripConfigDump(err);
      throw err;
    }
    // A remote.<name>.* record here is the sibling's own per-worktree
    // section override — the name still resolves for that worktree once
    // the shared section goes. Deliberate per-worktree state: refuse,
    // mirroring the include-held doctrine.
    for (const key of byKey.keys()) {
      if (!key.startsWith(`remote.${name}.`)) continue;
      // Section identity, not prefix: a sibling remote whose name
      // EXTENDS this one (`a.b` next to `a`) is not an override of `a`.
      const rest = key.slice('remote.'.length);
      const dot = rest.lastIndexOf('.');
      if (dot > 0 && rest.slice(0, dot) === name) {
        throw new Error('remote still configured after removal');
      }
    }
    const keys: string[] = [];
    for (const [key, values] of byKey) {
      if (key === 'remote.pushdefault') {
        if (values.includes(name)) keys.push(key);
        continue;
      }
      if (!key.startsWith('branch.')) continue;
      const rest = key.slice('branch.'.length);
      const dot = rest.lastIndexOf('.');
      if (dot <= 0) continue;
      const sub = rest.slice(dot + 1);
      if (sub === 'remote' || sub === 'pushremote') {
        if (values.includes(name)) keys.push(key);
      } else if (sub === 'merge') {
        // The merge key pairs with the branch's remote key in the same
        // file: sweep it only when that remote key is being value-swept
        // here AND holds no entry naming a surviving remote (a
        // multi-valued key keeps the branch's upstream — the merge half
        // stays, mirroring the main path). A merge whose remote lives
        // in the shared config is not this file's to decide.
        const remoteValues = byKey.get(`branch.${rest.slice(0, dot)}.remote`);
        if (
          remoteValues !== undefined &&
          remoteValues.includes(name) &&
          remoteValues.every((value) => value === name)
        ) {
          keys.push(key);
        }
      }
    }
    for (const key of keys) {
      const isMerge = key.endsWith('.merge');
      const args = isMerge
        ? ['config', '--worktree', '--unset-all', key]
        : ['config', '--worktree', '--fixed-value', '--unset-all', key, name];
      try {
        await runGit(wt, args, env);
      } catch {
        // re-verified just below
      }
    }
    // Re-verify: a key that survived (a killed unset, a concurrent
    // re-add) must refuse rather than be certified cleaned. Only the
    // swept shapes count — an unrelated branch subkey that happens to
    // carry the name (a description, say) is not the sweep's business.
    const after = await worktreeScopeRecords(wt, env);
    for (const [key, values] of after) {
      if (key === 'remote.pushdefault' && values.includes(name)) {
        throw new Error('remote still configured after removal');
      }
      if (
        key.startsWith('branch.') &&
        (key.endsWith('.remote') || key.endsWith('.pushremote')) &&
        values.includes(name)
      ) {
        throw new Error('remote still configured after removal');
      }
    }
  }
}

// The local-scope values of one branch key, [] when unset (exit 1 with
// no output). A kill is not an answer. Read with includes ON: the
// snapshot these presence checks are weighed against captured the
// config dump's `local`-labeled records, and git labels an
// include.path'd file's records `local` too — a bare `--local` (includes
// off) would read an include-held survivor as absent and re-add it to
// .git/config, duplicating the key and permanently shadowing the
// include (a `--add` appends at EOF, past the include directive, and
// wins last-value resolution).
async function localBranchKeyValues(
  cwd: string,
  key: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  try {
    const out = await runGit(
      cwd,
      ['config', '--local', '--includes', '--get-all', key],
      env,
    );
    return out.split('\n').filter((line) => line !== '');
  } catch (err) {
    if (isNoMatchConfigError(err)) return [];
    stripConfigDump(err);
    throw err;
  }
}

// Restore the local-scope upstream records git's rm destroyed through
// its effective-value match: a pointed branch whose LOCAL copy named a
// SURVIVING remote (shadowed by a worktree-scope record) loses the whole
// [branch <b>] section. Only absent keys are rewritten — a surviving
// key (a multi-valued one git skipped, swept by value above) or an
// include-held one (the presence check reads with includes on) is never
// duplicated. Fail-closed: a restore that cannot run refuses the
// certification rather than leaving the branch silently untracked.
async function restoreLocalUpstreamBackups(
  cwd: string,
  pointed: PointingBranches,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  for (const [branch, backup] of pointed.localBackup) {
    const remoteNow = await localBranchKeyValues(
      cwd,
      `branch.${branch}.remote`,
      env,
    );
    const remoteRestore = (backup.remote ?? []).filter((v) => v !== name);
    const remoteRestored = remoteNow.length === 0 && remoteRestore.length > 0;
    if (remoteRestored) {
      for (const value of remoteRestore) {
        await runGit(
          cwd,
          ['config', '--local', '--add', `branch.${branch}.remote`, value],
          env,
        );
      }
    }
    // The merge key pairs with the branch's upstream — restore it when
    // the remote was restored here OR survived (a multi-valued remote
    // key git's rm skips while still deleting the merge).
    if (remoteRestored || remoteNow.length > 0) {
      const mergeNow = await localBranchKeyValues(
        cwd,
        `branch.${branch}.merge`,
        env,
      );
      if (mergeNow.length === 0) {
        for (const value of backup.merge ?? []) {
          await runGit(
            cwd,
            ['config', '--local', '--add', `branch.${branch}.merge`, value],
            env,
          );
        }
      }
    }
    const pushNow = await localBranchKeyValues(
      cwd,
      `branch.${branch}.pushremote`,
      env,
    );
    const pushRestore = (backup.pushremote ?? []).filter((v) => v !== name);
    if (pushNow.length === 0 && pushRestore.length > 0) {
      for (const value of pushRestore) {
        await runGit(
          cwd,
          ['config', '--local', '--add', `branch.${branch}.pushremote`, value],
          env,
        );
      }
    }
  }
  // git rm's handle_push_default writes the common config when the
  // EFFECTIVE pushDefault matched — a shadowed local copy naming a
  // survivor goes with it. Restore the non-name values.
  const pdRestore = (pointed.pushDefaultBackup ?? []).filter((v) => v !== name);
  if (pdRestore.length > 0) {
    const pdNow = await localBranchKeyValues(cwd, 'remote.pushdefault', env);
    if (pdNow.length === 0) {
      for (const value of pdRestore) {
        await runGit(
          cwd,
          ['config', '--local', '--add', 'remote.pushdefault', value],
          env,
        );
      }
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
  // Sections carrying a pushurl record: a pushurl-ONLY section resolves
  // PUSH-side (git push reaches it) while the fetch-side resolver probe
  // echoes the bare name — the push-side unmask arms must count it as
  // resolving. (The fetch arm stays resolver-only: a pushurl-only
  // upstream is genuinely fetch-dangling.)
  const pushurlSections = new Set<string>();
  // Push-side alias prefixes (`url.*.pushInsteadOf`): a value they
  // prefix-match resolves push-side while nothing fetch-side answers
  // it — count it as live, the same polarity as pushurlSections.
  const pushAliases: string[] = [];
  for (const record of iterConfigRecords(raw)) {
    lastValue.set(record.key, record.value);
    if (
      record.value &&
      record.key.startsWith('url.') &&
      record.key.endsWith('.pushinsteadof')
    ) {
      pushAliases.push(record.value);
      continue;
    }
    if (!record.key.startsWith('remote.')) continue;
    if (!record.key.endsWith('.pushurl')) continue;
    const rest = record.key.slice('remote.'.length, -'.pushurl'.length);
    if (rest.length > 0) pushurlSections.add(rest);
  }
  const pushAliasMatches = (value: string) =>
    pushAliases.some((alias) => value.startsWith(alias));
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
      !(await remoteNameResolves(cwd, value, env)) &&
      !(await bareWordResolvesAsRepoPath(cwd, value, env))
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
      !pushurlSections.has(value) &&
      !pushAliasMatches(value) &&
      !(await remoteNameResolves(cwd, value, env)) &&
      !(await bareWordResolvesAsRepoPath(cwd, value, env))
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
      !pushurlSections.has(value) &&
      !pushAliasMatches(value) &&
      !(await remoteNameResolves(cwd, value, env)) &&
      !(await bareWordResolvesAsRepoPath(cwd, value, env))
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
// is a valid upstream, not a dangling remote name. Only these shapes
// skip the resolution probe — a bare word is the one remaining class,
// and git's own resolver answers it (a URL-less section resolves
// nothing; a legacy remotes/ file resolves with no section at all).
function isSectionlessUpstream(value: string): boolean {
  return (
    value === '.' ||
    value.includes(':') ||
    value.includes('/') ||
    // Windows path spellings are sectionless values on win32 the same
    // way `/`-bearing ones are on POSIX (git normalizes backslashes);
    // on POSIX a backslash is an ordinary name character.
    (process.platform === 'win32' &&
      (value.includes('\\') || /^[A-Za-z]:[\\/]/.test(value)))
  );
}

// Whether any upstream key still RESOLVES to the removed name after the
// sweep — the re-verify's question. Presence is not the question: an
// entry the sweep could not edit (an include-held file) that is
// SHADOWED by a surviving-remote record is inert, exactly the
// shadowed-survivor doctrine the surviving-keys gate states.
async function sweptUpstreamResolving(
  cwd: string,
  pointed: PointingBranches,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await runGit(cwd, ['config', '--list', '--show-scope', '-z'], env);
  } catch (err) {
    stripConfigDump(err);
    throw err;
  }
  const lastValue = new Map<string, string>();
  for (const record of iterConfigRecords(raw)) {
    lastValue.set(record.key, record.value);
  }
  for (const branch of pointed.fetch) {
    if (lastValue.get(`branch.${branch}.remote`) === name) return true;
  }
  for (const branch of pointed.push) {
    if (lastValue.get(`branch.${branch}.pushremote`) === name) return true;
  }
  return lastValue.get('remote.pushdefault') === name;
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
