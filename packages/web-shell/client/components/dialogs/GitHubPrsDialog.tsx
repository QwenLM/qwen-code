/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  CheckIcon,
  ClockIcon,
  GitPullRequestIcon,
  GitPullRequestDraftIcon,
  XIcon,
} from 'lucide-react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonGitHubPullRequest,
  DaemonGitHubPullRequestChecks,
  DaemonGitHubPullRequestList,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { timeAgo } from '../../utils/timeAgo';
import styles from './GitHubPrsDialog.module.css';

function errorCode(error: unknown): string | null {
  const body =
    error && typeof error === 'object'
      ? (error as { body?: unknown }).body
      : undefined;
  const code =
    body && typeof body === 'object'
      ? (body as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' ? code : null;
}

function ChecksIcon({ checks }: { checks: DaemonGitHubPullRequestChecks }) {
  const { t } = useI18n();
  switch (checks) {
    case 'passing':
      return (
        <span
          className={styles.checksPassing}
          title={t('githubPrs.checksPassing')}
        >
          <CheckIcon size={13} />
        </span>
      );
    case 'failing':
      return (
        <span
          className={styles.checksFailing}
          title={t('githubPrs.checksFailing')}
        >
          <XIcon size={13} />
        </span>
      );
    case 'pending':
      return (
        <span
          className={styles.checksPending}
          title={t('githubPrs.checksPending')}
        >
          <ClockIcon size={13} />
        </span>
      );
    default:
      return null;
  }
}

function PullRequestRow({
  pr,
  now,
}: {
  pr: DaemonGitHubPullRequest;
  now: number;
}) {
  const { t, language } = useI18n();
  const StateIcon =
    pr.state === 'draft' ? GitPullRequestDraftIcon : GitPullRequestIcon;
  const reviewBadge =
    pr.reviewDecision === 'approved' ? (
      <span className={`${styles.badge} ${styles.badgeApproved}`}>
        {t('githubPrs.reviewApproved')}
      </span>
    ) : pr.reviewDecision === 'changes_requested' ? (
      <span className={`${styles.badge} ${styles.badgeChanges}`}>
        {t('githubPrs.reviewChanges')}
      </span>
    ) : null;

  return (
    <button
      type="button"
      className={styles.prRow}
      aria-label={t('githubPrs.open', { number: pr.number })}
      onClick={() => {
        if (pr.url) window.open(pr.url, '_blank', 'noopener,noreferrer');
      }}
    >
      <span className={styles.prLine}>
        <StateIcon
          size={14}
          className={
            pr.state === 'draft' ? styles.stateDraft : styles.stateOpen
          }
        />
        <span className={styles.prTitle}>{pr.title}</span>
        {reviewBadge}
        <ChecksIcon checks={pr.checks} />
      </span>
      <span className={styles.prMeta}>
        #{pr.number} · {pr.headRefName}
        {pr.author ? ` · ${pr.author}` : ''} ·{' '}
        {timeAgo(pr.updatedAt, now, language)}
      </span>
    </button>
  );
}

export function GitHubPrsContent({
  workspaceCwd,
  onSubtitleChange,
}: {
  workspaceCwd: string;
  onSubtitleChange?: (subtitle: string | undefined) => void;
}) {
  const { client } = useWorkspace();
  const { t } = useI18n();
  const [list, setList] = useState<DaemonGitHubPullRequestList | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    client
      .workspaceByCwd(workspaceCwd)
      .workspaceGitHubPullRequests()
      .then((result) => {
        if (!cancelled) setList(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(errorCode(error) ?? 'unknown');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceCwd]);

  const subtitle = list?.available
    ? t('githubPrs.subtitle', { count: list.pullRequests.length })
    : undefined;

  useEffect(() => {
    onSubtitleChange?.(subtitle);
  }, [onSubtitleChange, subtitle]);

  let body: ReactNode;
  if (loading) {
    body = <div className={styles.placeholder}>{t('githubPrs.loading')}</div>;
  } else if (failure === 'github_cli_unavailable') {
    body = (
      <div className={styles.placeholder}>{t('githubPrs.cliUnavailable')}</div>
    );
  } else if (failure !== null) {
    body = <div className={styles.placeholder}>{t('githubPrs.error')}</div>;
  } else if (!list || !list.available) {
    body = (
      <div className={styles.placeholder}>{t('githubPrs.unavailable')}</div>
    );
  } else if (list.pullRequests.length === 0) {
    body = <div className={styles.placeholder}>{t('githubPrs.empty')}</div>;
  } else {
    body = (
      <div className={styles.prList}>
        {list.pullRequests.map((pr) => (
          <PullRequestRow key={pr.number} pr={pr} now={now} />
        ))}
      </div>
    );
  }

  return <div className={styles.content}>{body}</div>;
}
