/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState, type Ref } from 'react';
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowLeftIcon,
  MessageSquareIcon,
  RefreshCwIcon,
} from 'lucide-react';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import {
  useChannelEvents,
  useChannels,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { workspaceLabel } from '../../utils/workspace';
import { isSafeHref } from '../messages/Markdown';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Spinner } from '../ui/spinner';
import { githubEventNumber, githubEventWebUrl } from './channel-platform';
import styles from './ChannelEventsPage.module.css';

interface ChannelEventsPageProps {
  onClose?: () => void;
  initialFocusRef?: Ref<HTMLHeadingElement>;
}

const EVENT_TYPES = ['inbound', 'outbound', 'task', 'poll'] as const;
type EventTypeFilter = (typeof EVENT_TYPES)[number] | 'all';
const ALL_CHANNELS = '__all__';

/**
 * Outcomes the page knows how to label. Anything else renders as its raw
 * token, so a new adapter outcome degrades to an unreadable-but-safe row
 * rather than a missing translation key. Exported for the catalog
 * completeness test: every entry here needs an EN and a ZH label.
 */
export const KNOWN_OUTCOMES = new Set([
  'accepted',
  'skipped',
  'posted',
  'suppressed',
  'posting',
  'failed',
  'failed_ambiguous',
  'ok',
  'degraded',
  'running',
  'delivered',
  'retired',
  'reply_pending',
  'cancelled',
]);

/**
 * Recovery edges keep `degraded` on the wire (the outcome vocabulary is
 * unchanged); labeling them "Degraded" would read as an ongoing failure, so
 * the reason names the label instead. Module-level like KNOWN_OUTCOMES — it
 * is a constant, not per-render state.
 */
const RECOVERY_REASONS = new Set([
  'watch_reconcile_recovered',
  'watch_budget_recovered',
]);

