/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useState, type Ref } from 'react';
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowLeftIcon,
  RefreshCwIcon,
} from 'lucide-react';
import {
  useChannelEvents,
  useChannels,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
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
import styles from './ChannelEventsPage.module.css';

interface ChannelEventsPageProps {
  onClose?: () => void;
  initialFocusRef?: Ref<HTMLHeadingElement>;
}

const EVENT_TYPES = ['inbound', 'outbound', 'task', 'poll'] as const;
type EventTypeFilter = (typeof EVENT_TYPES)[number] | 'all';
const ALL_CHANNELS = '__all__';

const KNOWN_OUTCOMES = new Set([
  'accepted',
  'skipped',
  'posted',
  'suppressed',
  'posting',
  'failed',
  'ok',
  'running',
  'reply_pending',
  'cancelled',
]);

export function ChannelEventsPage({
  onClose,
  initialFocusRef,
}: ChannelEventsPageProps) {
  const { t, language } = useI18n();
  const workspace = useWorkspace();
  const supportsChannelEvents =
    workspace.capabilities?.features.includes('channel_management') === true;
  const workspaceCwd = workspace.workspaceCwd;
  const [channel, setChannel] = useState<string>(ALL_CHANNELS);
  const [type, setType] = useState<EventTypeFilter>('all');

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

  const outcomeLabel = (outcome: string) =>
    KNOWN_OUTCOMES.has(outcome)
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
                    const target = event.repository
                      ? `${event.repository}${
                          event.number !== undefined ? `#${event.number}` : ''
                        }`
                      : event.thread;
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
                          {outcomeLabel(event.outcome)}
                        </span>
                        <span className={styles.target}>
                          {target ?? ''}
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
                          {event.type === 'poll' &&
                          typeof event.detail?.['notifications'] ===
                            'number' ? (
                            <span className={styles.duration}>
                              {t('channelEvents.notifications', {
                                count: event.detail['notifications'] as number,
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
