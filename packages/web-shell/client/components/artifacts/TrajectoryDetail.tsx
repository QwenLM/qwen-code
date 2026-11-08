/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  XIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { getShadowAwareActiveElement, isFocusUnclaimed } from '../../utils/dom';
import { formatDuration } from '../messages/StatsMessage';
import { DiffView } from '../messages/tools/DiffView';
import { daemonToolBlockToToolCall } from '../../adapters/transcriptToMessages';
import type { TrajectoryLifecycleEntry } from '../../trajectory/project-trajectory-lifecycle';
import type { TrajectoryExecutionRow } from '../../trajectory/project-trajectory-executions';
import type { TrajectoryRow, TrajectoryTurn } from '../../trajectory/types';
import { compactTokens } from './TrajectorySummaryBar';
import {
  MAX_DETAIL_LENGTH,
  stringifyValue,
  ToolCallDetail,
  toolCallContent,
} from './tool-call-content';
import styles from './TrajectoryDetail.module.css';

const EXPANDED_LENGTH = 40_000;

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/** One fact; `undefined` is a measurement that was not recorded. */
interface Fact {
  label: string;
  value: ReactNode | undefined;
  /** Copyable plain text of the value, when it differs from its node. */
  text?: string;
  mono?: boolean;
}

interface Section {
  key: string;
  label: string;
  /** Plain text, rendered as JSON when it parses and copied as shown. */
  text?: string;
  diff?: string;
  /** Collapsed until opened: identifiers and lifecycle. */
  collapsed?: boolean;
  fields?: Array<[label: string, value: string]>;
}

type Status = 'failed' | 'cancelled' | 'running';

function toolStatus(row: Extract<TrajectoryRow, { kind: 'tool' }>) {
  const status = row.toolStatus ?? row.block.status;
  if (status === 'error' || status === 'failed') return 'failed';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'in_progress' || status === 'pending' || status === 'running')
    return 'running';
  return undefined;
}

function idFields(
  t: Translate,
  ids: Array<[key: string, value: string | undefined]>,
): Array<[string, string]> {
  return ids.flatMap(([key, value]) =>
    value
      ? [[t(`trajectory.inspector.${key}`), value] as [string, string]]
      : [],
  );
}

/** A recorded value as written: strings unchanged, anything else as JSON. */
function formatRaw(value: unknown, t: Translate): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? undefined;
  } catch {
    return t('trajectory.inspector.formatFailed');
  }
}

function clock(epochMs: number, language: string): string {
  return new Date(epochMs).toLocaleString(language);
}

