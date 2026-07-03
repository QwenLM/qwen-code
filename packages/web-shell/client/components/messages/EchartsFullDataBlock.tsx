import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CodeBlockRenderer,
  WebShellCodeBlockRenderInfo,
} from '../../customization';
import {
  EnhancedTable,
  MAX_ENHANCED_TABLE_COLUMNS,
  MAX_ENHANCED_TABLE_ROWS,
  type EnhancedTableData,
} from './EnhancedMarkdownTable';
import styles from './EchartsFullDataBlock.module.css';

export const ECHARTS_FULLDATA_LANGUAGE = 'echarts-fulldata';

type DatasetCell = string | number | boolean | null;
type DatasetRow = Record<string, DatasetCell> | DatasetCell[];
type DatasetSource = DatasetRow[];
type DatasetDimension = string | { name?: string };
type EchartsObject = Record<string, unknown>;
type ChartTheme = 'dark' | 'light';

interface EchartsDataset {
  dimensions?: DatasetDimension[];
  source?: DatasetSource;
}

export interface EchartsFullDataOption {
  title?: { text?: string } | Array<{ text?: string }>;
  dataset?: EchartsDataset | EchartsDataset[];
  [key: string]: unknown;
}

export interface EchartsInstance {
  setOption(option: EchartsFullDataOption): void;
  resize(): void;
  dispose(): void;
}

export interface EchartsRuntime {
  init(element: HTMLElement, theme?: string): EchartsInstance;
}

export type EchartsRuntimeLoader = () =>
  | EchartsRuntime
  | Promise<EchartsRuntime>;

export interface EchartsFullDataBlockProps {
  /**
   * Chart option. Must be JSON-serializable; functions and other non-JSON
   * values are stripped during internal cloning.
   */
  option?: EchartsFullDataOption;
  parseError?: string;
  isStreaming?: boolean;
  theme: ChartTheme;
  loadEcharts?: EchartsRuntimeLoader;
}

export interface EchartsFullDataRendererOptions {
  loadEcharts?: EchartsRuntimeLoader;
}

interface EchartsFullDataBlockFromCodeProps {
  code: string;
  isStreaming: boolean;
  theme: ChartTheme;
  loadEcharts?: EchartsRuntimeLoader;
}

const CHART_THEME = {
  light: {
    background: '#ffffff',
    foreground: '#343434',
    muted: '#838d95',
    border: '#e0e6f1',
    axisLine: '#5d666f',
    axisPointer: '#7c8a96',
    tooltipBackground: '#ffffff',
    tooltipShadow: '0 8px 24px rgba(15,23,42,0.12)',
    primary: '#6250f9',
    palette: [
      '#6250F9',
      '#33AFA9',
      '#AB7BFF',
      '#5F99F9',
      '#A9AFFF',
      '#60CCC5',
      '#C2A5FF',
      '#8EB8FE',
      '#E0E3FE',
      '#98E3DD',
      '#E8E1FA',
      '#D7E6FF',
    ],
  },
  dark: {
    background: '#0d0d0d',
    foreground: '#f4f7ff',
    muted: '#9aa3b7',
    border: 'rgba(129,145,209,0.24)',
    axisLine: '#657086',
    axisPointer: '#8a98b3',
    tooltipBackground: '#161616',
    tooltipShadow: '0 10px 28px rgba(0,0,0,0.34)',
    primary: '#8aa0ff',
    palette: [
      '#8AA0FF',
      '#60CCC5',
      '#C2A5FF',
      '#5F99F9',
      '#A9AFFF',
      '#33AFA9',
      '#AB7BFF',
      '#8EB8FE',
      '#E0E3FE',
      '#98E3DD',
      '#E8E1FA',
      '#D7E6FF',
    ],
  },
} satisfies Record<ChartTheme, Record<string, unknown> & { palette: string[] }>;

