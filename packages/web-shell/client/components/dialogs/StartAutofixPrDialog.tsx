/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  CheckIcon,
  ClockIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  XIcon,
} from 'lucide-react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonGitHubPullRequest,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import {
  AUTOFIX_PR_WATCH_INTERVALS,
  DEFAULT_AUTOFIX_PR_WATCH_EVERY,
  buildAutofixPrStartCommand,
  findWatchForPr,
  isValidAutofixPrWatchInterval,
  isWatchActivePhase,
  parseAutofixPrInput,
  type AutofixPrStartMode,
  type IndexedAutofixPrWatch,
} from '../../utils/autofixPrWatches';
import { workspaceLabelForCwd } from '../../utils/workspace';
import type { AutofixPrStartSessionRequest } from '../autofixPr/AutofixPrContext';
import { DialogShell } from './DialogShell';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import styles from './StartAutofixPrDialog.module.css';

export interface StartAutofixPrDialogProps {
  workspaces: DaemonWorkspaceCapability[];
  defaultWorkspaceCwd?: string;
  watchIndex?: ReadonlyMap<string, IndexedAutofixPrWatch>;
  onStart: (request: AutofixPrStartSessionRequest) => Promise<void> | void;
  onClose: () => void;
}

const POSITIVE_INT_RE = /^[1-9]\d*$/;

