/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { formatDuration } from '../messages/StatsMessage';
import type { TrajectoryRow } from '../../trajectory/types';
import styles from './TrajectoryInspector.module.css';

const PREVIEW_LENGTH = 4_000;
const EXPANDED_LENGTH = 40_000;
type Tab = 'summary' | 'input' | 'output' | 'metrics' | 'body';
type DetailField = [label: string, value: unknown];

function formatValue(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

export function TrajectoryInspector({
  row,
  title,
  stale = false,
  turnSelected = false,
  hiddenByRange,
  onClearRange,
  onClose,
}: {
  row?: TrajectoryRow;
  title?: string;
  stale?: boolean;
  turnSelected?: boolean;
  hiddenByRange: boolean;
  onClearRange: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('summary');
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed'>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  const copyVersion = useRef(0);

  useEffect(() => {
    alive.current = true;
    headingRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    copyVersion.current++;
    setTab('summary');
    setExpanded(false);
    setCopyStatus(undefined);
  }, [row?.key]);

  const tabs: Tab[] = !row
    ? []
    : row.kind === 'request'
      ? ['summary', 'metrics']
      : row.kind === 'tool'
        ? ['summary', 'input', 'output', 'metrics']
        : ['summary', 'body'];
  const selectedTab = tabs.includes(tab) ? tab : 'summary';

  const fields = useMemo<DetailField[]>(() => {
    if (!row) return [];
    if (row.kind === 'request') {
      if (selectedTab === 'summary') {
        return [
          [t('trajectory.inspector.model'), row.model],
          [t('trajectory.inspector.status'), row.status],
          [t('trajectory.inspector.responseId'), row.responseId],
          [t('trajectory.inspector.promptId'), row.promptId],
          [t('trajectory.inspector.subagent'), row.subagentId],
          [t('trajectory.inspector.parentCall'), row.parentToolCallId],
        ];
      }
      const { durationMs, startedAt, ttftMs } = row.timing;
      return [
        [t('trajectory.inspector.duration'), formatDuration(durationMs)],
        [
          t('trajectory.inspector.start'),
          startedAt === undefined
            ? undefined
            : new Date(startedAt).toLocaleString(),
        ],
        [
          t('trajectory.inspector.end'),
          startedAt === undefined
            ? undefined
            : new Date(startedAt + durationMs).toLocaleString(),
        ],
        [
          t('trajectory.inspector.ttft'),
          ttftMs === undefined ? undefined : formatDuration(ttftMs),
        ],
        [
          t('trajectory.inspector.afterFirst'),
          ttftMs === undefined
            ? undefined
            : ttftMs >= 0 && ttftMs <= durationMs
              ? formatDuration(durationMs - ttftMs)
              : t('trajectory.inspector.invalidTtft'),
        ],
        [t('trajectory.inspector.inputTokens'), row.usage?.inputTokens],
        [t('trajectory.inspector.outputTokens'), row.usage?.outputTokens],
        [t('trajectory.inspector.cachedTokens'), row.usage?.cachedTokens],
      ];
    }
    if (row.kind === 'tool') {
      const block = row.block;
      if (selectedTab === 'summary') {
        return [
          [t('trajectory.inspector.status'), row.toolStatus ?? block.status],
          [t('trajectory.inspector.tool'), block.toolName],
          [t('trajectory.inspector.callId'), block.toolCallId],
          [t('trajectory.inspector.parentCall'), block.parentToolCallId],
          [t('trajectory.inspector.subagent'), block.subagentType],
          [t('trajectory.inspector.details'), block.details],
          [t('trajectory.inspector.preview'), block.preview],
        ];
      }
      if (selectedTab === 'metrics') {
        return [
          [
            t('trajectory.inspector.duration'),
            row.timing === undefined
              ? undefined
              : formatDuration(row.timing.durationMs),
          ],
          [
            t('trajectory.inspector.start'),
            row.timing?.startedAt === undefined
              ? undefined
              : new Date(row.timing.startedAt).toLocaleString(),
          ],
        ];
      }
      if (selectedTab === 'input')
        return [[t('trajectory.inspector.input'), block.rawInput]];
      return [
        [
          block.rawOutput === undefined
            ? t('trajectory.inspector.contentFallback')
            : t('trajectory.inspector.output'),
          block.rawOutput === undefined ? block.content : block.rawOutput,
        ],
      ];
    }
    if (row.kind === 'user' || row.kind === 'message') {
      if (selectedTab === 'body')
        return [[t('trajectory.inspector.body'), row.block.text]];
      const images = row.block.images;
      const files = row.block.files;
      return [
        [t('trajectory.inspector.kind'), row.block.kind],
        [
          t('trajectory.inspector.images'),
          images
            ?.map((image) =>
              image.attachmentId
                ? `${image.mimeType} · ${image.attachmentId}`
                : image.mimeType,
            )
            .join(', '),
        ],
        [
          t('trajectory.inspector.files'),
          files
            ?.map(
              (file) =>
                `${file.name} (${file.mimeType})${file.attachmentId ? ` · ${file.attachmentId}` : ''}`,
            )
            .join(', '),
        ],
      ];
    }
    if (row.kind === 'other') {
      const block = row.block;
      if (selectedTab === 'summary')
        return [[t('trajectory.inspector.kind'), block.kind]];
      switch (block.kind) {
        case 'shell':
          return [[t('trajectory.inspector.body'), block.text]];
        case 'user_shell':
          return [
            [t('trajectory.inspector.command'), block.command],
            [t('trajectory.inspector.body'), block.text],
          ];
        case 'status':
        case 'error':
        case 'debug':
          return [[t('trajectory.inspector.body'), block.text]];
        case 'permission':
          return [
            [t('trajectory.inspector.title'), block.title],
            [t('trajectory.inspector.status'), block.resolved],
          ];
        case 'prompt_cancelled':
          return [[t('trajectory.inspector.reason'), block.reason]];
        default:
          return [];
      }
    }
    return [];
  }, [row, selectedTab, t]);

  const formattedFields = useMemo(
    () =>
      fields.map(([label, value]) => ({
        label,
        formatted: formatValue(value),
      })),
    [fields],
  );
  const limit = expanded ? EXPANDED_LENGTH : PREVIEW_LENGTH;
  const displayed = formattedFields.map(({ label, formatted }) => {
    return {
      label,
      text:
        formatted === undefined
          ? t('trajectory.unrecorded')
          : formatted === null
            ? t('trajectory.inspector.formatFailed')
            : formatted.slice(0, limit),
      truncated:
        formatted !== undefined &&
        formatted !== null &&
        formatted.length > limit,
    };
  });
  const canExpand = formattedFields.some(
    ({ formatted }) => (formatted?.length ?? 0) > PREVIEW_LENGTH,
  );
  const copyText = displayed.map(({ text }) => text).join('\n');

  return (
    <section
      className={styles.inspector}
      aria-label={t('trajectory.inspector.title')}
      data-testid="trajectory-inspector"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={styles.header}>
        <h3 ref={headingRef} tabIndex={-1}>
          {title ?? t('trajectory.inspector.title')}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('trajectory.inspector.close')}
        >
          {t('trajectory.inspector.close')}
        </button>
      </div>
      {hiddenByRange && row && (
        <div className={styles.notice}>
          {t('trajectory.inspector.hiddenByRange')}{' '}
          <button type="button" onClick={onClearRange}>
            {t('trajectory.range.clear')}
          </button>
        </div>
      )}
      {!row ? (
        <p className={styles.notice}>
          {t(
            stale
              ? 'trajectory.inspector.stale'
              : turnSelected
                ? 'trajectory.inspector.selectRowInTurn'
                : 'trajectory.inspector.selectRecord',
          )}
        </p>
      ) : (
        <>
          <div
            className={styles.tabs}
            role="group"
            aria-label={t('trajectory.inspector.title')}
          >
            {tabs.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={selectedTab === item}
                onClick={() => {
                  copyVersion.current++;
                  setTab(item);
                  setExpanded(false);
                  setCopyStatus(undefined);
                }}
              >
                {t(`trajectory.inspector.tab.${item}`)}
              </button>
            ))}
          </div>
          <div className={styles.content}>
            {displayed.map(({ label, text, truncated }, index) => (
              <div className={styles.field} key={`${label}-${index}`}>
                <div className={styles.fieldLabel}>{label}</div>
                <pre>{text}</pre>
                {truncated && (
                  <span>{t('trajectory.inspector.truncated')}</span>
                )}
              </div>
            ))}
            {canExpand && !expanded && (
              <button
                type="button"
                onClick={() => {
                  copyVersion.current++;
                  setExpanded(true);
                  setCopyStatus(undefined);
                }}
              >
                {t('trajectory.inspector.expand')}
              </button>
            )}
            {displayed.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  const version = copyVersion.current;
                  try {
                    await navigator.clipboard.writeText(copyText);
                    if (alive.current && version === copyVersion.current)
                      setCopyStatus('copied');
                  } catch {
                    if (alive.current && version === copyVersion.current)
                      setCopyStatus('failed');
                  }
                }}
              >
                {t('trajectory.inspector.copy')}
              </button>
            )}
            {copyStatus && (
              <span role="status">
                {t(
                  copyStatus === 'copied'
                    ? 'trajectory.inspector.copied'
                    : 'trajectory.inspector.copyFailed',
                )}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