const MAX_CHART_CODE_LENGTH = 500_000;
const MAX_OPTION_DEPTH = 40;
const MAX_DATA_ROWS = 2_000;
const MAX_DATA_CELLS = 40_000;
const noop = () => {};

const SAFE_TOP_LEVEL_OPTION_KEYS = new Set([
  'angleAxis',
  'backgroundColor',
  'color',
  'dataset',
  'dataZoom',
  'grid',
  'legend',
  'polar',
  'radar',
  'radiusAxis',
  'series',
  'textStyle',
  'title',
  'tooltip',
  'xAxis',
  'yAxis',
]);

const UNSAFE_OPTION_KEYS = new Set([
  'appendTo',
  'backgroundImage',
  'brush',
  'calendar',
  'extraCssText',
  'geo',
  'graphic',
  'href',
  'image',
  'link',
  'map',
  'media',
  'renderItem',
  'src',
  'target',
  'timeline',
  'toolbox',
  'url',
]);

function isObject(value: unknown): value is EchartsObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeDefaults(defaults: EchartsObject, value: unknown): EchartsObject {
  if (!isObject(value)) return { ...defaults };
  const merged: EchartsObject = { ...defaults, ...value };
  for (const key of Object.keys(defaults)) {
    if (isObject(defaults[key]) && isObject(value[key])) {
      merged[key] = mergeDefaults(defaults[key] as EchartsObject, value[key]);
    }
  }
  return merged;
}

function styleComponent(value: unknown, defaults: EchartsObject): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      isObject(entry) ? mergeDefaults(defaults, entry) : entry,
    );
  }
  if (isObject(value)) return mergeDefaults(defaults, value);
  return value == null ? { ...defaults } : value;
}

function forceTooltipSafety(value: unknown, safeExtraCssText: string): unknown {
  const force = (entry: unknown) =>
    isObject(entry)
      ? {
          ...entry,
          appendToBody: false,
          confine: true,
          enterable: false,
          extraCssText: safeExtraCssText,
          renderMode: 'richText',
        }
      : entry;

  if (Array.isArray(value)) return value.map(force);
  return force(value);
}

function getSafeTooltipCss(tokens: (typeof CHART_THEME)[ChartTheme]): string {
  return `border-radius:6px;box-shadow:${tokens.tooltipShadow};max-height:300px;overflow:auto;white-space:pre-wrap;`;
}

function styleExistingObject(value: unknown, defaults: EchartsObject): unknown {
  return isObject(value) ? mergeDefaults(defaults, value) : value;
}

function styleAxis(
  value: unknown,
  getDefaults: (index: number) => EchartsObject,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      isObject(entry) ? mergeDefaults(getDefaults(index), entry) : entry,
    );
  }
  if (isObject(value)) return mergeDefaults(getDefaults(0), value);
  return value;
}

function exceedsMaxDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.depth > maxDepth) return true;
    if (!current.value || typeof current.value !== 'object') continue;

    const entries = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const entry of entries) {
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }

  return false;
}

function isUnsafeString(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith('data:') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('image://') ||
    normalized.startsWith('javascript:') ||
    /<\/?[a-z]/i.test(value)
  );
}

function sanitizeDatasetCell(value: unknown): DatasetCell {
  if (typeof value === 'string') return isUnsafeString(value) ? '' : value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  return '';
}

function sanitizeDatasetRow(row: unknown): DatasetRow | undefined {
  if (Array.isArray(row)) return row.map(sanitizeDatasetCell);
  if (!isObject(row)) return undefined;

  const sanitized: Record<string, DatasetCell> = {};
  for (const [key, value] of Object.entries(row)) {
    sanitized[key] = sanitizeDatasetCell(value);
  }
  return sanitized;
}

