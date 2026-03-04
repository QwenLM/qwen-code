// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';
import type { InsightData } from './types';

// Get localized strings or use defaults
function getI18n() {
  if (typeof window !== 'undefined' && window.INSIGHT_I18N) {
    return window.INSIGHT_I18N;
  }
  // Default English strings
  return {
    language: 'en',
    title: 'Qwen Code Insights',
    subtitle: 'Your personalized coding journey and patterns',
    messagesAcrossSessions: 'messages across {{sessions}} sessions',
    noDataAvailable: 'No insight data available',
  };
}

// Header Component
export function Header({
  data,
  dateRangeStr,
}: {
  data: InsightData;
  dateRangeStr: string;
}) {
  const { totalMessages, totalSessions } = data;
  const i18n = getI18n();

  const subtitleText = totalMessages
    ? i18n.messagesAcrossSessions.replace(
        '{{sessions}}',
        String(totalSessions ?? 0),
      )
    : i18n.subtitle;

  return (
    <header className="mb-8 space-y-3 text-center">
      <h1 className="text-3xl font-semibold text-slate-900 md:text-4xl">
        {i18n.title}
      </h1>
      <p className="text-sm text-slate-600">
        {subtitleText}
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
        <div className="stat-label">Messages</div>
      </div>
      <div className="stat">
        <div className="stat-value">
          +{totalLinesAdded}/-{totalLinesRemoved}
        </div>
        <div className="stat-label">Lines</div>
      </div>
      <div className="stat">
        <div className="stat-value">{totalFiles}</div>
        <div className="stat-label">Files</div>
      </div>
      <div className="stat">
        <div className="stat-value">{daysSpan}</div>
        <div className="stat-label">Days</div>
      </div>
      <div className="stat">
        <div className="stat-value">{msgsPerDay}</div>
        <div className="stat-label">Msgs/Day</div>
      </div>
    </div>
  );
}
