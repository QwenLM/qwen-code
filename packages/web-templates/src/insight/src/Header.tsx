// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';
import type { InsightData } from './types';
import { useTranslations } from './App';

// Header Component
export function Header({
  data,
  dateRangeStr,
}: {
  data: InsightData;
  dateRangeStr: string;
}) {
  const { totalMessages, totalSessions } = data;
  const t = useTranslations();

  return (
    <header className="mb-8 space-y-3 text-center">
      <h1 className="text-3xl font-semibold text-slate-900 md:text-4xl">
        {t.headerTitle}
      </h1>
      <p className="text-sm text-slate-600">
        {totalMessages
          ? t.headerSubtitle(totalMessages, totalSessions || 0)
          : t.headerSubtitleEmpty}
        {dateRangeStr && ` | ${dateRangeStr}`}
      </p>
    </header>
  );
}

export function StatsRow({ data }: { data: InsightData }) {
  const {
    totalMessages = 0,
    totalLinesAdded = 0,
    totalLinesRemoved = 0,
    totalFiles = 0,
    // totalSessions = 0,
    // totalHours = 0,
  } = data;

  const t = useTranslations();

  const heatmapKeys = Object.keys(data.heatmap || {});
  let daysSpan = 0;
  if (heatmapKeys.length > 0) {
    const dates = heatmapKeys.map((d) => new Date(d));
    const timestamps = dates.map((d) => d.getTime());
    const minDate = new Date(Math.min(...timestamps));
    const maxDate = new Date(Math.max(...timestamps));
    const diffTime = Math.abs(maxDate.getTime() - minDate.getTime());
    daysSpan = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
  }

  const msgsPerDay = daysSpan > 0 ? Math.round(totalMessages / daysSpan) : 0;

  return (
    <div className="stats-row">
      <div className="stat">
        <div className="stat-value">{totalMessages}</div>
        <div className="stat-label">{t.statMessages}</div>
      </div>
      <div className="stat">
        <div className="stat-value">
          +{totalLinesAdded}/-{totalLinesRemoved}
        </div>
        <div className="stat-label">{t.statLines}</div>
      </div>
      <div className="stat">
        <div className="stat-value">{totalFiles}</div>
        <div className="stat-label">{t.statFiles}</div>
      </div>
      <div className="stat">
        <div className="stat-value">{daysSpan}</div>
        <div className="stat-label">{t.statDays}</div>
      </div>
      <div className="stat">
        <div className="stat-value">{msgsPerDay}</div>
        <div className="stat-label">{t.statMsgsPerDay}</div>
      </div>
    </div>
  );
}
