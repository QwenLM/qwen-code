/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import type {
  DaemonGitBranchesResult,
  DaemonGitBranchInfo,
  DaemonGitRemoteInfo,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';
import {
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  ChevronRightIcon,
  GitBranchIcon,
  GitCommitIcon,
  GlobeIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  TagIcon,
  Trash2Icon,
  FileDiffIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { validateBranchName } from './GitModePopover';
import { deriveStatus, hasComputedTreeSummary } from './GitBranchIndicator';
import { getShadowAwareActiveElement } from '../utils/dom';
import styles from './BranchPickerPopover.module.css';

// The daemon's stash/force pull flows chain git commands, each with its own
// 30s budget. The stash flow's worst case is 16 of them (guards, fetch,
// upstream check, listings, push, pull, abort, apply, list, drop, and the
// drop-shift compensation's log + store) = 480s; size the client fetch
// timeout above that so the request is not aborted while the daemon is
// still restoring the repository.
const GIT_PULL_FETCH_TIMEOUT_MS = 600_000;

// A remote mutation chains git's add/rm plus the verification and
// upstream-cleanup spawns (each with its own 30s budget — the add chain
// is 5 of them), so size the client fetch timeout above the chain,
// mirroring the pull flow.
export const GIT_REMOTE_MUTATION_FETCH_TIMEOUT_MS = 600_000;

function daemonErrorBody(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof DaemonHttpError)) return undefined;
  const body = err.body;
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : undefined;
}

function pullRefusalCode(err: unknown): string | undefined {
  if (!(err instanceof DaemonHttpError) || err.status !== 409) return undefined;
  const code = daemonErrorBody(err)?.['error'];
  return typeof code === 'string' ? code : undefined;
}

function isDirtyWorkingTreeError(err: unknown): boolean {
  return pullRefusalCode(err) === 'dirty_working_tree';
}

// The daemon refuses to discard from a workspace below the repository root,
// but the tree is still dirty and stashing is still viable: keep the panel
// up (with the daemon's explanation) instead of hiding the remaining option.
function isForceUnsupportedError(err: unknown): boolean {
  return pullRefusalCode(err) === 'force_unsupported';
}

// The daemon's `message` is the carrier of what went wrong — git's own
// notice, or the core's explanation of a refusal — while the SDK's error
// message only names the route and code. Prefer the former when present.
function pullErrorMessage(err: unknown): string {
  const message = daemonErrorBody(err)?.['message'];
  if (typeof message === 'string' && message.trim() !== '') return message;
  return err instanceof Error ? err.message : String(err);
}

// Display-side counterpart of the core write-gate's invisible-character
// policy, derived from Unicode properties (the set grows with Unicode, so a
// hand list always has an unlisted corner). \p{Cc} covers C0/C1 controls,
// \p{Cf} the format characters, plus the line/paragraph separators.
// Strip for RENDERING only; mutation requests must carry the raw name (git
// knows the remote by its exact configured name), and filteredRemotes must
// match these same stripped values so search finds what the row displays.
const DISPLAY_INVISIBLE_CHARS =
  /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

function sanitizeRemoteDisplay(value: string): string {
  return value.replace(DISPLAY_INVISIBLE_CHARS, '');
}

// The popover content may live in a shadow-portal root (Web Shell portal
// mode): document.activeElement retargets to the host and
// document.body.querySelector cannot cross the boundary, so every focus
// capture and lookup resolves from the content element's own root.
function rootScope(element: Element | null): Document | ShadowRoot {
  const root = element?.getRootNode();
  return root instanceof ShadowRoot ? root : document;
}

// Tooltip/aria escapes for remote names AND URLs: whitespace joins the
// stripped invisible class, because CSS collapses edge and repeated
// whitespace out of the inked text — `origin` and `origin ` render one
// row — so the tooltip (and the name's aria-label) spells those
// characters out too. With `nonAscii`, EVERY non-printable-ASCII
// character is spelled out — for rows marked on canonical-equivalence
// or script-mixing grounds, where the ambiguity IS an ink-identical
// glyph (a Cyrillic `о` reads as `o`).
function escapeNameChars(value: string, nonAscii = false): string {
  return value.replace(
    nonAscii
      ? /[^\x21-\x7E]/gu
      : /[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu,
    (ch) => `\\u{${ch.codePointAt(0)?.toString(16)}}`,
  );
}

interface BranchPickerPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceCwd: string;
  gitCwd?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  onBranchChanged?: () => void;
  /**
   * Working-tree summary from the trigger chip. Seeds the hints beside the
   * Update / Commit / Push actions (dirty counts, in-progress operation) until
   * the popover's own on-open fetch lands; whichever of the two carries the
   * newer `computedAt` wins.
   */
  status?: DaemonWorkspaceGitStatus;
  /**
   * Receives the status the popover fetches for itself on open, so a caller
   * that renders a chip from the same object can update it in step.
   */
  onStatusRefreshed?: (status: DaemonWorkspaceGitStatus) => void;
  onOpenDiff?: () => void;
  onOpenCommit?: () => void;
  children: React.ReactNode;
}

type SectionKey = 'recent' | 'local' | 'remote' | 'tags';

type HintTone = 'muted' | 'info' | 'warning';

interface ActionHint {
  text: string;
  tone: HintTone;
}

interface ActionHints {
  pull?: ActionHint;
  pullDisabled: boolean;
  commit?: ActionHint;
  push?: ActionHint;
  pushDisabled: boolean;
}

type TranslateFn = ReturnType<typeof useI18n>['t'];

/**
 * Derive the per-action hints shown beside Update / Commit / Push so the user
 * can judge before clicking.
 *
 * Disabling is reserved for what is provable from the local repository
 * alone: `git pull` during a merge/rebase/cherry-pick, with unmerged
 * entries, on a detached HEAD, or without a usable upstream; `git push` only
 * on a detached HEAD. Whether a remote will accept a push is *not* locally
 * decidable — the destination depends on config git itself sometimes
 * declines to resolve (`push.default=simple` in triangular shapes),
 * `remote.<name>.push` refspecs and forcing refspecs change the answer, and
 * every count is a snapshot of the last fetch — so a push the counts call
 * doomed is warned about on an enabled row, and the click surfaces git's own
 * authoritative message. Soft states (up to date, nothing to push, clean
 * tree) only dim the row since the action is still harmless.
 *
 * The branch listing (fetched on open) provides ahead/behind/upstream; the
 * status provides the tree counters and the in-progress operation. When the
 * listing has no head entry the status fills in. Exported for tests.
 */
