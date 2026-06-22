// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';
import type { InsightData } from './types';

/**
 * Theme configuration for the share card
 */
export type Theme = 'light' | 'dark';

interface ThemeConfig {
  background: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  cardBackground: string;
  cardBackgroundSecondary: string;
  borderColor: string;
  heatmapColors: string[];
  heatmapEmpty: string;
}

const themes: Record<Theme, ThemeConfig> = {
  light: {
    background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
    textPrimary: '#0f172a',
    textSecondary: '#475569',
    textMuted: '#64748b',
    cardBackground: 'rgba(255,255,255,0.7)',
    cardBackgroundSecondary: 'rgba(255,255,255,0.5)',
    borderColor: '#e2e8f0',
    // GitHub contribution graph color palette (light mode)
    heatmapColors: ['#9be9a8', '#40c463', '#30a14e', '#216e39'],
    heatmapEmpty: '#ebedf0',
  },
  dark: {
    background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
    textPrimary: '#f8fafc',
    textSecondary: '#e2e8f0',
    textMuted: '#94a3b8',
    cardBackground: 'rgba(255,255,255,0.05)',
    cardBackgroundSecondary: 'rgba(255,255,255,0.04)',
    borderColor: 'rgba(255,255,255,0.08)',
    // GitHub contribution graph color palette (dark mode)
    heatmapColors: ['#0e4429', '#006d32', '#26a641', '#39d353'],
    heatmapEmpty: '#2d333b',
  },
};

/**
 * A hidden 1200x675 card optimized for Twitter/X sharing.
 * Rendered off-screen; captured by html2canvas when the user clicks "Share as Card".
 */
