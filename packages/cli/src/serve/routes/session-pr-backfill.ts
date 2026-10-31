/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Application, RequestHandler } from 'express';
import {
  SESSION_PR_LIST_LIMIT,
  canonicalSessionPrUrl,
  fetchAttributionRepoKeys,
  fetchGitHubPullRequests,
  fetchRemoteWebUrl,
  isValidSessionPrUrl,
  readSessionPrs,
  readWorktreeSession,
  replaceSessionPrs,
  repoKeyFromWebUrl,
  sessionPrSourceAuthority,
  toSessionPrInfo,
  type SessionArchiveState,
  type SessionPr,
  type SessionPrSource,
} from '@qwen-code/qwen-code-core';
import {
  hostsEquivalent,
  normalizeSegment,
} from '../../commands/review/lib/remote-match.js';
import type { SendBridgeError } from '../server/error-response.js';
import {
  AONE_MAX_MR_VIEW_CALLS_PER_RUN,
  defaultAoneMrBackend,
  isAoneDetailUrlForRepo,
  resolveAoneWorkspaceRepo,
  type AoneMrBackend,
} from '../server/aone-mrs.js';
import { DaemonDrainingError } from '../server/session-archive.js';
import { invalidateWorkspaceSessionListCache } from '../server/session-list.js';
import type { SessionPrArchiveLane } from '../server/session-pr-refresh.js';
import { isValidSessionId } from '../../config/session-id.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import {
  WorkspaceGenerationClosedError,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';

export interface SessionPrBackfillOptions {
  /**
   * Serialises each session's sidecar commit with archive/delete of that
   * session (see {@link SessionPrArchiveLane}). The daemon always passes the
   * app-wide coordinator; only tests omit it.
   */
  archiveCoordinator?: SessionPrArchiveLane;
  /**
   * The a1 read backend for Aone workspaces. Tests substitute fakes; the
   * daemon uses {@link defaultAoneMrBackend}.
   */
  aoneBackend?: AoneMrBackend;
  /**
   * A `/review` or `/verify-pr` command from a prompt the daemon has just
   * admitted. Its mentions are bound directly instead of being discovered by
   * the transcript scan: the live turn's user record may not be on disk yet,
   * and the badge must not wait for a later sweep. When set, no other session
   * is scanned.
   */
  liveCommand?: { sessionId: string; rawCommand: string };
}

// `--worktree=#<N>` launches persist slug `pr-<N>` with branch
// `worktree-pr-<N>` (see worktreeStartup / worktreeBranchForSlug); the
// sidecars survive restarts, so they are the zero-network backfill source.
// `[1-9]` mirrors parsePRReference's n > 0 invariant: `pr-0` is a legal
// user-chosen slug but PR 0 does not exist, and a persisted number 0 poisons
// the whole sidecar read; leading zeros stay out for unambiguous round-trips.
const SLUG_PR_PATTERN = /^pr-([1-9]\d{0,8})$/;
const BRANCH_PR_PATTERN = /^worktree-pr-([1-9]\d{0,8})$/;

/**
 * Extracts the PR number a worktree sidecar's slug/branch convention names.
 * The slug wins: a custom-renamed branch under a `pr-<N>` slug still refers
 * to PR N, while a custom slug keeps a conventional branch matchable.
 */
export function parsePrNumberFromWorktree(
  slug?: string,
  branch?: string,
): number | undefined {
  const slugMatch = SLUG_PR_PATTERN.exec(slug ?? '');
  if (slugMatch) return Number(slugMatch[1]);
  const branchMatch = BRANCH_PR_PATTERN.exec(branch ?? '');
  if (branchMatch) return Number(branchMatch[1]);
  return undefined;
}

export interface SessionPrBackfillWorkspaceResult {
  workspaceCwd: string;
  /** Persisted sessions scanned (active + archived). */
  scanned: number;
  /** New PR bindings written by this run (a session may bind several). */
  bound: number;
  /** Sidecar writes persisted, including eviction-only rewrites. */
  written: number;
  /** Resolved bindings that already existed in the sidecar. */
  alreadyBound: number;
  /** Resolved numbers skipped because they exceed the sidecar cap. */
  overLimit: number;
  /**
   * Planned numbers whose URL could not be resolved this run. On GitHub a
   * number with no gh page entry, no `/review <url>` form and no
   * resolvable remote; on Aone any planned number, since every URL comes
   * from a capped `mr view` and can fail or lose the view-budget race.
   */
  unresolved: number;
  /**
   * Numbers (or url forms) a `/verify-pr` claim named for ANOTHER
   * repository, so the binding was declined by the `--repo` gate rather
   * than failing to resolve. A zero `bound` count with this above zero is a
   * policy decline, not a degraded run — without it the two are
   * indistinguishable in the result.
   */
  repoDeclined?: number;
  /**
   * GitHub only: whether the workspace's `gh pr list` succeeded. False
   * means URL/state resolution degraded to the `/review <url>` forms and
   * the remote-web-URL fallback, so a zero `bound` count is a degraded
   * run, not an empty one.
   */
  ghAvailable?: boolean;
  /** The detected PR platform for this workspace's origin. */
  platform?: 'github' | 'aone';
  /** Sidecar writes that failed; the affected session keeps its bindings. */
  writeErrors?: number;
  error?: string;
}

interface BackfillCandidate {
  sessionId: string;
  archiveState: SessionArchiveState;
  /** Transcript path, used to never resurrect a removed session's sidecar. */
  transcriptPath: string;
  /** PR number named by the worktree slug/branch convention, if any. */
  conventionNumber: number | undefined;
  /**
   * Numbers named by the session's `/review` and `/verify-pr` commands in
   * TRANSCRIPT ORDER (first mention wins, bare and url forms interleaved as
   * typed): the cap trim tie-breaks same-rank plan members by plan position
   * as an age proxy, so appending one form after the other would evict the
   * wrong (younger) review. `bare` is true when ANY mention was bare or
   * `#N` — those name one repo's PR N: this workspace's, unless the mention
   * carries `/verify-pr`'s `--repo` qualifier.
   */
  mentions: readonly CommandMention[];
  /** URL forms, repo-gated once the page key is known. */
  urlForms: ReadonlyArray<{ number: number; url: string }>;
}

/** One PR number a prompt command names. */
interface CommandMention {
  number: number;
  bare: boolean;
  /**
   * Every `[HOST/]OWNER/REPO` spelling a `/verify-pr` claim on this number
   * carried: the number names THAT repo's PR, not this workspace's. Absent
   * means this workspace's, the only reading `/review` has. Kept as a list —
   * not the first spelling alone — so a later claim on this workspace's own
   * repository binds after an earlier one named another.
   */
  repoForms?: readonly string[];
}

