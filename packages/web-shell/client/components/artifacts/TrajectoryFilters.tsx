/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { TrajectoryFilter } from '../../trajectory/filterTrajectory';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import styles from './TrajectoryFilters.module.css';

const TYPES = ['all', 'request', 'tool', 'user', 'message', 'other'] as const;
const STATUSES = [
  'all',
  'success',
  'error',
  'cancelled',
  'running',
  'unknown',
] as const;

export function TrajectoryFilters({
  value,
  onChange,
  onNavigate,
  onClear,
  count,
  position,
  truncatedCount,
}: {
  value: TrajectoryFilter;
  onChange: (filter: TrajectoryFilter) => void;
  onNavigate: (direction: 1 | -1, filter?: TrajectoryFilter) => void;
  onClear: () => void;
  count: number;
  position: number;
  truncatedCount: number;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value.query);
  const composing = useRef(false);

  useEffect(() => {
    if (!composing.current) setDraft(value.query);
  }, [value.query]);

  const active =
    draft.length > 0 || value.type !== 'all' || value.status !== 'all';
  const appliedActive =
    value.query.trim().length > 0 ||
    value.type !== 'all' ||
    value.status !== 'all';
  const coverageText =
    truncatedCount > 0
      ? t('trajectory.filter.truncated', { count: truncatedCount })
      : '';

  return (
    <div className={styles.filters} data-trajectory-filters="">
      <div className={styles.controls}>
        <Input
          type="search"
          className={styles.search}
          value={draft}
          maxLength={256}
          aria-label={t('trajectory.filter.search')}
          placeholder={t('trajectory.filter.search')}
          onChange={(event) => {
            const query = event.currentTarget.value.slice(0, 256);
            setDraft(query);
            if (!composing.current) onChange({ ...value, query });
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            const query = event.currentTarget.value.slice(0, 256);
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
              query: event.currentTarget.value.slice(0, 256),
            };
            onChange(next);
            onNavigate(event.shiftKey ? -1 : 1, next);
          }}
        />
        <Select
          value={value.type}
          onValueChange={(type) => {
            const selected = TYPES.find((item) => item === type);
            if (selected)
              onChange({
                ...value,
                query: composing.current ? value.query : draft,
                type: selected,
              });
          }}
        >
          <SelectTrigger
            size="sm"
            className={styles.select}
            aria-label={t('trajectory.filter.type')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`trajectory.filter.type.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={value.status}
          onValueChange={(status) => {
            const selected = STATUSES.find((item) => item === status);
            if (selected)
              onChange({
                ...value,
                query: composing.current ? value.query : draft,
                status: selected,
              });
          }}
        >
          <SelectTrigger
            size="sm"
            className={styles.select}
            aria-label={t('trajectory.filter.status')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {t(`trajectory.filter.status.${status}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className={styles.results}>
        <span className={styles.count} role="status">
          {appliedActive &&
            t(
              position > 0
                ? 'trajectory.filter.position'
                : 'trajectory.filter.count',
              { count, position },
            )}
        </span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={!appliedActive || count === 0}
          onClick={() => onNavigate(-1)}
        >
          {t('trajectory.filter.previous')}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={!appliedActive || count === 0}
          onClick={() => onNavigate(1)}
        >
          {t('trajectory.filter.next')}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={!active}
          onClick={() => {
            composing.current = false;
            setDraft('');
            onClear();
          }}
        >
          {t('trajectory.filter.clear')}
        </Button>
      </div>
      <p className={styles.coverage} title={coverageText}>
        {coverageText}
      </p>
    </div>
  );
}
