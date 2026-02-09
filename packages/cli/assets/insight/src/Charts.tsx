/* eslint-disable @typescript-eslint/no-explicit-any */
import { InsightData } from './types';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React, { useRef, useEffect } from 'react';
const Chart = (window as any).Chart;

// -----------------------------------------------------------------------------
// Existing Components
// -----------------------------------------------------------------------------

// Dashboard Cards Component
export function DashboardCards({ insights }: { insights: InsightData }) {
  const cardClass = 'glass-card p-6';
  const sectionTitleClass =
    'text-lg font-semibold tracking-tight text-slate-900';
  const captionClass = 'text-sm font-medium text-slate-500';

  return (
    <div className="grid gap-4 md:grid-cols-3 md:gap-6">
      <StreakCard
        currentStreak={insights.currentStreak}
        longestStreak={insights.longestStreak}
        cardClass={cardClass}
        captionClass={captionClass}
      />
      <ActiveHoursChart
        activeHours={insights.activeHours}
        cardClass={cardClass}
        sectionTitleClass={sectionTitleClass}
      />
      <WorkSessionCard
        longestWorkDuration={insights.longestWorkDuration}
        longestWorkDate={insights.longestWorkDate}
        latestActiveTime={insights.latestActiveTime}
        cardClass={cardClass}
        sectionTitleClass={sectionTitleClass}
      />
    </div>
  );
}

// Streak Card Component
export function StreakCard({
  currentStreak,
  longestStreak,
  cardClass,
  captionClass,
}: {
  currentStreak: number;
  longestStreak: number;
  cardClass: string;
  captionClass: string;
}) {
  return (
    <div className={`${cardClass} h-full`}>
      <div className="flex items-start justify-between">
        <div>
          <p className={captionClass}>Current Streak</p>
          <p className="mt-1 text-4xl font-bold text-slate-900">
            {currentStreak}
            <span className="ml-2 text-base font-semibold text-slate-500">
              days
            </span>
          </p>
        </div>
        <span className="rounded-full bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700">
          Longest {longestStreak}d
        </span>
      </div>
    </div>
  );
}

// Active Hours Chart Component
export function ActiveHoursChart({
  activeHours,
  cardClass,
  sectionTitleClass,
}: {
  activeHours: Record<number, number>;
  cardClass: string;
  sectionTitleClass: string;
}) {
  const chartRef = useRef<HTMLCanvasElement | null>(null);
  const chartInstance = useRef<any>(null);

  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.destroy();
    }

    const canvas = chartRef.current;
    if (!canvas || !window.Chart) return;

    const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
    const data = labels.map((_, i) => activeHours[i] || 0);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    chartInstance.current = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Activity per Hour',
            data,
            backgroundColor: 'rgba(52, 152, 219, 0.7)',
            borderColor: 'rgba(52, 152, 219, 1)',
            borderWidth: 1,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            beginAtZero: true,
          },
        },
        plugins: {
          legend: {
            display: false,
          },
        },
      },
    });

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [activeHours]);

  return (
    <div className={`${cardClass} h-full`}>
      <div className="flex items-center justify-between">
        <h3 className={sectionTitleClass}>Active Hours</h3>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          24h
        </span>
      </div>
      <div className="mt-4 h-56 w-full">
        <canvas ref={chartRef} className="w-full h-56" />
      </div>
    </div>
  );
}

// Work Session Card Component
function WorkSessionCard({
  longestWorkDuration,
  longestWorkDate,
  latestActiveTime,
  cardClass,
  sectionTitleClass,
}: {
  longestWorkDuration: number;
  longestWorkDate: string | null;
  latestActiveTime: string | null;
  cardClass: string;
  sectionTitleClass: string;
}) {
  return (
    <div className={`${cardClass} h-full space-y-3`}>
      <h3 className={sectionTitleClass}>Work Session</h3>
      <div className="grid grid-cols-2 gap-3 text-sm text-slate-700">
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Longest
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900">
            {longestWorkDuration}m
          </p>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Date
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900">
            {longestWorkDate || '-'}
          </p>
        </div>
        <div className="col-span-2 rounded-xl bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Last Active
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900">
            {latestActiveTime || '-'}
          </p>
        </div>
      </div>
    </div>
  );
}

