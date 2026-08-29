/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import {
  DaemonHttpError,
  type DaemonGitBranchesResult,
} from '@qwen-code/sdk/daemon';
import {
  ChevronDownIcon,
  CircleDotIcon,
  GitBranchIcon,
  GitForkIcon,
  Loader2Icon,
  SearchIcon,
} from 'lucide-react';
import { useI18n } from '../i18n';
import {
  displayBranchName,
  qualifyLocalBranchRef,
  qualifyRemoteBranchRef,
} from '../utils/gitRefs';
import { sanitizeControlChars } from './messages/toolFormatting';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import styles from './GitModePopover.module.css';

export type SessionGitIntent =
  | { mode: 'current' }
  | { mode: 'branch'; name: string }
  | { mode: 'worktree'; slug?: string };

// Byte-length caps mirroring the server predicate in session.ts; keep in sync.
// git creates loose refs as files, so each `/`-separated component is bounded
// by the filesystem's per-component name limit (~255 bytes minus git's `.lock`
// suffix). Count UTF-8 bytes, not code points, since Unicode is allowed.
const MAX_BRANCH_NAME_BYTES = 1000;
const MAX_BRANCH_COMPONENT_BYTES = 200;

const branchNameEncoder = new TextEncoder();

// UX-only validation; the server re-validates in POST /session (session.ts).
// Keep the two predicates in sync.
export function validateBranchName(name: string): boolean {
  if (!name) return false;
  return !(
    /[^\p{L}\p{N}._/-]/u.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.startsWith('.') ||
    name.startsWith('-') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.git') ||
    name.includes('@{') ||
    name.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock')) ||
    name.toUpperCase() === 'HEAD' ||
    branchNameEncoder.encode(name).length > MAX_BRANCH_NAME_BYTES ||
    name
      .split('/')
      .some(
        (c) => branchNameEncoder.encode(c).length > MAX_BRANCH_COMPONENT_BYTES,
      )
  );
}

// Daemon git failures carry the human-facing, path-redacted git detail in
// `body.message`; the SDK-composed `error.message` is only the machine error
// code (`<route label>: <body.error>`). Sanitize whichever is shown: the
// detail is repo-controlled git output and can carry bidi overrides.
function describeGitDaemonError(error: unknown): string {
  const body =
    error instanceof DaemonHttpError &&
    typeof error.body === 'object' &&
    error.body !== null
      ? (error.body as { message?: unknown })
      : undefined;
  const detail =
    typeof body?.message === 'string' && body.message !== ''
      ? body.message
      : error instanceof Error
        ? error.message
        : String(error);
  return sanitizeControlChars(detail);
}

interface GitModePopoverProps {
  branch: string;
  workspaceCwd: string;
  compact?: boolean;
  intent: SessionGitIntent;
  onIntentChange: (intent: SessionGitIntent) => void;
  onBranchChanged?: () => void;
}

