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
  onBranchChanged?: () => void;
  onOpenDiff?: () => void;
  onOpenCommit?: () => void;
  children: React.ReactNode;
}

type SectionKey = 'recent' | 'local' | 'remote' | 'tags';

export function BranchPickerPopover({
  open,
  onOpenChange,
  onBranchChanged,
  onOpenDiff,
  onOpenCommit,
  children,
}: BranchPickerPopoverProps) {
  const { t } = useI18n();
  const { client } = useWorkspace();
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

  const fetchBranches = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.workspaceGitBranches();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (open) {
      void fetchBranches();
      setSearch('');
      setNewBranchMode(false);
      setCheckoutRefMode(false);
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
      setBusyAction('checkout');
      try {
        await client.workspaceGitCheckout(ref);
        showStatus(t('branchPicker.checkedOut', { branch: ref }), 'success');
        onBranchChanged?.();
        onOpenChange(false);
      } catch (err) {
        showStatus(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setBusyAction(null);
      }
    },
    [client, onBranchChanged, onOpenChange, showStatus, t],
  );

  const handleNewBranch = useCallback(async () => {
    if (!validateBranchName(newBranchName)) return;
    setBusyAction('newBranch');
    try {
      await client.workspaceGitCreateBranch(newBranchName);
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
  }, [client, newBranchName, onBranchChanged, onOpenChange, showStatus, t]);

  const handleCheckoutRef = useCallback(async () => {
    if (!checkoutRefValue.trim()) return;
    await handleCheckout(checkoutRefValue.trim());
  }, [checkoutRefValue, handleCheckout]);

  const handlePush = useCallback(async () => {
    setBusyAction('push');
    try {
      const result = await client.workspaceGitPush({ setUpstream: true });
      showStatus(result.output || t('branchPicker.pushSuccess'), 'success');
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyAction(null);
    }
  }, [client, showStatus, t]);

  const handlePull = useCallback(async () => {
    setBusyAction('pull');
    try {
      const result = await client.workspaceGitPull();
      showStatus(result.output || t('branchPicker.pullSuccess'), 'success');
      onBranchChanged?.();
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyAction(null);
    }
  }, [client, onBranchChanged, showStatus, t]);

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

  const actionsVisible =
    !q ||
    t('branchPicker.action.pull').toLowerCase().includes(q) ||
    t('branchPicker.action.push').toLowerCase().includes(q) ||
    t('branchPicker.action.commit').toLowerCase().includes(q) ||
    t('branchPicker.action.newBranch').toLowerCase().includes(q) ||
    t('branchPicker.action.checkoutRef').toLowerCase().includes(q);

  const toggleSection = (key: SectionKey) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className={styles.picker}
        side="bottom"
        align="start"
        sideOffset={4}
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

        <div className={styles.list} onPointerDown={(e) => e.stopPropagation()}>
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
                    className={styles.actionItem}
                    disabled={!!busyAction}
                    onClick={() => void handlePull()}
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
                  </button>
                  <button
                    type="button"
                    className={styles.actionItem}
                    disabled={!!busyAction}
                    onClick={() => {
                      onOpenCommit?.();
                      onOpenChange(false);
                    }}
                  >
                    <GitCommitIcon size={14} className={styles.actionIcon} />
                    <span className={styles.actionLabel}>
                      {t('branchPicker.action.commit')}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.actionItem}
                    disabled={!!busyAction}
                    onClick={() => void handlePush()}
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
                        {branches.map((b) => (
                          <BranchItem
                            key={b.name}
                            name={b.name.slice(remote.length + 1)}
                            isHead={false}
                            onClick={() => void handleCheckout(b.name)}
                          />
                        ))}
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
                      onClick={() => void handleCheckout(tg.name)}
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