export function ChannelEventsPage({
  onClose,
  initialFocusRef,
}: ChannelEventsPageProps) {
  const { t, language } = useI18n();
  const openExternalLink = useExternalLinkOpener();
  const workspace = useWorkspace();
  const supportsChannelEvents =
    workspace.capabilities?.features.includes('channel_management') === true;
  // The provider's cwd is the daemon-wide primary workspace, so a Channel
  // started in a registered secondary workspace needs its own selection here
  // — the same one the management page offers.
  const registeredWorkspaces = useMemo<DaemonWorkspaceCapability[]>(() => {
    const listed = (workspace.capabilities?.workspaces ?? []).filter(
      (entry) => entry.kind !== 'live',
    );
    if (listed.length > 0) return listed;
    if (!workspace.workspaceCwd) return [];
    return [
      {
        id: 'primary',
        cwd: workspace.workspaceCwd,
        primary: true,
        trusted: true,
      },
    ];
  }, [workspace.capabilities?.workspaces, workspace.workspaceCwd]);
  const defaultWorkspace =
    registeredWorkspaces.find((entry) => entry.primary) ??
    registeredWorkspaces.find((entry) => entry.trusted) ??
    registeredWorkspaces[0];
  const [selectedWorkspaceCwd, setSelectedWorkspaceCwd] = useState<
    string | undefined
  >();
  const activeWorkspace =
    registeredWorkspaces.find((entry) => entry.cwd === selectedWorkspaceCwd) ??
    defaultWorkspace;
  const workspaceCwd = activeWorkspace?.cwd;
  const [channel, setChannel] = useState<string>(ALL_CHANNELS);
  const [type, setType] = useState<EventTypeFilter>('all');

  useEffect(() => {
    setChannel(ALL_CHANNELS);
  }, [workspaceCwd]);

  const { data, loading, error, reload } = useChannelEvents({
    enabled: supportsChannelEvents && Boolean(workspaceCwd),
    workspaceCwd,
    ...(channel === ALL_CHANNELS ? {} : { channel }),
    ...(type === 'all' ? {} : { types: [type] }),
    limit: 200,
  });
  const { channels } = useChannels({
    autoLoad: supportsChannelEvents,
    enabled: supportsChannelEvents,
    workspaceCwd,
  });

  const events = useMemo(() => data?.events ?? [], [data?.events]);
  const channelOptions = useMemo(() => {
    const names = new Set(Object.keys(channels));
    for (const event of events) names.add(event.channel);
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [channels, events]);
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
    [language],
  );

  const outcomeLabel = (outcome: string, reason?: string) =>
    RECOVERY_REASONS.has(reason ?? '')
      ? t('channelEvents.outcome.recovered')
      : KNOWN_OUTCOMES.has(outcome)
        ? t(`channelEvents.outcome.${outcome}`)
        : outcome;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className={styles.backButton}
            onClick={onClose}
            aria-label={t('common.back')}
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <h1 ref={initialFocusRef} tabIndex={-1} className={styles.title}>
          {t('channelEvents.title')}
        </h1>
      </header>

      <div className={styles.pageBody}>
        <p className={styles.subtitle}>{t('channelEvents.subtitle')}</p>

        {!supportsChannelEvents ? (
          <Alert>
            <AlertCircleIcon />
            <AlertTitle>{t('channelEvents.errorTitle')}</AlertTitle>
            <AlertDescription>
              {t('channelEvents.unavailable')}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className={styles.toolbar}>
              <div className={styles.filters}>
                {registeredWorkspaces.length > 0 && (
                  <Select
                    value={workspaceCwd ?? ''}
                    onValueChange={setSelectedWorkspaceCwd}
                  >
                    <SelectTrigger
                      className={styles.channelSelect}
                      aria-label={t('channels.workspace.label')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {registeredWorkspaces.map((entry) => (
                        <SelectItem
                          key={entry.id}
                          value={entry.cwd}
                          disabled={!entry.trusted}
                        >
                          {workspaceLabel(entry)}
                          {entry.primary
                            ? ` · ${t('channels.workspace.primary')}`
                            : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger
                    className={styles.channelSelect}
                    aria-label={t('channelEvents.filterChannel')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_CHANNELS}>
                      {t('channelEvents.allChannels')}
                    </SelectItem>
                    {channelOptions.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div
                  className={styles.typeFilters}
                  role="group"
                  aria-label={t('channelEvents.filterType')}
                >
                  {(['all', ...EVENT_TYPES] as EventTypeFilter[]).map(
                    (value) => (
                      <Button
                        key={value}
                        type="button"
                        size="sm"
                        variant={type === value ? 'secondary' : 'outline'}
                        aria-pressed={type === value}
                        onClick={() => setType(value)}
                      >
                        {value === 'all'
                          ? t('channelEvents.typeAll')
                          : t(`channelEvents.type.${value}`)}
                      </Button>
                    ),
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                className={styles.refreshButton}
                disabled={loading}
                onClick={() => void reload()}
              >
                {loading ? <Spinner /> : <RefreshCwIcon />}
                {t('channelEvents.refresh')}
              </Button>
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>{t('channelEvents.errorTitle')}</AlertTitle>
                <AlertDescription>{extractErrorDetail(error)}</AlertDescription>
              </Alert>
            ) : null}

            {loading && events.length === 0 ? (
              <div
                className={styles.loadingState}
                role="status"
                aria-label={t('channelEvents.loading')}
              >
                <Spinner />
                {t('channelEvents.loading')}
              </div>
            ) : null}

            {!loading && !error && events.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ActivityIcon />
                  </EmptyMedia>
                  <EmptyTitle>{t('channelEvents.emptyTitle')}</EmptyTitle>
                  <EmptyDescription>
                    {t('channelEvents.emptyDescription')}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}

            {data?.truncated ? (
              <p className={styles.truncated}>{t('channelEvents.truncated')}</p>
            ) : null}

            {events.length > 0 ? (
              <ul
                className={styles.eventList}
                data-testid="channel-events-list"
              >
                {events
                  .slice()
                  .reverse()
                  .map((event, index) => {
                    const at = new Date(event.at);
                    // Same derivation the URL uses: the shared inbound path
                    // journals without `number`, only `thread: 'pr:42'`.
                    const number = githubEventNumber(event);
                    const target = event.repository
                      ? `${event.repository}${
                          number !== undefined ? `#${number}` : ''
                        }`
                      : event.thread;
                    const targetUrl = githubEventWebUrl(
                      event,
                      // The journal's merged metadata is authoritative:
                      // system settings can override a same-named workspace
                      // channel, which the scope-local listing would miss.
                      // The listing stays as the fallback for older daemons
                      // that do not send channelLinkMeta.
                      data?.channelLinkMeta?.[event.channel] ??
                        channels[event.channel]?.config,
                    );
                    const safeTargetUrl =
                      targetUrl && isSafeHref(targetUrl)
                        ? targetUrl
                        : undefined;
                    return (
                      <li
                        key={`${event.at}-${event.channel}-${index}`}
                        className={styles.eventRow}
                      >
                        <span className={styles.time}>
                          {Number.isNaN(at.getTime())
                            ? event.at
                            : timeFormatter.format(at)}
                        </span>
                        <Badge variant="outline" className={styles.channel}>
                          {event.channel}
                        </Badge>
                        <Badge variant="secondary" className={styles.type}>
                          {t(`channelEvents.type.${event.type}`)}
                        </Badge>
                        <span
                          className={styles.outcome}
                          data-outcome={event.outcome}
                        >
                          {outcomeLabel(event.outcome, event.reason)}
                        </span>
                        <span className={styles.target}>
                          {safeTargetUrl ? (
                            <a
                              href={safeTargetUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.targetLink}
                              aria-label={t('channelEvents.openTarget', {
                                target: target ?? '',
                              })}
                              onClick={(click) =>
                                openExternalLink(click, safeTargetUrl)
                              }
                            >
                              {target ?? ''}
                            </a>
                          ) : (
                            (target ?? '')
                          )}
                          {event.actor ? (
                            <span className={styles.actor}>@{event.actor}</span>
                          ) : null}
                        </span>
                        <span className={styles.marker}>
                          {event.reason || event.triggerKind ? (
                            <code className={styles.markerCode}>
                              {event.reason ?? event.triggerKind}
                            </code>
                          ) : null}
                          {event.sessionId ? (
                            <code
                              className={styles.markerCode}
                              title={event.sessionId}
                            >
                              {t('channelEvents.session', {
                                id: event.sessionId.slice(0, 8),
                              })}
                            </code>
                          ) : null}
                          {event.type === 'poll' &&
                          typeof event.detail?.['notifications'] ===
                            'number' ? (
                            <span className={styles.duration}>
                              {t('channelEvents.notifications', {
                                count: event.detail['notifications'] as number,
                              })}
                            </span>
                          ) : null}
                          {event.type === 'poll' &&
                          typeof event.detail?.['streak'] === 'number' ? (
                            <span className={styles.duration}>
                              {t('channelEvents.streak', {
                                count: event.detail['streak'] as number,
                              })}
                            </span>
                          ) : null}
                          {event.type === 'poll' &&
                          typeof event.detail?.['sessions'] === 'number' ? (
                            <span className={styles.duration}>
                              {t('channelEvents.sessions', {
                                count: event.detail['sessions'] as number,
                              })}
                            </span>
                          ) : null}
                          {typeof event.detail?.['filtered'] === 'number' ? (
                            <span className={styles.duration}>
                              {t('channelEvents.moreFiltered', {
                                count: event.detail['filtered'] as number,
                              })}
                            </span>
                          ) : null}
                          {event.type === 'poll' &&
                          typeof event.detail?.['remaining'] === 'number' &&
                          typeof event.detail?.['reserve'] === 'number' ? (
                            <span className={styles.duration}>
                              {t('channelEvents.budget', {
                                remaining: event.detail['remaining'] as number,
                                reserve: event.detail['reserve'] as number,
                              })}
                            </span>
                          ) : null}
                          {event.durationMs !== undefined ? (
                            <span className={styles.duration}>
                              {t('channelEvents.duration', {
                                ms: event.durationMs,
                              })}
                            </span>
                          ) : null}
                          {event.sessionId ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className={styles.sessionButton}
                              aria-label={t('channelEvents.openSession')}
                              title={t('channelEvents.openSession')}
                              onClick={() => {
                                // Same navigation path as markdown session
                                // links and turn notifications. Older
                                // records lack the owner workspace; the
                                // journal's own workspace is the fallback
                                // (correct for the Channel's own reply
                                // session).
                                window.dispatchEvent(
                                  new CustomEvent('qwen:open-session', {
                                    detail: {
                                      sessionId: event.sessionId,
                                      workspaceCwd:
                                        event.sessionWorkspaceCwd ??
                                        workspaceCwd,
                                    },
                                  }),
                                );
                              }}
                            >
                              <MessageSquareIcon />
                            </Button>
                          ) : null}
                        </span>
                        {event.error ? (
                          <span className={styles.error}>{event.error}</span>
                        ) : null}
                      </li>
                    );
                  })}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