export function ShareCard({
  data,
  theme = 'light',
}: {
  data: InsightData;
  theme?: Theme;
}) {
  const t = themes[theme];

  const {
    totalMessages = 0,
    totalSessions = 0,
    totalLinesAdded = 0,
    totalLinesRemoved = 0,
    totalFiles = 0,
    currentStreak = 0,
    longestStreak = 0,
    activeHours = {},
  } = data;

  // Calculate active days
  const heatmapKeys = Object.keys(data.heatmap || {});
  let activeDays = 0;
  let dateRangeStr = '';
  if (heatmapKeys.length > 0) {
    activeDays = heatmapKeys.length;
    const timestamps = heatmapKeys.map((d) => new Date(d).getTime());
    const minDate = new Date(Math.min(...timestamps));
    const maxDate = new Date(Math.max(...timestamps));
    const fmt = (d: Date) => d.toISOString().split('T')[0];
    dateRangeStr = `${fmt(minDate)} — ${fmt(maxDate)}`;
  }

  // Key pattern (truncated for card)
  const keyPattern = data.qualitative?.interactionStyle?.key_pattern ?? null;

  // Memorable moment headline (truncated)
  const truncatedHeadline = data.qualitative?.memorableMoment?.headline ?? null;

  // Mini heatmap: last 52 weeks (simplified 7-row grid)
  const miniHeatmap = buildMiniHeatmap(data.heatmap || {}, t);

  return (
    <div
      id="share-card"
      style={{
        width: '1200px',
        background: t.background,
        color: t.textPrimary,
        fontFamily:
          'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
        display: 'flex',
        flexDirection: 'column',
        padding: '48px 56px',
        position: 'absolute',
        left: '-9999px',
        top: '-9999px',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '32px',
        }}
      >
        <div>
          <div
            style={{
              fontSize: '32px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              lineHeight: 1.2,
            }}
          >
            Qwen Code Insights
          </div>
          <div
            style={{
              fontSize: '14px',
              color: t.textMuted,
              marginTop: '6px',
            }}
          >
            {dateRangeStr}
          </div>
        </div>
        <div
          style={{
            fontSize: '11px',
            color: t.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.15em',
            paddingTop: '8px',
          }}
        >
          qwen.ai
        </div>
      </div>

      {/* Stats Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          gap: '16px',
          marginBottom: '32px',
        }}
      >
        <StatBox value={String(totalMessages)} label="Messages" theme={t} />
        <StatBox value={String(totalSessions)} label="Sessions" theme={t} />
        <StatBox
          value={`+${totalLinesAdded}/-${totalLinesRemoved}`}
          label="Lines Changed"
          small
          theme={t}
        />
        <StatBox value={String(totalFiles)} label="Files" theme={t} />
        <StatBox value={`${currentStreak}d`} label="Streak" theme={t} />
        <StatBox value={`${longestStreak}d`} label="Best Streak" theme={t} />
      </div>

      {/* Body: Heatmap + Tools + Moment */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '24px',
          marginBottom: '16px',
        }}
      >
        {/* Left: Mini Heatmap */}
        <div
          style={{
            background: t.cardBackground,
            borderRadius: '12px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: t.textMuted,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: '12px',
            }}
          >
            Activity · {activeDays} active days
          </div>
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <MiniHeatmapGrid cells={miniHeatmap} />
          </div>
          <MiniHeatmapLegend theme={t} />
        </div>

        {/* Right: Active Hours + Moment */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          {/* Active Hours */}
          <div
            style={{
              background: t.cardBackground,
              borderRadius: '12px',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: t.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: '12px',
              }}
            >
              Active Hours
            </div>
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: '10px',
              }}
            >
              <ActiveHoursChart activeHours={activeHours} theme={t} />
            </div>
          </div>

          {/* Key Pattern + Memorable Moment */}
          <div
            style={{
              background: t.cardBackgroundSecondary,
              borderRadius: '12px',
              padding: '16px 16px',
              position: 'relative',
            }}
          >
            {/* Decorative large quote mark */}
            <div
              style={{
                position: 'absolute',
                left: '12px',
                fontSize: '64px',
                fontWeight: 700,
                color:
                  theme === 'light'
                    ? 'rgba(99,102,241,0.15)'
                    : 'rgba(99,102,241,0.2)',
                lineHeight: 1,
                fontFamily: 'Georgia, "Times New Roman", serif',
                userSelect: 'none',
                pointerEvents: 'none',
              }}
            >
              &ldquo;
            </div>
            <div
              style={{
                paddingLeft: '40px',
                position: 'relative',
              }}
            >
              {keyPattern && (
                <div
                  style={{
                    fontSize: '13px',
                    color: t.textSecondary,
                    lineHeight: 1.6,
                    marginBottom: truncatedHeadline ? '8px' : 0,
                  }}
                >
                  {keyPattern}
                </div>
              )}
              {truncatedHeadline && (
                <div
                  style={{
                    fontSize: '12px',
                    color: t.textMuted,
                    lineHeight: 1.5,
                    fontStyle: 'italic',
                  }}
                >
                  {truncatedHeadline}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 'auto',
          paddingTop: '24px',
          borderTop: `1px solid ${t.borderColor}`,
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: '12px', color: t.textMuted }}>
          Generated by Qwen Code · {new Date().toISOString().split('T')[0]}
        </div>
        <div style={{ fontSize: '12px', color: t.textMuted }}>
          github.com/QwenLM/qwen-code
        </div>
      </div>
    </div>
  );
}

function StatBox({
  value,
  label,
  small,
  theme,
}: {
  value: string;
  label: string;
  small?: boolean;
  theme: ThemeConfig;
}) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          fontSize: small ? '18px' : '28px',
          fontWeight: 700,
          color: theme.textPrimary,
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: '11px',
          color: theme.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginTop: '4px',
        }}
      >
        {label}
      </div>
    </div>
  );
}