export function deriveActionHints(
  t: TranslateFn,
  data: DaemonGitBranchesResult | null,
  status: DaemonWorkspaceGitStatus | undefined,
): ActionHints {
  const head = data?.local.find((b) => b.isHead);
  const s = deriveStatus(status);
  const detached = data?.detached ?? s.detached;
  const ahead = head?.ahead ?? s.ahead;
  const behind = head?.behind ?? s.behind;
  const upstream = head?.upstream;
  const upstreamGone = head?.upstreamGone === true;
  const hasUpstream: boolean | undefined = head
    ? Boolean(head.upstream) && !upstreamGone
    : status?.hasUpstream;
  // Entry-granularity counters (a partially staged file counts twice, an
  // untracked directory once), so the copy says "changes", not "files".
  const changed = s.staged + s.unstaged + s.untracked + s.conflicted;

  const blocker: ActionHint | undefined = s.operation
    ? { text: t(`git.operation.${s.operation}`), tone: 'warning' }
    : s.conflicted > 0
      ? { text: t('git.conflicted', { count: s.conflicted }), tone: 'warning' }
      : detached
        ? { text: t('git.detached'), tone: 'warning' }
        : undefined;

  let pull: ActionHint | undefined;
  let pullDisabled = false;
  if (blocker) {
    pull = blocker;
    pullDisabled = true;
  } else if (hasUpstream === false) {
    pull = {
      text: t(
        upstreamGone
          ? 'branchPicker.hint.upstreamGone'
          : 'branchPicker.hint.noUpstream',
      ),
      tone: 'muted',
    };
    pullDisabled = true;
  } else if (behind > 0) {
    pull =
      changed > 0
        ? {
            text: t('branchPicker.hint.behindDirty', { count: behind }),
            tone: 'warning',
          }
        : {
            text: upstream ? `↓${behind} · ${upstream}` : `↓${behind}`,
            tone: 'info',
          };
  } else if (hasUpstream) {
    pull = { text: t('branchPicker.hint.upToDate'), tone: 'muted' };
  }

  let push: ActionHint | undefined;
  // The push row's *information* comes from the push destination — git's own
  // `%(push)` answer, which may differ from the tracking upstream in
  // triangular workflows:
  //  - `pushTarget` resolved: its counts rule; `pushGone` means the
  //    destination's ref is missing, so a push would create it.
  //  - A live upstream but no `pushTarget`: git declined to name a
  //    destination (`push.default` the branch name does not satisfy, a
  //    `remote.<name>.push` refspec, `nothing`) and refuses some of those
  //    pushes outright, so the upstream counts are no stand-in — say nothing
  //    rather than dress a pull-side number as a push-side one.
  //  - No upstream: the push publishes the branch and sets one.
  // With no listing at all the status counters are all there is.
  const pushKnown = head?.pushTarget !== undefined && head.pushGone !== true;
  const pushSideUnknown =
    head !== undefined && head.pushTarget === undefined && hasUpstream === true;
  const pushAhead = pushKnown ? (head.pushAhead ?? 0) : ahead;
  const pushBehind = pushKnown ? (head.pushBehind ?? 0) : behind;
  // Only a detached HEAD disables: it is the one push failure provable from
  // local state alone (the daemon's `--set-upstream` path refuses it).
  // Everything the counts suggest — behind, diverged — is a last-fetch
  // snapshot about a remote whose acceptance also depends on refspecs and
  // reconciliation config, so those states warn on an enabled row and let
  // git give the authoritative answer on click.
  const pushDisabled = detached;
  if (blocker) {
    push = blocker;
  } else if (head?.pushGone === true) {
    // The destination is known and its ref is missing: a push publishes the
    // branch. Named ahead of the count branches so this never reads as
    // "Nothing to push".
    push = {
      text: t('branchPicker.hint.createsPushBranch', {
        target: head.pushTarget ?? '',
      }),
      tone: 'info',
    };
  } else if (pushSideUnknown) {
    // Git declined to name the destination; any number here would be a
    // pull-side count wearing a push-side label.
    push = undefined;
  } else if (hasUpstream === false && !pushKnown) {
    push = { text: t('branchPicker.hint.setsUpstream'), tone: 'info' };
  } else if (pushAhead > 0 && pushBehind > 0) {
    push = {
      text: t('branchPicker.hint.aheadBehind', {
        ahead: pushAhead,
        behind: pushBehind,
      }),
      tone: 'warning',
    };
  } else if (pushBehind > 0) {
    // Nothing to push and the destination is ahead: a push would be
    // rejected as it stands, so this is a warning rather than a dim row.
    push = { text: `↓${pushBehind}`, tone: 'warning' };
  } else if (pushAhead > 0) {
    push = { text: `↑${pushAhead}`, tone: 'info' };
  } else if (hasUpstream || pushKnown) {
    push = { text: t('branchPicker.hint.nothingToPush'), tone: 'muted' };
  }

  let commit: ActionHint | undefined;
  if (hasComputedTreeSummary(status)) {
    commit =
      changed > 0
        ? {
            text:
              s.untracked > 0
                ? t('branchPicker.hint.changesUntracked', {
                    count: changed,
                    untracked: s.untracked,
                  })
                : t('branchPicker.hint.changes', { count: changed }),
            tone: 'info',
          }
        : { text: t('branchPicker.hint.noChanges'), tone: 'muted' };
  }

  return { pull, pullDisabled, commit, push, pushDisabled };
}

/** Of two statuses, the one the daemon computed later (a missing stamp loses). */
function newerStatus(
  a: DaemonWorkspaceGitStatus | undefined,
  b: DaemonWorkspaceGitStatus | undefined,
): DaemonWorkspaceGitStatus | undefined {
  if (!a) return b;
  if (!b) return a;
  return (b.computedAt ?? -1) >= (a.computedAt ?? -1) ? b : a;
}

/**
 * True when a status disagrees with the branch listing on a field the hints
 * take from the listing — the signal that the listing is stale and should be
 * re-fetched. Exported for tests.
 */
export function listingContradictsStatus(
  data: DaemonGitBranchesResult,
  status: DaemonWorkspaceGitStatus,
): boolean {
  if (status.detached !== undefined && status.detached !== data.detached) {
    return true;
  }
  const head = data.local.find((b) => b.isHead);
  if (!head) return false;
  // The status cannot express a gone upstream (it reports the configured
  // tracking as present), so the listing's `upstreamGone` is not a
  // disagreement — only a genuinely set/unset upstream is.
  const upstreamComparable = !head.upstreamGone;
  return (
    (upstreamComparable &&
      status.hasUpstream !== undefined &&
      status.hasUpstream !== Boolean(head.upstream)) ||
    (status.ahead !== undefined && status.ahead !== head.ahead) ||
    (status.behind !== undefined && status.behind !== head.behind)
  );
}