function sanitizeOptionValue(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeOptionValue(entry, path))
      .filter((entry) => entry !== undefined);
  }

  if (isObject(value)) {
    const sanitized: EchartsObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (UNSAFE_OPTION_KEYS.has(key)) continue;
      if (key === 'formatter' && path.includes('tooltip')) continue;

      const next = sanitizeOptionValue(entry, [...path, key]);
      if (next !== undefined) sanitized[key] = next;
    }
    return sanitized;
  }

  if (typeof value === 'string' && isUnsafeString(value)) return undefined;
  return value;
}

function sanitizeDatasetValue(value: unknown): unknown {
  const sanitizeDataset = (entry: unknown) => {
    if (!isObject(entry)) return undefined;
    const dataset: EchartsDataset = {};
    if (Array.isArray(entry.dimensions)) {
      dataset.dimensions = entry.dimensions.filter(
        (dimension): dimension is DatasetDimension =>
          typeof dimension === 'string' || isObject(dimension),
      );
    }
    if (Array.isArray(entry.source)) {
      dataset.source = entry.source
        .map(sanitizeDatasetRow)
        .filter((row): row is DatasetRow => !!row);
    }
    return dataset;
  };

  if (Array.isArray(value)) return value.map(sanitizeDataset).filter(Boolean);
  return sanitizeDataset(value);
}

function sanitizeOptionForChart(
  option: EchartsFullDataOption,
): EchartsFullDataOption {
  const sanitized: EchartsFullDataOption = {};
  for (const [key, value] of Object.entries(option)) {
    if (!SAFE_TOP_LEVEL_OPTION_KEYS.has(key)) continue;
    const next =
      key === 'dataset'
        ? sanitizeDatasetValue(value)
        : sanitizeOptionValue(value, [key]);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

function getSeriesList(series: unknown): EchartsObject[] {
  if (Array.isArray(series)) return series.filter(isObject);
  return isObject(series) ? [series] : [];
}

function getEncodedDimension(
  value: unknown,
  dimensions: string[],
): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === 'string') return candidate;
  if (typeof candidate === 'number' && Number.isInteger(candidate)) {
    return dimensions[candidate];
  }
  return undefined;
}

function normalizeDatasetValueFormatter(
  formatter: unknown,
  dimension: string | undefined,
): unknown {
  if (typeof formatter !== 'string' || !dimension) return formatter;
  return formatter.replace(/\{c(?::[^}]*)?\}/g, `{@${dimension}}`);
}

function normalizeSeriesDatasetFormatters(
  series: EchartsObject,
  dimensions: string[],
): EchartsObject {
  const encode = isObject(series.encode) ? series.encode : undefined;
  const yDimension = getEncodedDimension(encode?.y, dimensions);
  if (!yDimension || !isObject(series.label)) return series;

  return {
    ...series,
    label: {
      ...series.label,
      formatter: normalizeDatasetValueFormatter(
        series.label.formatter,
        yDimension,
      ),
    },
  };
}

function normalizeObjectDatasetFormatters(
  option: EchartsFullDataOption,
): EchartsFullDataOption {
  const firstRow = getRows(option)[0];
  if (!isObject(firstRow)) return option;

  const dimensions = getColumns(option);
  if (dimensions.length === 0 || !('series' in option)) return option;

  if (Array.isArray(option.series)) {
    return {
      ...option,
      series: option.series.map((entry) =>
        isObject(entry)
          ? normalizeSeriesDatasetFormatters(entry, dimensions)
          : entry,
      ),
    };
  }

  return isObject(option.series)
    ? {
        ...option,
        series: normalizeSeriesDatasetFormatters(option.series, dimensions),
      }
    : option;
}

function getTooltipTrigger(option: EchartsFullDataOption): 'axis' | 'item' {
  const hasAxis = 'xAxis' in option || 'yAxis' in option;
  if (!hasAxis) return 'item';
  const series = getSeriesList(option.series);
  const itemOnlyTypes = new Set(['pie', 'funnel', 'gauge', 'radar', 'treemap']);
  if (
    series.length > 0 &&
    series.every((entry) => itemOnlyTypes.has(String(entry.type)))
  ) {
    return 'item';
  }
  return 'axis';
}

