/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  InfoIcon,
  ListFilterIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import type { TrajectoryFilter } from '../../trajectory/filterTrajectory';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import styles from './TrajectoryToolbar.module.css';

const TYPES = ['all', 'request', 'tool', 'user', 'message', 'other'] as const;
const STATUSES = [
  'all',
  'success',
  'error',
  'cancelled',
  'running',
  'unknown',
] as const;
const QUERY_LIMIT = 256;

/**
 * Search, the type and status facets, and the selected time range, in one
 * row. Matching rules live in `filterTrajectory`; this only edits the filter.
 */
export function TrajectoryToolbar({
  value,
  onChange,
  onNavigate,
  onClear,
  count,
  position,
  truncatedCount,
  range,
  onClearRange,
  status,
}: {
  value: TrajectoryFilter;
  onChange: (filter: TrajectoryFilter) => void;
  onNavigate: (direction: 1 | -1, filter?: TrajectoryFilter) => void;
  onClear: () => void;
  count: number;
  position: number;
  truncatedCount: number;
  /** Label of the selected time range, when there is one. */
  range?: string;
  onClearRange: () => void;
  /** How many records the current filters leave visible; announced only. */
  status?: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value.query);
  const composing = useRef(false);

  useEffect(() => {
    if (!composing.current) setDraft(value.query);
  }, [value.query]);

  const appliedQuery = value.query.trim().length > 0;
  const facets = Number(value.type !== 'all') + Number(value.status !== 'all');
  const appliedActive = appliedQuery || facets > 0;
  const coverageText =
    truncatedCount > 0
      ? t('trajectory.filter.truncated', { count: truncatedCount })
      : '';
  const commit = (next: Partial<TrajectoryFilter>) =>
    onChange({
      ...value,
      query: composing.current ? value.query : draft,
      ...next,
    });

  return (
    <div className={styles.toolbar} data-trajectory-filters="">
      <div className={styles.search}>
        <SearchIcon size={14} aria-hidden="true" className={styles.icon} />
        {/* The box around it draws the border and focus ring, so the field
            itself sheds its own. */}
        <Input
          type="search"
          className={`h-full min-w-10 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-[13px] placeholder:text-[var(--traj-text-secondary)] focus-visible:ring-0 md:text-[13px] dark:bg-transparent ${styles.input}`}
          value={draft}
          maxLength={QUERY_LIMIT}
          aria-label={t('trajectory.filter.search')}
          placeholder={t('trajectory.filter.search')}
          onChange={(event) => {
            const query = event.currentTarget.value.slice(0, QUERY_LIMIT);
            setDraft(query);
            if (!composing.current) onChange({ ...value, query });
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            const query = event.currentTarget.value.slice(0, QUERY_LIMIT);
            setDraft(query);
            if (query !== value.query) onChange({ ...value, query });
          }}
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              composing.current ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            )
              return;
            event.preventDefault();
            const next = {
              ...value,
              query: event.currentTarget.value.slice(0, QUERY_LIMIT),
            };
            onChange(next);
            onNavigate(event.shiftKey ? -1 : 1, next);
          }}
        />
        {coverageText && (
          <span
            className={styles.coverage}
            title={coverageText}
            aria-label={coverageText}
            role="img"
          >
            <InfoIcon size={13} aria-hidden="true" />
          </span>
        )}
        <span className={styles.count} role="status">
          {appliedActive &&
            t(
              position > 0
                ? 'trajectory.filter.position'
                : 'trajectory.filter.count',
              { count, position },
            )}
        </span>
        {appliedActive && (
          <>
            <button
              type="button"
              className={styles.iconButton}
              disabled={count === 0}
              aria-label={t('trajectory.filter.previous')}
              title={t('trajectory.filter.previous')}
              onClick={() => onNavigate(-1)}
            >
              <ChevronUpIcon size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              disabled={count === 0}
              aria-label={t('trajectory.filter.next')}
              title={t('trajectory.filter.next')}
              onClick={() => onNavigate(1)}
            >
              <ChevronDownIcon size={14} aria-hidden="true" />
            </button>
          </>
        )}
        {draft.length > 0 && (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('trajectory.filter.clearSearch')}
            title={t('trajectory.filter.clearSearch')}
            onClick={() => {
              composing.current = false;
              setDraft('');
              if (value.query !== '') onChange({ ...value, query: '' });
            }}
          >
            <XIcon size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {range !== undefined && (
        <span className={styles.rangeChip}>
          <ClockIcon size={12} aria-hidden="true" />
          <span>{range}</span>
          <button
            type="button"
            className={styles.chipButton}
            aria-label={t('trajectory.range.clear')}
            title={t('trajectory.range.clear')}
            onClick={onClearRange}
            data-testid="trajectory-range-clear"
          >
            <XIcon size={12} aria-hidden="true" />
          </button>
        </span>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={styles.filterButton}
            aria-label={
              facets > 0
                ? `${t('trajectory.filter.button')} · ${t('trajectory.filter.active', { count: facets })}`
                : t('trajectory.filter.button')
            }
          >
            <ListFilterIcon size={14} aria-hidden="true" />
            <span className={styles.filterLabel}>
              {t('trajectory.filter.button')}
            </span>
            {facets > 0 && <span className={styles.badge}>{facets}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className={styles.popover}>
          <fieldset className={styles.group}>
            <legend>{t('trajectory.filter.type')}</legend>
            <RadioGroup
              value={value.type}
              onValueChange={(type) => {
                const selected = TYPES.find((item) => item === type);
                if (selected) commit({ type: selected });
              }}
              aria-label={t('trajectory.filter.type')}
            >
              {TYPES.map((type) => (
                <label key={type} className={styles.option}>
                  <RadioGroupItem value={type} />
                  {t(`trajectory.filter.type.${type}`)}
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          <fieldset className={styles.group}>
            <legend>{t('trajectory.filter.status')}</legend>
            <RadioGroup
              value={value.status}
              onValueChange={(status) => {
                const selected = STATUSES.find((item) => item === status);
                if (selected) commit({ status: selected });
              }}
              aria-label={t('trajectory.filter.status')}
            >
              {STATUSES.map((item) => (
                <label key={item} className={styles.option}>
                  <RadioGroupItem value={item} />
                  {t(`trajectory.filter.status.${item}`)}
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          <button
            type="button"
            className={styles.clear}
            disabled={!appliedActive && draft.length === 0}
            onClick={() => {
              composing.current = false;
              setDraft('');
              onClear();
            }}
          >
            {t('trajectory.filter.clear')}
          </button>
        </PopoverContent>
      </Popover>
      {status && (
        <span
          className={styles.srOnly}
          role="status"
          data-testid="trajectory-range-status"
        >
          {status}
        </span>
      )}
    </div>
  );
}