export function BranchPickerPopover({
  open,
  onOpenChange,
  workspaceCwd,
  gitCwd,
  side = 'bottom',
  onBranchChanged,
  status,
  onStatusRefreshed,
  onOpenDiff,
  onOpenCommit,
  children,
}: BranchPickerPopoverProps) {
  const { t } = useI18n();
  const { client } = useWorkspace();
  const ws = useMemo(
    () => client.workspaceByCwd(workspaceCwd),
    [client, workspaceCwd],
  );
  const [data, setData] = useState<DaemonGitBranchesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<
    'info' | 'error' | 'success' | 'warning'
  >('info');
  const [search, setSearch] = useState('');
  const [newBranchMode, setNewBranchMode] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [checkoutRefMode, setCheckoutRefMode] = useState(false);
  const [checkoutRefValue, setCheckoutRefValue] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pullBlocked, setPullBlocked] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Daemon explanation shown in the panel instead of the fixed blocked line
  // when the refusal carried one worth reading — a discard the daemon
  // refused (force_unsupported). While set, the Discard action is hidden:
  // the daemon has declared it impossible for this workspace, so offering
  // it again could only loop the same refusal.
  const [pullBlockedDetail, setPullBlockedDetail] = useState<string | null>(
    null,
  );
  // Whether the footer currently shows a stash-restore warning: the only
  // signal that the user's changes sit in a stash entry, so it must survive
  // the reopen reset below even when the pull settled while closed.
  const stickyWarningRef = useRef(false);
  // The standing sticky warning while the remotes view is up: a remotes
  // mutation's own footer (add/remove status) would otherwise overwrite
  // the only in-product record of the stash entry AND disarm its flag.
  const remotesStickySnapshotRef = useRef<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    recent: false,
    local: false,
    remote: true,
    tags: true,
  });
  const [view, setView] = useState<'branches' | 'remotes'>('branches');
  const [remotes, setRemotes] = useState<DaemonGitRemoteInfo[] | null>(null);
  const [remotesLoading, setRemotesLoading] = useState(false);
  const [remotesError, setRemotesError] = useState<string | null>(null);
  const [remoteName, setRemoteName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  // The two-click remove confirm: holds the armed remote's name, or null.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // The row whose removal is in flight: busyAction only says a removal is
  // running, not which row, and the row needs that to show its spinner.
  const [removingName, setRemovingName] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Focus target when leaving the remotes view, so the view switch does not
  // drop keyboard focus to document.body.
  const manageRemotesRef = useRef<HTMLButtonElement>(null);
  // Set by closeRemotes and consumed once the branches view commits (the
  // target row is unmounted while the remotes view is up).
  const pendingManageFocusRef = useRef(false);
  // The add-form input that held focus when a mutation started: disabling
  // the inputs blurs them in real browsers, so focus is restored once the
  // mutation settles (see the busyAction effect below).
  const addFocusRestoreRef = useRef<string | null>(null);
  // The row whose removal is in flight: disabling every remove button
  // blurs the armed one, and success unmounts its row, so focus is
  // restored once the mutation settles (back button if the row is gone).
  const removeFocusRestoreRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  // Separate from requestIdRef: handleRemoteRemove calls fetchBranches,
  // which would otherwise invalidate the remotes request it is paired with.
  const remotesRequestIdRef = useRef(0);
  // Wall-clock time the current listing was received; lets a status the
  // daemon computed later trigger a listing re-fetch (see the effect below).
  const [listingFetchedAt, setListingFetchedAt] = useState<number>();
  // The popover's own on-open status fetch, so every entry point (sidebar
  // chip, composer chip, environment panel) sees fresh counters instead of
  // whatever its caller last polled.
  const [liveStatus, setLiveStatus] = useState<DaemonWorkspaceGitStatus>();
  const statusRequestIdRef = useRef(0);
  const reconciledAtRef = useRef<number | undefined>(undefined);
  // Held in a ref so an inline callback from the parent doesn't re-arm the
  // open effect on every render (callback → setState → render → refetch…).
  const onStatusRefreshedRef = useRef(onStatusRefreshed);
  onStatusRefreshedRef.current = onStatusRefreshed;
  // The busy state mirrored into a ref: the open effect reads it without
  // re-running the open reset on every mutation state flip.
  const busyActionRef = useRef(busyAction);
  busyActionRef.current = busyAction;

  // `silent` is the post-action refresh: the listing on screen is stale but
  // usable, so the refresh must neither raise the placeholder the render gate
  // swaps those rows for nor replace them with its own error.
  const fetchBranches = useCallback(
    async (silent = false) => {
      const requestId = ++requestIdRef.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const result = await ws.workspaceGitBranches(gitCwd);
        if (requestId !== requestIdRef.current) return;
        setData(result);
        setListingFetchedAt(Date.now());
      } catch (err) {
        if (requestId !== requestIdRef.current || silent) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [ws, gitCwd],
  );

  const fetchStatus = useCallback(async () => {
    const requestId = ++statusRequestIdRef.current;
    try {
      // Mirrors the app-level poll: a worktree `?cwd=` read always computes
      // directly, so `wait` only matters for the workspace root.
      const fresh = await ws.workspaceGit(
        gitCwd ? { cwd: gitCwd } : { wait: true },
      );
      if (requestId !== statusRequestIdRef.current) return;
      setLiveStatus(fresh);
      onStatusRefreshedRef.current?.(fresh);
    } catch {
      // Keep whatever the caller passed; the hints degrade to the listing.
    }
  }, [ws, gitCwd]);

  // Re-read the listing and the status together so the hints never mix a
  // fresh listing with a pre-action tree snapshot.
  const refreshAfterAction = useCallback(async () => {
    await fetchBranches(true);
    void fetchStatus();
  }, [fetchBranches, fetchStatus]);

  // A status or remotes list fetched for a previous workspace must not
  // seed the next one; focus the user lent to that workspace's controls
  // must not be restored onto the next workspace's panel either.
  useEffect(() => {
    setLiveStatus(undefined);
    statusRequestIdRef.current++;
    remotesRequestIdRef.current++;
    addFocusRestoreRef.current = null;
    removeFocusRestoreRef.current = null;
    remotesStickySnapshotRef.current = null;
  }, [ws, gitCwd]);

  const effectiveStatus = useMemo(
    () => newerStatus(status, liveStatus),
    [status, liveStatus],
  );

  useEffect(() => {
    if (open) {
      void fetchBranches();
      void fetchStatus();
      setSearch('');
      setNewBranchMode(false);
      setCheckoutRefMode(false);
      setNewBranchName('');
      setCheckoutRefValue('');
      setView('branches');
      setRemotes(null);
      setRemotesError(null);
      setRemoteName('');
      setRemoteUrl('');
      setConfirmRemove(null);
      // A dismissal while the remotes view was up (outside click, trigger
      // toggle) never runs closeRemotes, so the snapshot can still be
      // held here: restore it — message AND flag — rather than dropping
      // the only record of the stash entry. Gated on no in-flight
      // mutation: a settling mutation lands its own footer after this
      // restore would run, overwriting it — the held snapshot is
      // restored on a later open once the mutation has settled.
      if (!busyActionRef.current) {
        const stickySnapshot = remotesStickySnapshotRef.current;
        remotesStickySnapshotRef.current = null;
        // A warning armed at open time is the same warning the
        // snapshot holds (a view-up dismissal never disarms it) or a
        // newer one — either way the standing warning wins and the
        // held snapshot is dropped.
        if (stickySnapshot && !stickyWarningRef.current) {
          setStatusMsg(stickySnapshot);
          setStatusType('warning');
          stickyWarningRef.current = true;
        }
      }
      if (!stickyWarningRef.current) setStatusMsg(null);
      setPullBlocked(false);
      setConfirmDiscard(false);
      setPullBlockedDetail(null);
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, fetchBranches, fetchStatus]);

  // The listing is fetched once on open. If a status the daemon computed
  // after that disagrees with it (upstream unset, HEAD detached, new commits
  // from a terminal), re-fetch the listing so the rows follow the repo rather
  // than the snapshot — once per status, so a persistent disagreement can't
  // loop.
  useEffect(() => {
    if (!open || !data || !effectiveStatus || listingFetchedAt === undefined)
      return;
    const at = effectiveStatus.computedAt;
    if (at === undefined || at <= listingFetchedAt) return;
    if (reconciledAtRef.current === at) return;
    if (!listingContradictsStatus(data, effectiveStatus)) return;
    reconciledAtRef.current = at;
    void fetchBranches();
  }, [open, data, effectiveStatus, listingFetchedAt, fetchBranches]);

  // Radix's dismiss layer listens for Escape on the owner document in the
  // capture phase and checks only `event.key === 'Escape'` (no IME guard),
  // so a composition-cancelling Escape in the search/add inputs would both
  // tear down the view (or the popover) and — via the layer's
  // preventDefault — swallow the native composition cancel. Mask the key
  // from the capture-phase listener and restore it before the event
  // reaches the focused input, mirroring DialogShell.preserveImeEscape.
  useEffect(() => {
    if (!open) return;
    const preserveImeEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        (!event.isComposing && event.keyCode !== 229)
      ) {
        return;
      }
      Object.defineProperty(event, 'key', {
        configurable: true,
        value: 'Process',
      });
      document.addEventListener(
        'keydown',
        (currentEvent) => {
          if (currentEvent === event) Reflect.deleteProperty(event, 'key');
        },
        { capture: true, once: true },
      );
    };
    window.addEventListener('keydown', preserveImeEscape, { capture: true });
    return () => {
      window.removeEventListener('keydown', preserveImeEscape, {
        capture: true,
      });
    };
  }, [open]);

  const showStatus = useCallback(
    (msg: string, type: 'info' | 'error' | 'success' | 'warning' = 'info') => {
      setStatusMsg(msg);
      setStatusType(type);
      stickyWarningRef.current = type === 'warning';
    },
    [],
  );

  const clearPullPanel = useCallback(() => {
    setPullBlocked(false);
    setConfirmDiscard(false);
    setPullBlockedDetail(null);
    // The panel hides the status line while it is up; drop that stale
    // blocked message too so a competing action starts from a clean footer.
    setStatusMsg(null);
    stickyWarningRef.current = false;
  }, []);

  const handleCheckout = useCallback(
    async (ref: string) => {
      if (busyAction) return;
      clearPullPanel();
      setBusyAction('checkout');
      try {
        await ws.workspaceGitCheckout(ref, gitCwd);
        showStatus(t('branchPicker.checkedOut', { branch: ref }), 'success');
        onBranchChanged?.();
        onOpenChange(false);
      } catch (err) {
        showStatus(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setBusyAction(null);
      }
    },
    [
      ws,
      busyAction,
      gitCwd,
      onBranchChanged,
      onOpenChange,
      showStatus,
      clearPullPanel,
      t,
    ],
  );

  const handleNewBranch = useCallback(async () => {
    if (busyAction) return;
    if (!validateBranchName(newBranchName)) {
      // An empty name just means "not typed yet"; only explain the rejection
      // once the user has actually entered something invalid.
      if (newBranchName) {
        showStatus(t('branchPicker.invalidBranchName'), 'error');
      }
      return;
    }
    // Only an actual branch creation competes with the pull panel; a
    // rejected name leaves the resolution offer in place.
    clearPullPanel();
    setBusyAction('newBranch');
    try {
      await ws.workspaceGitCreateBranch(newBranchName, undefined, gitCwd);
      showStatus(
        t('branchPicker.createdBranch', { branch: newBranchName }),
        'success',
      );
      onBranchChanged?.();
      onOpenChange(false);
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyAction(null);
    }
  }, [
    ws,
    busyAction,
    gitCwd,
    newBranchName,
    onBranchChanged,
    onOpenChange,
    showStatus,
    clearPullPanel,
    t,
  ]);

  const handleCheckoutRef = useCallback(async () => {
    if (!checkoutRefValue.trim()) return;
    await handleCheckout(checkoutRefValue.trim());
  }, [checkoutRefValue, handleCheckout]);

  const handlePush = useCallback(async () => {
    if (busyAction) return;
    clearPullPanel();
    setBusyAction('push');
    try {
      const result = await ws.workspaceGitPush({ setUpstream: true }, gitCwd);
      showStatus(result.output || t('branchPicker.pushSuccess'), 'success');
      await fetchBranches();
      onBranchChanged?.();
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), 'error');
      // A rejected push moves no local ref, so this re-read only picks up a
      // fetch that landed elsewhere — git's message above is the authority on
      // why. Awaited so the row spinner stays up until the re-read lands.
      await refreshAfterAction();
    } finally {
      setBusyAction(null);
    }
  }, [
    ws,
    busyAction,
    gitCwd,
    refreshAfterAction,
    fetchBranches,
    onBranchChanged,
    showStatus,
    clearPullPanel,
    t,
  ]);

  const handlePull = useCallback(
    async (opts?: { stash?: boolean; force?: boolean }) => {
      if (busyAction) return;
      const action = opts?.stash
        ? 'pullStash'
        : opts?.force
          ? 'pullDiscard'
          : 'pull';
      setBusyAction(action);
      setStatusMsg(null);
      try {
        const result = await ws.workspaceGitPull(
          opts,
          gitCwd,
          GIT_PULL_FETCH_TIMEOUT_MS,
        );
        // The resolution panel stays mounted (with its button spinner) while
        // its own action is in flight; it only closes once the pull settles.
        clearPullPanel();
        if (result.stashRestoreConflict) {
          showStatus(
            t('branchPicker.pullStashConflict', {
              sha: result.stashSha ?? '',
            }),
            'warning',
          );
        } else if (result.stashKept) {
          // A kept or displaced stash entry: the output is the only record
          // of where it went, so render it sticky like the conflict case.
          showStatus(result.output, 'warning');
        } else {
          showStatus(result.output || t('branchPicker.pullSuccess'), 'success');
        }
        await fetchBranches();
        onBranchChanged?.();
      } catch (err) {
        if (isDirtyWorkingTreeError(err)) {
          setPullBlocked(true);
          setConfirmDiscard(false);
          setPullBlockedDetail(null);
          showStatus(t('branchPicker.pullBlocked'), 'error');
        } else if (isForceUnsupportedError(err)) {
          setPullBlocked(true);
          setConfirmDiscard(false);
          setPullBlockedDetail(pullErrorMessage(err));
          showStatus(t('branchPicker.pullBlocked'), 'error');
        } else {
          clearPullPanel();
          showStatus(pullErrorMessage(err), 'error');
        }
        // A failed pull has usually still fetched (the force-reset shape
        // self-heals here; a deleted upstream ref defeats the fetch itself
        // and needs a prune). Not awaited: the resolution panel this catch
        // just opened must not sit disabled for a listing round-trip it
        // never needed.
        void refreshAfterAction();
      } finally {
        setBusyAction(null);
      }
    },
    [
      ws,
      busyAction,
      gitCwd,
      fetchBranches,
      refreshAfterAction,
      onBranchChanged,
      showStatus,
      clearPullPanel,
      t,
    ],
  );

  // `silent` is the post-refusal re-read: the list on screen is stale but
  // usable, so the refresh must neither raise the placeholder the render
  // gate swaps those rows for nor replace them with its own error (same
  // contract fetchBranches states for its silent refresh).
  const fetchRemotes = useCallback(
    async (silent = false) => {
      const requestId = ++remotesRequestIdRef.current;
      if (!silent) setRemotesLoading(true);
      setRemotesError(null);
      try {
        const result = await ws.workspaceGitRemotes(gitCwd);
        if (requestId !== remotesRequestIdRef.current) return;
        setRemotes(result.remotes);
      } catch (err) {
        if (requestId !== remotesRequestIdRef.current) return;
        if (silent) return;
        setRemotesError(sanitizeRemoteDisplay(pullErrorMessage(err)));
      } finally {
        if (requestId === remotesRequestIdRef.current && !silent) {
          setRemotesLoading(false);
        }
      }
    },
    [ws, gitCwd],
  );

  // Only these daemon answers mean the displayed list is stale; every other
  // refusal (400 validation, 503 draining, transport failure) leaves the
  // usable list on screen and speaks through the footer alone.
  const mutationMeansStaleList = useCallback((err: unknown): boolean => {
    const code = daemonErrorBody(err)?.['error'];
    return (
      code === 'remote_already_exists' ||
      code === 'no_such_remote' ||
      code === 'remote_still_configured'
    );
  }, []);

  const openRemotes = useCallback(() => {
    // Only a standing pull-resolution panel competes with the remotes view;
    // an unrelated sticky warning (a kept stash entry) must survive the
    // round trip, per stickyWarningRef's contract — so snapshot it: a
    // remotes mutation's own footer would otherwise overwrite the message
    // and disarm the flag.
    if (pullBlocked) clearPullPanel();
    // Snapshot the standing warning only when one actually stands: a
    // snapshot held through a busy view-exit (a mutation settled after
    // the exit, disarming the flag) must not be nulled here before any
    // restore point consumes it.
    if (stickyWarningRef.current) {
      remotesStickySnapshotRef.current = statusMsg;
    }
    setNewBranchMode(false);
    setCheckoutRefMode(false);
    setConfirmRemove(null);
    // The query that found the "Manage Remotes…" action row must not carry
    // over as the remotes filter (typing "remote" to find the action would
    // otherwise open a panel filtered to nothing).
    setSearch('');
    setView('remotes');
    void fetchRemotes();
  }, [pullBlocked, clearPullPanel, fetchRemotes, statusMsg]);

  const closeRemotes = useCallback(() => {
    setView('branches');
    setConfirmRemove(null);
    setSearch('');
    // The row that opens the panel is unmounted while the remotes view is
    // up, so focus can only be restored after the branches view commits.
    pendingManageFocusRef.current = true;
    // Restore the sticky warning the view entry snapshotted — through
    // showStatus so the sticky flag is re-armed, not just the text. Not
    // while a mutation is in flight: its settle lands its own footer
    // after this restore would run, overwriting it — the held snapshot
    // is restored on the next open instead.
    if (!busyAction) {
      const snapshot = remotesStickySnapshotRef.current;
      remotesStickySnapshotRef.current = null;
      if (snapshot) showStatus(snapshot, 'warning');
    }
  }, [busyAction, showStatus]);

  useEffect(() => {
    if (view !== 'branches' || !pendingManageFocusRef.current) return;
    pendingManageFocusRef.current = false;
    // The row renders only when the listing and the action filter allow it;
    // fall back to the search box rather than leaving focus on the body.
    // A disabled button swallows focus(), and the row is disabled while a
    // mutation is in flight, so test focusability rather than presence.
    const target = manageRemotesRef.current;
    if (target && !target.disabled) target.focus();
    else searchRef.current?.focus();
  }, [view]);

  useEffect(() => {
    if (view !== 'remotes') {
      // A mutation left mid-view has no blurred control left to restore;
      // drop the refs so a later re-entry cannot consume them stale.
      addFocusRestoreRef.current = null;
      removeFocusRestoreRef.current = null;
      return;
    }
    if (busyAction !== null) return;
    // Dismissed mid-mutation: the content is unmounted, so a root-scoped
    // lookup would fall back to the whole document — and could steal
    // focus into ANOTHER popover instance's remotes view.
    if (!contentRef.current) {
      addFocusRestoreRef.current = null;
      removeFocusRestoreRef.current = null;
      return;
    }
    // Disabling the add inputs while the mutation ran blurred them; put
    // focus back once they are enabled again.
    const testId = addFocusRestoreRef.current;
    if (testId) {
      addFocusRestoreRef.current = null;
      const el = rootScope(contentRef.current).querySelector<HTMLElement>(
        `[data-testid="${testId}"]`,
      );
      const disabled =
        el instanceof HTMLInputElement || el instanceof HTMLButtonElement
          ? el.disabled
          : false;
      if (el && !disabled) el.focus();
      return;
    }
    // A remove that blurred its row's button: refocus it, or the panel's
    // back button when the row itself is gone (a successful removal).
    const removedName = removeFocusRestoreRef.current;
    if (!removedName) return;
    removeFocusRestoreRef.current = null;
    let target: HTMLElement | null = null;
    for (const button of rootScope(
      contentRef.current,
    ).querySelectorAll<HTMLButtonElement>('[data-testid^="remote-remove-"]')) {
      if (
        button.dataset.testid === `remote-remove-${removedName}` &&
        !button.disabled
      ) {
        target = button;
        break;
      }
    }
    (
      target ??
      rootScope(contentRef.current).querySelector<HTMLElement>(
        '[data-testid="remotes-back"]',
      )
    )?.focus();
  }, [busyAction, view]);

  const handleRemoteAdd = useCallback(async () => {
    if (busyAction) return;
    const name = remoteName.trim();
    const url = remoteUrl.trim();
    // UX-only guard against the obvious cases; the daemon remains the
    // authority on full name/URL validation and answers 400 with its own
    // message, which lands in the status bar below.
    if (!name || !url || name.startsWith('-') || url.startsWith('-')) {
      showStatus(t('branchPicker.remotes.invalidInput'), 'error');
      return;
    }
    const requestId = remotesRequestIdRef.current;
    setConfirmRemove(null);
    const active = getShadowAwareActiveElement(contentRef.current);
    addFocusRestoreRef.current =
      active instanceof HTMLElement &&
      (active.dataset.testid === 'remote-add-name' ||
        active.dataset.testid === 'remote-add-url' ||
        active.dataset.testid === 'remote-add-submit')
        ? active.dataset.testid
        : null;
    setBusyAction('remoteAdd');
    try {
      const result = await ws.workspaceGitRemoteAdd(
        name,
        url,
        gitCwd,
        GIT_REMOTE_MUTATION_FETCH_TIMEOUT_MS,
      );
      if (requestId !== remotesRequestIdRef.current) return;
      setRemotes(result.remotes);
      // A silent re-read issued before this mutation must not overwrite
      // the post-write list when it lands.
      remotesRequestIdRef.current++;
      setRemoteName('');
      setRemoteUrl('');
      // A standing filter could hide the row the success footer just
      // named.
      setSearch('');
      addFocusRestoreRef.current = 'remote-add-name';
      showStatus(
        t('branchPicker.remotes.added', {
          name: sanitizeRemoteDisplay(name),
        }),
        'success',
      );
    } catch (err) {
      if (requestId !== remotesRequestIdRef.current) return;
      // git echoes config-sourced names in its errors; the footer renders
      // verbatim, so sanitize at this display boundary too.
      showStatus(sanitizeRemoteDisplay(pullErrorMessage(err)), 'error');
      // A refused add can mean the list is stale (409 already-exists for a
      // remote the panel does not show); re-read silently so the panel
      // converges without tearing down the rows and the typed draft.
      if (mutationMeansStaleList(err)) void fetchRemotes(true);
    } finally {
      setBusyAction(null);
    }
  }, [
    ws,
    busyAction,
    gitCwd,
    remoteName,
    remoteUrl,
    fetchRemotes,
    mutationMeansStaleList,
    showStatus,
    t,
  ]);

  const handleRemoteRemove = useCallback(
    async (name: string) => {
      if (busyAction) return;
      const requestId = remotesRequestIdRef.current;
      setConfirmRemove(null);
      // Restore only focus the user actually lent: on platforms whose
      // buttons do not take focus on click (Safari) or on programmatic
      // triggers, the row button never held focus, so there is nothing to
      // restore and the settle effect must not yank focus elsewhere.
      const active = getShadowAwareActiveElement(contentRef.current);
      removeFocusRestoreRef.current =
        active instanceof HTMLElement &&
        active.dataset.testid === `remote-remove-${name}`
          ? name
          : null;
      setBusyAction('remoteRemove');
      setRemovingName(name);
      try {
        const result = await ws.workspaceGitRemoteRemove(
          name,
          gitCwd,
          GIT_REMOTE_MUTATION_FETCH_TIMEOUT_MS,
        );
        if (requestId !== remotesRequestIdRef.current) return;
        setRemotes(result.remotes);
        // A silent re-read issued before this mutation must not overwrite
        // the post-write list when it lands.
        remotesRequestIdRef.current++;
        showStatus(
          t('branchPicker.remotes.removed', {
            name: sanitizeRemoteDisplay(name),
          }),
          'success',
        );
        // Removal deletes refs/remotes/<name>/* and the tracking config of
        // any branch that pointed at it, so both the branch listing and the
        // chip's upstream state are stale now — refreshed in the
        // background: holding busyAction for a whole listing round trip
        // the remotes view never renders would leave focus parked on
        // document.body the entire time.
        void fetchBranches(true);
        void fetchStatus();
        onBranchChanged?.();
      } catch (err) {
        if (requestId !== remotesRequestIdRef.current) return;
        showStatus(sanitizeRemoteDisplay(pullErrorMessage(err)), 'error');
        // A refused remove usually means the list is stale (git answered
        // "No such remote" for a row still on screen — a terminal removed
        // it first); re-read silently so the panel converges instead of
        // offering the same doomed click forever. Awaited: the converged
        // list must commit before the settle effect restores focus, or the
        // restore lands on a row the re-read is about to unmount.
        if (mutationMeansStaleList(err)) await fetchRemotes(true);
        // git deletes refs/remotes/<name>/* and the pointing branches'
        // upstream config BEFORE the section write, so every refusal that
        // proves or leaves that destruction — no-such-remote (another
        // client already removed it, refs and all), a lock-failed write,
        // or a split section whose other half survives the verification —
        // leaves the branch list and the upstream chip stale as well.
        const code = daemonErrorBody(err)?.['error'];
        if (
          code === 'no_such_remote' ||
          code === 'git_config_write_failed' ||
          code === 'remote_still_configured'
        ) {
          void fetchBranches(true);
          void fetchStatus();
        }
      } finally {
        setBusyAction(null);
        setRemovingName(null);
      }
    },
    [
      ws,
      busyAction,
      gitCwd,
      fetchBranches,
      fetchStatus,
      fetchRemotes,
      mutationMeansStaleList,
      onBranchChanged,
      showStatus,
      t,
    ],
  );

  const q = search.toLowerCase().trim();

  const filterBranches = useCallback(
    (branches: DaemonGitBranchInfo[]) => {
      if (!q) return branches;
      return branches.filter((b) => b.name.toLowerCase().includes(q));
    },
    [q],
  );

  const filteredLocal = useMemo(
    () => (data ? filterBranches(data.local) : []),
    [data, filterBranches],
  );
  const filteredRemote = useMemo(
    () => (data ? filterBranches(data.remote) : []),
    [data, filterBranches],
  );
  const filteredTags = useMemo(() => {
    if (!data) return [];
    if (!q) return data.tags;
    return data.tags.filter((tg) => tg.name.toLowerCase().includes(q));
  }, [data, q]);
  const filteredRecent = useMemo(() => {
    if (!data) return [];
    if (!q) return data.recent;
    return data.recent.filter((r) => r.toLowerCase().includes(q));
  }, [data, q]);

  const remoteGroups = useMemo(() => {
    const groups = new Map<string, DaemonGitBranchInfo[]>();
    for (const b of filteredRemote) {
      const slash = b.name.indexOf('/');
      const remote = slash > 0 ? b.name.slice(0, slash) : 'other';
      let list = groups.get(remote);
      if (!list) {
        list = [];
        groups.set(remote, list);
      }
      list.push(b);
    }
    return groups;
  }, [filteredRemote]);

  const filteredRemotes = useMemo(() => {
    if (!remotes) return [];
    if (!q) return remotes;
    // Match the values the row actually renders (sanitized), on both sides:
    // a needle copied from a raw config string carries the same invisible
    // characters the row strips, so sanitize it too — and collapse
    // whitespace the way CSS inks it, so a needle copied from the row's
    // displayed (collapsed) text finds the row.
    const collapse = (v: string) => v.replace(/\s+/g, ' ');
    const needle = collapse(sanitizeRemoteDisplay(q)).toLowerCase();
    return remotes.filter(
      (r) =>
        collapse(sanitizeRemoteDisplay(r.name))
          .toLowerCase()
          .includes(needle) ||
        collapse(sanitizeRemoteDisplay(r.fetchUrl))
          .toLowerCase()
          .includes(needle) ||
        collapse(sanitizeRemoteDisplay(r.pushUrl))
          .toLowerCase()
          .includes(needle) ||
        collapse(sanitizeRemoteDisplay(remoteExtras(r, t)))
          .toLowerCase()
          .includes(needle),
    );
  }, [remotes, q, t]);

  // An armed confirm whose row left the rendered list (a search filter
  // hiding it) must not stay pre-armed for the next single click.
  useEffect(() => {
    if (
      confirmRemove !== null &&
      !filteredRemotes.some((r) => r.name === confirmRemove)
    ) {
      setConfirmRemove(null);
    }
  }, [filteredRemotes, confirmRemove]);

  const hints = useMemo(
    () => deriveActionHints(t, data, effectiveStatus),
    [t, data, effectiveStatus],
  );

  const actionsVisible =
    !q ||
    t('branchPicker.action.pull').toLowerCase().includes(q) ||
    t('branchPicker.action.push').toLowerCase().includes(q) ||
    t('branchPicker.action.commit').toLowerCase().includes(q) ||
    t('branchPicker.action.newBranch').toLowerCase().includes(q) ||
    t('branchPicker.action.checkoutRef').toLowerCase().includes(q) ||
    t('branchPicker.action.viewChanges').toLowerCase().includes(q) ||
    t('branchPicker.action.manageRemotes').toLowerCase().includes(q);

  useEffect(() => {
    if (!actionsVisible) {
      setNewBranchMode(false);
      setCheckoutRefMode(false);
    }
  }, [actionsVisible]);

  const toggleSection = useCallback(
    (key: SectionKey) =>
      setCollapsed((prev) => ({ ...prev, [key]: !prev[key] })),
    [],
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        className={styles.picker}
        side={side}
        align="start"
        sideOffset={4}
        // The content is portaled out of the composer, but React synthetic
        // clicks still bubble through the React tree to the composer
        // surface's onClick, which calls core.focus() and steals focus out
        // of the popover — Radix then dismisses it via focus-outside.
        // Stop the bubble so clicks inside keep focus in the popover
        // (mirrors the GitModePopover / ToolbarPopover pattern).
        onClick={(e) => e.stopPropagation()}
        onPointerDownOutside={(e) => {
          if (contentRef.current?.contains(e.target as Node)) {
            e.preventDefault();
          }
        }}
        // Escape leaves the nested remotes view first; only a second Escape
        // (from the branches view) dismisses the whole popover, so the typed
        // add draft is not destroyed by the key that means "go back". An
        // armed remove confirm gets its own tier first: the universal
        // cancel disarms the destructive confirm instead of throwing the
        // user out of the view.
        onEscapeKeyDown={(e) => {
          if (view === 'remotes') {
            e.preventDefault();
            if (confirmRemove !== null) setConfirmRemove(null);
            else closeRemotes();
          }
        }}
      >
        <div className={styles.searchWrap}>
          <SearchIcon size={14} className={styles.searchIcon} />
          <input
            ref={searchRef}
            className={styles.searchInput}
            placeholder={
              view === 'remotes'
                ? t('branchPicker.remotes.searchPlaceholder')
                : t('branchPicker.search')
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid={view === 'remotes' ? 'remotes-search' : undefined}
          />
        </div>

        <div className={styles.list}>
          {view === 'remotes' ? (
            <RemotesView
              remotes={filteredRemotes}
              totalCount={remotes?.length ?? 0}
              loading={remotesLoading}
              error={remotesError}
              busyAction={busyAction}
              removingName={removingName}
              confirmRemove={confirmRemove}
              onConfirmRemove={setConfirmRemove}
              onRemove={(name) => void handleRemoteRemove(name)}
              name={remoteName}
              url={remoteUrl}
              onNameChange={setRemoteName}
              onUrlChange={setRemoteUrl}
              onAdd={() => void handleRemoteAdd()}
              onBack={closeRemotes}
            />
          ) : (
            <>
              {loading && (
                <div className={styles.loading}>
                  {t('branchPicker.loading')}
                </div>
              )}
              {error && <div className={styles.empty}>{error}</div>}

              {!loading && !error && data && (
                <>
                  {actionsVisible && (
                    <>
                      <button
                        type="button"
                        className={`${styles.actionItem} ${hints.pull?.tone === 'muted' ? styles.actionItemMuted : ''}`}
                        disabled={!!busyAction || hints.pullDisabled}
                        onClick={() => void handlePull()}
                        data-testid="branch-picker-pull"
                      >
                        {busyAction === 'pull' ? (
                          <Loader2Icon
                            size={14}
                            className={`${styles.actionIcon} ${styles.spin}`}
                          />
                        ) : (
                          <ArrowDownToLineIcon
                            size={14}
                            className={styles.actionIcon}
                          />
                        )}
                        <span className={styles.actionLabel}>
                          {t('branchPicker.action.pull')}
                        </span>
                        <ActionHintLabel hint={hints.pull} />
                      </button>
                      {onOpenCommit && (
                        <button
                          type="button"
                          className={`${styles.actionItem} ${hints.commit?.tone === 'muted' ? styles.actionItemMuted : ''}`}
                          disabled={!!busyAction}
                          onClick={() => {
                            onOpenCommit();
                            onOpenChange(false);
                          }}
                          data-testid="branch-picker-commit"
                        >
                          <GitCommitIcon
                            size={14}
                            className={styles.actionIcon}
                          />
                          <span className={styles.actionLabel}>
                            {t('branchPicker.action.commit')}
                          </span>
                          <ActionHintLabel hint={hints.commit} />
                        </button>
                      )}
                      <button
                        type="button"
                        className={`${styles.actionItem} ${hints.push?.tone === 'muted' ? styles.actionItemMuted : ''}`}
                        disabled={!!busyAction || hints.pushDisabled}
                        onClick={() => void handlePush()}
                        data-testid="branch-picker-push"
                      >
                        {busyAction === 'push' ? (
                          <Loader2Icon
                            size={14}
                            className={`${styles.actionIcon} ${styles.spin}`}
                          />
                        ) : (
                          <ArrowUpFromLineIcon
                            size={14}
                            className={styles.actionIcon}
                          />
                        )}
                        <span className={styles.actionLabel}>
                          {t('branchPicker.action.push')}
                        </span>
                        <ActionHintLabel hint={hints.push} />
                      </button>
                      {onOpenDiff && (
                        <button
                          type="button"
                          className={styles.actionItem}
                          onClick={() => {
                            onOpenDiff();
                            onOpenChange(false);
                          }}
                        >
                          <FileDiffIcon
                            size={14}
                            className={styles.actionIcon}
                          />
                          <span className={styles.actionLabel}>
                            {t('branchPicker.action.viewChanges')}
                          </span>
                        </button>
                      )}

                      <div className={styles.separator} />

                      <button
                        type="button"
                        className={styles.actionItem}
                        onClick={() => {
                          setNewBranchMode(!newBranchMode);
                          setCheckoutRefMode(false);
                        }}
                      >
                        <PlusIcon size={14} className={styles.actionIcon} />
                        <span className={styles.actionLabel}>
                          {t('branchPicker.action.newBranch')}
                        </span>
                      </button>
                      {newBranchMode && (
                        <div className={styles.inlineInput}>
                          <input
                            className={`${styles.inlineInputField} ${
                              newBranchName &&
                              !validateBranchName(newBranchName)
                                ? styles.inlineInputFieldInvalid
                                : ''
                            }`}
                            placeholder={t('branchPicker.newBranchPlaceholder')}
                            value={newBranchName}
                            onChange={(e) => setNewBranchName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleNewBranch();
                              if (e.key === 'Escape') setNewBranchMode(false);
                            }}
                            autoFocus
                          />
                        </div>
                      )}

                      <button
                        type="button"
                        className={styles.actionItem}
                        onClick={() => {
                          setCheckoutRefMode(!checkoutRefMode);
                          setNewBranchMode(false);
                        }}
                      >
                        <TagIcon size={14} className={styles.actionIcon} />
                        <span className={styles.actionLabel}>
                          {t('branchPicker.action.checkoutRef')}
                        </span>
                      </button>
                      {checkoutRefMode && (
                        <div className={styles.inlineInput}>
                          <input
                            className={styles.inlineInputField}
                            placeholder={t(
                              'branchPicker.checkoutRefPlaceholder',
                            )}
                            value={checkoutRefValue}
                            onChange={(e) =>
                              setCheckoutRefValue(e.target.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleCheckoutRef();
                              if (e.key === 'Escape') setCheckoutRefMode(false);
                            }}
                            autoFocus
                          />
                        </div>
                      )}

                      <button
                        type="button"
                        ref={manageRemotesRef}
                        className={styles.actionItem}
                        disabled={!!busyAction}
                        onClick={openRemotes}
                        data-testid="branch-picker-manage-remotes"
                      >
                        <GlobeIcon size={14} className={styles.actionIcon} />
                        <span className={styles.actionLabel}>
                          {t('branchPicker.action.manageRemotes')}
                        </span>
                      </button>

                      <div className={styles.separator} />
                    </>
                  )}

                  {filteredRecent.length > 0 && (
                    <BranchSection
                      label={t('branchPicker.section.recent')}
                      sectionKey="recent"
                      collapsed={collapsed.recent}
                      onToggle={toggleSection}
                    >
                      {filteredRecent.map((name) => (
                        <BranchItem
                          key={name}
                          name={name}
                          isHead={name === data.head && !data.detached}
                          onClick={() => void handleCheckout(name)}
                        />
                      ))}
                    </BranchSection>
                  )}

                  <BranchSection
                    label={t('branchPicker.section.local')}
                    sectionKey="local"
                    collapsed={collapsed.local}
                    onToggle={toggleSection}
                  >
                    {filteredLocal.length === 0 ? (
                      <div className={styles.empty}>
                        {t('branchPicker.noBranches')}
                      </div>
                    ) : (
                      filteredLocal.map((b) => (
                        <BranchItem
                          key={b.name}
                          name={b.name}
                          isHead={b.isHead}
                          ahead={b.ahead}
                          behind={b.behind}
                          upstream={b.upstream}
                          onClick={() => void handleCheckout(b.name)}
                        />
                      ))
                    )}
                  </BranchSection>

                  <BranchSection
                    label={t('branchPicker.section.remote')}
                    sectionKey="remote"
                    collapsed={collapsed.remote}
                    onToggle={toggleSection}
                  >
                    {filteredRemote.length === 0 ? (
                      <div className={styles.empty}>
                        {t('branchPicker.noBranches')}
                      </div>
                    ) : (
                      Array.from(remoteGroups.entries()).map(
                        ([remote, branches]) => (
                          <div key={remote}>
                            <div className={styles.remoteGroupLabel}>
                              {remote}
                            </div>
                            {branches.map((b) => {
                              const slash = b.name.indexOf('/');
                              const localName =
                                slash > 0 ? b.name.slice(slash + 1) : b.name;
                              return (
                                <BranchItem
                                  key={b.name}
                                  name={localName}
                                  isHead={false}
                                  onClick={() => void handleCheckout(b.name)}
                                />
                              );
                            })}
                          </div>
                        ),
                      )
                    )}
                  </BranchSection>

                  <BranchSection
                    label={t('branchPicker.section.tags')}
                    sectionKey="tags"
                    collapsed={collapsed.tags}
                    onToggle={toggleSection}
                  >
                    {filteredTags.length === 0 ? (
                      <div className={styles.empty}>
                        {t('branchPicker.noTags')}
                      </div>
                    ) : (
                      filteredTags.map((tg) => (
                        <button
                          key={tg.name}
                          type="button"
                          className={styles.item}
                          onClick={() =>
                            void handleCheckout(`refs/tags/${tg.name}`)
                          }
                        >
                          <TagIcon size={13} className={styles.itemIcon} />
                          <span className={styles.itemName}>{tg.name}</span>
                        </button>
                      ))
                    )}
                  </BranchSection>
                </>
              )}
            </>
          )}
        </div>

        {pullBlocked ? (
          <div className={styles.pullBlocked}>
            <div className={styles.pullBlockedMessage}>
              {pullBlockedDetail ?? t('branchPicker.pullBlocked')}
            </div>
            {confirmDiscard ? (
              <>
                <div className={styles.pullBlockedHint}>
                  {t('branchPicker.pullDiscardConfirm')}
                </div>
                <div className={styles.pullBlockedActions}>
                  <button
                    type="button"
                    className={`${styles.pullBlockedButton} ${styles.pullBlockedButtonDanger}`}
                    disabled={!!busyAction}
                    onClick={() => void handlePull({ force: true })}
                  >
                    {busyAction === 'pullDiscard' && (
                      <Loader2Icon size={13} className={styles.spin} />
                    )}
                    {t('branchPicker.pullDiscardGo')}
                  </button>
                  <button
                    type="button"
                    className={styles.pullBlockedButton}
                    disabled={!!busyAction}
                    onClick={() => setConfirmDiscard(false)}
                  >
                    {t('branchPicker.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.pullBlockedActions}>
                <button
                  type="button"
                  className={styles.pullBlockedButton}
                  disabled={!!busyAction}
                  onClick={() => void handlePull({ stash: true })}
                >
                  {busyAction === 'pullStash' ? (
                    <Loader2Icon size={13} className={styles.spin} />
                  ) : (
                    <ArrowDownToLineIcon size={13} />
                  )}
                  {t('branchPicker.pullStash')}
                </button>
                {pullBlockedDetail === null && (
                  <button
                    type="button"
                    className={`${styles.pullBlockedButton} ${styles.pullBlockedButtonDanger}`}
                    disabled={!!busyAction}
                    onClick={() => setConfirmDiscard(true)}
                  >
                    {t('branchPicker.pullDiscard')}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.pullBlockedButton}
                  disabled={!!busyAction}
                  onClick={() => clearPullPanel()}
                >
                  {t('branchPicker.cancel')}
                </button>
              </div>
            )}
          </div>
        ) : (
          statusMsg && (
            <div
              className={`${styles.statusBar} ${
                statusType === 'error'
                  ? styles.statusBarError
                  : statusType === 'success'
                    ? styles.statusBarSuccess
                    : statusType === 'warning'
                      ? styles.statusBarWarning
                      : ''
              }`}
            >
              {statusMsg}
            </div>
          )
        )}
      </PopoverContent>
    </Popover>
  );
}

function ActionHintLabel({ hint }: { hint?: ActionHint }) {
  if (!hint) return null;
  return (
    <span
      className={styles.actionHint}
      data-tone={hint.tone}
      data-testid="branch-picker-action-hint"
    >
      {hint.text}
    </span>
  );
}

function BranchSection({
  label,
  sectionKey: _key,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  sectionKey: SectionKey;
  collapsed: boolean;
  onToggle: (key: SectionKey) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.sectionHeader}
        aria-expanded={!collapsed}
        onClick={() => onToggle(_key)}
      >
        <ChevronRightIcon
          size={12}
          className={`${styles.sectionChevron} ${
            collapsed ? styles.sectionChevronCollapsed : ''
          }`}
        />
        {label}
      </button>
      {!collapsed && children}
    </div>
  );
}

function BranchItem({
  name,
  isHead,
  ahead,
  behind,
  upstream,
  onClick,
}: {
  name: string;
  isHead: boolean;
  ahead?: number;
  behind?: number;
  upstream?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.item} ${isHead ? styles.itemActive : ''}`}
      onClick={onClick}
    >
      {isHead ? (
        <StarIcon
          size={13}
          className={`${styles.itemIcon} ${styles.itemStar}`}
        />
      ) : (
        <GitBranchIcon size={13} className={styles.itemIcon} />
      )}
      <span className={styles.itemName}>{name}</span>
      <span className={styles.itemMeta}>
        {(ahead ?? 0) > 0 || (behind ?? 0) > 0 ? (
          <span className={styles.itemAheadBehind}>
            {(ahead ?? 0) > 0 && <span>↑{ahead}</span>}
            {(behind ?? 0) > 0 && <span>↓{behind}</span>}
          </span>
        ) : null}
        {upstream && <span className={styles.itemUpstream}>{upstream}</span>}
        {isHead && <CheckIcon size={12} />}
      </span>
    </button>
  );
}

function RemotesView({
  remotes,
  totalCount,
  loading,
  error,
  busyAction,
  removingName,
  confirmRemove,
  onConfirmRemove,
  onRemove,
  name,
  url,
  onNameChange,
  onUrlChange,
  onAdd,
  onBack,
}: {
  remotes: DaemonGitRemoteInfo[];
  /** Pre-search count, so a filtered-to-empty list does not claim the
   * repository has no remotes at all. */
  totalCount: number;
  loading: boolean;
  error: string | null;
  busyAction: string | null;
  removingName: string | null;
  confirmRemove: string | null;
  onConfirmRemove: (name: string) => void;
  onRemove: (name: string) => void;
  name: string;
  url: string;
  onNameChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  onAdd: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const backRef = useRef<HTMLButtonElement>(null);
  // The view replaces the branch list, so focus must land inside it rather
  // than on the unmounted rows' former position (document.body).
  useEffect(() => {
    backRef.current?.focus();
  }, []);
  return (
    <>
      <div className={styles.remotesHeader}>
        <button
          type="button"
          ref={backRef}
          className={styles.backButton}
          onClick={onBack}
          aria-label={t('branchPicker.remotes.back')}
          data-testid="remotes-back"
        >
          <ArrowLeftIcon size={14} />
        </button>
        <span className={styles.remotesTitle}>
          {t('branchPicker.remotes.title')}
        </span>
      </div>
      {loading && (
        <div className={styles.loading}>
          {t('branchPicker.remotes.loading')}
        </div>
      )}
      {error && <div className={styles.empty}>{error}</div>}
      {!loading && !error && (
        <>
          {remotes.length === 0 ? (
            <div className={styles.empty}>
              {totalCount === 0
                ? t('branchPicker.remotes.empty')
                : t('branchPicker.remotes.noMatches')}
            </div>
          ) : (
            remotes.map((r) => {
              const displayName = sanitizeRemoteDisplay(r.name);
              // A config-held name can sanitize to the same text as a
              // sibling row (origin vs ori\u200bgin): flag every row whose
              // rendered text differs from its raw name, and carry the
              // escaped raw name into the tooltip and the aria-labels so
              // two lookalikes never present one identity. CSS also
              // collapses edge and repeated whitespace out of the inked
              // text, so a name differing only by whitespace (origin vs
              // "origin ") flags the same way. Two more structural
              // arms, because the class list alone has no last corner:
              // canonical-equivalence twins (an NFD name inks like its
              // NFC twin), and a Latin name mixing in another script's
              // letters (the Cyrillic-`о` homoglyph shape). Both mark
              // the UNUSUAL row, keeping the house polarity: a plain
              // sibling row stays unmarked.
              const nfcName = r.name.normalize('NFC');
              const mixedScripts =
                /\p{Script=Latin}/u.test(r.name) &&
                /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(
                  r.name,
                );
              const hiddenChars =
                displayName !== r.name ||
                r.name.replace(/\s+/g, ' ').trim() !== r.name ||
                nfcName !== r.name ||
                mixedScripts;
              // The marker's visible part shows the name as CSS inks it
              // (whitespace collapsed, edges trimmed) so the raw name's
              // padding does not double the separator before the marker;
              // the raw name itself is in the tooltip/aria escapes.
              const visibleName = displayName.replace(/\s+/g, ' ').trim();
              const rowName = hiddenChars
                ? visibleName
                  ? `${visibleName} ${t('branchPicker.remotes.hiddenChars')}`
                  : t('branchPicker.remotes.invisibleName')
                : displayName;
              const escapedName = hiddenChars
                ? escapeNameChars(r.name, nfcName !== r.name || mixedScripts)
                : undefined;
              const ariaName = escapedName
                ? `${rowName} ${escapedName}`
                : rowName;
              const fetchDisplay = sanitizeRemoteDisplay(r.fetchUrl);
              const pushDisplay = sanitizeRemoteDisplay(r.pushUrl);
              // Same lookalike treatment as the name: two URLs that differ
              // only by invisible characters OR whitespace must not
              // tooltip identically (CSS collapses the latter out of the
              // inked text, so the tooltip carries the escapes).
              const fetchTitle =
                fetchDisplay === r.fetchUrl &&
                r.fetchUrl.replace(/\s+/g, ' ').trim() === r.fetchUrl
                  ? fetchDisplay
                  : escapeNameChars(r.fetchUrl);
              const pushTitle =
                pushDisplay === r.pushUrl &&
                r.pushUrl.replace(/\s+/g, ' ').trim() === r.pushUrl
                  ? pushDisplay
                  : escapeNameChars(r.pushUrl);
              const extras = remoteExtras(r, t);
              return (
                <div
                  key={r.name}
                  className={styles.remoteRow}
                  data-testid="remote-row"
                >
                  <GlobeIcon size={13} className={styles.itemIcon} />
                  <span
                    className={styles.remoteName}
                    title={escapedName ?? displayName}
                    data-testid="remote-name"
                  >
                    {rowName}
                  </span>
                  {extras && (
                    <span
                      className={styles.remoteBadge}
                      title={extras}
                      data-testid="remote-badge"
                    >
                      {extras}
                    </span>
                  )}
                  <span
                    className={styles.remoteUrl}
                    data-testid="remote-url"
                    title={
                      r.pushUrl !== r.fetchUrl
                        ? `${t('branchPicker.remotes.urlTooltipFetch', { url: fetchTitle })}\n${t('branchPicker.remotes.urlTooltipPush', { url: pushTitle })}`
                        : fetchTitle
                    }
                  >
                    {fetchDisplay}
                  </span>
                  <button
                    type="button"
                    className={`${styles.remoteRemove} ${
                      confirmRemove === r.name ? styles.remoteRemoveConfirm : ''
                    }`}
                    disabled={!!busyAction}
                    onClick={() =>
                      confirmRemove === r.name
                        ? onRemove(r.name)
                        : onConfirmRemove(r.name)
                    }
                    aria-label={
                      confirmRemove === r.name
                        ? t('branchPicker.remotes.removeConfirmFor', {
                            name: ariaName,
                            extras,
                          })
                        : t('branchPicker.remotes.remove', {
                            name: ariaName,
                          })
                    }
                    data-testid={`remote-remove-${r.name}`}
                  >
                    {busyAction === 'remoteRemove' &&
                    removingName === r.name ? (
                      <Loader2Icon size={13} className={styles.spin} />
                    ) : confirmRemove === r.name ? (
                      t('branchPicker.remotes.removeConfirm')
                    ) : (
                      <Trash2Icon size={13} />
                    )}
                  </button>
                </div>
              );
            })
          )}
          <div className={styles.addRemoteForm} data-testid="remote-add-form">
            <input
              className={styles.inlineInputField}
              placeholder={t('branchPicker.remotes.namePlaceholder')}
              value={name}
              disabled={!!busyAction}
              onChange={(e) => onNameChange(e.target.value)}
              onKeyDown={(e) => {
                // An IME-owned Enter commits the composition, not the
                // form (WebKit marks it keyCode 229 while isComposing is
                // still false — the house guard shape).
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                  return;
                if (e.key === 'Enter' && name.trim() && url.trim()) onAdd();
              }}
              spellCheck={false}
              autoComplete="off"
              data-testid="remote-add-name"
            />
            <input
              className={styles.inlineInputField}
              placeholder={t('branchPicker.remotes.urlPlaceholder')}
              value={url}
              disabled={!!busyAction}
              onChange={(e) => onUrlChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                  return;
                if (e.key === 'Enter' && name.trim() && url.trim()) onAdd();
              }}
              spellCheck={false}
              autoComplete="off"
              data-testid="remote-add-url"
            />
            <button
              type="button"
              className={styles.addRemoteButton}
              disabled={!!busyAction || !name.trim() || !url.trim()}
              onClick={onAdd}
              data-testid="remote-add-submit"
            >
              {busyAction === 'remoteAdd' ? (
                <Loader2Icon size={13} className={styles.spin} />
              ) : (
                <PlusIcon size={13} />
              )}
              {t('branchPicker.remotes.add')}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * What removal would destroy beyond the URL the row shows: git deletes the
 * whole `remote.<name>` section, and re-adding restores only the URL and
 * git's default refspec. Surfaced on the row so the two-click confirm names
 * the consequence instead of certifying a lossless round trip.
 */
function remoteExtras(
  r: DaemonGitRemoteInfo,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const parts: string[] = [];
  // The filter is destroyed by removal even when the promisor flag itself
  // is unset, so the badge gates on either half of the pair.
  if (r.promisor || r.partialCloneFilter) {
    parts.push(
      r.partialCloneFilter
        ? t('branchPicker.remotes.partialClone', {
            // Config-sourced string: sanitize at the render boundary like
            // every other value on the row.
            filter: sanitizeRemoteDisplay(r.partialCloneFilter),
          })
        : t('branchPicker.remotes.promisor'),
    );
  }
  if (r.customRefspec) parts.push(t('branchPicker.remotes.customRefspec'));
  if (r.extraFetchUrls > 0 || r.extraPushUrls > 0) {
    parts.push(
      t('branchPicker.remotes.extraUrls', {
        count: r.extraFetchUrls + r.extraPushUrls,
      }),
    );
  }
  if (r.otherSettings > 0) {
    parts.push(
      t('branchPicker.remotes.otherSettings', { count: r.otherSettings }),
    );
  }
  return parts.join(' · ');
}
