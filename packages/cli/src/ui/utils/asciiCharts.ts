/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

const HEATMAP_CHARS = ['··', '  ', '  ', '  ', '  '] as const;
export const MONTH_LABELS = [
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
const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'] as const;

function getMonthLabel(month: number): string {
  return MONTH_LABELS[month]!;
}

export type HeatmapIntensity = 0 | 1 | 2 | 3 | 4;

export interface HeatmapCell {
  char: string;
  intensity: HeatmapIntensity;
  isToday?: boolean;
}

export interface HeatmapRow {
  label: string;
  cells: HeatmapCell[];
}

export interface HeatmapColLabel {
  col: number;
  text: string;
}

export interface HeatmapData {
  colLabels: HeatmapColLabel[];
  totalCols: number;
  startDate: string;
  endDate: string;
  rows: HeatmapRow[];
}

function intensityLevel(
  count: number,
  thresholds: [number, number, number, number],
): HeatmapIntensity {
  if (count === 0) return 0;
  if (count <= thresholds[0]) return 1;
  if (count <= thresholds[1]) return 2;
  if (count <= thresholds[2]) return 3;
  return 4;
}

function computeThresholds(
  data: Record<string, number>,
): [number, number, number, number] {
  const values = Object.values(data)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return [1, 2, 4, 8];
  const p = (pct: number) =>
    values[Math.floor(values.length * pct)] || values[values.length - 1]!;
  return [p(0.25), p(0.5), p(0.75), p(0.9)];
}

function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function buildHeatmapData(
  data: Record<string, number>,
  weeks: number = 52,
  monthOffset: number = 0,
): HeatmapData {
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Use the later of today or latest data date as the end reference
  const dataKeys = Object.keys(data)
    .filter((k) => data[k]! > 0)
    .sort();
  let endDate = new Date(now);
  if (dataKeys.length > 0) {
    const latest = new Date(dataKeys[dataKeys.length - 1]!);
    latest.setHours(0, 0, 0, 0);
    if (latest.getTime() > endDate.getTime()) endDate = latest;
  }

  // Shift endDate back by monthOffset months
  if (monthOffset > 0) {
    endDate.setMonth(endDate.getMonth() - monthOffset);
    // Set to end of that month
    endDate.setMonth(endDate.getMonth() + 1, 0);
  }

  const endDay = endDate.getDay();
  const endOffset = endDay === 0 ? 6 : endDay - 1;
  const totalDays = weeks * 7 + endOffset + 1;

  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - totalDays + 1);
  const startDay = startDate.getDay();
  const mondayOffset = startDay === 0 ? 1 : startDay === 1 ? 0 : 8 - startDay;
  startDate.setDate(startDate.getDate() + mondayOffset);

  const thresholds = computeThresholds(data);

  const grid: HeatmapCell[][] = [];
  for (let row = 0; row < 7; row++) {
    grid.push([]);
  }

  let col = 0;
  const colMondays: Array<{ col: number; date: Date }> = [];

  const todayKey = formatDateKey(new Date());
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const dayOfWeek = cursor.getDay();
    const row = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const key = formatDateKey(cursor);
    const count = data[key] || 0;
    const level = intensityLevel(count, thresholds);
    const isToday = key === todayKey;
    grid[row]!.push({ char: HEATMAP_CHARS[level]!, intensity: level, isToday });

    if (dayOfWeek === 1) {
      colMondays.push({ col, date: new Date(cursor) });
      col++;
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  // Build colLabels: month names at month boundaries, day numbers in between
  // Rules:
  //   - Month label (e.g. "Sep") occupies 2 cols (4 chars), left-aligned
  //   - Day number (e.g. "15") occupies 1 col (2 chars), left-aligned
  //   - At least 1 empty col gap between any labels
  //   - At least 1 empty col gap after month label before first day
  //   - At least 1 empty col gap before next month label
  const colLabels: HeatmapColLabel[] = [];
  const occupied = new Set<number>();
  let prevMonth = -1;

  // Pass 1: place month labels
  for (const cm of colMondays) {
    const month = cm.date.getMonth();
    if (month !== prevMonth) {
      colLabels.push({ col: cm.col, text: getMonthLabel(month) });
      occupied.add(cm.col);
      occupied.add(cm.col + 1);
      prevMonth = month;
    }
  }

  // Handle first month if started mid-week
  if (colLabels.length === 0 || colLabels[0]!.col > 0) {
    const firstMonth = startDate.getMonth();
    const label = getMonthLabel(firstMonth);
    if (colLabels.length === 0 || colLabels[0]!.text !== label) {
      colLabels.unshift({ col: 0, text: label });
      occupied.add(0);
      occupied.add(1);
    }
  }

  // Build set of month-label columns for gap checks
  const monthCols = new Set(colLabels.map((cl) => cl.col));

  // Pass 2: fill day numbers in gaps
  // Month label at col C occupies C and C+1. First day can go at C+3 (2 col gap).
  // Between days, leave at least 1 empty col gap.
  let nextAvail = 0;
  for (const cm of colMondays) {
    if (occupied.has(cm.col)) {
      if (monthCols.has(cm.col)) nextAvail = cm.col + 3;
      continue;
    }
    if (cm.col < nextAvail) continue;
    // Don't place right before or 1 col before a month label
    const nextMonth = [...monthCols].find((mc) => mc > cm.col);
    if (nextMonth !== undefined && nextMonth - cm.col <= 1) continue;
    colLabels.push({ col: cm.col, text: String(cm.date.getDate()) });
    occupied.add(cm.col);
    nextAvail = cm.col + 2;
  }

  colLabels.sort((a, b) => a.col - b.col);

  const labelWidth = 4;
  const maxCells = Math.max(...grid.map((r) => r.length));
  for (const row of grid) {
    while (row.length < maxCells) {
      row.push({ char: '  ', intensity: 0 });
    }
  }

  const rows: HeatmapRow[] = [];
  for (let row = 0; row < 7; row++) {
    rows.push({
      label: (DAY_LABELS[row] || '').padEnd(labelWidth),
      cells: grid[row]!,
    });
  }

  return {
    colLabels,
    totalCols: maxCells,
    startDate: formatDateKey(startDate),
    endDate: formatDateKey(endDate),
    rows,
  };
}

export interface LineChartPoint {
  date: string;
  value: number;
}

export interface BrailleLineCell {
  char: string;
  filled: boolean;
  isDataPoint?: boolean;
}

export interface BrailleLineResult {
  rows: BrailleLineCell[][]; // rows[0] = top row
  yLabels: string[]; // one label per row, right-aligned
  xLabels: string; // date axis string
  peak: number;
}

function fmtAxisValue(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

export function buildBrailleLineChart(
  data: LineChartPoint[],
  chartWidth: number,
  chartHeight: number = 8,
): BrailleLineResult | null {
  if (data.length === 0) return null;

  const pixelW = chartWidth * 2;
  const pixelH = chartHeight * 4;

  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return null;

  const peak = Math.max(...sorted.map((p) => p.value));
  if (peak === 0) return null;

  const pixels: boolean[][] = [];
  for (let y = 0; y < pixelH; y++) {
    pixels.push(new Array(pixelW).fill(false) as boolean[]);
  }

  const mappedPoints: Array<{ px: number; py: number }> = sorted.map((p, i) => {
    const px =
      sorted.length === 1
        ? Math.floor(pixelW / 2)
        : Math.round((i / (sorted.length - 1)) * (pixelW - 1));
    let py: number;
    if (p.value === 0) {
      py = pixelH - 1;
    } else {
      const normalized = p.value / peak;
      py = Math.min(pixelH - 2, Math.floor((1 - normalized) * (pixelH - 1)));
    }
    return { px, py };
  });

  // Bresenham's line between consecutive mapped points
  for (let i = 0; i < mappedPoints.length; i++) {
    const { px, py } = mappedPoints[i]!;
    if (py >= 0 && py < pixelH && px >= 0 && px < pixelW) {
      pixels[py]![px] = true;
    }

    if (i > 0) {
      const { px: x0, py: y0 } = mappedPoints[i - 1]!;
      const x1 = px;
      const y1 = py;
      const dx = Math.abs(x1 - x0);
      const dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      let cx = x0;
      let cy = y0;
      while (true) {
        if (cx >= 0 && cx < pixelW && cy >= 0 && cy < pixelH) {
          pixels[cy]![cx] = true;
        }
        if (cx === x1 && cy === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          cx += sx;
        }
        if (e2 <= dx) {
          err += dx;
          cy += sy;
        }
      }
    }
  }

  const dataPointCells = new Set<string>();
  for (const mp of mappedPoints) {
    const cc = Math.floor(mp.px / 2);
    const cr = Math.floor(mp.py / 4);
    dataPointCells.add(`${cc},${cr}`);
  }

  const rows: BrailleLineCell[][] = [];
  const DOT_BITS = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
  ];

  for (let charRow = 0; charRow < chartHeight; charRow++) {
    const row: BrailleLineCell[] = [];
    for (let charCol = 0; charCol < chartWidth; charCol++) {
      let bits = 0;
      for (let dr = 0; dr < 4; dr++) {
        const py = charRow * 4 + dr;
        if (py >= pixelH) continue;
        for (let dc = 0; dc < 2; dc++) {
          const px = charCol * 2 + dc;
          if (px < pixelW && pixels[py]![px]) {
            bits |= DOT_BITS[dr]![dc]!;
          }
        }
      }
      const isDP = dataPointCells.has(`${charCol},${charRow}`);
      row.push({
        char: isDP ? '*' : String.fromCharCode(0x2800 + bits),
        filled: bits !== 0 || isDP,
        isDataPoint: isDP,
      });
    }
    rows.push(row);
  }

  const yLabels: string[] = [];
  for (let r = 0; r < chartHeight; r++) {
    const fraction = 1 - r / (chartHeight - 1);
    const value = Math.round(peak * fraction);
    yLabels.push(fmtAxisValue(value));
  }

  // X-axis: place a label at each data point's character column,
  // skipping when labels would be closer than 3 characters apart.
  const xChars: string[] = new Array(chartWidth).fill(' ');
  let nextAllowed = 0;
  for (let di = 0; di < mappedPoints.length; di++) {
    const cc = Math.floor(mappedPoints[di]!.px / 2);
    if (cc < nextAllowed || cc >= chartWidth) continue;
    const day = String(new Date(sorted[di]!.date + 'T00:00:00').getDate());
    if (cc + day.length > chartWidth) continue;
    for (let k = 0; k < day.length; k++) xChars[cc + k] = day[k]!;
    nextAllowed = cc + day.length + 1;
  }
  const xLabels = xChars.join('');

  return { rows, yLabels, xLabels, peak };
}