/** A time of day to the millisecond, for spans shorter than a second. */
function preciseTime(epochMs: number, language: string): string {
  return new Date(epochMs).toLocaleTimeString(language, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

function rowContent(
  row: TrajectoryRow,
  lifecycle: TrajectoryLifecycleEntry | undefined,
  t: Translate,
  language: string,
): { status?: Status; facts: Fact[]; sections: Section[] } {
  if (row.kind === 'request') {
    const { durationMs, startedAt, ttftMs } = row.timing;
    const validTtft =
      ttftMs !== undefined && ttftMs >= 0 && ttftMs <= durationMs
        ? ttftMs
        : undefined;
    const usage = row.usage;
    return {
      ...(row.status === 'error' ? { status: 'failed' as const } : {}),
      facts: [
        {
          label: t('trajectory.inspector.duration'),
          value: formatDuration(durationMs),
        },
        {
          label: t('trajectory.inspector.ttft'),
          value:
            ttftMs === undefined ? undefined : validTtft === undefined ? (
              t('trajectory.inspector.invalidTtft')
            ) : (
              <>
                {formatDuration(validTtft)}{' '}
                <span className={styles.sub}>
                  ·{' '}
                  {t('trajectory.detail.generating', {
                    duration: formatDuration(durationMs - validTtft),
                  })}
                </span>
                <span className={styles.ttftBar} aria-hidden="true">
                  <i
                    style={{
                      width: `${durationMs > 0 ? (validTtft / durationMs) * 100 : 0}%`,
                    }}
                  />
                  <i />
                </span>
              </>
            ),
          text:
            validTtft === undefined
              ? undefined
              : `${formatDuration(validTtft)} · ${t('trajectory.detail.generating', { duration: formatDuration(durationMs - validTtft) })}`,
        },
        {
          label: t('trajectory.detail.tokens'),
          value: usage
            ? t('trajectory.detail.tokenCounts', {
                input: compactTokens(usage.inputTokens),
                cached: compactTokens(usage.cachedTokens ?? 0),
                output: compactTokens(usage.outputTokens),
              })
            : undefined,
        },
        {
          label: t('trajectory.inspector.start'),
          value:
            startedAt === undefined ? undefined : clock(startedAt, language),
        },
        ...(row.model
          ? [{ label: t('trajectory.inspector.model'), value: row.model }]
          : []),
      ],
      sections: [
        {
          key: 'ids',
          label: t('trajectory.detail.identifiers'),
          collapsed: true,
          fields: idFields(t, [
            ['executionId', row.executionId],
            ['responseId', row.responseId],
            ['promptId', row.promptId],
            ['subagent', row.subagentId],
            ['parentCall', row.parentToolCallId],
          ]),
        },
        ...(lifecycle
          ? [
              {
                key: 'lifecycle',
                label: t('trajectory.detail.lifecycle'),
                collapsed: true,
                text: stringifyValue(lifecycle),
              },
            ]
          : []),
      ],
    };
  }
  if (row.kind === 'tool') {
    const block = row.block;
    const tool = daemonToolBlockToToolCall(block, false);
    const content = toolCallContent(tool, block);
    // A shell call reads as its command and output, as in Tool Calls; any
    // other value as recorded, so whitespace, an explicit null or an empty
    // result are not lost.
    const recordedOutput = formatRaw(
      block.rawOutput === undefined ? block.content : block.rawOutput,
      t,
    );
    const input = content.shell
      ? content.argumentsText || formatRaw(block.rawInput, t)
      : formatRaw(block.rawInput, t);
    const output = content.shell
      ? content.resultText || recordedOutput
      : recordedOutput;
    const timing = row.timing;
    const status = toolStatus(row);
    return {
      ...(status ? { status } : {}),
      facts: [
        {
          label: t('trajectory.inspector.duration'),
          value: timing ? formatDuration(timing.durationMs) : undefined,
        },
        {
          label: t('trajectory.inspector.start'),
          value:
            timing?.startedAt === undefined
              ? undefined
              : `${new Date(timing.startedAt).toLocaleDateString(language)} ${preciseTime(timing.startedAt, language)} → ${preciseTime(timing.startedAt + timing.durationMs, language)}`,
        },
        ...(block.toolName
          ? [
              {
                label: t('trajectory.inspector.tool'),
                value: block.toolName,
                mono: true,
              },
            ]
          : []),
        ...(block.subagentType
          ? [
              {
                label: t('trajectory.inspector.subagent'),
                value: block.subagentType,
              },
            ]
          : []),
      ],
      sections: [
        ...(input !== undefined
          ? [{ key: 'input', label: t('trajectory.detail.input'), text: input }]
          : []),
        content.diff
          ? {
              key: 'output',
              label: t('trajectory.detail.output'),
              diff: content.diff,
            }
          : {
              key: 'output',
              label: t('trajectory.detail.output'),
              text: output,
            },
        ...(content.shell?.other
          ? [
              {
                key: 'other',
                label: t('trajectory.detail.other'),
                collapsed: true,
                text: content.shell.other,
              },
            ]
          : []),
        {
          key: 'ids',
          label: t('trajectory.detail.identifiers'),
          collapsed: true,
          fields: idFields(t, [
            ['callId', block.toolCallId],
            ['parentCall', block.parentToolCallId],
          ]),
        },
      ],
    };
  }
  if (row.kind === 'user' || row.kind === 'message') {
    const { images, files, resourceLinks } = row.block;
    return {
      facts: [
        ...(images?.length
          ? [
              {
                label: t('trajectory.inspector.images'),
                value: images
                  .map((image) =>
                    image.attachmentId
                      ? `${image.mimeType} · ${image.attachmentId}`
                      : image.mimeType,
                  )
                  .join(', '),
              },
            ]
          : []),
        ...(files?.length
          ? [
              {
                label: t('trajectory.inspector.files'),
                value: files
                  .map(
                    (file) =>
                      `${file.name} (${file.mimeType})${file.attachmentId ? ` · ${file.attachmentId}` : ''}`,
                  )
                  .join(', '),
              },
            ]
          : []),
      ],
      sections: [
        ...(row.block.text
          ? [
              {
                key: 'text',
                label: t('trajectory.detail.text'),
                text: row.block.text,
              },
            ]
          : []),
        ...(resourceLinks?.length
          ? [
              {
                key: 'links',
                label: t('trajectory.inspector.resourceLinks'),
                text: stringifyValue(
                  resourceLinks.map((link) => ({
                    name: link.name,
                    uri: link.uri,
                    ...(link.mimeType ? { mimeType: link.mimeType } : {}),
                    ...(link.size !== undefined && link.size !== null
                      ? { size: link.size }
                      : {}),
                    ...(link.description
                      ? { description: link.description }
                      : {}),
                  })),
                ),
              },
            ]
          : []),
      ],
    };
  }
  const block = row.block;
  const body = (text: string | undefined): Section[] =>
    text ? [{ key: 'text', label: t('trajectory.detail.text'), text }] : [];
  switch (block.kind) {
    case 'permission':
      return {
        facts: [
          {
            label: t('trajectory.inspector.permissionTitle'),
            value: block.title,
          },
          {
            label: t('trajectory.inspector.status'),
            value:
              block.resolved ?? t('trajectory.inspector.permissionPending'),
          },
        ],
        sections: [],
      };
    case 'user_shell':
      return {
        facts: [],
        sections: [
          ...(block.command
            ? [
                {
                  key: 'input',
                  label: t('trajectory.inspector.command'),
                  text: block.command,
                },
              ]
            : []),
          ...body(block.text),
        ],
      };
    case 'prompt_cancelled':
      return {
        status: 'cancelled',
        facts: [
          { label: t('trajectory.inspector.reason'), value: block.reason },
        ],
        sections: [],
      };
    case 'shell':
    case 'status':
    case 'error':
    case 'debug':
      return {
        ...(block.kind === 'error' ? { status: 'failed' as const } : {}),
        facts: [],
        sections: body(block.text),
      };
    default:
      return {
        facts: [{ label: t('trajectory.inspector.kind'), value: block.kind }],
        sections: [],
      };
  }
}

function turnFacts(turn: TrajectoryTurn, t: Translate): Fact[] {
  return [
    { label: t('trajectory.detail.steps'), value: String(turn.requestCount) },
    { label: t('trajectory.detail.tools'), value: String(turn.toolCount) },
    {
      label: t('trajectory.detail.modelTime'),
      value: turn.requestMs > 0 ? formatDuration(turn.requestMs) : undefined,
    },
  ];
}

function executionContent(
  execution: TrajectoryExecutionRow,
  t: Translate,
  language: string,
): { status?: Status; facts: Fact[]; sections: Section[] } {
  const event = execution.entry.event;
  const status: Status | undefined =
    execution.status === 'running'
      ? 'running'
      : execution.status === 'error' || execution.status === 'conflict'
        ? 'failed'
        : execution.status === 'cancelled' || execution.status === 'interrupted'
          ? 'cancelled'
          : undefined;
  return {
    ...(status ? { status } : {}),
    facts: [
      {
        label: t('trajectory.inspector.status'),
        value: t(`trajectory.executions.status.${execution.status}`),
      },
      {
        label: t('trajectory.inspector.duration'),
        value:
          execution.durationMs === undefined
            ? undefined
            : formatDuration(execution.durationMs),
      },
      {
        label: t('trajectory.inspector.start'),
        value:
          execution.startedAt === undefined
            ? undefined
            : clock(execution.startedAt, language),
      },
      {
        label: t('trajectory.inspector.end'),
        value:
          execution.endedAt === undefined
            ? undefined
            : clock(execution.endedAt, language),
      },
      { label: t('trajectory.inspector.kind'), value: event.kind },
      event.kind === 'request'
        ? { label: t('trajectory.inspector.model'), value: event.model }
        : {
            label: t('trajectory.inspector.tool'),
            value: event.toolName,
            mono: true,
          },
      ...(event.kind === 'tool'
        ? [
            {
              label: t('trajectory.executions.executionStatus'),
              value: event.executionStatus,
            },
          ]
        : []),
      ...(event.phase === 'ended'
        ? [{ label: t('trajectory.executions.outcome'), value: event.outcome }]
        : []),
    ],
    sections: [
      {
        key: 'ids',
        label: t('trajectory.detail.identifiers'),
        collapsed: true,
        fields: idFields(t, [
          ['executionId', event.executionId],
          ['promptId', event.kind === 'request' ? event.promptId : undefined],
          ['callId', event.kind === 'tool' ? event.callId : undefined],
          ['subagent', event.subagentId],
        ]),
      },
      {
        key: 'lifecycle',
        label: t('trajectory.detail.lifecycle'),
        collapsed: true,
        text: stringifyValue(execution.entry),
      },
    ],
  };
}

/**
 * Everything recorded about one record, turn or live execution: a header that
 * names it and steps through the list, the measured facts, then its content.
 * Docked it covers the list (`drill-in`); fullscreen it sits beside it.
 */
export function TrajectoryDetail({
  row,
  turn,
  lifecycle,
  execution,
  onLocateExecution,
  title,
  presentation,
  stale = false,
  hiddenByRange = false,
  hiddenByCollapse = false,
  hiddenByFilter = false,
  onClearFilter,
  onReveal,
  onClearRange,
  onClose,
  onStep,
  onFocusedUnmount,
}: {
  /** For a turn, its prompt; absent when the window cut the turn's head off. */
  row?: TrajectoryRow;
  turn?: TrajectoryTurn;
  lifecycle?: TrajectoryLifecycleEntry;
  execution?: TrajectoryExecutionRow;
  onLocateExecution?: () => void;
  title?: string;
  presentation: 'drill-in' | 'side';
  stale?: boolean;
  hiddenByRange?: boolean;
  hiddenByCollapse?: boolean;
  hiddenByFilter?: boolean;
  onClearFilter?: () => void;
  onReveal?: () => void;
  onClearRange?: () => void;
  onClose: () => void;
  /** Steps to the previous or next record in the list; absent for executions. */
  onStep?: (direction: 1 | -1) => void;
  onFocusedUnmount?: () => void;
}) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed'>();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onFocusedUnmountRef = useRef(onFocusedUnmount);
  useLayoutEffect(() => {
    onFocusedUnmountRef.current = onFocusedUnmount;
  }, [onFocusedUnmount]);
  const alive = useRef(true);
  const copyVersion = useRef(0);

  useEffect(() => {
    alive.current = true;
    headingRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  const setSectionElement = useCallback((node: HTMLElement | null) => {
    const previous = sectionRef.current;
    if (!node && previous?.contains(getShadowAwareActiveElement(previous))) {
      // Wait for the commit; simulated cleanup leaves the node connected.
      const root = previous.getRootNode();
      queueMicrotask(() => {
        if (!previous.isConnected && isFocusUnclaimed(root)) {
          onFocusedUnmountRef.current?.();
        }
      });
    }
    sectionRef.current = node;
  }, []);

  const identity = execution?.key ?? (turn ? `turn:${turn.index}` : row?.key);
  useEffect(() => {
    copyVersion.current++;
    setExpanded(false);
    setCopyStatus(undefined);
  }, [identity]);

  const content = useMemo(() => {
    if (execution) return executionContent(execution, t, language);
    const recorded = row ? rowContent(row, lifecycle, t, language) : undefined;
    if (!turn) return recorded;
    return {
      facts: [...turnFacts(turn, t), ...(recorded?.facts ?? [])],
      sections: recorded?.sections ?? [],
    };
  }, [execution, row, turn, lifecycle, t, language]);
  const limit = expanded ? EXPANDED_LENGTH : MAX_DETAIL_LENGTH;
  const canExpand = !!content?.sections.some(
    (section) =>
      (section.text?.length ?? 0) > MAX_DETAIL_LENGTH ||
      (section.diff?.length ?? 0) > MAX_DETAIL_LENGTH,
  );

  const copy = async (text: string) => {
    const version = copyVersion.current;
    try {
      await navigator.clipboard.writeText(text);
      if (alive.current && version === copyVersion.current)
        setCopyStatus('copied');
    } catch {
      if (alive.current && version === copyVersion.current)
        setCopyStatus('failed');
    }
  };

  const notRecorded = t('trajectory.detail.notRecorded');
  const sectionBody = (section: Section) => {
    if (section.fields)
      return section.fields.length > 0 ? (
        <dl className={styles.ids}>
          {section.fields.map(([label, value]) => (
            <div key={label} className={styles.idRow}>
              <dt>{label}</dt>
              <dd>{value}</dd>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={t('trajectory.detail.copySection', {
                  section: label,
                })}
                title={t('trajectory.detail.copySection', { section: label })}
                onClick={() => void copy(value)}
              >
                <CopyIcon size={12} aria-hidden="true" />
              </button>
            </div>
          ))}
        </dl>
      ) : (
        <p className={styles.empty}>{notRecorded}</p>
      );
    const full = section.diff ?? section.text;
    if (full === undefined)
      return <p className={styles.empty}>{notRecorded}</p>;
    // Cut here rather than in the renderer, so Copy takes exactly what shows.
    const shown = full.slice(0, limit);
    return (
      <>
        {section.diff !== undefined ? (
          <DiffView diff={shown} />
        ) : (
          <ToolCallDetail text={shown} limit={limit} />
        )}
        {full.length > limit && (
          <p className={styles.empty}>{t('trajectory.inspector.truncated')}</p>
        )}
      </>
    );
  };
  const sectionText = (section: Section) =>
    section.fields
      ? section.fields.map(([label, value]) => `${label}: ${value}`).join('\n')
      : (section.diff ?? section.text ?? '').slice(0, limit);

  return (
    <section
      ref={setSectionElement}
      className={styles.detail}
      data-presentation={presentation}
      aria-label={t('trajectory.inspector.title')}
      data-testid="trajectory-detail"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={styles.header}>
        {presentation === 'drill-in' && (
          <button
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label={t('trajectory.detail.back')}
            title={t('trajectory.detail.back')}
          >
            <ChevronLeftIcon size={16} aria-hidden="true" />
          </button>
        )}
        <h3 ref={headingRef} tabIndex={-1} title={title}>
          {title ?? t('trajectory.inspector.selectRecord')}
        </h3>
        {content?.status && (
          <span className={styles.pill} data-status={content.status}>
            {t(
              `trajectory.executions.status.${content.status === 'failed' ? 'error' : content.status}`,
            )}
          </span>
        )}
        <div className={styles.headerActions}>
          {onStep && (
            <>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => onStep(-1)}
                aria-label={t('trajectory.detail.previous')}
                title={t('trajectory.detail.previous')}
              >
                <ArrowUpIcon size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => onStep(1)}
                aria-label={t('trajectory.detail.next')}
                title={t('trajectory.detail.next')}
              >
                <ArrowDownIcon size={15} aria-hidden="true" />
              </button>
            </>
          )}
          {presentation === 'side' && (
            <button
              type="button"
              className={styles.iconButton}
              onClick={onClose}
              aria-label={t('trajectory.inspector.close')}
              title={t('trajectory.inspector.close')}
            >
              <XIcon size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className={styles.body}>
        {hiddenByFilter && row && (
          <p className={styles.callout}>
            {t('trajectory.filter.hidden')}{' '}
            {onClearFilter && (
              <button type="button" onClick={onClearFilter}>
                {t('trajectory.filter.clear')}
              </button>
            )}
          </p>
        )}
        {hiddenByRange && row && (
          <p className={styles.callout}>
            {t('trajectory.inspector.hiddenByRange')}{' '}
            <button type="button" onClick={onClearRange}>
              {t('trajectory.range.clear')}
            </button>
          </p>
        )}
        {hiddenByCollapse && row && (
          <p className={styles.callout}>
            {t('trajectory.inspector.hiddenByCollapse')}{' '}
            <button type="button" onClick={onReveal}>
              {t('trajectory.reveal')}
            </button>
          </p>
        )}
        {execution && (
          <p className={styles.callout}>
            {t('trajectory.executions.metadata')}{' '}
            {onLocateExecution ? (
              <button type="button" onClick={onLocateExecution}>
                {t('trajectory.executions.locate')}
              </button>
            ) : (
              t('trajectory.executions.unlinked')
            )}
          </p>
        )}
        {!content ? (
          <p className={styles.empty}>
            {t(
              stale
                ? 'trajectory.inspector.stale'
                : 'trajectory.inspector.selectRecord',
            )}
          </p>
        ) : (
          <>
            {content.facts.length > 0 && (
              <dl className={styles.facts}>
                {content.facts.map((fact) => (
                  <div key={fact.label} className={styles.fact}>
                    <dt>{fact.label}</dt>
                    <dd
                      className={fact.mono ? styles.mono : undefined}
                      {...(fact.value === undefined
                        ? { title: notRecorded, 'aria-label': notRecorded }
                        : {})}
                    >
                      {fact.value ?? '—'}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {content.sections.map((section) =>
              section.collapsed ? (
                <details
                  key={section.key}
                  className={styles.section}
                  data-section={section.key}
                >
                  <summary className={styles.sectionTitle}>
                    <ChevronRightIcon size={13} aria-hidden="true" />
                    {section.label}
                  </summary>
                  {sectionBody(section)}
                </details>
              ) : (
                <div
                  key={section.key}
                  className={styles.section}
                  data-section={section.key}
                >
                  <div className={styles.sectionTitle}>
                    <span>{section.label}</span>
                    {(section.text !== undefined ||
                      section.diff !== undefined) && (
                      <button
                        type="button"
                        className={styles.iconButton}
                        aria-label={t('trajectory.detail.copySection', {
                          section: section.label,
                        })}
                        title={t('trajectory.detail.copySection', {
                          section: section.label,
                        })}
                        onClick={() => void copy(sectionText(section))}
                      >
                        <CopyIcon size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {sectionBody(section)}
                </div>
              ),
            )}
            {canExpand && !expanded && (
              <button
                type="button"
                className={styles.more}
                onClick={() => {
                  copyVersion.current++;
                  setExpanded(true);
                  setCopyStatus(undefined);
                }}
              >
                {t('trajectory.inspector.expand')}
              </button>
            )}
          </>
        )}
      </div>
      <span role="status" className={styles.copyStatus}>
        {copyStatus &&
          t(
            copyStatus === 'copied'
              ? 'trajectory.inspector.copied'
              : 'trajectory.inspector.copyFailed',
          )}
      </span>
    </section>
  );
}