export function GitModePopover({
  branch,
  workspaceCwd,
  compact = false,
  intent,
  onIntentChange,
  onBranchChanged,
}: GitModePopoverProps) {
  const { t } = useI18n();
  const { client } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [selectedMode, setSelectedMode] = useState<
    'current' | 'existing' | 'branch' | 'worktree'
  >(intent.mode);
  const [branchName, setBranchName] = useState(
    intent.mode === 'branch' ? intent.name : '',
  );
  const [existingBranches, setExistingBranches] =
    useState<DaemonGitBranchesResult | null>(null);
  const [existingSearch, setExistingSearch] = useState('');
  const [collapsedExistingGroups, setCollapsedExistingGroups] = useState(
    () => new Set<string>(),
  );
  const [existingLoading, setExistingLoading] = useState(false);
  const [existingError, setExistingError] = useState<string | null>(null);
  // A checkout failure can arrive after dismissal (the request keeps
  // running); kept apart from the list error so a reopen can surface it.
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [existingRetryNonce, setExistingRetryNonce] = useState(0);
  const [checkoutRef, setCheckoutRef] = useState<string | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);

  const branchValid = useMemo(
    () => validateBranchName(branchName),
    [branchName],
  );

  const handleOpenChange = useCallback(
    (v: boolean) => {
      setOpen(v);
      if (v) {
        // An unread checkout failure must stay visible on reopen — the
        // existing-branch box is the only surface that renders it and the
        // in-flight spinner; the fetch and checkout paths clear errors when
        // real work starts.
        setSelectedMode(
          checkoutError || checkoutRef ? 'existing' : intent.mode,
        );
        setBranchName(intent.mode === 'branch' ? intent.name : '');
        setExistingSearch('');
      }
    },
    [intent, checkoutError, checkoutRef],
  );

  const handleSelectCurrent = useCallback(() => {
    onIntentChange({ mode: 'current' });
    setOpen(false);
  }, [onIntentChange]);

  const handleConfirmBranch = useCallback(() => {
    if (!branchName || !branchValid) return;
    onIntentChange({ mode: 'branch', name: branchName });
    setOpen(false);
  }, [branchName, branchValid, onIntentChange]);

  const handleConfirmWorktree = useCallback(() => {
    onIntentChange({ mode: 'worktree' });
    setOpen(false);
  }, [onIntentChange]);

  useEffect(() => {
    if (!open || selectedMode !== 'existing') return;
    let cancelled = false;
    setExistingBranches(null);
    setExistingLoading(true);
    setExistingError(null);
    client
      .workspaceByCwd(workspaceCwd)
      .workspaceGitBranches()
      .then((result) => {
        if (cancelled) return;
        if (result.available === false) {
          setExistingError(t('gitMode.branchesUnavailable'));
          return;
        }
        setExistingBranches(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setExistingError(describeGitDaemonError(error));
        }
      })
      .finally(() => {
        if (!cancelled) setExistingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, open, selectedMode, workspaceCwd, existingRetryNonce, t]);

  const existingGroups = useMemo(() => {
    const query = existingSearch.trim().toLowerCase();
    const groups = new Map<string, Array<{ name: string; ref: string }>>();
    const add = (group: string, name: string, ref = name) => {
      if (query && !name.toLowerCase().includes(query)) return;
      const items = groups.get(group) ?? [];
      items.push({ name, ref });
      groups.set(group, items);
    };
    // Values are fully qualified so the daemon checks out the exact ref
    // namespace of the clicked row; a colliding short name (a tag or
    // same-named branch) cannot resolve to a different target. The qualify
    // helpers absorb git's disambiguation prefixes (`heads/x`, `remotes/x`)
    // so an ambiguous short name never yields a double-prefixed ref.
    for (const item of existingBranches?.local ?? []) {
      if (!item.isHead)
        add(
          t('gitMode.existingLocal'),
          displayBranchName(item.name),
          qualifyLocalBranchRef(item.name),
        );
    }
    for (const item of existingBranches?.remote ?? []) {
      const displayName = displayBranchName(item.name);
      const slash = displayName.indexOf('/');
      const remote = slash > 0 ? displayName.slice(0, slash) : 'remote';
      add(
        t('gitMode.existingRemote', { remote }),
        displayName,
        qualifyRemoteBranchRef(item.name),
      );
    }
    return groups;
  }, [existingBranches, existingSearch, t]);
  const existingSearchActive = existingSearch.trim().length > 0;

  const toggleExistingGroup = useCallback((group: string) => {
    setCollapsedExistingGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const handleCheckoutExisting = useCallback(
    async (ref: string) => {
      if (checkoutRef) return;
      setCheckoutRef(ref);
      setExistingError(null);
      setCheckoutError(null);
      try {
        await client.workspaceByCwd(workspaceCwd).workspaceGitCheckout(ref);
        onIntentChange({ mode: 'current' });
        onBranchChanged?.();
        setOpen(false);
      } catch (error) {
        setCheckoutError(describeGitDaemonError(error));
      } finally {
        setCheckoutRef(null);
      }
    },
    [checkoutRef, client, onBranchChanged, onIntentChange, workspaceCwd],
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onIntentChange({ mode: 'current' });
      setOpen(false);
    },
    [onIntentChange],
  );

  const isBranch = intent.mode === 'branch';
  const isWorktree = intent.mode === 'worktree';
  const chipLabel = isBranch
    ? `→ ${intent.name}`
    : isWorktree
      ? t('gitMode.worktree')
      : branch;

  return (
    <span className={styles.wrap}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`${styles.chip} ${isBranch ? styles.chipBranch : ''} ${isWorktree ? styles.chipWorktree : ''} ${compact ? styles.chipCompact : ''}`}
            data-web-shell-git-branch
            data-testid="git-mode-chip"
            aria-label={`${t('gitMode.title')}: ${chipLabel}`}
          >
            <span className={styles.chipIcon}>
              {isWorktree ? (
                <GitForkIcon size={14} strokeWidth={1.5} />
              ) : (
                <GitBranchIcon size={15} strokeWidth={1.5} />
              )}
            </span>
            {!compact && <span className={styles.chipText}>{chipLabel}</span>}
            <svg
              className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
              viewBox="0 0 16 16"
              fill="currentColor"
              width={9}
              height={9}
              aria-hidden="true"
            >
              <path d="M4.427 7.427l3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z" />
            </svg>
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          side="top"
          align="end"
          sideOffset={8}
          className={styles.popover}
          // The content is portaled out of the composer, but React synthetic
          // clicks still bubble through the React tree to the composer
          // surface's onClick, which calls core.focus() and steals focus out of
          // the popover — Radix then dismisses it via focus-outside. Stop the
          // bubble so option clicks keep focus inside (mirrors the composer
          // ToolbarPopover pattern in ChatEditor).
          onClick={(e) => e.stopPropagation()}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // The portal container fools Radix's dismissable-layer into
            // thinking clicks inside the popover are "outside". Only
            // prevent dismissal when the target is genuinely inside.
            if (contentRef.current?.contains(e.target as Node)) {
              e.preventDefault();
            }
          }}
        >
          <div className={styles.header}>{t('gitMode.title')}</div>

          <button
            type="button"
            role="radio"
            aria-checked={selectedMode === 'current'}
            disabled={checkoutRef !== null}
            className={`${styles.option} ${selectedMode === 'current' ? styles.optionSelected : ''}`}
            onClick={handleSelectCurrent}
          >
            <span className={`${styles.optionIcon} ${styles.iconCurrent}`}>
              <CircleDotIcon size={15} strokeWidth={1.5} />
            </span>
            <span className={styles.optionText}>
              <span className={styles.optionName}>{t('gitMode.current')}</span>
              <span className={styles.optionDesc}>
                {t('gitMode.currentDesc', { branch })}
              </span>
            </span>
            {selectedMode === 'current' && (
              <span className={styles.checkCurrent} aria-hidden="true">
                ✓
              </span>
            )}
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={selectedMode === 'existing'}
            disabled={checkoutRef !== null}
            className={`${styles.option} ${selectedMode === 'existing' ? styles.optionSelected : ''}`}
            onClick={() => {
              if (selectedMode === 'existing') return;
              setExistingBranches(null);
              setExistingLoading(true);
              setExistingError(null);
              setSelectedMode('existing');
            }}
          >
            <span className={`${styles.optionIcon} ${styles.iconExisting}`}>
              <GitBranchIcon size={15} strokeWidth={1.5} />
            </span>
            <span className={styles.optionText}>
              <span className={styles.optionName}>{t('gitMode.existing')}</span>
              <span className={styles.optionDesc}>
                {t('gitMode.existingDesc')}
              </span>
            </span>
            {selectedMode === 'existing' && (
              <span className={styles.checkExisting} aria-hidden="true">
                ✓
              </span>
            )}
          </button>

          {selectedMode === 'existing' && (
            <div className={styles.existingBox}>
              <div className={styles.existingSearch}>
                <SearchIcon size={13} />
                <input
                  value={existingSearch}
                  onChange={(event) => setExistingSearch(event.target.value)}
                  placeholder={t('gitMode.existingSearch')}
                  aria-label={t('gitMode.existingSearch')}
                  autoFocus
                />
              </div>
              <div
                className={styles.existingList}
                role="listbox"
                aria-label={t('gitMode.existing')}
                onWheelCapture={(event) => event.stopPropagation()}
              >
                {(existingError ?? checkoutError) && (
                  <div className={styles.existingError}>
                    {existingError ?? checkoutError}
                    <button
                      type="button"
                      className={styles.existingRetry}
                      onClick={() => {
                        setExistingError(null);
                        setCheckoutError(null);
                        setExistingRetryNonce((nonce) => nonce + 1);
                      }}
                    >
                      {t('gitMode.retry')}
                    </button>
                  </div>
                )}
                {existingLoading ? (
                  <div className={styles.existingStatus}>
                    <Loader2Icon className={styles.spin} size={14} />
                    {t('gitMode.existingLoading')}
                  </div>
                ) : existingGroups.size === 0 &&
                  !existingError &&
                  !checkoutError ? (
                  <div className={styles.existingStatus}>
                    {t('gitMode.existingEmpty')}
                  </div>
                ) : (
                  Array.from(existingGroups.entries()).map(([group, items]) => {
                    const expanded =
                      existingSearchActive ||
                      !collapsedExistingGroups.has(group);
                    return (
                      <div className={styles.existingSection} key={group}>
                        <button
                          type="button"
                          className={styles.existingGroup}
                          aria-expanded={expanded}
                          disabled={existingSearchActive}
                          onClick={() => toggleExistingGroup(group)}
                        >
                          <ChevronDownIcon
                            className={`${styles.existingGroupChevron} ${expanded ? '' : styles.existingGroupChevronCollapsed}`}
                            aria-hidden="true"
                          />
                          <span>{sanitizeControlChars(group)}</span>
                        </button>
                        {expanded &&
                          items.map((item) => (
                            <button
                              key={item.ref}
                              type="button"
                              role="option"
                              aria-selected={false}
                              className={styles.existingItem}
                              disabled={checkoutRef !== null}
                              onClick={() =>
                                void handleCheckoutExisting(item.ref)
                              }
                            >
                              <GitBranchIcon size={13} />
                              <span>{sanitizeControlChars(item.name)}</span>
                              {checkoutRef === item.ref && (
                                <Loader2Icon
                                  className={styles.spin}
                                  size={13}
                                />
                              )}
                            </button>
                          ))}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          <button
            type="button"
            role="radio"
            aria-checked={selectedMode === 'branch'}
            disabled={checkoutRef !== null}
            className={`${styles.option} ${selectedMode === 'branch' ? styles.optionSelected : ''}`}
            onClick={() => setSelectedMode('branch')}
          >
            <span className={`${styles.optionIcon} ${styles.iconBranch}`}>
              <GitBranchIcon size={15} strokeWidth={1.5} />
            </span>
            <span className={styles.optionText}>
              <span className={styles.optionName}>{t('gitMode.branch')}</span>
              <span className={styles.optionDesc}>
                {t('gitMode.branchDesc', { branch })}
              </span>
            </span>
            {selectedMode === 'branch' && (
              <span className={styles.checkBranch} aria-hidden="true">
                ✓
              </span>
            )}
          </button>

          {selectedMode === 'branch' && (
            <div className={styles.branchBox}>
              <div className={styles.branchRow}>
                <label
                  className={styles.branchLabel}
                  htmlFor="git-mode-branch-input"
                >
                  {t('gitMode.branchLabel')}
                </label>
                <span className={styles.branchInputWrap}>
                  <input
                    className={`${styles.branchInput} ${branchName && !branchValid ? styles.branchInputInvalid : ''} ${branchName && branchValid ? styles.branchInputValid : ''}`}
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && branchName && branchValid)
                        handleConfirmBranch();
                    }}
                    placeholder={t('gitMode.branchPlaceholder')}
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    id="git-mode-branch-input"
                    data-testid="git-mode-branch-input"
                  />
                  {branchName && (
                    <span
                      className={styles.branchStatus}
                      aria-hidden="true"
                      style={{
                        color: branchValid
                          ? 'var(--git-mode-valid)'
                          : 'var(--git-mode-invalid)',
                      }}
                    >
                      {branchValid ? '✓' : '✗'}
                    </span>
                  )}
                </span>
              </div>
              <div
                className={`${styles.branchHint} ${branchName && !branchValid ? styles.branchHintError : ''}`}
              >
                {branchName && !branchValid
                  ? t('gitMode.branchInvalidName')
                  : t('gitMode.branchHint')}
              </div>
              {branchName && branchValid && (
                <div className={styles.branchHint}>
                  {t('gitMode.branchConflictWarning')}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            role="radio"
            aria-checked={selectedMode === 'worktree'}
            disabled={checkoutRef !== null}
            className={`${styles.option} ${selectedMode === 'worktree' ? styles.optionSelected : ''}`}
            onClick={() => setSelectedMode('worktree')}
          >
            <span className={`${styles.optionIcon} ${styles.iconWorktree}`}>
              <GitForkIcon size={15} strokeWidth={1.5} />
            </span>
            <span className={styles.optionText}>
              <span className={styles.optionName}>{t('gitMode.worktree')}</span>
              <span className={styles.optionDesc}>
                {t('gitMode.worktreeDesc')}
              </span>
            </span>
            {selectedMode === 'worktree' && (
              <span className={styles.checkWorktree} aria-hidden="true">
                ✓
              </span>
            )}
          </button>

          <div className={styles.footer}>
            <span className={styles.cmd}>
              {selectedMode === 'branch'
                ? `$ git checkout -b ${branchName || '…'} ← ${branch}`
                : selectedMode === 'existing'
                  ? '$ git checkout <branch>'
                  : selectedMode === 'worktree'
                    ? '$ git worktree add .qwen/worktrees/<slug>'
                    : `$ git checkout ${branch}`}
            </span>
            {selectedMode === 'branch' && (
              <button
                type="button"
                className={styles.confirmBranch}
                disabled={!branchName || !branchValid}
                onClick={handleConfirmBranch}
                data-testid="git-mode-confirm-branch"
              >
                {t('gitMode.confirmBranch')}
              </button>
            )}
            {selectedMode === 'worktree' && (
              <button
                type="button"
                className={styles.confirmWorktree}
                onClick={handleConfirmWorktree}
                data-testid="git-mode-confirm-worktree"
              >
                {t('gitMode.confirmWorktree')}
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {(isBranch || isWorktree) && (
        <button
          type="button"
          className={styles.clearBtn}
          onClick={handleClear}
          aria-label={t('gitMode.resetToCurrent')}
          title={t('gitMode.resetToCurrent')}
          data-testid="git-mode-clear"
        >
          ✕
        </button>
      )}
    </span>
  );
}