function ActiveHoursChart({
  activeHours,
  theme,
}: {
  activeHours: { [hour: number]: number };
  theme: ThemeConfig;
}) {
  const phases = [
    {
      label: 'Morning',
      time: '06–12',
      hours: [6, 7, 8, 9, 10, 11],
      color: '#fbbf24',
    },
    {
      label: 'Afternoon',
      time: '12–18',
      hours: [12, 13, 14, 15, 16, 17],
      color: '#0ea5e9',
    },
    {
      label: 'Evening',
      time: '18–22',
      hours: [18, 19, 20, 21],
      color: '#6366f1',
    },
    {
      label: 'Night',
      time: '22–06',
      hours: [22, 23, 0, 1, 2, 3, 4, 5],
      color: '#475569',
    },
  ];

  const data = phases.map((phase) => ({
    ...phase,
    total: phase.hours.reduce((acc, h) => acc + (activeHours[h] || 0), 0),
  }));
  const maxTotal = Math.max(...data.map((d) => d.total), 1);

  return (
    <>
      {data.map((item) => {
        const pct = maxTotal > 0 ? (item.total / maxTotal) * 100 : 0;
        return (
          <div key={item.label}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: '12px',
                marginBottom: '4px',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: item.color,
                    display: 'inline-block',
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: theme.textSecondary, fontWeight: 500 }}>
                  {item.label}
                </span>
                <span style={{ color: theme.textMuted, fontSize: '11px' }}>
                  {item.time}
                </span>
              </div>
              <span style={{ color: theme.textMuted, fontWeight: 600 }}>
                {item.total}
              </span>
            </div>
            <div
              style={{
                height: '6px',
                background: theme.borderColor,
                borderRadius: '3px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  backgroundColor: item.color,
                  borderRadius: '3px',
                }}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Build a 7x~26 grid of intensity values for the mini heatmap (last ~6 months). */
function buildMiniHeatmap(
  heatmap: Record<string, number>,
  theme: ThemeConfig,
): Array<{ color: string }> {
  const today = new Date();
  const weeksToShow = 26;
  const totalDays = weeksToShow * 7;

  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - totalDays + 1);
  // Align to the beginning of the week (Sunday)
  startDate.setDate(startDate.getDate() - startDate.getDay());

  const cells: Array<{ color: string }> = [];

  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + (6 - endDate.getDay())); // end of this week

  const d = new Date(startDate);
  while (d <= endDate) {
    const key = d.toISOString().split('T')[0];
    const val = heatmap[key] || 0;
    cells.push({ color: heatColor(val, theme) });
    d.setDate(d.getDate() + 1);
  }

  return cells;
}

// GitHub contribution graph color palette - theme aware
function heatColor(val: number, theme: ThemeConfig): string {
  if (val === 0) return theme.heatmapEmpty;
  if (val < 2) return theme.heatmapColors[0];
  if (val < 4) return theme.heatmapColors[1];
  if (val < 10) return theme.heatmapColors[2];
  return theme.heatmapColors[3];
}

function MiniHeatmapGrid({ cells }: { cells: Array<{ color: string }> }) {
  const rows = 7;
  const cols = Math.ceil(cells.length / rows);
  const cellSize = 14;
  const gap = 3;
  const svgWidth = cols * (cellSize + gap);
  const svgHeight = rows * (cellSize + gap);

  return (
    <svg
      width={svgWidth}
      height={svgHeight}
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
    >
      {cells.map((cell, i) => {
        const col = Math.floor(i / rows);
        const row = i % rows;
        return (
          <rect
            key={i}
            x={col * (cellSize + gap)}
            y={row * (cellSize + gap)}
            width={cellSize}
            height={cellSize}
            rx={2}
            fill={cell.color}
          />
        );
      })}
    </svg>
  );
}

// Mini Heatmap Legend Component for ShareCard (theme aware)
function MiniHeatmapLegend({ theme }: { theme: ThemeConfig }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '12px',
      }}
    >
      <span style={{ fontSize: '11px', color: theme.textMuted }}>Less</span>
      {[
        theme.heatmapEmpty,
        theme.heatmapColors[0],
        theme.heatmapColors[1],
        theme.heatmapColors[2],
        theme.heatmapColors[3],
      ].map((color, index) => (
        <span
          key={index}
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '2px',
            backgroundColor: color,
            display: 'inline-block',
          }}
        />
      ))}
      <span style={{ fontSize: '11px', color: theme.textMuted }}>More</span>
    </div>
  );
}