function styleSeriesEntry(
  series: EchartsObject,
  tokens: (typeof CHART_THEME)[ChartTheme],
): EchartsObject {
  const type = typeof series.type === 'string' ? series.type : undefined;
  let defaults: EchartsObject = {
    emphasis: {
      focus: 'series',
      itemStyle: {
        borderColor: tokens.background,
        borderWidth: 2,
      },
    },
    labelLayout: {
      hideOverlap: true,
    },
  };

  if (type === 'line') {
    defaults = mergeDefaults(defaults, {
      lineStyle: {
        width: 2,
      },
      itemStyle: {
        borderWidth: 1,
      },
      symbol: 'circle',
      symbolSize: 4,
    });
  } else if (type === 'bar') {
    defaults = mergeDefaults(defaults, {
      barCategoryGap: '48%',
      barMaxWidth: 42,
      itemStyle: {
        borderRadius: [3, 3, 0, 0],
      },
    });
  } else if (type === 'pie') {
    defaults = mergeDefaults(defaults, {
      itemStyle: {
        borderColor: tokens.background,
        borderWidth: 2,
      },
    });
  }

  const styled = mergeDefaults(defaults, series);
  const safeTooltipCss = getSafeTooltipCss(tokens);
  if ('tooltip' in series) {
    styled.tooltip = forceTooltipSafety(
      styleComponent(series.tooltip, {
        appendToBody: false,
        confine: true,
        enterable: false,
        extraCssText: safeTooltipCss,
        renderMode: 'richText',
      }),
      safeTooltipCss,
    );
  }
  const annotationLabel = {
    color: tokens.foreground,
    fontSize: 12,
    textBorderColor: tokens.background,
    textBorderWidth: 2,
  };

  if (isObject(series.label)) {
    styled.label = styleExistingObject(series.label, {
      color: tokens.foreground,
      fontSize: 12,
      textBorderColor: tokens.background,
      textBorderWidth: 2,
    });
  }
  if (isObject(series.markPoint)) {
    styled.markPoint = styleExistingObject(series.markPoint, {
      itemStyle: {
        borderColor: tokens.background,
        borderWidth: 1,
      },
      label: annotationLabel,
    });
  }
  if (isObject(series.markLine)) {
    styled.markLine = styleExistingObject(series.markLine, {
      label: {
        ...annotationLabel,
        color: tokens.muted,
      },
      lineStyle: {
        color: tokens.primary,
        type: 'dashed',
        width: 1.5,
      },
      symbol: ['none', 'none'],
    });
  }

  return styled;
}

function styleSeries(
  value: unknown,
  tokens: (typeof CHART_THEME)[ChartTheme],
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      isObject(entry) ? styleSeriesEntry(entry, tokens) : entry,
    );
  }
  return isObject(value) ? styleSeriesEntry(value, tokens) : value;
}

