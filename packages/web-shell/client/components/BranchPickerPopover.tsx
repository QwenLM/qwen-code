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
import styles from './BranchPickerPopover.module.css';

interface BranchPickerPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceCwd: string;
  gitCwd?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  onBranchChanged?: () => void;
  /**
   * Live working-tree summary from the trigger chip. Drives the hints beside
   * the Update / Commit / Push actions (dirty counts, in-progress operation);
   * ahead/behind/upstream prefer the branch listing fetched on open, which is
   * fresher than the chip's polled snapshot.
   */
  status?: DaemonWorkspaceGitStatus;
  /** Invoked when the popover opens so the caller can refresh `status`. */
  onRefreshStatus?: () => void;
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
 * can judge before clicking. Hard blockers (in-progress merge/rebase,
 * conflicts, detached HEAD, pull without upstream) disable the action because
 * the daemon would reject it anyway; soft states (up to date, nothing to push,
 * clean tree) only dim the row since the action is still harmless.
 *
 * Exported for tests.
 */
export function deriveActionHints(
  t: TranslateFn,
  data: DaemonGitBranchesResult | null,
  status: DaemonWorkspaceGitStatus | undefined,
): ActionHints {
  const head = data?.local.find((b) => b.isHead);
  const detached = data?.detached ?? status?.detached ?? false;
  const operation = status?.operation;
  const conflicted = status?.conflicted ?? 0;
  // The branch listing is fetched on open, so it wins over the polled status.
  const ahead = head?.ahead ?? status?.ahead ?? 0;
  const behind = head?.behind ?? status?.behind ?? 0;
  const upstream = head?.upstream;
  const hasUpstream: boolean | undefined = head
    ? Boolean(head.upstream)
    : status?.hasUpstream;
  // Dirty counts only exist on v2 status; `computedAt` marks that the enriched
  // fields were actually computed rather than defaulted.
  const hasTreeSummary = status?.computedAt !== undefined;
  const staged = status?.staged ?? 0;
  const unstaged = status?.unstaged ?? 0;
  const untracked = status?.untracked ?? 0;
  const changed = staged + unstaged + untracked + conflicted;

  const blocker: ActionHint | undefined = operation
    ? { text: t(`git.operation.${operation}`), tone: 'warning' }
    : conflicted > 0
      ? { text: t('git.conflicted', { count: conflicted }), tone: 'warning' }
      : detached
        ? { text: t('git.detached'), tone: 'warning' }
        : undefined;

  let pull: ActionHint | undefined;
  let pullDisabled = false;
  if (blocker) {
    pull = blocker;
    pullDisabled = true;
  } else if (hasUpstream === false) {
    pull = { text: t('branchPicker.hint.noUpstream'), tone: 'muted' };
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
  let pushDisabled = false;
  if (blocker) {
    push = blocker;
    pushDisabled = true;
  } else if (hasUpstream === false) {
    push = { text: t('branchPicker.hint.willCreateUpstream'), tone: 'info' };
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
  if (hasTreeSummary) {
    commit =
      changed > 0
        ? {
            text:
              untracked > 0
                ? t('branchPicker.hint.changedFilesUntracked', {
                    count: changed,
                    untracked,
                  })
                : t('branchPicker.hint.changedFiles', { count: changed }),
            tone: 'info',
          }
        : { text: t('branchPicker.hint.noChanges'), tone: 'muted' };
  }

  return { pull, pullDisabled, commit, push, pushDisabled };
}

export function BranchPickerPopover({
  open,
  onOpenChange,
  workspaceCwd,
  gitCwd,
  side = 'bottom',
  onBranchChanged,
  status,
  onRefreshStatus,
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
  // Held in a ref so an inline callback from the parent doesn't re-arm the
  // open effect on every render (refresh → setState → render → refresh…).
  const onRefreshStatusRef = useRef(onRefreshStatus);
  onRefreshStatusRef.current = onRefreshStatus;

  const fetchBranches = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await ws.workspaceGitBranches(gitCwd);
      if (requestId !== requestIdRef.current) return;
      setData(result);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [ws, gitCwd]);

  useEffect(() => {
    if (open) {
      void fetchBranches();
      onRefreshStatusRef.current?.();
      setSearch('');
      setNewBranchMode(false);
      setCheckoutRefMode(false);
      setNewBranchName('');
      setCheckoutRefValue('');
      setStatusMsg(null);
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, fetchBranches]);

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
    [ws, busyAction, gitCwd, onBranchChanged, onOpenChange, showStatus, t],
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
      const result = await ws.workspaceGitPush({ setUpstream: true }, gitCwd);
      showStatus(result.output || t('branchPicker.pushSuccess'), 'success');
      await fetchBranches();
      onBranchChanged?.();
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyAction(null);
    }
  }, [ws, busyAction, gitCwd, fetchBranches, onBranchChanged, showStatus, t]);

  const handlePull = useCallback(async () => {
    if (busyAction) return;
    setBusyAction('pull');
    try {
      const result = await ws.workspaceGitPull(undefined, gitCwd);
      showStatus(result.output || t('branchPicker.pullSuccess'), 'success');
      await fetchBranches();
      onBranchChanged?.();
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyAction(null);
    }
  }, [ws, busyAction, gitCwd, fetchBranches, onBranchChanged, showStatus, t]);

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
    () => deriveActionHints(t, data, status),
    [t, data, status],
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