export function StartAutofixPrDialog({
  workspaces,
  defaultWorkspaceCwd,
  watchIndex,
  onStart,
  onClose,
}: StartAutofixPrDialogProps) {
  const { t } = useI18n();
  const { client } = useWorkspace();
  const initialCwd = useMemo(() => {
    if (
      defaultWorkspaceCwd &&
      (workspaces.length === 0 ||
        workspaces.some((ws) => ws.cwd === defaultWorkspaceCwd))
    ) {
      return defaultWorkspaceCwd;
    }
    return workspaces[0]?.cwd ?? defaultWorkspaceCwd;
  }, [defaultWorkspaceCwd, workspaces]);

  const [workspaceCwd, setWorkspaceCwd] = useState<string | undefined>(
    initialCwd,
  );
  const [prInput, setPrInput] = useState('');
  const [mode, setMode] = useState<AutofixPrStartMode>('watch');
  const [everyInput, setEveryInput] = useState('2');
  const [reply, setReply] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [openPrs, setOpenPrs] = useState<DaemonGitHubPullRequest[] | null>(
    null,
  );
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const aliveRef = useRef(true);
  const workspaceSelectId = useId();
  const prInputId = useId();
  const everyInputId = useId();
  const everyListId = useId();
  const instructionsInputId = useId();

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!workspaceCwd) {
      setOpenPrs(null);
      setLoadingPrs(false);
      return;
    }
    let cancelled = false;
    setLoadingPrs(true);
    setOpenPrs(null);
    client
      .workspaceByCwd(workspaceCwd)
      .workspaceGitHubPullRequests()
      .then((list) => {
        if (!cancelled) {
          setOpenPrs(list.available ? list.pullRequests : []);
        }
      })
      .catch(() => {
        if (!cancelled) setOpenPrs([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingPrs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceCwd]);

  const handleSubmit = async () => {
    if (submitting) return;
    const parsed = parseAutofixPrInput(prInput);
    if (!parsed) {
      setError(t('autofixPr.dialog.prInvalid'));
      return;
    }

    let every: number | undefined;
    if (mode === 'watch') {
      const trimmedEvery = everyInput.trim();
      if (trimmedEvery) {
        if (!POSITIVE_INT_RE.test(trimmedEvery)) {
          setError(t('autofixPr.dialog.everyInvalid'));
          return;
        }
        const value = Number(trimmedEvery);
        if (!isValidAutofixPrWatchInterval(value)) {
          setError(t('autofixPr.dialog.everyInvalid'));
          return;
        }
        if (value !== DEFAULT_AUTOFIX_PR_WATCH_EVERY) every = value;
      }
    }

    const matchedPr =
      parsed.kind === 'number'
        ? openPrs?.find((candidate) => candidate.number === parsed.number)
        : undefined;
    const prTarget =
      parsed.kind === 'url' ? parsed.url : (matchedPr?.url ?? parsed.number);

    const prompt = buildAutofixPrStartCommand({
      pr: prTarget,
      mode,
      every,
      noReply: !reply,
      instructions,
    });

    setError(null);
    setSubmitting(true);
    try {
      await onStart({
        prompt,
        ...(workspaceCwd ? { workspaceCwd } : {}),
        sessionTitle: t('autofixPr.sessionTitle', { number: parsed.number }),
      });
      if (aliveRef.current) onClose();
    } catch (err) {
      if (aliveRef.current) {
        setError(
          err instanceof Error && err.message
            ? err.message
            : t('autofixPrWatches.startFailed'),
        );
      }
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  };

  return (
    <DialogShell
      title={t('autofixPr.dialog.title')}
      size="md"
      dismissible={!submitting}
      onClose={onClose}
    >
      <form
        className={styles.form}
        noValidate
        aria-busy={submitting}
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        {workspaces.length > 1 && (
          <div className={styles.field}>
            <label htmlFor={workspaceSelectId} className={styles.label}>
              {t('autofixPr.dialog.workspace')}
            </label>
            <select
              id={workspaceSelectId}
              className={styles.select}
              value={workspaceCwd ?? ''}
              disabled={submitting}
              onChange={(event) => {
                setWorkspaceCwd(event.target.value);
                setPrInput('');
                setError(null);
              }}
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.cwd}>
                  {workspaceLabelForCwd(ws.cwd, workspaces)}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className={styles.field}>
          <label htmlFor={prInputId} className={styles.label}>
            {t('autofixPr.dialog.prLabel')}
          </label>
          <Input
            id={prInputId}
            autoFocus
            placeholder={t('autofixPr.dialog.prPlaceholder')}
            maxLength={2048}
            value={prInput}
            disabled={submitting}
            onChange={(event) => {
              setPrInput(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          />
        </div>

        {workspaceCwd && (loadingPrs || (openPrs && openPrs.length > 0)) && (
          <div className={styles.field}>
            <span className={styles.label}>
              {t('autofixPr.dialog.openPrs')}
            </span>
            <div className={styles.prPicker} role="listbox">
              {loadingPrs ? (
                <div className={styles.prPickerStatus}>
                  {t('autofixPr.dialog.loadingPrs')}
                </div>
              ) : (
                openPrs?.map((pr) => {
                  const watched = watchIndex
                    ? findWatchForPr(watchIndex, pr.url)
                    : undefined;
                  const active =
                    watched !== undefined && isWatchActivePhase(watched.phase);
                  const selected = prInput.trim() === pr.url;
                  const StateIcon =
                    pr.state === 'draft'
                      ? GitPullRequestDraftIcon
                      : GitPullRequestIcon;
                  return (
                    <button
                      key={pr.number}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`${styles.prOption}${selected ? ` ${styles.prOptionSelected}` : ''}`}
                      disabled={submitting}
                      onClick={() => {
                        setPrInput(pr.url);
                        if (error) setError(null);
                      }}
                    >
                      <StateIcon size={13} aria-hidden="true" />
                      <span className={styles.prOptionNumber}>
                        #{pr.number}
                      </span>
                      <span className={styles.prOptionTitle}>{pr.title}</span>
                      <span className={styles.prOptionMeta}>
                        {active && (
                          <span className={styles.watchedTag}>
                            {t('autofixPr.dialog.watchedBadge')}
                          </span>
                        )}
                        {pr.checks === 'failing' && (
                          <XIcon
                            size={12}
                            className={styles.checksFailing}
                            aria-label={t('githubPrs.checksFailing')}
                          />
                        )}
                        {pr.checks === 'passing' && (
                          <CheckIcon
                            size={12}
                            className={styles.checksPassing}
                            aria-label={t('githubPrs.checksPassing')}
                          />
                        )}
                        {pr.checks === 'pending' && (
                          <ClockIcon
                            size={12}
                            className={styles.checksPending}
                            aria-label={t('githubPrs.checksPending')}
                          />
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        <div className={styles.field}>
          <span className={styles.label}>{t('autofixPr.dialog.mode')}</span>
          <div className={styles.modeGroup} role="radiogroup">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'watch'}
              disabled={submitting}
              className={`${styles.modeOption}${mode === 'watch' ? ` ${styles.modeOptionActive}` : ''}`}
              onClick={() => setMode('watch')}
            >
              {t('autofixPr.dialog.modeWatch')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'once'}
              disabled={submitting}
              className={`${styles.modeOption}${mode === 'once' ? ` ${styles.modeOptionActive}` : ''}`}
              onClick={() => setMode('once')}
            >
              {t('autofixPr.dialog.modeOnce')}
            </button>
          </div>
        </div>

        <div className={styles.watchOptions}>
          {mode === 'watch' && (
            <div className={styles.intervalField}>
              <label htmlFor={everyInputId} className={styles.label}>
                {t('autofixPr.dialog.every')}
              </label>
              <Input
                id={everyInputId}
                type="number"
                min={1}
                max={60}
                step={1}
                list={everyListId}
                value={everyInput}
                disabled={submitting}
                onChange={(event) => {
                  setEveryInput(event.target.value);
                  if (error) setError(null);
                }}
              />
              <datalist id={everyListId}>
                {AUTOFIX_PR_WATCH_INTERVALS.map((minutes) => (
                  <option key={minutes} value={minutes} />
                ))}
              </datalist>
            </div>
          )}
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={reply}
              disabled={submitting}
              onChange={(event) => setReply(event.target.checked)}
            />
            <span>{t('autofixPr.dialog.reply')}</span>
          </label>
        </div>

        <div className={styles.field}>
          <label htmlFor={instructionsInputId} className={styles.label}>
            {t('autofixPr.dialog.instructions')}
          </label>
          <Input
            id={instructionsInputId}
            placeholder={t('autofixPr.dialog.instructionsPlaceholder')}
            maxLength={1000}
            value={instructions}
            disabled={submitting}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </div>

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        <div className={styles.footer}>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={onClose}
          >
            {t('autofixPr.dialog.cancel')}
          </Button>
          <Button type="submit" disabled={submitting || !prInput.trim()}>
            {t('autofixPr.dialog.submit')}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
