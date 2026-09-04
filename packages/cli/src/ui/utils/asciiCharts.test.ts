/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildHeatmapData, buildBrailleLineChart } from './asciiCharts.js';

describe('buildHeatmapData', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-04T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 7 rows for empty data', () => {
    const result = buildHeatmapData({}, 8);
    expect(result.rows).toHaveLength(7);
    expect(result.rows[0]!.label.trim()).toBe('Mon');
    expect(result.rows[6]!.label.trim()).toBe('Sun');
  });

  it('all cells have intensity 0 for empty data', () => {
    const result = buildHeatmapData({}, 8);
    for (const row of result.rows) {
      for (const cell of row.cells) {
        expect(cell.intensity).toBe(0);
      }
    }
  });

  it('assigns non-zero intensity for days with data', () => {
    const data: Record<string, number> = {
      '2025-06-02': 100,
      '2025-06-03': 500,
      '2025-06-04': 1000,
    };
    const result = buildHeatmapData(data, 8);

    const allCells = result.rows.flatMap((r) => r.cells);
    const filled = allCells.filter((c) => c.intensity > 0);
    expect(filled.length).toBeGreaterThanOrEqual(3);
  });

  it('marks today cell with isToday flag', () => {
    const data: Record<string, number> = { '2025-06-04': 100 };
    const result = buildHeatmapData(data, 8);

    const allCells = result.rows.flatMap((r) => r.cells);
    const todayCells = allCells.filter((c) => c.isToday);
    expect(todayCells).toHaveLength(1);
    expect(todayCells[0]!.intensity).toBeGreaterThan(0);
  });

  it('startDate and endDate are valid date strings', () => {
    const result = buildHeatmapData({}, 8);
    expect(result.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(result.startDate).getTime()).toBeLessThan(
      new Date(result.endDate).getTime(),
    );
  });

  it('generates column labels with month names', () => {
    const result = buildHeatmapData({}, 12);
    const monthLabels = result.colLabels.filter((cl) => cl.text.length === 3);
    expect(monthLabels.length).toBeGreaterThan(0);
    const validMonths = [
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
    for (const label of monthLabels) {
      expect(validMonths).toContain(label.text);
    }
  });

  it('computes dynamic thresholds from data distribution', () => {
    const data: Record<string, number> = {
      '2025-05-01': 10,
      '2025-05-02': 50,
      '2025-05-03': 100,
      '2025-05-04': 500,
      '2025-05-05': 1000,
    };
    const result = buildHeatmapData(data, 8);

    const allCells = result.rows.flatMap((r) => r.cells);
    const intensities = new Set(allCells.map((c) => c.intensity));
    expect(intensities.size).toBeGreaterThan(1);
  });

  it('pads all rows to same length', () => {
    const result = buildHeatmapData({}, 8);
    const lengths = result.rows.map((r) => r.cells.length);
    expect(new Set(lengths).size).toBe(1);
  });

  it('totalCols matches cell count per row', () => {
    const result = buildHeatmapData({}, 10);
    expect(result.totalCols).toBe(result.rows[0]!.cells.length);
  });

  it('supports monthOffset to shift view backward', () => {
    const data: Record<string, number> = { '2025-04-15': 100 };
    const noOffset = buildHeatmapData(data, 8, 0);
    const withOffset = buildHeatmapData(data, 8, 1);
    expect(new Date(withOffset.endDate).getTime()).toBeLessThan(
      new Date(noOffset.endDate).getTime(),
    );
  });
});

describe('buildBrailleLineChart', () => {
  it('returns null for empty data', () => {
    const result = buildBrailleLineChart([], 40, 8);
    expect(result).toBeNull();
  });

  it('returns null when all values are zero', () => {
    const data = [
      { date: '2025-06-01', value: 0 },
      { date: '2025-06-02', value: 0 },
    ];
    const result = buildBrailleLineChart(data, 40, 8);
    expect(result).toBeNull();
  });

  it('returns correct number of rows', () => {
    const data = [
      { date: '2025-06-01', value: 100 },
      { date: '2025-06-02', value: 200 },
      { date: '2025-06-03', value: 150 },
    ];
    const result = buildBrailleLineChart(data, 40, 8);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(8);
  });

  it('rows have correct width', () => {
    const data = [
      { date: '2025-06-01', value: 100 },
      { date: '2025-06-02', value: 200 },
    ];
    const chartWidth = 30;
    const result = buildBrailleLineChart(data, chartWidth, 6);
    expect(result).not.toBeNull();
    for (const row of result!.rows) {
      expect(row).toHaveLength(chartWidth);
    }
  });

  it('peak equals the maximum value in data', () => {
    const data = [
      { date: '2025-06-01', value: 100 },
      { date: '2025-06-02', value: 500 },
      { date: '2025-06-03', value: 300 },
    ];
    const result = buildBrailleLineChart(data, 40, 8);
    expect(result!.peak).toBe(500);
  });

  it('marks data point cells with isDataPoint', () => {
    const data = [
      { date: '2025-06-01', value: 100 },
      { date: '2025-06-02', value: 200 },
    ];
    const result = buildBrailleLineChart(data, 40, 8);
    const dpCells = result!.rows.flatMap((r) => r.filter((c) => c.isDataPoint));
    expect(dpCells.length).toBeGreaterThan(0);
    for (const cell of dpCells) {
      expect(cell.char).toBe('*');
      expect(cell.filled).toBe(true);
    }
  });

  it('has filled cells between data points (Bresenham line)', () => {
    const data = [
      { date: '2025-06-01', value: 100 },
      { date: '2025-06-02', value: 500 },
    ];
    const result = buildBrailleLineChart(data, 40, 8);
    const filledCells = result!.rows.flatMap((r) => r.filter((c) => c.filled));
    expect(filledCells.length).toBeGreaterThan(2);
  });

  it('generates yLabels matching row count', () => {
    const data = [
      { date: '2025-06-01', value: 1000 },
      { date: '2025-06-02', value: 2000 },
    ];
    const chartHeight = 6;
    const result = buildBrailleLineChart(data, 40, chartHeight);
    expect(result!.yLabels).toHaveLength(chartHeight);
  });

  it('generates xLabels string', () => {
    const data = [
      { date: '2025-06-01', value: 100 },
      { date: '2025-06-02', value: 200 },
      { date: '2025-06-03', value: 300 },
    ];
    const result = buildBrailleLineChart(data, 40, 8);
    expect(typeof result!.xLabels).toBe('string');
    expect(result!.xLabels.length).toBe(40);
  });

  it('handles single data point', () => {
    const data = [{ date: '2025-06-01', value: 100 }];
    const result = buildBrailleLineChart(data, 40, 8);
    expect(result).not.toBeNull();
    expect(result!.peak).toBe(100);
  });

  it('sorts data by date regardless of input order', () => {
    const data = [
      { date: '2025-06-03', value: 300 },
      { date: '2025-06-01', value: 100 },
      { date: '2025-06-02', value: 200 },
    ];
    const result = buildBrailleLineChart(data, 40, 8);
    expect(result).not.toBeNull();
    expect(result!.peak).toBe(300);
  });
});
