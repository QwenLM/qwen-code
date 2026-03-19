import type { InsightData } from './types';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';

// -----------------------------------------------------------------------------
// Existing Components
// -----------------------------------------------------------------------------

// Dashboard Cards Component
export function DashboardCards({ insights }: { insights: InsightData }) {
  const cardClass = 'glass-card p-6';
  const sectionTitleClass =
    'text-lg font-semibold tracking-tight text-slate-900';

  return (
    <div className="grid gap-4 md:grid-cols-2 md:gap-6">
      <ActiveHoursChart
        activeHours={insights.activeHours}
        cardClass={cardClass}
        sectionTitleClass={sectionTitleClass}
      />
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
  const phases = [
    {
      label: 'Morning',
      time: '06:00 - 12:00',
      hours: [6, 7, 8, 9, 10, 11],
      color: '#fbbf24', // amber-400
    },
    {
      label: 'Afternoon',
      time: '12:00 - 18:00',
      hours: [12, 13, 14, 15, 16, 17],
      color: '#0ea5e9', // sky-500
    },
    {
      label: 'Evening',
      time: '18:00 - 22:00',
      hours: [18, 19, 20, 21],
      color: '#6366f1', // indigo-500
    },
    {
      label: 'Night',
      time: '22:00 - 06:00',
      hours: [22, 23, 0, 1, 2, 3, 4, 5],
      color: '#475569', // slate-600
    },
  ];

  const data = phases.map((phase) => {
    const total = phase.hours.reduce(
      (acc, hour) => acc + (activeHours[hour] || 0),
      0,
    );
    return { ...phase, total };
  });

  const maxTotal = Math.max(...data.map((d) => d.total));

  return (
    <div className={`${cardClass} h-full flex flex-col min-h-[320px]`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className={sectionTitleClass}>Active Hours</h3>
      </div>
      <div className="flex-1 flex flex-col justify-center gap-4">
        {data.map((item) => (
          <div key={item.label} className="space-y-2">
            <div className="flex justify-between items-center text-sm">
              <div className="flex items-center gap-2">
                <span
                  className="rounded-full"
                  style={{
                    width: '12px',
                    height: '12px',
                    backgroundColor: item.color,
                  }}
                ></span>
                <span className="font-medium text-slate-700">{item.label}</span>
                <span className="text-xs text-slate-400 hidden xl:inline">
                  {item.time}
                </span>
              </div>
              <span className="font-semibold text-slate-900">{item.total}</span>
            </div>
            <div
              className="w-full rounded-full overflow-hidden"
              style={{ height: '12px', backgroundColor: '#e2e8f0' }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${maxTotal > 0 ? (item.total / maxTotal) * 100 : 0}%`,
                  backgroundColor: item.color,
                }}
              />
            </div>
          </div>
        ))}
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
    <div className={`${cardClass} mt-4 md:mt-6`}>
      <div className="mb-3">
        <h3 className={sectionTitleClass}>Activity Heatmap</h3>
        <p className="text-xs text-slate-500">Showing past year of activity</p>
      </div>
      <div className="heatmap-container">
        <div className="min-w-[720px] rounded-xl bg-white/70">
          <ActivityHeatmap heatmapData={heatmap} />
        </div>
      </div>
      <HeatmapLegend />
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
  const height = 130;
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
  // GitHub contribution graph color palette (green)
  const colors = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];

  function getColor(value: number) {
    if (value === 0) return colors[0];
    for (let i = colorLevels.length - 1; i >= 1; i--) {
      if (value >= colorLevels[i]) return colors[i];
    }
    return colors[1];
  }

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

  // Calculate start day of week (0 = Sunday, 1 = Monday, etc.)
  const startDayOfWeek = oneYearAgo.getDay();

  // Generate month labels
  const monthLabels: Array<{ x: number; text: string }> = [];
  let lastMonth = -1;
  let lastX = -100; // Initialize with a value far to the left

  dates.forEach((date, index) => {
    // Calculate position
    const adjustedIndex = index + startDayOfWeek;
    const week = Math.floor(adjustedIndex / 7);
    const x = startX + week * (cellSize + cellPadding);

    const currentMonth = date.getMonth();

    // Add month label if month changes
    if (currentMonth !== lastMonth) {
      // Only add label if there is enough space from the previous one
      // Approximate width of a month label is about 25-30px
      if (x - lastX > 30) {
        monthLabels.push({
          x,
          text: months[currentMonth],
        });
        lastX = x;
      }
      lastMonth = currentMonth;
    }
  });

  return (
    <svg
      className="heatmap-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {/* Render heatmap cells */}
      {dates.map((date, index) => {
        // Calculate grid position based on calendar week and day
        const adjustedIndex = index + startDayOfWeek;
        const week = Math.floor(adjustedIndex / 7);
        const day = date.getDay(); // 0 (Sun) to 6 (Sat)

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
    </svg>
  );
}

// Heatmap Legend Component (outside SVG)
function HeatmapLegend() {
  const colors = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];

  return (
    <div className="flex items-center gap-2 mt-4">
      <span className="text-xs text-slate-500">Less</span>
      {colors.map((color, index) => (
        <span
          key={index}
          className="inline-block rounded"
          style={{
            width: '10px',
            height: '10px',
            backgroundColor: color,
          }}
        />
      ))}
      <span className="text-xs text-slate-500">More</span>
    </div>
  );
}