function applyDefaultChartStyle(
  option: EchartsFullDataOption,
  theme: ChartTheme,
): EchartsFullDataOption {
  const tokens = CHART_THEME[theme];
  const styled: EchartsFullDataOption = { ...option };

  styled.backgroundColor = option.backgroundColor ?? tokens.background;
  styled.color = option.color ?? tokens.palette;
  styled.textStyle = styleComponent(option.textStyle, {
    color: tokens.foreground,
    fontFamily:
      "'pingfang SC', 'helvetica neue', arial, 'hiragino sans gb', 'microsoft yahei ui', 'microsoft yahei', sans-serif",
  });
  styled.grid = styleComponent(option.grid, {
    top: 24,
    right: 36,
    bottom: 48,
    left: 24,
    containLabel: true,
  });
  const safeTooltipCss = getSafeTooltipCss(tokens);
  styled.tooltip = forceTooltipSafety(
    styleComponent(option.tooltip, {
      trigger: getTooltipTrigger(option),
      confine: true,
      enterable: false,
      renderMode: 'richText',
      backgroundColor: tokens.tooltipBackground,
      borderColor: tokens.border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: {
        color: tokens.foreground,
        fontSize: 12,
      },
      axisPointer: {
        lineStyle: {
          color: tokens.axisPointer,
          width: 1,
        },
        crossStyle: {
          color: tokens.axisPointer,
          width: 1,
        },
      },
      extraCssText: safeTooltipCss,
    }),
    safeTooltipCss,
  );
  styled.legend = styleComponent(option.legend, {
    type: 'scroll',
    bottom: 8,
    padding: [4, 16],
    textStyle: {
      color: tokens.muted,
      fontSize: 12,
    },
    pageIconColor: tokens.primary,
    pageIconInactiveColor: tokens.border,
    pageTextStyle: {
      color: tokens.muted,
    },
  });

  if ('xAxis' in option) {
    styled.xAxis = styleAxis(option.xAxis, () => ({
      axisLine: {
        show: true,
        lineStyle: {
          color: tokens.axisLine,
        },
      },
      axisTick: {
        show: true,
        lineStyle: {
          color: tokens.axisLine,
        },
      },
      axisLabel: {
        color: tokens.muted,
        fontSize: 12,
        hideOverlap: true,
      },
      splitLine: {
        show: false,
        lineStyle: {
          color: tokens.border,
        },
      },
      nameTextStyle: {
        color: tokens.muted,
      },
    }));
  }

  if ('yAxis' in option) {
    styled.yAxis = styleAxis(option.yAxis, (index) => ({
      alignTicks: true,
      axisLine: {
        show: false,
        lineStyle: {
          color: tokens.axisLine,
        },
      },
      axisTick: {
        show: false,
        lineStyle: {
          color: tokens.axisLine,
        },
      },
      axisLabel: {
        color: tokens.muted,
        fontSize: 12,
        hideOverlap: true,
      },
      splitLine: {
        show: index === 0,
        lineStyle: {
          color: tokens.border,
        },
      },
      nameGap: 12,
      nameTextStyle: {
        color: tokens.muted,
        align: index === 0 ? 'left' : 'right',
      },
    }));
  }

  if ('series' in option) {
    styled.series = styleSeries(option.series, tokens);
  }

  return styled;
}

function cloneAndSanitizeOptionForChart(
  option: EchartsFullDataOption,
): EchartsFullDataOption {
  const cloned = JSON.parse(JSON.stringify(option)) as EchartsFullDataOption;
  const normalized = normalizeObjectDatasetFormatters(cloned);
  return sanitizeOptionForChart(normalized);
}

function styleOptionForChart(
  option: EchartsFullDataOption,
  theme: ChartTheme,
): EchartsFullDataOption {
  const styled = applyDefaultChartStyle(option, theme);
  delete styled.title;
  return styled;
}

function getPrimaryDataset(
  option: EchartsFullDataOption | undefined,
): EchartsDataset | undefined {
  if (!option) return undefined;
  return Array.isArray(option.dataset) ? option.dataset[0] : option.dataset;
}

function getTitle(option: EchartsFullDataOption | undefined): string {
  const title = option?.title;
  if (Array.isArray(title)) {
    return (
      title.find(
        (entry): entry is { text: string } =>
          isObject(entry) && typeof entry.text === 'string' && !!entry.text,
      )?.text ?? 'Dataset chart'
    );
  }
  return isObject(title) && typeof title.text === 'string'
    ? title.text
    : 'Dataset chart';
}

function getRows(option: EchartsFullDataOption | undefined): DatasetSource {
  const source = getPrimaryDataset(option)?.source;
  return Array.isArray(source) ? source : [];
}