// Heatmap Section Component
export function HeatmapSection({
  heatmap,
}: {
  heatmap: Record<string, number>;
}) {
  const cardClass = 'glass-card p-6';
  const sectionTitleClass =
    'text-lg font-semibold tracking-tight text-slate-900';

  return (
    <div className={`${cardClass} mt-4 space-y-4 md:mt-6`}>
      <div className="flex items-center justify-between">
        <h3 className={sectionTitleClass}>Activity Heatmap</h3>
        <span className="text-xs font-semibold text-slate-500">Past year</span>
      </div>
      <div className="heatmap-container">
        <div className="min-w-[720px] rounded-xl border border-slate-100 bg-white/70 p-4 shadow-inner shadow-slate-100">
          <ActivityHeatmap heatmapData={heatmap} />
        </div>
      </div>
    </div>
  );
}

// Activity Heatmap Component
function ActivityHeatmap({
  heatmapData,
}: {
  heatmapData: Record<string, number>;
}) {
  const width = 1000;
  const height = 150;
  const cellSize = 14;
  const cellPadding = 2;

  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(today.getFullYear() - 1);

  // Generate all dates for the past year
  const dates = [];
  const currentDate = new Date(oneYearAgo);
  while (currentDate <= today) {
    dates.push(new Date(currentDate));
    currentDate.setDate(currentDate.getDate() + 1);
  }

  const colorLevels = [0, 2, 4, 10, 20];
  const colors = ['#e2e8f0', '#a5d8ff', '#74c0fc', '#339af0', '#1c7ed6'];

  function getColor(value: number) {
    if (value === 0) return colors[0];
    for (let i = colorLevels.length - 1; i >= 1; i--) {
      if (value >= colorLevels[i]) return colors[i];
    }
    return colors[1];
  }

  const weeksInYear = Math.ceil(dates.length / 7);
  const startX = 50;
  const startY = 20;

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  // Generate month labels
  const monthLabels = [];
  let currentMonth = oneYearAgo.getMonth();
  let monthX = startX;

  for (let week = 0; week < weeksInYear; week++) {
    const weekDate = new Date(oneYearAgo);
    weekDate.setDate(weekDate.getDate() + week * 7);

    if (weekDate.getMonth() !== currentMonth) {
      currentMonth = weekDate.getMonth();
      monthLabels.push({
        x: monthX,
        text: months[currentMonth],
      });
      monthX = startX + week * (cellSize + cellPadding);
    }
  }

  return (
    <svg
      className="heatmap-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {/* Render heatmap cells */}
      {dates.map((date, index) => {
        const week = Math.floor(index / 7);
        const day = index % 7;

        const x = startX + week * (cellSize + cellPadding);
        const y = startY + day * (cellSize + cellPadding);

        const dateKey = date.toISOString().split('T')[0];
        const value = heatmapData[dateKey] || 0;
        const color = getColor(value);

        return (
          <rect
            key={dateKey}
            className="heatmap-day"
            x={x}
            y={y}
            width={cellSize}
            height={cellSize}
            rx="2"
            fill={color}
            data-date={dateKey}
            data-count={value}
          >
            <title>
              {dateKey}: {value} activities
            </title>
          </rect>
        );
      })}

      {/* Render month labels */}
      {monthLabels.map((label, index) => (
        <text key={index} x={label.x} y="15" fontSize="12" fill="#64748b">
          {label.text}
        </text>
      ))}

      {/* Render legend */}
      <text x={startX} y={height - 40} fontSize="12" fill="#64748b">
        Less
      </text>
      {colors.map((color, index) => {
        const legendX = startX + 40 + index * (cellSize + 2);
        return (
          <rect
            key={index}
            x={legendX}
            y={height - 30}
            width="10"
            height="10"
            rx="2"
            fill={color}
          />
        );
      })}
      <text
        x={startX + 40 + colors.length * (cellSize + 2) + 5}
        y={height - 21}
        fontSize="12"
        fill="#64748b"
        width={cellSize}
      >
        More
      </text>
    </svg>
  );
}