// `/review 9584`, `/review #9584`, `/review https://…/pull/9584 …` and the
// same forms after `/verify-pr`, read only at COMMAND position — the very
// start of the prompt the user typed. User records lead with that prompt;
// @-imported file content is appended as later text parts, and shipped docs
// contain line-leading `/review N` examples, so nothing after the first part
// may seed a binding. `[ \t]+` (not `\s+`) keeps the number on the command's
// own line and isolates the command token — `/review-skill …` and
// `/verify-pr-watch …` are other commands and must not forge a binding. The
// bare-number alternative closes its token against filename characters
// (`(?!\w)`-class): `/review <file-path>` is another documented invocation
// form, so `/review 001_init.sql` must not forge PR 1. A glued `--flag` is
// the one exception: users type `/verify-pr 15979--publish` without the
// space and the skill still runs, so the badge must bind too. The exception
// admits only a FLAG-SHAPED tail — `--`, a letter-led name of word/dash
// characters, an optional `=value`, then whitespace or end — so a single
// `-` (date-style `2026-08-25-notes.md`) and double-dash file names
// (`42--diff.patch`, `2026--08-25-notes.md`), digit tails (`42--45`) and a
// lone `--` all stay rejected. parsePrCommand grants the tolerance to
// /verify-pr only: /review also accepts extension-less file paths
// (`42--notes`), which no tail grammar can tell from a flag. The URL
// alternative keeps `(?!\d)`: it rejects 10+-digit numbers instead of
// truncating them to a 9-digit prefix.
// The bare-number alternative comes first: `/review 42 and fix #7` names 42.
// Bare session git branches are NOT a source: they bind the workspace's
// current branch PR onto every session — measured pure noise, removed with
// cleanup.
const PR_COMMAND_PATTERN =
  /^\s*\/(review|verify-pr)(?:[ \t]+#?(\d{1,9})(?![\w./]|-(?!-[A-Za-z][\w-]*(?:=[^\s]*)?(?=[ \t\r\n]|$)))|[ \t]+[^\n"\\]*?(https?:\/\/[A-Za-z0-9][^\s"'<>)]*\/pull\/(\d{1,9})(?!\d)))/;

// `/verify-pr --repo <owner>/<repo>` scopes the number to another repository;
// a bare number beside it must never bind this workspace's same-numbered PR.
// The flag is recognised by its TOKEN, not by whether its value parses: the
// value capture below tolerates quotes, but a URL, an scp form, a
// `host:port`, gh's `-R`, or a value on the next line would otherwise parse
// as no qualifier at all — and an unread qualifier must decline, never fall
// through to this workspace's PR. `--assets-repo` is a different flag of the
// same command and must not count as one. `/review` takes no `--repo`, so a
// stray occurrence in its prompt reads as a qualifier too — the safer
// reading, and never a binding this workspace's number. The glued spelling
// `77--repo` must count as well — otherwise its missing or next-line value
// would read as no qualifier and bind this workspace's PR 77 — but ONLY
// glued to the command's own number: the arm is anchored to the command
// position, because a prose digit (`docs/a1--repo`, a quoted `"77--repo"`,
// even line-final) is not a qualifier and must not decline a legitimate
// bare binding. A right-hand boundary alone cannot tell those apart.
const REPO_FLAG_PATTERN =
  /(?:^|[^-\w])--repo(?![\w-])|^\s*\/(?:review|verify-pr)[ \t]+#?\d{1,9}--repo(?=[ \t\r\n=]|$)|(?:^|[\s])-R[ \t\r\n]*=?[ \t\r\n]*["']?(?:[a-z][a-z0-9+.-]*:\/\/[^\s"']+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?(?![\w./-]))["']?/g;
const REPO_VALUE_PATTERN = /--repo(?:[ \t]*=[ \t]*|[ \t]+)["']?[^\s"']+/g;
const REPO_FORM_PATTERN = /--repo(?:[ \t]*=[ \t]*|[ \t]+)["']?([^\s"']+)/;

/**
 * Longest prompt the grammar scans. The lazy URL alternative in
 * `PR_COMMAND_PATTERN` backtracks quadratically past this size, and the live
 * hook runs the match on the synchronous prefix of every admitted prompt.
 * 16 KiB matches `MID_TURN_MESSAGE_MAX_LENGTH` and leaves room above the
 * 2048-char `SESSION_PR_URL_MAX_LENGTH` for flags.
 */
const PR_COMMAND_MAX_LENGTH = 16 * 1024;

// The URL form names the repo it reviewed; it is repo-gated once gh's page
// key is known (see backfillWorkspaceSessionPrs) rather than here.
function parsePrCommand(prompt: string): {
  mention?: CommandMention;
  urlForm?: { number: number; url: string };
} {
  if (prompt.length > PR_COMMAND_MAX_LENGTH) return {};
  const match = PR_COMMAND_PATTERN.exec(prompt);
  if (!match) return {};
  const bareNumber = match[2];
  if (bareNumber !== undefined) {
    // `\d{1,9}` admits 0; PR 0 does not exist and the sidecar write
    // declines it, so it must never count as a binding.
    if (Number(bareNumber) <= 0) return {};
    // `/review <file-path>` is a documented invocation form, and an
    // extension-less path (`42--notes`) is indistinguishable from a glued
    // flag — so the glued-tail tolerance is /verify-pr's alone, the
    // incident command, which takes no file path. The regex encodes the
    // tail SHAPE; this is the per-command POLICY.
    if (match[1] === 'review' && prompt.charAt(match[0].length) === '-') {
      return {};
    }
    const repoForm = REPO_FORM_PATTERN.exec(prompt)?.[1];
    // The TOKEN decides, not the VALUE: a qualifier this grammar cannot read
    // is still a qualifier, so the number must decline. Comparing the counts
    // keeps the two independent — an unrelated readable `--repo` later in the
    // prompt must not excuse an unreadable one on the command itself — and the
    // empty list keeps the decline countable instead of looking like a prompt
    // that named no PR at all.
    const flagCount = (prompt.match(REPO_FLAG_PATTERN) ?? []).length;
    const valueCount = (prompt.match(REPO_VALUE_PATTERN) ?? []).length;
    if (valueCount < flagCount) {
      return {
        mention: { number: Number(bareNumber), bare: true, repoForms: [] },
      };
    }
    return {
      mention: {
        number: Number(bareNumber),
        bare: true,
        ...(repoForm !== undefined ? { repoForms: [repoForm] } : {}),
      },
    };
  }
  const url = match[3];
  const urlNumber = match[4];
  if (url === undefined || urlNumber === undefined) return {};
  const number = Number(urlNumber);
  return number > 0
    ? { mention: { number, bare: false }, urlForm: { number, url } }
    : {};
}

/** The single-command shape of {@link collectCommandPrNumbers}. */
function liveCommandTargets(prompt: string): {
  mentions: readonly CommandMention[];
  urlForms: ReadonlyArray<{ number: number; url: string }>;
} {
  const parsed = parsePrCommand(prompt);
  return {
    mentions: parsed.mention ? [parsed.mention] : [],
    urlForms: parsed.urlForm ? [parsed.urlForm] : [],
  };
}

// Only the prompt the user typed counts: assistant prose, tool calls, and
// tool results (read_file echoes of fixtures/docs) quote `/review <N>`
// without requesting one, and the parts after the first carry @-imported
// file content whose line-leading examples would forge bindings. The TUI
// expands bundled skills BEFORE recording: the user record's first part is
// the skill body with the typed command appended at its END, so the typed
// `/review <N>` survives only in the `slash_command` system record's
// `rawCommand` — read that when present, falling back to the user record's
// first text part (the daemon-provided prompt path carries no payload).
function collectCommandPrNumbers(raw: string): {
  mentions: readonly CommandMention[];
  urlForms: ReadonlyArray<{ number: number; url: string }>;
} {
  const mentions: CommandMention[] = [];
  const mentionByNumber = new Map<number, CommandMention>();
  // A number an unqualified claim (`/review N`) named is THIS workspace's for
  // good: a later `--repo` claim must not overwrite that meaning, or a session
  // that reviewed PR N and then asked about another repo's N would lose the
  // binding it already earned.
  const ownClaimed = new Set<number>();
  const noteMention = (mention: CommandMention): void => {
    const known = mentionByNumber.get(mention.number);
    if (known) {
      // The position stays with the first mention: it is the cap trim's age
      // proxy. Qualifiers ACCUMULATE — a later `/verify-pr N` naming this
      // workspace's repo must bind after an earlier one named another —
      // unless an unqualified claim already settled the meaning.
      if (mention.bare) {
        known.bare = true;
        if (mention.repoForms === undefined) {
          ownClaimed.add(mention.number);
          delete known.repoForms;
        } else if (ownClaimed.has(mention.number)) {
          // Settled as this workspace's; the later qualifier changes nothing.
        } else if (mention.repoForms.length > 0) {
          known.repoForms = [
            ...new Set([...(known.repoForms ?? []), ...mention.repoForms]),
          ];
        } else {
          // A qualifier this grammar cannot read: the number is qualified but
          // its repository is unknown, which must stay distinct from "no
          // qualifier at all" so it declines rather than binding this
          // workspace's number.
          known.repoForms ??= [];
        }
      }
      return;
    }
    if (mention.bare && mention.repoForms === undefined) {
      ownClaimed.add(mention.number);
    }
    mentionByNumber.set(mention.number, mention);
    mentions.push(mention);
  };
  const urlForms: Array<{ number: number; url: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('/review') && !line.includes('/verify-pr')) continue;
    let record: {
      type?: string;
      subtype?: string;
      systemPayload?: { phase?: string; rawCommand?: string };
      message?: {
        parts?: Array<{ text?: string; functionResponse?: unknown }>;
      };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    let prompt: string | undefined;
    if (
      record.type === 'system' &&
      record.subtype === 'slash_command' &&
      record.systemPayload?.phase === 'invocation' &&
      typeof record.systemPayload.rawCommand === 'string'
    ) {
      prompt = record.systemPayload.rawCommand;
    } else if (record.type === 'user') {
      const firstPart = record.message?.parts?.[0];
      if (typeof firstPart?.text === 'string' && !firstPart.functionResponse) {
        prompt = firstPart.text;
      }
    }
    if (prompt === undefined) continue;
    const parsed = parsePrCommand(prompt);
    if (parsed.mention) noteMention(parsed.mention);
    if (parsed.urlForm) urlForms.push(parsed.urlForm);
  }
  return { mentions, urlForms };
}

/**
 * Backfills PR bindings onto a workspace's persisted sessions. Sources, in
 * ascending authority order: `/review` and `/verify-pr` commands the user
 * typed (the session merely looked at that PR), and the worktree slug/branch
 * convention last (the session exists FOR that PR, so it must never be
 * evicted by weaker numbers). Transcript `gh pr create` traces and bare
 * session git branches are deliberately NOT sources: text alone carries no
 * gh-side attribution (a forged binding vector), and the branch source
 * bound the workspace's current-branch PR onto every session (measured
 * pure noise) — on every platform. GitHub workspaces resolve numbers to
 * URLs via one batched `gh pr list --state all` per workspace (repo-gated),
 * else URL forms, else the workspace's git remote web URL.
 * Aone workspaces view each planned number through `a1 repo mr view`
 * (capped per run) — Aone links are never assembled from the remote — and
 * repair the fabricated `<origin>/pull/<N>` bindings the pre-Aone backfill
 * persisted.
 */
export async function backfillWorkspaceSessionPrs(
  runtime: WorkspaceRuntime,
  fetchPullRequests: typeof fetchGitHubPullRequests = fetchGitHubPullRequests,
  fetchRepoKeys: typeof fetchAttributionRepoKeys = fetchAttributionRepoKeys,
  options: SessionPrBackfillOptions = {},
): Promise<SessionPrBackfillWorkspaceResult> {
  // The route snapshots this runtime from the registry and then awaits
  // scans, `gh`, and queued writes; a trust/env replacement or removal
  // closes the generation guard meanwhile, and a retired generation must
  // not run `gh` with its stale env or commit sidecars — the same guard
  // every REST/ACP binding writer asserts around `upsertSessionPr`.
  const assertGenerationOpen = (): void =>
    runtime.generationGuard?.assertOpen();
  const result: SessionPrBackfillWorkspaceResult = {
    workspaceCwd: runtime.workspaceCwd,
    scanned: 0,
    bound: 0,
    written: 0,
    alreadyBound: 0,
    overLimit: 0,
    unresolved: 0,
  };
  const sessionService = createWorkspaceRuntimeSessionService(runtime);
  // One remote lookup per run, before scanning so the /review URL form can
  // repo-gate against it; async so the daemon event loop is never blocked.
  const remote = await fetchRemoteWebUrl(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
  );
  const workspaceRepoKey = remote ? repoKeyFromWebUrl(remote) : undefined;
  // Origin-based platform detection, before the scan: on Aone a session
  // holding a sidecar is a candidate even without a source, so the legacy
  // repair below reaches bindings whose worktree sidecar is gone.
  const aoneRepo = await resolveAoneWorkspaceRepo(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
  );
  const live = options.liveCommand;
  // The live turn may not have a transcript yet; resolve its archive state
  // best-effort and default to active, matching the shell post-hook.
  let liveArchiveState: SessionArchiveState = 'active';
  if (live) {
    try {
      if (
        (await sessionService.getSessionLocation(live.sessionId)) === 'archived'
      ) {
        liveArchiveState = 'archived';
      }
    } catch {
      /* best-effort binding */
    }
  }
  const candidates: BackfillCandidate[] = [];
  for (const archiveState of ['active', 'archived'] as const) {
    // Tie-safe exhaustive enumeration (see listAllProjectSessionIds): the
    // paged listSessions mtime cursor silently skips sessions tied with a
    // page's last entry, which an all-sessions sweep must never do. A live
    // bind names its own session, so the sweep has nothing else to scan.
    const sessionIds = live
      ? archiveState === liveArchiveState && isValidSessionId(live.sessionId)
        ? [live.sessionId]
        : []
      : await sessionService.listAllProjectSessionIds(archiveState);
    for (const sessionId of sessionIds) {
      // The id comes verbatim from the transcript's first record, and every
      // sidecar path below embeds it — a traversal id must be rejected
      // before path construction, the same way the sibling sidecar routes
      // gate.
      if (!isValidSessionId(sessionId)) continue;
      result.scanned += 1;
      const dir = path.dirname(
        sessionService.getWorktreeSessionPathForArchiveState(
          sessionId,
          archiveState,
        ),
      );
      let worktree: Awaited<ReturnType<typeof readWorktreeSession>>;
      try {
        worktree = await readWorktreeSession(
          path.join(dir, `${sessionId}.worktree.json`),
        );
      } catch {
        worktree = null;
      }
      const liveCandidate = live?.sessionId === sessionId;
      let transcriptRaw = '';
      if (!liveCandidate) {
        try {
          transcriptRaw = await fs.readFile(
            path.join(dir, `${sessionId}.jsonl`),
            'utf8',
          );
        } catch {
          transcriptRaw = '';
        }
      }
      const reviewed =
        liveCandidate && live
          ? liveCommandTargets(live.rawCommand)
          : collectCommandPrNumbers(transcriptRaw);
      const conventionNumber = worktree
        ? parsePrNumberFromWorktree(worktree.slug, worktree.worktreeBranch)
        : undefined;
      const hasSidecar =
        aoneRepo !== undefined &&
        existsSync(
          sessionService.getPrSessionPathForArchiveState(
            sessionId,
            archiveState,
          ),
        );
      if (
        conventionNumber === undefined &&
        reviewed.mentions.length === 0 &&
        !hasSidecar
      ) {
        continue;
      }
      candidates.push({
        sessionId,
        archiveState,
        transcriptPath: path.join(dir, `${sessionId}.jsonl`),
        conventionNumber,
        mentions: reviewed.mentions,
        urlForms: reviewed.urlForms,
      });
    }
  }
  if (candidates.length === 0) return result;

  assertGenerationOpen();
  // gh's page is authoritative for everything it lists: `pageUrlByNumber`
  // records every entry BEFORE the repo gate so a fork layout — where gh
  // resolves the PARENT repo for list queries — still attributes a
  // convention number to the parent PR the session exists for. The gated
  // map holds only same-repo entries.
  const numberToUrl = new Map<number, string>();
  const pageUrlByNumber = new Map<number, string>();
  const pageStateByNumber = new Map<number, 'open' | 'merged' | 'closed'>();
  // gh lists one repo per page — the PARENT's in the fork layout. Record
  // its key once: PR URLs always point there in that layout, so
  // `/review <url>` forms naming it are legitimate even though the
  // workspace origin's key is the fork's.
  let pageRepoKey: string | undefined;
  // gh's page may only feed bindings when it lists the workspace's OWN
  // repo or a CONFIRMED fork parent: gh's repo resolution is git-config
  // driven (`gh repo set-default`, remaining remotes), so it can diverge
  // from the workspace repo entirely, and bare numbers resolving through a
  // divergent page would bind a stranger's same-numbered PR. Fail CLOSED
  // when the workspace key is unknown (no resolvable origin): the remote
  // fallback is already disabled in that state.
  let pageMapTrusted = false;
  // Aone only: resolves a planned number's URL through one capped, cached
  // `mr view` — the sole sanctioned source of an Aone MR URL. The view is
  // this repo's own attested read, so its entries feed the trusted page
  // maps (URL, state) and the same-PR identity guard directly.
  let resolveAoneUrl:
    | ((number: number) => Promise<string | undefined>)
    | undefined;
  // Aone only: recognises the fabricated `<origin>/pull/<N>` URLs the
  // pre-Aone backfill persisted, so the plan can repair them in place.
  let isLegacyFabricated:
    | ((url: string, number: number) => boolean)
    | undefined;
  if (aoneRepo) {
    result.platform = 'aone';
    const aoneBackend = options.aoneBackend ?? defaultAoneMrBackend;
    const viewCache = new Map<number, string | undefined>();
    let viewCalls = 0;
    resolveAoneUrl = async (number) => {
      if (viewCache.has(number)) return viewCache.get(number);
      let url: string | undefined;
      if (viewCalls < AONE_MAX_MR_VIEW_CALLS_PER_RUN) {
        viewCalls += 1;
        try {
          const view = await aoneBackend.view(aoneRepo.repoPath, number);
          url = view.url;
          numberToUrl.set(number, url);
          pageUrlByNumber.set(number, url);
          pageStateByNumber.set(number, view.state);
        } catch {
          url = undefined;
        }
      }
      viewCache.set(number, url);
      return url;
    };
    pageMapTrusted = true;
    // Such an entry can never match a real detailUrl — its state would
    // stay frozen, and it would spend one view call per refresh sweep,
    // forever. Detect exactly that shape; any other URL keeps its
    // foreign-repo protection.
    isLegacyFabricated = (url, number) =>
      remote !== undefined &&
      canonicalSessionPrUrl(url) ===
        canonicalSessionPrUrl(`${remote}/pull/${number}`);
  } else {
    result.platform = 'github';
  }
  const prs = aoneRepo
    ? undefined
    : await fetchPullRequests(runtime.workspaceCwd, runtime.env.effectiveEnv, {
        state: 'all',
        limit: 500,
        slim: true,
      });
  if (prs) result.ghAvailable = prs.kind === 'ok';
  if (prs?.kind === 'ok') {
    for (const pr of prs.pullRequests) {
      // The sidecar snapshot has no 'draft' variant — a draft is still open.
      const state = pr.state === 'draft' ? 'open' : pr.state;
      pageUrlByNumber.set(pr.number, pr.url);
      pageStateByNumber.set(pr.number, state);
      pageRepoKey ??= repoKeyFromWebUrl(pr.url);
      if (
        workspaceRepoKey === undefined ||
        repoKeyFromWebUrl(pr.url) !== workspaceRepoKey
      ) {
        continue;
      }
      numberToUrl.set(pr.number, pr.url);
    }
    if (pageRepoKey !== undefined) {
      if (workspaceRepoKey !== undefined && pageRepoKey === workspaceRepoKey) {
        pageMapTrusted = true;
      } else {
        // Fork layout: gh lists the PARENT repo's PRs from a fork checkout.
        // Trust the page only when gh's OWN resolution names the workspace
        // repo AND the page is that repo's fork parent — a resolution
        // diverged elsewhere (`gh repo set-default`) would otherwise feed a
        // stranger's PRs into bindings; an unrelated page fails closed.
        const { resolved, parent } = await fetchRepoKeys(
          runtime.workspaceCwd,
          runtime.env.effectiveEnv,
        );
        pageMapTrusted =
          workspaceRepoKey !== undefined &&
          resolved === workspaceRepoKey &&
          parent === pageRepoKey;
      }
    }
  }

  // `/review <url>` names the repo it reviewed: accept the workspace's own
  // key OR the repo gh's page actually resolved to (the fork layout's
  // parent); a third repo's PR must never bind into this workspace.
  const allowedRepoKeys = new Set<string>();
  if (workspaceRepoKey !== undefined) allowedRepoKeys.add(workspaceRepoKey);
  if (pageRepoKey !== undefined) allowedRepoKeys.add(pageRepoKey);
  // The keys under which a form names THE SAME PR as a bare `/review N` or
  // the `pr-<N>` convention — this repo's PR N: the workspace itself, and
  // the page only while it is trusted (the confirmed fork parent). A form
  // from a divergent page's repo passes the gate for its OWN binding (the
  // user reviewed that PR), but its URL must never be lent to a bare or
  // convention number: that would bind a stranger's same-numbered PR onto
  // the session that exists for this repo's PR N.
  const sameRepoKeys = new Set<string>();
  if (workspaceRepoKey !== undefined) sameRepoKeys.add(workspaceRepoKey);
  if (pageMapTrusted && pageRepoKey !== undefined) {
    sameRepoKeys.add(pageRepoKey);
  }
  // `/verify-pr --repo <owner>/<repo>` is gh's `[HOST/]OWNER/REPO` form. The
  // comparison runs on the qualifier, against the workspace's FULL origin
  // path: `repoKeyFromWebUrl` keeps only two path segments, so a nested group
  // (`group/sub/cli`) collapses to `sub/cli` and the collapsed key cannot tell
  // the only correct spelling from a sibling project or from a bare group.
  // Segments and hosts normalize through the shared review helpers; the keys
  // stay exactly as their source built them.
  const repoSegments = (
    form: string,
  ): { host?: string; path: string[] } | undefined => {
    let v = form.trim().replace(/^["']|["']$/g, '');
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    v = v.replace(/^[^@/\s]+@/, '');
    // scp syntax `host:group/...`; a port keeps its colon.
    v = v.replace(/^([^/:@\s]+):(?!\d+\/)/, '$1/');
    v = v.replace(/[.,;]+$/, '').replace(/\/+$/, '');
    const parts = v.split('/').filter(Boolean);
    if (parts.length < 2) return undefined;
    // A first segment carrying a dot or a colon is read as a HOST. That makes
    // a nested group whose first segment contains a dot (`a.b/c`) indistinguish-
    // able from `host/owner`: nothing in gh's `[HOST/]OWNER/REPO` shape tells
    // them apart. The host reading wins, which leaves one path segment, so such
    // a qualifier declines — the safe side, and the reason this is a decision
    // rather than a spelling to patch.
    if (/[.:]/.test(parts[0])) {
      const path = parts.slice(1).map(normalizeSegment);
      return path.length >= 2 ? { host: parts[0], path } : undefined;
    }
    return { path: parts.map(normalizeSegment) };
  };
  const ownedIdentities: Array<{ host?: string; path: string[] }> = [];
  if (remote !== undefined) {
    try {
      const url = new URL(remote);
      const path = url.pathname
        .split('/')
        .filter(Boolean)
        .map(normalizeSegment);
      if (path.length >= 2) ownedIdentities.push({ host: url.host, path });
    } catch {
      // An unparseable remote leaves the workspace identity unknown, which
      // fails closed: a qualifier can match nothing.
    }
  }
  if (pageMapTrusted && pageRepoKey !== undefined) {
    const [host, owner, repo] = pageRepoKey.split('/');
    if (owner !== undefined && repo !== undefined) {
      ownedIdentities.push({ host, path: [owner, repo] });
    }
  }
  // One comparison for the two questions this file asks of a repository name:
  // whether a `--repo` qualifier names this workspace, and whether a resolved
  // PR URL landed in the repository the qualifier named. Paths must be equal
  // segment for segment — a suffix comparison would admit `sub/cli` (or
  // `host/sub/cli`) for `host/group/sub/cli`, a different project. A spelled
  // host is compared through the shared host equivalence, which normalizes
  // case and a `:port`, and is `www.`-insensitive here.
  const hostKey = (host: string): string => host.replace(/^www\./i, '');
  const segmentsMatch = (
    form: { host?: string; path: string[] },
    identity: { host?: string; path: string[] },
  ): boolean => {
    if (form.host !== undefined) {
      if (identity.host === undefined) return false;
      if (!hostsEquivalent(hostKey(form.host), hostKey(identity.host))) {
        return false;
      }
    }
    if (form.path.length !== identity.path.length) return false;
    return form.path.every(
      (segment, index) => segment === identity.path[index],
    );
  };
  /** The repository a PR URL belongs to: host plus the path above its PR/MR id. */
  const identityFromUrl = (
    prUrl: string,
  ): { host: string; path: string[] } | undefined => {
    try {
      const parsed = new URL(prUrl);
      // Strip the PR/MR route from the END: a repository may legitimately be
      // named `pull` (`/o/pull/pull/77`), so the first matching segment is not
      // the marker.
      const route = /\/(?:pull|merge_requests|codereview)\/[^/]+\/?$/.exec(
        parsed.pathname,
      );
      const repoPath = (
        route
          ? parsed.pathname.slice(0, route.index).replace(/\/-$/, '')
          : parsed.pathname
      )
        .split('/')
        .filter(Boolean)
        .map(normalizeSegment);
      return repoPath.length >= 2
        ? { host: parsed.host, path: repoPath }
        : undefined;
    } catch {
      return undefined;
    }
  };
  const repoFormMatches = (repoForm: string): boolean => {
    const form = repoSegments(repoForm);
    if (form === undefined) return false;
    return ownedIdentities.some((identity) => segmentsMatch(form, identity));
  };

  for (const candidate of candidates) {
    // The live command names one session; the commit below uses this to
    // decide whether a missing transcript is a brand-new turn or a deleted
    // session, and to re-resolve its location under the lane.
    const liveCandidate = live?.sessionId === candidate.sessionId;
    // Insert in ASCENDING authority so the strongest bindings survive the
    // sidecar's tail cap: reviewed first (the session merely looked at that
    // PR), and the worktree convention last (the session exists FOR that
    // PR, so it must never be evicted by weaker numbers). Reviewed numbers
    // keep TRANSCRIPT order across bare and url forms: the trim tie-breaks
    // same-rank plan members by plan position as the age proxy, mirroring
    // the sidecar cap's list-order tie-break.
    // `/review <url>` forms name their PR's URL explicitly — bind the named
    // URL itself instead of re-resolving the bare number, which could land
    // another repo's same-numbered PR. Only forms that PASS the repo gate
    // AND the sidecar's url shape check may supply a number at all: the
    // transcript is user-controlled text, the capture is unbounded, and
    // the reader fails the WHOLE sidecar closed on one over-long or
    // control-character url — persisting it would wipe every binding and
    // re-poison on each run.
    // On Aone the capture (`/pull/<N>`) can only ever match the fabricated
    // `<origin>/pull/<N>` shape the pre-Aone backfill persisted (real MR
    // links are `…/codereview/<id>`), so a form is admitted only when it
    // is exactly this workspace's own fabricated shape — a FULL-path
    // comparison, because the two-segment repo key collapses nested groups
    // and would let a sibling project's form through — and it supplies
    // the NUMBER only: the URL always comes from `mr view`.
    const formUrlByNumber = new Map<number, string>();
    for (const form of candidate.urlForms) {
      if (!isValidSessionPrUrl(form.url)) continue;
      if (isLegacyFabricated) {
        if (isLegacyFabricated(form.url, form.number)) {
          formUrlByNumber.set(form.number, form.url);
        } else {
          // Aone-only: a form that is not this workspace's fabricated shape
          // names a different repository (real MR links are `…/codereview/
          // <id>`), so it is a decline for the same reason a GitHub form from
          // another repo is.
          result.repoDeclined = (result.repoDeclined ?? 0) + 1;
        }
        continue;
      }
      const repoKey = repoKeyFromWebUrl(form.url);
      if (repoKey !== undefined && allowedRepoKeys.has(repoKey)) {
        formUrlByNumber.set(form.number, form.url);
      } else {
        // A url form naming another repository: declined, not unresolved.
        result.repoDeclined = (result.repoDeclined ?? 0) + 1;
      }
    }
    const numbers: number[] = [];
    // A bare number names this workspace's PR N unless EVERY `/verify-pr
    // --repo` claim on it names another repository: one claim on this
    // workspace's own repo (or the page's trusted fork parent) is enough, so
    // a later correct spelling is not lost to an earlier foreign one.
    const ownsBareNumber = (mention: CommandMention): boolean =>
      mention.bare &&
      (mention.repoForms === undefined ||
        mention.repoForms.some((form) => repoFormMatches(form)));
    for (const mention of candidate.mentions) {
      // A number mentioned ONLY through url forms is planned only when a
      // form passed the gate; a bare mention names this repo's PR N and
      // plans regardless.
      const owned = ownsBareNumber(mention);
      const plannedByForm = formUrlByNumber.has(mention.number);
      if (!owned && mention.bare) {
        // Counted even when a form still supplies the number: the BARE claim
        // was declined, and a zero-`bound` run caused by that must be
        // distinguishable from a silent miss.
        result.repoDeclined = (result.repoDeclined ?? 0) + 1;
      }
      if (owned || plannedByForm) numbers.push(mention.number);
    }
    // Numbers named as THIS repo's PR N (bare or convention): a form may
    // lend such a number its URL only when it names the same PR.
    const namedAsOwn = new Set<number>(
      candidate.mentions
        .filter(ownsBareNumber)
        .map((mention) => mention.number),
    );
    if (candidate.conventionNumber !== undefined) {
      namedAsOwn.add(candidate.conventionNumber);
    }
    const lendableFormUrl = (number: number): string | undefined => {
      // Aone links are never assembled: a form never supplies a URL there.
      if (resolveAoneUrl) return undefined;
      const url = formUrlByNumber.get(number);
      if (url === undefined || !namedAsOwn.has(number)) return url;
      const key = repoKeyFromWebUrl(url);
      return key !== undefined && sameRepoKeys.has(key) ? url : undefined;
    };
    if (candidate.conventionNumber !== undefined) {
      const conventionNumber = candidate.conventionNumber;
      const rest = numbers.filter((n) => n !== conventionNumber);
      numbers.length = 0;
      numbers.push(...rest, conventionNumber);
    }
    // Numbers whose meaning is ONLY qualified — no unqualified claim, no
    // convention, no url form. The resolver's page and remote fallbacks can
    // point at the other side of a fork, which is a different PR with the same
    // number, so their resolved URL has to land in a repository the user
    // named.
    const qualifiedForms = new Map<number, string[]>();
    for (const mention of candidate.mentions) {
      if (mention.repoForms === undefined) continue;
      qualifiedForms.set(mention.number, [
        ...(qualifiedForms.get(mention.number) ?? []),
        ...mention.repoForms,
      ]);
    }
    const urlMatchesQualifier = (prUrl: string, forms: string[]): boolean => {
      const identity = identityFromUrl(prUrl);
      if (identity === undefined) return false;
      return forms.some((form) => {
        const parsed = repoSegments(form);
        return parsed !== undefined && segmentsMatch(parsed, identity);
      });
    };
    // The legacy-repair pass below must stay reachable for a session with
    // nothing planned this run, so only the GitHub path — which has no
    // repairs — skips on empty numbers before reading the sidecar.
    if (numbers.length === 0 && !isLegacyFabricated) continue;
    // Re-resolve the session's CURRENT archive state immediately before the
    // snapshot read and locked write: an archive/restore transition landing
    // during the scan and gh window above must not strand the new bindings
    // in the wrong state's chats dir. A location that cannot be determined
    // keeps the enumerated state.
    let archiveState = candidate.archiveState;
    try {
      const location = await sessionService.getSessionLocation(
        candidate.sessionId,
      );
      if (location === 'active' || location === 'archived') {
        archiveState = location;
      }
    } catch {
      // Best-effort backfill: keep the enumerated state.
    }
    const prPath = sessionService.getPrSessionPathForArchiveState(
      candidate.sessionId,
      archiveState,
    );
    // The transcript moves with an archive transition; the write-time
    // existence guard must check the re-resolved location, not the
    // enumerated one.
    const transcriptPath = path.join(
      path.dirname(prPath),
      `${candidate.sessionId}.jsonl`,
    );
    // Captured before the snapshot read: an entry committed while this run
    // is in flight is newer than the plan and must not be trimmed by it.
    const snapshotAt = new Date().toISOString();
    let existing: Awaited<ReturnType<typeof readSessionPrs>>;
    try {
      existing = await readSessionPrs(prPath);
    } catch {
      existing = null;
    }
    // Repair legacy fabricated bindings (Aone only): re-resolve their
    // numbers through the same capped view path. Successfully viewed ones
    // are rewritten in the commit below (keeping their createdAt and
    // provenance); failed ones stay as they are and the next run retries.
    const repairs = new Map<
      number,
      { url: string; state: SessionPr['state'] | undefined }
    >();
    if (isLegacyFabricated && resolveAoneUrl && existing) {
      for (const entry of existing) {
        if (!isLegacyFabricated(entry.url, entry.number)) continue;
        const url = await resolveAoneUrl(entry.number);
        if (url === undefined) continue;
        repairs.set(entry.number, {
          url,
          state: pageStateByNumber.get(entry.number),
        });
      }
    }
    if (numbers.length === 0 && repairs.size === 0) continue;
    const existingNumbers = new Set((existing ?? []).map((pr) => pr.number));
    // A live bind names only the current command, so the sweep's
    // transcript-order plan does not carry the session's older review
    // bindings. Without them in the plan, every older review counts as a
    // foreign occupant and a full sidecar leaves zero slots for the new
    // review. Include them as evictable occupants — only `review`
    // provenance; create/worktree and pre-provenance entries keep their
    // slots — ordered oldest-first, so the cap trims the oldest review and
    // the new command survives.
    const liveEvictableNumbers =
      options.liveCommand === undefined
        ? []
        : (existing ?? [])
            .filter(
              (entry) =>
                entry.source === 'review' &&
                !numbers.includes(entry.number) &&
                entry.createdAt < snapshotAt,
            )
            .map((entry) => entry.number);
    const urls = new Map<number, string>();
    const states = new Map<number, SessionPr['state']>();
    for (const number of numbers) {
      if (existingNumbers.has(number)) continue;
      let url = numberToUrl.get(number);
      if (url === undefined) url = lendableFormUrl(number);
      if (url === undefined && pageMapTrusted) {
        url = pageUrlByNumber.get(number);
      }
      if (url === undefined) {
        if (resolveAoneUrl) {
          // Aone links are never assembled: a number the view budget or
          // the platform declines stays unresolved for the next run.
          url = await resolveAoneUrl(number);
        } else if (remote !== undefined) {
          // Fork layout: the RELATED page (confirmed fork parent) is
          // preferred over a synthesized fork URL (forks host no PRs; the
          // link would 404). Only a number the page lacks entirely falls
          // back to the workspace remote (gh unavailable, divergent page,
          // or outside the list window) — a bare reviewed number names
          // this repo's PR N.
          url = `${remote}/pull/${number}`;
        }
      }
      // Every url source is checked once here: a remote-derived url can
      // exceed the bound too (an absurd origin), and the sidecar writer
      // declines what the reader would reject.
      if (url === undefined || !isValidSessionPrUrl(url)) {
        result.unresolved += 1;
        continue;
      }
      // A number named only through `--repo` must bind in the repository the
      // user named. `me/fork` beside a trusted parent page resolves to the
      // parent's same-numbered PR, and `parent/repo` for a number the page
      // lacks falls back to the fork's — both are different PRs, so the URL is
      // declined rather than substituted. A url form names its own repository
      // explicitly and is not gated here.
      const forms = qualifiedForms.get(number);
      if (
        number !== candidate.conventionNumber &&
        forms !== undefined &&
        forms.length > 0 &&
        !formUrlByNumber.has(number) &&
        !urlMatchesQualifier(url, forms)
      ) {
        result.repoDeclined = (result.repoDeclined ?? 0) + 1;
        continue;
      }
      urls.set(number, url);
      // The page's state belongs to the page's OWN url for the number: a
      // `/review <url>` form that resolved another repo's URL (the fork
      // layout) must not pair with the page repo's same-numbered PR — a
      // DIFFERENT PR whose terminal state would poison this binding.
      const state =
        pageMapTrusted && pageUrlByNumber.get(number) === url
          ? pageStateByNumber.get(number)
          : undefined;
      if (state !== undefined) states.set(number, state);
    }
    // The cap is shared with entries this run did not resolve and cannot
    // re-resolve (dialog-created bindings, PRs that fell out of the gh
    // window): they take their slots first, and the resolved numbers are
    // trimmed around them, counting the displaced in overLimit. The plan is
    // finalized inside the mutation queue, against the freshest list, so a
    // binding that lands between the snapshot read and this write is never
    // dropped and the slots are recomputed around it; sequential capped
    // upserts instead cascaded evictions through the list.
    const droppable = new Set(
      numbers.filter(
        (number) => existingNumbers.has(number) || urls.has(number),
      ),
    );
    for (const number of liveEvictableNumbers) droppable.add(number);
    const createdAt = new Date().toISOString();
    let added = 0;
    // A closed generation is a whole-run condition, not a per-session write
    // failure: surface it to the route (which reports the workspace as
    // failed) instead of miscounting it in writeErrors.
    assertGenerationOpen();
    const commit = async (): Promise<void> => {
      // The shared lane excludes transitions that are IN FLIGHT, but one may
      // have completed between the pre-lane location/snapshot and this
      // commit. A live bind re-resolves under the lane and writes where the
      // session is NOW: a deleted session must not resurrect its sidecar, and
      // an archived one must not have its binding stranded in the active
      // directory. The sweep keeps its pre-lane path on purpose: a session
      // that moved mid-scan is re-bound by a later sweep from its new
      // transcript, and writing here would leave a stray sidecar.
      let commitPrPath = prPath;
      if (liveCandidate) {
        let location: SessionArchiveState | 'conflict' | undefined = undefined;
        try {
          location = await sessionService.getSessionLocation(
            candidate.sessionId,
          );
        } catch {
          // An unknown location cannot be written safely: do not assume
          // active and resurrect metadata under the wrong state.
          return;
        }
        if (location === 'active' || location === 'archived') {
          commitPrPath = sessionService.getPrSessionPathForArchiveState(
            candidate.sessionId,
            location,
          );
        } else {
          if (location === 'conflict') return;
          // No transcript in either state. A session the bridge still owns is
          // a brand-new turn whose transcript has not been written yet; one
          // the bridge no longer knows was deleted and must not be
          // resurrected. Any throw means liveness cannot be proven; skip.
          try {
            runtime.bridge.getSessionSummary(candidate.sessionId);
          } catch {
            return;
          }
        }
      }
      const persisted = await replaceSessionPrs(commitPrPath, (fresh) => {
        assertGenerationOpen();
        // Under the archive lane no archive/delete rename can interleave
        // with this write; the existence check still covers a transcript
        // removed by a path that takes no lane, so the plan never
        // resurrects a sidecar for a session gone from this archive state.
        // A live `/review` bind is exempt only after the re-check above
        // proved the session still exists (a bridge-owned new turn); a
        // deleted one returned already.
        if (!liveCandidate && !existsSync(transcriptPath)) {
          return null;
        }
        // Repair legacy fabricated URLs first (Aone only), so the repaired
        // entries plan under their real identity and their state unblocks
        // the refresh sweep. The re-check keeps a concurrently landed
        // non-legacy rewrite of the same number untouched.
        const base =
          repairs.size === 0
            ? fresh
            : fresh.map((entry) => {
                const repair = repairs.get(entry.number);
                return repair && isLegacyFabricated?.(entry.url, entry.number)
                  ? {
                      ...entry,
                      url: repair.url,
                      ...(repair.state !== undefined
                        ? { state: repair.state }
                        : {}),
                    }
                  : entry;
              });
        const freshNumbers = new Set(base.map((entry) => entry.number));
        // Only entries seen in the snapshot are subject to this plan; newer
        // ones are bindings this run never planned for and must keep.
        // Snapshot-held numbers this run re-offers are occupants, not
        // additions (heldInFresh below) — a same-PR re-bind preserves
        // createdAt, so identity here is snapshot membership, not age.
        const plannedFor = (entry: SessionPr): boolean => {
          // Same-PR identity is number + canonical url, as in
          // upsertSessionPr: a binding to another repository's
          // same-numbered PR is foreign to this plan and keeps its slot;
          // trimming it would let a later run flip it to this repo's PR.
          const resolved =
            numberToUrl.get(entry.number) ?? urls.get(entry.number);
          // Aone fails CLOSED unless the entry is provably one of this
          // repo's own MRs — either view-attested this run, or matching
          // the exact detailUrl shape for this repoPath (the shape a
          // previous successful bind or repair persisted). The shape check
          // is what keeps a full sidecar's re-planned entries trimmable
          // WITHOUT spending the view budget re-attesting them every run;
          // anything else stays foreign and kept. GitHub keeps the
          // fail-open default: an unlisted convention binding stays
          // re-plannable.
          const samePr = aoneRepo
            ? (resolved !== undefined &&
                canonicalSessionPrUrl(entry.url) ===
                  canonicalSessionPrUrl(resolved)) ||
              isAoneDetailUrlForRepo(aoneRepo.repoPath, entry.number, entry.url)
            : resolved === undefined ||
              canonicalSessionPrUrl(entry.url) ===
                canonicalSessionPrUrl(resolved);
          return (
            droppable.has(entry.number) &&
            existingNumbers.has(entry.number) &&
            entry.createdAt < snapshotAt &&
            samePr
          );
        };
        const foreignEntries = base.filter((entry) => !plannedFor(entry));
        // Fresh-foreign numbers already hold their slots; billing them
        // again as plan members trims a snapshot binding even though the
        // cap is never exceeded.
        const foreignNumbers = new Set(
          foreignEntries.map((entry) => entry.number),
        );
        const foreignCount = foreignEntries.length;
        const slots = Math.max(0, SESSION_PR_LIST_LIMIT - foreignCount);
        let plan = [...liveEvictableNumbers, ...numbers].filter(
          (number) => droppable.has(number) && !foreignNumbers.has(number),
        );
        if (plan.length > slots) {
          // Trim by provenance authority — the sidecar's own cap rule —
          // oldest plan position within the same rank. Every plan member
          // ranks as what this run would stamp it (the convention number
          // as the session's own PR, everything else as a review), and a
          // re-offered occupant additionally keeps the rank its persisted
          // entry carries on the sidecar's ladder: a session's created PR
          // re-mentioned as `/review 100` must not be demoted to a review
          // and displaced by newer reviews — and an occupant persisted
          // WITHOUT provenance (every binding from before source was
          // recorded, GitDialog creates included) sits above reviews on
          // that ladder for the same reason, so a weak candidate never
          // displaces it either.
          result.overLimit += plan.length - slots;
          const heldSource = new Map(
            base.map((entry) => [entry.number, entry.source] as const),
          );
          const rank = (number: number): number => {
            const stamp = sessionPrSourceAuthority(
              number === candidate.conventionNumber ? 'worktree' : 'review',
            );
            return heldSource.has(number)
              ? Math.max(
                  stamp,
                  sessionPrSourceAuthority(heldSource.get(number)),
                )
              : stamp;
          };
          const evicted = new Set(
            plan
              .map((_, index) => index)
              .sort((a, b) => rank(plan[a]) - rank(plan[b]) || a - b)
              .slice(0, plan.length - slots),
          );
          plan = plan.filter((_, index) => !evicted.has(index));
        }
        const planSet = new Set(plan);
        // Occupants are not requests: a live bind must not report nine
        // older reviews as "already bound". Only numbers this run planned
        // for count, matching the sweep (where every plan number is one).
        const requestedNumbers = new Set(numbers);
        result.alreadyBound += plan.filter(
          (number) => requestedNumbers.has(number) && freshNumbers.has(number),
        ).length;
        // A re-offered occupant this run ranks higher than its persisted
        // provenance (a `/review`-bound number the session now exists for
        // via the `pr-<N>` convention) is promoted in place — url,
        // createdAt and position untouched, never downgraded — the way
        // upsertSessionPrs upgrades a same-URL re-offer. Otherwise the
        // trim above protects the entry only in this planner while every
        // other capped writer still sees the weaker persisted rank and
        // evicts the session's own PR first. A new object, so the no-op
        // check below commits the promotion.
        //
        // Plan membership is NOT enough for the stamp: plannedFor fails
        // open on GitHub when the number cannot be resolved this run, which
        // is fine for trimmability (reversible) but not for provenance
        // (permanent) — a foreign same-numbered occupant at the convention
        // number would become the session's highest-authority binding.
        // The stamp needs ATTESTED identity, the bar upsertSessionPrs sets
        // for its upgrade: the entry's canonical url is the one gh resolved
        // for the number, or this workspace's own `<remote>/pull/<N>` shape
        // (a url names its repository by path), or on Aone the exact
        // detailUrl shape for this repoPath. Anything else stays as it is
        // until a later run can attest it.
        const attested = (entry: SessionPr): boolean => {
          if (aoneRepo) {
            return isAoneDetailUrlForRepo(
              aoneRepo.repoPath,
              entry.number,
              entry.url,
            );
          }
          const canonical = canonicalSessionPrUrl(entry.url);
          const resolved = numberToUrl.get(entry.number);
          // In the fork layout the workspace's own numbers live on the
          // CONFIRMED parent page: numberToUrl is gated to the fork's key
          // and the remote shape is the fork's url, so without this
          // disjunct a parent-bound convention occupant could never be
          // attested — and never promoted — in that layout. Gated on
          // pageMapTrusted: a divergent page must not attest anything.
          const pageUrl = pageUrlByNumber.get(entry.number);
          return (
            (resolved !== undefined &&
              canonical === canonicalSessionPrUrl(resolved)) ||
            (pageMapTrusted &&
              pageUrl !== undefined &&
              canonical === canonicalSessionPrUrl(pageUrl)) ||
            (remote !== undefined &&
              canonical ===
                canonicalSessionPrUrl(`${remote}/pull/${entry.number}`))
          );
        };
        const kept = base
          .filter((entry) => planSet.has(entry.number) || !plannedFor(entry))
          .map((entry) => {
            if (!planSet.has(entry.number) || !attested(entry)) return entry;
            const stamp: SessionPrSource =
              entry.number === candidate.conventionNumber
                ? 'worktree'
                : 'review';
            return sessionPrSourceAuthority(stamp) >
              sessionPrSourceAuthority(entry.source)
              ? { ...entry, source: stamp }
              : entry;
          });
        const additions: SessionPr[] = [];
        for (const number of plan) {
          if (freshNumbers.has(number)) continue;
          const url = urls.get(number);
          // Snapshot-held numbers were skipped by the URL loop, so one
          // evicted concurrently has no URL here; re-adding it url-less
          // would fail isValidSessionPr and void the whole sidecar. Skip
          // it and let the next run re-bind it.
          if (url === undefined) continue;
          const state = states.get(number);
          const source: SessionPrSource =
            number === candidate.conventionNumber ? 'worktree' : 'review';
          additions.push({
            number,
            url,
            createdAt,
            ...(state !== undefined ? { state } : {}),
            source,
          });
        }
        added = additions.length;
        const next = [...kept, ...additions];
        // Compare against the PERSISTED list, not the repaired one: when a
        // repair rewrote an entry in `base`, `next` matching `base` is the
        // change that must commit, not a no-op.
        return next.length === fresh.length &&
          next.every((entry, index) => entry === fresh[index])
          ? null
          : next;
      });
      if (persisted !== null) {
        result.bound += added;
        result.written += 1;
        // Every other binding writer keeps the hydrated bridge entry in
        // step with the sidecar; a capped plan can evict numbers, and the
        // stale entry would resurrect them in the summary merge until a
        // daemon restart. The sync runs inside the mutation queue against
        // the freshest list, so a bind queued between the rewrite's commit
        // and the sync keeps its slot instead of being clobbered by the
        // rewrite-time snapshot. No-op when the session is not live.
        await replaceSessionPrs(commitPrPath, (fresh) => {
          // Never publish into a retired generation's bridge.
          assertGenerationOpen();
          runtime.bridge.setSessionPrs?.(
            candidate.sessionId,
            fresh.map(toSessionPrInfo),
          );
          return null;
        });
      }
    };
    try {
      // The shared lane spans the rewrite AND the live-entry sync: archive
      // and delete take the exclusive lane across their renames, so while
      // this holds the session neither can move the transcript or sidecar
      // out from under the atomic write, and the sync publishes a list the
      // archive move cannot have split.
      await (options.archiveCoordinator
        ? options.archiveCoordinator.runSharedMany(
            [candidate.sessionId],
            commit,
          )
        : commit());
    } catch (error) {
      if (
        error instanceof WorkspaceGenerationClosedError ||
        error instanceof DaemonDrainingError
      ) {
        throw error;
      }
      // One unwritable (or concurrently archiving) sidecar must not abort
      // the whole workspace; the next run re-plans it.
      result.writeErrors = (result.writeErrors ?? 0) + 1;
    }
  }
  // A live bind bypasses the sweep route, which owns the catalog mark for
  // its own runs. Publish here so the badge does not wait for unrelated
  // catalog churn.
  if (options.liveCommand && result.written > 0) {
    publishSessionPrWrites(runtime);
  }
  return result;
}

/**
 * Publishes sidecar writes to the sidebar: drops the list cache and advances
 * the catalog revision so live-state clients refetch (~2 s). Call it only
 * after a write that changed something.
 */
function publishSessionPrWrites(runtime: WorkspaceRuntime): void {
  // A generation retired after its last commit must not notify its obsolete
  // bridge; the successor owns the catalog now.
  runtime.generationGuard?.assertOpen();
  invalidateWorkspaceSessionListCache({
    runtimeBaseDir: runtime.sessionRuntimeBaseDir,
    workspaceCwd: runtime.workspaceCwd,
    archiveStates: ['active', 'archived'],
  });
  runtime.bridge.markSessionCatalogChanged();
}

/**
 * Binds the PR named by a `/review` or `/verify-pr` prompt the daemon has
 * just admitted. The transcript sweep would find the same command later (or
 * never, for a brand-new session), so the live path injects it instead of
 * waiting. Best-effort: callers must not fail the prompt on a binding error.
 */
export async function bindSessionPrsFromPromptCommand(
  runtime: WorkspaceRuntime,
  sessionId: string,
  promptText: string,
  options: SessionPrBackfillOptions = {},
): Promise<SessionPrBackfillWorkspaceResult | undefined> {
  if (!runtime.trusted) return undefined;
  if (parsePrCommand(promptText).mention === undefined) return undefined;
  return backfillWorkspaceSessionPrs(runtime, undefined, undefined, {
    ...options,
    liveCommand: { sessionId, rawCommand: promptText },
  });
}

export function registerSessionPrBackfillRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
    archiveCoordinator?: SessionPrArchiveLane;
  },
): void {
  app.post('/sessions/backfill-prs', deps.mutate(), async (_req, res) => {
    const route = 'POST /sessions/backfill-prs';
    try {
      const workspaces: SessionPrBackfillWorkspaceResult[] = [];
      for (const runtime of deps.workspaceRegistry.listAll()) {
        if (!runtime.trusted) {
          workspaces.push({
            workspaceCwd: runtime.workspaceCwd,
            scanned: 0,
            bound: 0,
            written: 0,
            alreadyBound: 0,
            overLimit: 0,
            unresolved: 0,
            error: 'untrusted workspace skipped',
          });
          continue;
        }
        try {
          const result = await backfillWorkspaceSessionPrs(
            runtime,
            undefined,
            undefined,
            {
              archiveCoordinator: deps.archiveCoordinator,
            },
          );
          // Same pairing as every other catalog mutation in this feature:
          // the sidebar refetch is catalog-version-gated, so a persisted
          // rewrite — new bindings or an eviction-only plan — stays
          // invisible until the cache scope is dropped and the revision
          // advances. Gate on writes, not additions: a capped plan can
          // evict an entry while adding none.
          if (result.written > 0) publishSessionPrWrites(runtime);
          workspaces.push(result);
        } catch (error) {
          workspaces.push({
            workspaceCwd: runtime.workspaceCwd,
            scanned: 0,
            bound: 0,
            written: 0,
            alreadyBound: 0,
            overLimit: 0,
            unresolved: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      res.status(200).json({
        v: 1,
        workspaces,
        scanned: workspaces.reduce((sum, w) => sum + w.scanned, 0),
        bound: workspaces.reduce((sum, w) => sum + w.bound, 0),
      });
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });
}
