/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonGitBranchesResult,
  DaemonGitBranchInfo,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  ChevronRightIcon,
  GitBranchIcon,
  GitCommitIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  TagIcon,
  FileDiffIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { validateBranchName } from './GitModePopover';
import { deriveStatus, hasComputedTreeSummary } from './GitBranchIndicator';
import styles from './BranchPickerPopover.module.css';

interface BranchPickerPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceCwd: string;
  gitCwd?: string;
  gitSessionId?: string;
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
 * Disabling is reserved for what git itself refuses: `git pull` during a
 * merge/rebase/cherry-pick, with unmerged entries, on a detached HEAD, or
 * without a usable upstream; `git push --set-upstream` only on a detached
 * HEAD (a push does not consult the index, so conflicts and in-progress
 * operations are shown as warnings on an enabled row). Soft states (up to
 * date, nothing to push, clean tree) only dim the row since the action is
 * still harmless.
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
  // Only a detached HEAD makes the daemon's `git push --set-upstream` fail;
  // an in-progress operation or conflicts are surfaced but left clickable.
  const pushDisabled = detached;
  if (blocker) {
    push = blocker;
  } else if (hasUpstream === false) {
    push = { text: t('branchPicker.hint.setsUpstream'), tone: 'info' };
  } else if (ahead > 0 && behind > 0) {
    push = {
      text: t('branchPicker.hint.aheadBehind', { ahead, behind }),
      tone: 'warning',
    };
  } else if (ahead > 0) {
    push = { text: `↑${ahead}`, tone: 'info' };
  } else if (hasUpstream) {
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
  gitSessionId,
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
  const [statusType, setStatusType] = useState<'info' | 'error' | 'success'>(
    'info',
  );
  const [search, setSearch] = useState('');
  const [newBranchMode, setNewBranchMode] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [checkoutRefMode, setCheckoutRefMode] = useState(false);
  const [checkoutRefValue, setCheckoutRefValue] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    recent: false,
    local: false,
    remote: true,
    tags: true,
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
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

  const fetchBranches = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await ws.workspaceGitBranches(gitCwd, gitSessionId);
      if (requestId !== requestIdRef.current) return;
      setData(result);
      setListingFetchedAt(Date.now());
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [ws, gitCwd, gitSessionId]);

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

  // A status fetched for a previous workspace must not seed the next one.
  useEffect(() => {
    setLiveStatus(undefined);
    statusRequestIdRef.current++;
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
      setStatusMsg(null);
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

  const showStatus = useCallback(
    (msg: string, type: 'info' | 'error' | 'success' = 'info') => {
      setStatusMsg(msg);
      setStatusType(type);
    },
    [],
  );

  const handleCheckout = useCallback(
    async (ref: string) => {
      if (busyAction) return;
      setBusyAction('checkout');
      try {
        await ws.workspaceGitCheckout(ref, gitCwd, gitSessionId);
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
      gitSessionId,
      onBranchChanged,
      onOpenChange,
      showStatus,
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
    setBusyAction('newBranch');
    try {
      await ws.workspaceGitCreateBranch(
        newBranchName,
        undefined,
        gitCwd,
        gitSessionId,
      );
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
    gitSessionId,
    newBranchName,
    onBranchChanged,
    onOpenChange,
    showStatus,
    t,
  ]);

  const handleCheckoutRef = useCallback(async () => {
    if (!checkoutRefValue.trim()) return;
    await handleCheckout(checkoutRefValue.trim());
  }, [checkoutRefValue, handleCheckout]);

  const handlePush = useCallback(async () => {
    if (busyAction) return;
    setBusyAction('push');
    try {
      const result = await ws.workspaceGitPush(
        { setUpstream: true },
        gitCwd,
        gitSessionId,
      );
      showStatus(result.output || t('branchPicker.pushSuccess'), 'success');
      await fetchBranches();
      onBranchChanged?.();
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyAction(null);
    }
  }, [
    ws,
    busyAction,
    gitCwd,
    gitSessionId,
    fetchBranches,
    onBranchChanged,
    showStatus,
    t,
  ]);

  const handlePull = useCallback(async () => {
    if (busyAction) return;
    setBusyAction('pull');
    try {
      const result = await ws.workspaceGitPull(undefined, gitCwd, gitSessionId);
      showStatus(result.output || t('branchPicker.pullSuccess'), 'success');
      await fetchBranches();
      onBranchChanged?.();
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyAction(null);
    }
  }, [
    ws,
    busyAction,
    gitCwd,
    gitSessionId,
    fetchBranches,
    onBranchChanged,
    showStatus,
    t,
  ]);

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
    t('branchPicker.action.viewChanges').toLowerCase().includes(q);

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
      >
        <div className={styles.searchWrap}>
          <SearchIcon size={14} className={styles.searchIcon} />
          <input
            ref={searchRef}
            className={styles.searchInput}
            placeholder={t('branchPicker.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className={styles.list}>
          {loading && (
            <div className={styles.loading}>{t('branchPicker.loading')}</div>
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
                      <GitCommitIcon size={14} className={styles.actionIcon} />
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
                      <FileDiffIcon size={14} className={styles.actionIcon} />
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
                          newBranchName && !validateBranchName(newBranchName)
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
                        placeholder={t('branchPicker.checkoutRefPlaceholder')}
                        value={checkoutRefValue}
                        onChange={(e) => setCheckoutRefValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleCheckoutRef();
                          if (e.key === 'Escape') setCheckoutRefMode(false);
                        }}
                        autoFocus
                      />
                    </div>
                  )}

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
                        <div className={styles.remoteGroupLabel}>{remote}</div>
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
                  <div className={styles.empty}>{t('branchPicker.noTags')}</div>
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
        </div>

        {statusMsg && (
          <div
            className={`${styles.statusBar} ${
              statusType === 'error'
                ? styles.statusBarError
                : statusType === 'success'
                  ? styles.statusBarSuccess
                  : ''
            }`}
          >
            {statusMsg}
          </div>
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