function normalizeDimensions(
  dimensions: DatasetDimension[] | undefined,
): string[] {
  if (!Array.isArray(dimensions)) return [];
  return dimensions.map((dimension, index) => {
    if (typeof dimension === 'string') return dimension;
    return typeof dimension.name === 'string' && dimension.name
      ? dimension.name
      : String(index);
  });
}

function getColumns(option: EchartsFullDataOption | undefined): string[] {
  const dataset = getPrimaryDataset(option);
  const explicit = normalizeDimensions(dataset?.dimensions);
  if (explicit.length > 0) return explicit;

  const first = getRows(option)[0];
  if (!first) return [];
  if (Array.isArray(first)) {
    return first.map((_, index) => String(index + 1));
  }
  return Object.keys(first);
}

function getCell(
  row: DatasetRow,
  column: string,
  columnIndex: number,
): DatasetCell | undefined {
  return Array.isArray(row) ? row[columnIndex] : row[column];
}

function formatCell(value: DatasetCell | undefined): string {
  if (value == null) return '';
  return String(value);
}

function validateOptionShape(
  option: EchartsFullDataOption,
): string | undefined {
  if (exceedsMaxDepth(option, MAX_OPTION_DEPTH)) {
    return 'Chart data is too deeply nested.';
  }

  const rows = getRows(option);
  if (rows.length === 0) {
    return 'Chart data must include dataset.source.';
  }
  if (rows.length > MAX_DATA_ROWS) {
    return `Chart data has too many rows. Maximum supported rows: ${MAX_DATA_ROWS}.`;
  }

  const columns = getColumns(option);
  const cellCount = rows.length * Math.max(columns.length, 1);
  if (cellCount > MAX_DATA_CELLS) {
    return `Chart data has too many cells. Maximum supported cells: ${MAX_DATA_CELLS}.`;
  }

  return undefined;
}

function parseOption(code: string): {
  option?: EchartsFullDataOption;
  parseError?: string;
} {
  if (code.length > MAX_CHART_CODE_LENGTH) {
    return {
      parseError: `Chart data is too large. Maximum supported size: ${MAX_CHART_CODE_LENGTH} characters.`,
    };
  }

  try {
    const parsed = JSON.parse(code) as unknown;
    if (!isObject(parsed)) {
      return { parseError: 'Chart data must be a JSON object.' };
    }
    const option = parsed as EchartsFullDataOption;
    const shapeError = validateOptionShape(option);
    if (shapeError) return { parseError: shapeError };
    return { option };
  } catch (error) {
    return {
      parseError:
        error instanceof Error ? error.message : 'Chart data is invalid.',
    };
  }
}

export function createEchartsFullDataRenderer({
  loadEcharts,
}: EchartsFullDataRendererOptions = {}): CodeBlockRenderer {
  return function renderEchartsFullDataBlock(
    info: WebShellCodeBlockRenderInfo,
  ) {
    if (info.language !== ECHARTS_FULLDATA_LANGUAGE) return undefined;
    return (
      <EchartsFullDataBlockFromCode
        code={info.code}
        isStreaming={info.isStreaming}
        theme={info.theme}
        loadEcharts={loadEcharts}
      />
    );
  };
}

function EchartsFullDataBlockFromCode({
  code,
  isStreaming,
  theme,
  loadEcharts,
}: EchartsFullDataBlockFromCodeProps) {
  const { option, parseError } = useMemo<{
    option?: EchartsFullDataOption;
    parseError?: string;
  }>(() => (isStreaming ? {} : parseOption(code)), [code, isStreaming]);

  return (
    <EchartsFullDataBlock
      option={option}
      parseError={parseError}
      isStreaming={isStreaming}
      theme={theme}
      loadEcharts={loadEcharts}
    />
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="10" width="3" height="6" rx="1" />
      <rect x="8.5" y="6" width="3" height="10" rx="1" />
      <rect x="14" y="3" width="3" height="13" rx="1" />
    </svg>
  );
}

function DataIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect
        x="3"
        y="4"
        width="14"
        height="12"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M3 8.5H17M3 12.5H17M8 4V16M13 4V16" />
    </svg>
  );
}

function toEnhancedTableData(
  columns: string[],
  rows: DatasetSource,
): EnhancedTableData {
  return {
    headers: columns.map((column, columnIndex) => ({
      key: `header-${columnIndex}-${column}`,
      content: column,
      text: column,
      isHeader: true,
    })),
    rows: rows.map((row, rowIndex) => ({
      key: `row-${rowIndex}`,
      cells: columns.map((column, columnIndex) => {
        const text = formatCell(getCell(row, column, columnIndex));
        return {
          key: `row-${rowIndex}-${columnIndex}`,
          content: text,
          text,
          isHeader: false,
        };
      }),
    })),
    columnCount: columns.length,
  };
}

function SimpleDatasetTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: DatasetSource;
}) {
  const visibleRows = rows.slice(0, MAX_ENHANCED_TABLE_ROWS);
  const isTruncated = rows.length > visibleRows.length;

  return (
    <div className={styles.tableWrap} data-testid="echarts-fulldata-table">
      {isTruncated && (
        <div className={styles.tableNotice}>
          Showing {visibleRows.length} of {rows.length} rows
        </div>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column, columnIndex) => (
              <th key={`${columnIndex}-${column}`}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column, columnIndex) => (
                <td key={`${columnIndex}-${column}`}>
                  {formatCell(getCell(row, column, columnIndex))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EchartsDataTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: DatasetSource;
}) {
  if (columns.length === 0 || rows.length === 0) {
    return <div className={styles.state}>No data</div>;
  }

  if (
    rows.length > MAX_ENHANCED_TABLE_ROWS ||
    columns.length > MAX_ENHANCED_TABLE_COLUMNS
  ) {
    return <SimpleDatasetTable columns={columns} rows={rows} />;
  }

  return (
    <div data-testid="echarts-fulldata-table">
      <EnhancedTable table={toEnhancedTableData(columns, rows)} />
    </div>
  );
}

function ChartLoadingState() {
  return (
    <div
      className={`${styles.state} ${styles.loading}`}
      role="status"
      aria-label="Rendering chart"
    >
      <span className={styles.spinner} aria-hidden="true" />
    </div>
  );
}

export function EchartsFullDataBlock({
  option,
  parseError,
  isStreaming = false,
  theme,
  loadEcharts,
}: EchartsFullDataBlockProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<EchartsInstance | undefined>(undefined);
  const removeResizeRef = useRef<() => void>(noop);
  const loadEchartsRef = useRef(loadEcharts);
  const renderRequestRef = useRef(0);
  const themeRef = useRef(theme);
  const [mode, setMode] = useState<'chart' | 'data'>('chart');
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const rows = useMemo(() => getRows(option), [option]);
  const columns = useMemo(() => getColumns(option), [option]);
  const { sanitizedOption, chartOptionError } = useMemo(() => {
    if (!option || parseError) return {};
    try {
      return { sanitizedOption: cloneAndSanitizeOptionForChart(option) };
    } catch (error) {
      return { chartOptionError: error };
    }
  }, [option, parseError]);
  const chartOption = useMemo(
    () =>
      sanitizedOption ? styleOptionForChart(sanitizedOption, theme) : undefined,
    [sanitizedOption, theme],
  );
  const hasLoadEcharts = !!loadEcharts;
  loadEchartsRef.current = loadEcharts;
  themeRef.current = theme;

  const disposeChart = useCallback(() => {
    removeResizeRef.current();
    removeResizeRef.current = noop;
    chartInstanceRef.current?.dispose();
    chartInstanceRef.current = undefined;
  }, []);

  useEffect(
    () => () => {
      renderRequestRef.current += 1;
      disposeChart();
    },
    [disposeChart],
  );

  useEffect(() => {
    if (mode !== 'chart' || parseError || (!chartOption && !chartOptionError)) {
      renderRequestRef.current += 1;
      disposeChart();
      setChartReady(false);
      return;
    }
    const requestId = (renderRequestRef.current += 1);
    if (chartOptionError) {
      disposeChart();
      setChartReady(false);
      console.error(
        '[web-shell] echarts-fulldata render failed:',
        chartOptionError,
      );
      setChartError(
        chartOptionError instanceof Error
          ? chartOptionError.message
          : 'Chart render failed.',
      );
      return;
    }
    if (!chartOption) {
      disposeChart();
      setChartReady(false);
      return;
    }
    if (!hasLoadEcharts) {
      disposeChart();
      setChartReady(false);
      setChartError('Chart runtime is unavailable.');
      return;
    }

    setChartError(null);
    if (!chartInstanceRef.current) setChartReady(false);

    const renderChart = async () => {
      try {
        let chart = chartInstanceRef.current;
        if (!chart) {
          const loadRuntime = loadEchartsRef.current;
          if (!loadRuntime || !chartRef.current) return;
          const runtime = await Promise.resolve().then(loadRuntime);
          if (requestId !== renderRequestRef.current || !chartRef.current) {
            return;
          }
          chart = runtime.init(chartRef.current, themeRef.current);
          chartInstanceRef.current = chart;
        }

        if (requestId !== renderRequestRef.current) return;
        chart.setOption(chartOption);
        if (removeResizeRef.current === noop && chartRef.current) {
          const onResize = () => chartInstanceRef.current?.resize();
          const observer =
            typeof ResizeObserver === 'undefined'
              ? undefined
              : new ResizeObserver(onResize);
          observer?.observe(chartRef.current);
          window.addEventListener('resize', onResize);
          removeResizeRef.current = () => {
            observer?.disconnect();
            window.removeEventListener('resize', onResize);
          };
        }
        setChartReady(true);
      } catch (error) {
        if (requestId !== renderRequestRef.current) return;
        console.error('[web-shell] echarts-fulldata render failed:', error);
        disposeChart();
        setChartReady(false);
        setChartError(
          error instanceof Error ? error.message : 'Chart render failed.',
        );
      }
    };

    void renderChart();
  }, [
    chartOption,
    chartOptionError,
    disposeChart,
    hasLoadEcharts,
    mode,
    parseError,
  ]);

  const title = getTitle(option);

  return (
    <section className={styles.card} data-testid="echarts-fulldata-rendered">
      <div className={styles.toolbar}>
        <div className={styles.title} title={title}>
          {title}
        </div>
        {!parseError && (
          <div className={styles.toggle} aria-label="View mode">
            <button
              type="button"
              className={styles.toggleButton}
              aria-label="Show chart"
              aria-pressed={mode === 'chart'}
              title="Chart"
              onClick={() => setMode('chart')}
            >
              <ChartIcon />
            </button>
            <button
              type="button"
              className={styles.toggleButton}
              aria-label="Show data"
              aria-pressed={mode === 'data'}
              title="Data"
              onClick={() => setMode('data')}
            >
              <DataIcon />
            </button>
          </div>
        )}
      </div>
      {parseError && isStreaming ? (
        <ChartLoadingState />
      ) : parseError ? (
        <div className={styles.state}>{parseError}</div>
      ) : mode === 'chart' ? (
        <div className={styles.chartFrame}>
          <div
            ref={chartRef}
            className={styles.chartSurface}
            data-testid="echarts-fulldata-chart"
            role="img"
            aria-label={title}
          />
          {chartError ? (
            <div className={styles.chartOverlay}>
              <div className={styles.state}>{chartError}</div>
            </div>
          ) : (
            !chartReady && (
              <div className={styles.chartOverlay}>
                <ChartLoadingState />
              </div>
            )
          )}
        </div>
      ) : (
        <EchartsDataTable columns={columns} rows={rows} />
      )}
    </section>
  );
}
