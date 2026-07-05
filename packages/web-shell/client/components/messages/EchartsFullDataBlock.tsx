import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CodeBlockRenderer,
  WebShellCodeBlockRenderInfo,
} from '../../customization';
import type { WebShellTheme } from '../../themeContext';
import {
  EnhancedTable,
  MAX_ENHANCED_TABLE_COLUMNS,
  MAX_ENHANCED_TABLE_ROWS,
  type EnhancedTableData,
} from './EnhancedMarkdownTable';
import { useI18n } from '../../i18n';
import styles from './EchartsFullDataBlock.module.css';

export const ECHARTS_FULLDATA_LANGUAGE = 'echarts-fulldata';

export type DatasetCell = string | number | boolean | null;
type DatasetRow = Record<string, DatasetCell> | DatasetCell[];
type DatasetSource = DatasetRow[];
type DatasetDimension = string | { name?: string };
type EchartsObject = Record<string, unknown>;
type ChartTheme = WebShellTheme;

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
  setOption(option: EchartsFullDataOption, opts?: { notMerge?: boolean }): void;
  resize(): void;
  dispose(): void;
}

export interface EchartsRuntime {
  init(element: HTMLElement, theme?: string): EchartsInstance;
}

export type EchartsRuntimeLoader = () =>
  | EchartsRuntime
  | Promise<EchartsRuntime>;

export interface EchartsFullDataResolvedDataset {
  dimensions: string[];
  source: DatasetCell[][];
}

export interface EchartsFullDataRefMeta {
  dimensions: string[];
  format: 'csv' | 'json';
}

/**
 * Resolves a renderer-validated data ref. The ref uses artifact:// or
 * session-file:// with normalized non-empty path segments and no traversal,
 * dot, drive-qualified, query/hash, whitespace, control, backslash, or
 * double-encoded percent forms.
 */
export type EchartsFullDataRefResolver = (
  ref: string,
  meta: EchartsFullDataRefMeta,
) => EchartsFullDataResolvedDataset | Promise<EchartsFullDataResolvedDataset>;

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
  resolveDataRef?: EchartsFullDataRefResolver;
}

interface EchartsFullDataBlockFromCodeProps {
  code: string;
  isStreaming: boolean;
  theme: ChartTheme;
  loadEcharts?: EchartsRuntimeLoader;
  resolveDataRef?: EchartsFullDataRefResolver;
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
const MAX_SERIES_COUNT = 100;
const MAX_FORMATTER_TEMPLATE_LENGTH = 4_096;
const MAX_FORMATTER_DIMENSION_LENGTH = 256;
const DATA_REF_TIMEOUT_MS = 30_000;
const SUPPORTED_DATA_REF_PREFIXES = ['artifact://', 'session-file://'];
const SUPPORTED_DATA_REF_FORMATS = new Set(['csv', 'json']);
const UNSAFE_URI_WITH_AUTHORITY_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//;
const UNSAFE_DIMENSION_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const UNSAFE_OPTION_HTML_TAG_PATTERN =
  /<\/?(?:a|applet|base|button|embed|form|iframe|img|input|link|meta|object|script|style|svg)(?=[\s/>])/i;
const ECHARTS_TEMPLATE_DIMENSION_METACHAR_PATTERN = /[|{}]/;
const WINDOWS_DRIVE_SEGMENT_PATTERN = /^[a-z]:/i;
const noop = () => {};

// Sanitization is intentionally two-layered: top-level option keys are an
// allowlist/default-deny surface, while nested keys are a denylist/default-allow
// surface. UNSAFE_OPTION_KEYS does not backstop SAFE_TOP_LEVEL_OPTION_KEYS; any
// key promoted to the top-level allowlist needs a fresh subtree review.
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
  'cursor',
  'data',
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

export const ECHARTS_FULLDATA_SANITIZER_KEY_OVERLAP = Object.freeze(
  [...SAFE_TOP_LEVEL_OPTION_KEYS].filter((key) => UNSAFE_OPTION_KEYS.has(key)),
);

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

function isUnsafeUriString(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith('//') ||
    UNSAFE_URI_WITH_AUTHORITY_PATTERN.test(normalized) ||
    normalized.startsWith('blob:') ||
    normalized.startsWith('data:') ||
    normalized.startsWith('image://') ||
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:')
  );
}

function isUnsafeOptionString(value: string): boolean {
  return isUnsafeUriString(value) || UNSAFE_OPTION_HTML_TAG_PATTERN.test(value);
}

function isUnsafeDimensionName(value: string): boolean {
  return UNSAFE_DIMENSION_NAMES.has(value) || isUnsafeOptionString(value);
}

function sanitizeDatasetDimension(
  dimension: unknown,
): DatasetDimension | undefined {
  if (typeof dimension === 'number' && Number.isFinite(dimension)) {
    return String(dimension);
  }
  if (typeof dimension === 'string') {
    return isUnsafeDimensionName(dimension) ? {} : dimension;
  }
  if (isObject(dimension) && typeof dimension.name === 'string') {
    return isUnsafeDimensionName(dimension.name)
      ? {}
      : { name: dimension.name };
  }
  return isObject(dimension) ? {} : undefined;
}

function getUnsafeDimensionError(dimensions: string[]): string | undefined {
  return dimensions.some(isUnsafeDimensionName)
    ? 'Chart envelope data.dimensions contains an unsafe dimension name.'
    : undefined;
}

function sanitizeDatasetCell(value: unknown): DatasetCell {
  if (typeof value === 'string') return isUnsafeUriString(value) ? '' : value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  return '';
}

function sanitizeDatasetRow(row: unknown): DatasetRow | undefined {
  if (Array.isArray(row)) return row.map(sanitizeDatasetCell);
  if (!isObject(row)) return undefined;

  const sanitized: Record<string, DatasetCell> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === '__proto__') continue;
    sanitized[key] = sanitizeDatasetCell(value);
  }
  return sanitized;
}

function isAllowedAnnotationData(path: string[]): boolean {
  const parentKey = path.at(-1);
  return (
    parentKey === 'markLine' ||
    parentKey === 'markPoint' ||
    parentKey === 'markArea'
  );
}

function sanitizeOptionValue(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOptionValue(entry, path) ?? null);
  }

  if (isObject(value)) {
    const sanitized: EchartsObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__') continue;
      if (
        UNSAFE_OPTION_KEYS.has(key) &&
        !(key === 'data' && isAllowedAnnotationData(path))
      ) {
        continue;
      }
      if (key === 'formatter' && path.includes('tooltip')) continue;

      const next = sanitizeOptionValue(entry, [...path, key]);
      if (next !== undefined) sanitized[key] = next;
    }
    return sanitized;
  }

  if (typeof value === 'string' && isUnsafeOptionString(value))
    return undefined;
  return value;
}

function sanitizeDatasetValue(value: unknown): unknown {
  const sanitizeDataset = (entry: unknown) => {
    if (!isObject(entry)) return undefined;
    const dataset: EchartsDataset = {};
    if (Array.isArray(entry.dimensions)) {
      dataset.dimensions = entry.dimensions
        .map(sanitizeDatasetDimension)
        .filter(
          (dimension): dimension is DatasetDimension => dimension !== undefined,
        );
    }
    if (Array.isArray(entry.source)) {
      dataset.source = entry.source
        .map(sanitizeDatasetRow)
        .filter((row): row is DatasetRow => !!row);
    }
    return dataset;
  };

  if (Array.isArray(value)) {
    const datasets = value
      .map(sanitizeDataset)
      .filter((entry): entry is EchartsDataset => !!entry);
    return datasets.length > 0 ? datasets : undefined;
  }
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

function hasRenderableChartData(option: EchartsFullDataOption): boolean {
  return getSeriesList(option.series).length > 0 || !!option.dataset;
}

function getEncodedDimension(
  value: unknown,
  dimensions: string[],
): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === 'string') {
    return dimensions.includes(candidate) ? candidate : undefined;
  }
  if (typeof candidate === 'number' && Number.isInteger(candidate)) {
    return (
      dimensions[candidate] ??
      dimensions.find((dimension) => dimension === String(candidate))
    );
  }
  return undefined;
}

function normalizeDatasetValueFormatter(
  formatter: unknown,
  dimension: string | undefined,
): unknown {
  if (typeof formatter !== 'string' || !dimension) return formatter;
  if (ECHARTS_TEMPLATE_DIMENSION_METACHAR_PATTERN.test(dimension)) {
    return formatter;
  }
  if (
    formatter.length > MAX_FORMATTER_TEMPLATE_LENGTH ||
    dimension.length > MAX_FORMATTER_DIMENSION_LENGTH
  ) {
    return formatter;
  }
  return formatter.replace(
    /\{c(?::([^}]*))?\}/g,
    (_match: string, format?: string) =>
      format ? `{@${dimension}|${format}}` : `{@${dimension}}`,
  );
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
  styled.color = option.color ?? [...tokens.palette];
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
  // The component is exported, so callers can pass programmatic options; clone
  // first to strip non-JSON values before the sanitizer walks the tree.
  const cloned = JSON.parse(JSON.stringify(option)) as EchartsFullDataOption;
  const normalized = normalizeObjectDatasetFormatters(cloned);
  const sanitized = sanitizeOptionForChart(normalized);
  if (!hasRenderableChartData(sanitized)) {
    throw new Error(
      'Sanitized chart has no series or dataset; option keys may have been stripped.',
    );
  }
  return sanitized;
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

function getTitle(
  option: EchartsFullDataOption | undefined,
): string | undefined {
  const title = option?.title;
  if (Array.isArray(title)) {
    return title.find(
      (entry): entry is { text: string } =>
        isObject(entry) && typeof entry.text === 'string' && !!entry.text,
    )?.text;
  }
  return isObject(title) && typeof title.text === 'string' && !!title.text
    ? title.text
    : undefined;
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
    if (typeof dimension === 'number' && Number.isFinite(dimension)) {
      return String(dimension);
    }
    return isObject(dimension) &&
      typeof dimension.name === 'string' &&
      dimension.name
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
  return Array.isArray(row)
    ? row[columnIndex]
    : Object.hasOwn(row, column)
      ? row[column]
      : undefined;
}

function formatCell(value: DatasetCell | undefined): string {
  if (value == null) return '';
  return String(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasWhitespaceOrControl(value: string): boolean {
  return /\s/.test(value) || hasControlCharacter(value);
}

type EchartsFullDataRefDescriptor = {
  ref: string;
  meta: EchartsFullDataRefMeta;
  option: EchartsFullDataOption;
};

type ParseOptionResult = {
  option?: EchartsFullDataOption;
  parseError?: string;
  dataRef?: EchartsFullDataRefDescriptor;
};

function validateDatasetSize(
  rowCount: number,
  columnCount: number,
  cellCount = rowCount * Math.max(columnCount, 1),
): string | undefined {
  if (rowCount === 0) {
    return 'Chart data must include dataset.source.';
  }
  if (rowCount > MAX_DATA_ROWS) {
    return `Chart data has too many rows. Maximum supported rows: ${MAX_DATA_ROWS}.`;
  }

  if (cellCount > MAX_DATA_CELLS) {
    return `Chart data has too many cells. Maximum supported cells: ${MAX_DATA_CELLS}.`;
  }

  return undefined;
}

function validateDatasetCell(
  value: unknown,
  rowIndex: number,
  cellIndex: number,
): string | undefined {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return undefined;
  }
  return `Chart data row ${rowIndex + 1} cell ${cellIndex + 1} must be a string, number, boolean, or null.`;
}

function validateDatasetRows(
  option: EchartsFullDataOption,
): string | undefined {
  const rows = getRows(option);
  const columns = getColumns(option);
  let cellCount = 0;
  let maxColumnCount = columns.length;

  for (const [rowIndex, row] of rows.entries()) {
    if (Array.isArray(row)) {
      if (columns.length > 0 && row.length !== columns.length) {
        return `Chart data row ${rowIndex + 1} has ${row.length} cells; expected ${columns.length}.`;
      }
      maxColumnCount = Math.max(maxColumnCount, row.length);
      cellCount += row.length;
      for (const [cellIndex, cell] of row.entries()) {
        const cellError = validateDatasetCell(cell, rowIndex, cellIndex);
        if (cellError) return cellError;
      }
      continue;
    }

    if (!isObject(row)) {
      return `Chart data row ${rowIndex + 1} must be an object or array.`;
    }

    const values = Object.values(row);
    maxColumnCount = Math.max(maxColumnCount, values.length);
    cellCount += values.length;
    for (const [cellIndex, cell] of values.entries()) {
      const cellError = validateDatasetCell(cell, rowIndex, cellIndex);
      if (cellError) return cellError;
    }
  }

  return validateDatasetSize(rows.length, maxColumnCount, cellCount);
}

function validateDatasetDimensions(
  option: EchartsFullDataOption,
): string | undefined {
  const datasets = Array.isArray(option.dataset)
    ? option.dataset
    : option.dataset
      ? [option.dataset]
      : [];

  for (const dataset of datasets) {
    if (!Array.isArray(dataset.dimensions)) continue;
    const error = getUnsafeDimensionError(
      normalizeDimensions(dataset.dimensions),
    );
    if (error) return error;
  }

  return undefined;
}

function validateOptionShape(
  option: EchartsFullDataOption,
): string | undefined {
  if (exceedsMaxDepth(option, MAX_OPTION_DEPTH)) {
    return 'Chart data is too deeply nested.';
  }

  const datasetError = validateDatasetRows(option);
  if (datasetError) return datasetError;

  const dimensionError = validateDatasetDimensions(option);
  if (dimensionError) return dimensionError;

  const seriesCount = getSeriesList(option.series).length;
  if (seriesCount > MAX_SERIES_COUNT) {
    return `Chart data has too many series. Maximum supported series: ${MAX_SERIES_COUNT}.`;
  }

  return undefined;
}

function normalizeEnvelopeDataset(value: unknown): {
  dataset?: EchartsFullDataResolvedDataset;
  parseError?: string;
} {
  if (!isObject(value)) {
    return { parseError: 'Chart envelope data must be an object.' };
  }

  const dimensions = value.dimensions;
  if (
    !Array.isArray(dimensions) ||
    dimensions.length === 0 ||
    !dimensions.every((dimension) => typeof dimension === 'string')
  ) {
    return {
      parseError: 'Chart envelope data.dimensions must be a string array.',
    };
  }
  const dimensionError = getUnsafeDimensionError(dimensions);
  if (dimensionError) return { parseError: dimensionError };

  const source = value.source;
  if (!Array.isArray(source)) {
    return {
      parseError: 'Chart envelope data.source must be an array of rows.',
    };
  }

  const sizeError = validateDatasetSize(source.length, dimensions.length);
  if (sizeError) return { parseError: sizeError };

  const rows: DatasetCell[][] = [];
  for (const [rowIndex, row] of source.entries()) {
    if (!Array.isArray(row)) {
      return {
        parseError: `Chart envelope data.source row ${rowIndex + 1} must be an array.`,
      };
    }
    if (row.length !== dimensions.length) {
      return {
        parseError: `Chart envelope data.source row ${rowIndex + 1} has ${row.length} cells; expected ${dimensions.length}.`,
      };
    }

    const nextRow: DatasetCell[] = [];
    for (const [cellIndex, cell] of row.entries()) {
      const cellError = validateDatasetCell(cell, rowIndex, cellIndex);
      if (cellError) {
        return {
          parseError: cellError.replace(
            'Chart data row',
            'Chart envelope data.source row',
          ),
        };
      }
      nextRow.push(cell as DatasetCell);
    }
    rows.push(nextRow);
  }

  return { dataset: { dimensions: [...dimensions], source: rows } };
}

function injectDatasetAndValidate(
  option: EchartsFullDataOption,
  dataset: EchartsFullDataResolvedDataset,
): ParseOptionResult {
  const normalized: EchartsFullDataOption = {
    ...option,
    dataset: {
      dimensions: dataset.dimensions,
      source: dataset.source,
    },
  };
  const shapeError = validateOptionShape(normalized);
  return shapeError ? { parseError: shapeError } : { option: normalized };
}

function isEchartsFullDataEnvelope(value: EchartsObject): boolean {
  return 'version' in value && 'data' in value && 'option' in value;
}

function normalizeDataRef(ref: unknown): {
  ref?: string;
  parseError?: string;
} {
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    return {
      parseError: 'Chart envelope data.ref must be a non-empty string.',
    };
  }
  const trimmed = ref.trim();
  if (trimmed !== ref || hasWhitespaceOrControl(ref)) {
    return {
      parseError:
        'Chart envelope data.ref must not contain whitespace or control characters.',
    };
  }
  const lower = trimmed.toLowerCase();
  const prefix = SUPPORTED_DATA_REF_PREFIXES.find((candidate) =>
    lower.startsWith(candidate),
  );
  if (!prefix) {
    return {
      parseError:
        'Chart envelope data.ref must use artifact:// or session-file://.',
    };
  }

  const rawPath = trimmed.slice(prefix.length);
  if (rawPath.length === 0) {
    return { parseError: 'Chart envelope data.ref path must be non-empty.' };
  }
  if (/[?#\\]/.test(rawPath)) {
    return {
      parseError:
        'Chart envelope data.ref path must not include query, hash, or backslash characters.',
    };
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return { parseError: 'Chart envelope data.ref path is malformed.' };
  }
  if (/[%?#\\]/.test(decodedPath) || hasWhitespaceOrControl(decodedPath)) {
    return {
      parseError:
        'Chart envelope data.ref path must not include query, hash, whitespace, control, backslash, or double-encoded percent characters.',
    };
  }

  const segments = decodedPath.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        WINDOWS_DRIVE_SEGMENT_PATTERN.test(segment),
    )
  ) {
    return {
      parseError:
        'Chart envelope data.ref path must use non-empty normalized segments and cannot contain ".", "..", or drive-qualified segments.',
    };
  }
  return { ref: `${prefix}${segments.join('/')}` };
}

function normalizeDataRefMeta(data: EchartsObject): {
  meta?: EchartsFullDataRefMeta;
  parseError?: string;
} {
  const dimensions = data.dimensions;
  if (
    !Array.isArray(dimensions) ||
    dimensions.length === 0 ||
    !dimensions.every((dimension) => typeof dimension === 'string')
  ) {
    return {
      parseError: 'Chart envelope data.dimensions must be a string array.',
    };
  }
  const dimensionError = getUnsafeDimensionError(dimensions);
  if (dimensionError) return { parseError: dimensionError };

  const format = data.format;
  if (typeof format !== 'string' || !SUPPORTED_DATA_REF_FORMATS.has(format)) {
    return {
      parseError: 'Chart envelope data.format must be "csv" or "json".',
    };
  }

  return {
    meta: {
      dimensions: [...dimensions],
      format: format as EchartsFullDataRefMeta['format'],
    },
  };
}

function normalizeEnvelope(envelope: EchartsObject): ParseOptionResult {
  if (envelope.version !== 1) {
    return { parseError: 'Chart envelope version must be 1.' };
  }
  if (!isObject(envelope.option)) {
    return { parseError: 'Chart envelope option must be an object.' };
  }
  if (!isObject(envelope.data)) {
    return { parseError: 'Chart envelope data must be an object.' };
  }

  const option = envelope.option as EchartsFullDataOption;
  const { data } = envelope;
  if (data.kind === 'inline') {
    const { dataset, parseError } = normalizeEnvelopeDataset(data);
    if (parseError || !dataset) return { parseError };
    return injectDatasetAndValidate(option, dataset);
  }

  if (data.kind !== 'ref') {
    return {
      parseError: 'Chart envelope data.kind must be "inline" or "ref".',
    };
  }

  const { ref, parseError } = normalizeDataRef(data.ref);
  if (parseError || !ref) return { parseError };
  const { meta, parseError: metaError } = normalizeDataRefMeta(data);
  if (metaError || !meta) return { parseError: metaError };
  return { dataRef: { ref, meta, option } };
}

function resolveDataRefWithTimeout(
  resolveDataRef: EchartsFullDataRefResolver,
  ref: string,
  meta: EchartsFullDataRefMeta,
): Promise<EchartsFullDataResolvedDataset> {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      console.warn(
        '[web-shell] echarts-fulldata data-ref resolution timed out after %dms (ref=%s, format=%s)',
        DATA_REF_TIMEOUT_MS,
        ref,
        meta.format,
      );
      reject(new Error('Data reference resolution timed out.'));
    }, DATA_REF_TIMEOUT_MS);

    Promise.resolve()
      .then(() => resolveDataRef(ref, meta))
      .then(resolve, reject)
      .finally(() => globalThis.clearTimeout(timeoutId));
  });
}

function isResolvedDataset(
  value: unknown,
): value is EchartsFullDataResolvedDataset {
  return (
    isObject(value) &&
    Array.isArray(value.dimensions) &&
    Array.isArray(value.source)
  );
}

function resolveEnvelopeDataRef(
  resolveDataRef: EchartsFullDataRefResolver,
  dataRef: EchartsFullDataRefDescriptor,
): Promise<ParseOptionResult> {
  return resolveDataRefWithTimeout(resolveDataRef, dataRef.ref, dataRef.meta)
    .then((resolved) => {
      if (!isResolvedDataset(resolved)) {
        console.error(
          '[web-shell] echarts-fulldata resolver returned invalid dataset:',
          dataRef.ref,
          resolved,
        );
        return {
          parseError: 'Chart data resolver returned an invalid dataset.',
        };
      }
      const result = normalizeEnvelopeDataset({
        kind: 'inline',
        dimensions: resolved.dimensions,
        source: resolved.source,
      });
      if (result.parseError || !result.dataset) {
        return { parseError: result.parseError };
      }
      return injectDatasetAndValidate(dataRef.option, result.dataset);
    })
    .catch((error: unknown) => {
      console.error(
        '[web-shell] echarts-fulldata data-ref resolution failed:',
        dataRef.ref,
        error,
      );
      return {
        parseError: 'Chart data reference could not be resolved.',
      };
    });
}

function parseOptionInner(code: string): ParseOptionResult {
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
    if (exceedsMaxDepth(parsed, MAX_OPTION_DEPTH)) {
      return { parseError: 'Chart data is too deeply nested.' };
    }
    if (isEchartsFullDataEnvelope(parsed)) {
      return normalizeEnvelope(parsed);
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

function parseOption(code: string): ParseOptionResult {
  const result = parseOptionInner(code);
  if (result.parseError) {
    console.warn(
      '[web-shell] echarts-fulldata parse failed: %s (code length=%d)',
      result.parseError,
      code.length,
    );
  }
  return result;
}

function getDataRefKey(
  dataRef: EchartsFullDataRefDescriptor,
  code: string,
): string {
  return JSON.stringify([
    dataRef.ref,
    dataRef.meta.format,
    dataRef.meta.dimensions,
    code,
  ]);
}

export function createEchartsFullDataRenderer({
  loadEcharts,
  resolveDataRef,
}: EchartsFullDataRendererOptions = {}): CodeBlockRenderer {
  return function renderEchartsFullDataBlock(
    info: WebShellCodeBlockRenderInfo,
  ) {
    if (
      info.source !== 'assistant' ||
      info.language.toLowerCase() !== ECHARTS_FULLDATA_LANGUAGE
    ) {
      return undefined;
    }
    return (
      <EchartsFullDataBlockFromCode
        code={info.code}
        isStreaming={info.isStreaming}
        theme={info.theme}
        loadEcharts={loadEcharts}
        resolveDataRef={resolveDataRef}
      />
    );
  };
}

function EchartsFullDataBlockFromCode({
  code,
  isStreaming,
  theme,
  loadEcharts,
  resolveDataRef,
}: EchartsFullDataBlockFromCodeProps) {
  const resolveDataRefRef = useRef(resolveDataRef);
  resolveDataRefRef.current = resolveDataRef;
  const hasResolveDataRef = !!resolveDataRef;
  const stableResolveDataRef = useCallback<EchartsFullDataRefResolver>(
    (ref, meta) => {
      const resolver = resolveDataRefRef.current;
      if (!resolver) {
        throw new Error('Chart data reference resolver is unavailable.');
      }
      return resolver(ref, meta);
    },
    [],
  );
  const parsed = useMemo<ParseOptionResult>(
    () => (isStreaming ? {} : parseOption(code)),
    [code, isStreaming],
  );
  const [resolvedParsed, setResolvedParsed] = useState<ParseOptionResult>({});
  const { dataRef } = parsed;
  const dataRefKey = dataRef ? getDataRefKey(dataRef, code) : undefined;
  const dataRefRef = useRef(dataRef);
  const resolvedDataRefCacheRef = useRef<
    { key: string; result: ParseOptionResult } | undefined
  >(undefined);
  dataRefRef.current = dataRef;

  useEffect(() => {
    const currentDataRef = dataRefRef.current;
    if (!dataRefKey || !currentDataRef) {
      return;
    }
    if (!hasResolveDataRef) {
      setResolvedParsed({
        parseError: 'Chart data reference resolver is unavailable.',
      });
      return;
    }
    if (resolvedDataRefCacheRef.current?.key === dataRefKey) {
      setResolvedParsed(resolvedDataRefCacheRef.current.result);
      return;
    }

    let cancelled = false;
    setResolvedParsed({});
    resolveEnvelopeDataRef(stableResolveDataRef, currentDataRef).then(
      (result) => {
        if (!cancelled) {
          resolvedDataRefCacheRef.current = { key: dataRefKey, result };
          setResolvedParsed(result);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dataRefKey, hasResolveDataRef, stableResolveDataRef]);

  const { option, parseError } = dataRef ? resolvedParsed : parsed;

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
  const { t } = useI18n();
  const visibleRows = rows.slice(0, MAX_ENHANCED_TABLE_ROWS);
  const visibleColumns = columns.slice(0, MAX_ENHANCED_TABLE_COLUMNS);
  const omittedRows = rows.length - visibleRows.length;
  const omittedColumns = columns.length - visibleColumns.length;
  const isTruncated = omittedRows > 0 || omittedColumns > 0;

  return (
    <div className={styles.tableWrap} data-testid="echarts-fulldata-table">
      {isTruncated && (
        <div className={styles.tableNotice}>
          {t('echartsChart.tableNotice', {
            visibleRows: visibleRows.length,
            totalRows: rows.length,
            visibleColumns: visibleColumns.length,
            totalColumns: columns.length,
            omittedRows,
            omittedColumns,
          })}
        </div>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            {visibleColumns.map((column, columnIndex) => (
              <th key={`${columnIndex}-${column}`}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {visibleColumns.map((column, columnIndex) => (
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
  const { t } = useI18n();
  const isEmpty = columns.length === 0 || rows.length === 0;
  const isOversized =
    rows.length > MAX_ENHANCED_TABLE_ROWS ||
    columns.length > MAX_ENHANCED_TABLE_COLUMNS;
  const table = useMemo(
    () =>
      isEmpty || isOversized ? undefined : toEnhancedTableData(columns, rows),
    [columns, isEmpty, isOversized, rows],
  );

  if (isEmpty) {
    return <div className={styles.state}>{t('echartsChart.noData')}</div>;
  }

  if (isOversized) {
    return <SimpleDatasetTable columns={columns} rows={rows} />;
  }

  return (
    <div data-testid="echarts-fulldata-table">
      <EnhancedTable table={table!} />
    </div>
  );
}

function ChartLoadingState() {
  const { t } = useI18n();
  return (
    <div
      className={`${styles.state} ${styles.loading}`}
      role="status"
      aria-label={t('echartsChart.rendering')}
    >
      <span className={styles.spinner} aria-hidden="true" />
    </div>
  );
}

function loadEchartsWithTimeout(
  loadRuntime: EchartsRuntimeLoader,
): Promise<EchartsRuntime> {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      console.warn(
        '[web-shell] echarts-fulldata runtime load timed out after %dms',
        DATA_REF_TIMEOUT_MS,
      );
      reject(new Error('Chart runtime load timed out.'));
    }, DATA_REF_TIMEOUT_MS);

    Promise.resolve()
      .then(loadRuntime)
      .then(resolve, reject)
      .finally(() => globalThis.clearTimeout(timeoutId));
  });
}

export function EchartsFullDataBlock({
  option,
  parseError,
  isStreaming = false,
  theme,
  loadEcharts,
}: EchartsFullDataBlockProps) {
  const { t } = useI18n();
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<EchartsInstance | undefined>(undefined);
  const removeResizeRef = useRef<() => void>(noop);
  const loadEchartsRef = useRef(loadEcharts);
  const tRef = useRef(t);
  const renderRequestRef = useRef(0);
  const chartThemeRef = useRef<ChartTheme | undefined>(undefined);
  const [mode, setMode] = useState<'chart' | 'data'>('chart');
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const { sanitizedOption, chartOptionError } = useMemo(() => {
    if (!option || parseError) return {};
    try {
      return { sanitizedOption: cloneAndSanitizeOptionForChart(option) };
    } catch (error) {
      return { chartOptionError: error };
    }
  }, [option, parseError]);
  const rows = useMemo(() => getRows(sanitizedOption), [sanitizedOption]);
  const columns = useMemo(() => getColumns(sanitizedOption), [sanitizedOption]);
  const chartOption = useMemo(
    () =>
      sanitizedOption ? styleOptionForChart(sanitizedOption, theme) : undefined,
    [sanitizedOption, theme],
  );
  const hasLoadEcharts = !!loadEcharts;
  loadEchartsRef.current = loadEcharts;
  tRef.current = t;

  const disposeChart = useCallback(() => {
    removeResizeRef.current();
    removeResizeRef.current = noop;
    chartInstanceRef.current?.dispose();
    chartInstanceRef.current = undefined;
    chartThemeRef.current = undefined;
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
      setChartError(null);
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
          : tRef.current('echartsChart.renderFailed'),
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
      setChartError(tRef.current('echartsChart.runtimeUnavailable'));
      return;
    }

    setChartError(null);
    if (!chartInstanceRef.current) setChartReady(false);

    const renderChart = async () => {
      try {
        let chart = chartInstanceRef.current;
        if (chart && chartThemeRef.current !== theme) {
          disposeChart();
          setChartReady(false);
          chart = undefined;
        }
        if (!chart) {
          const loadRuntime = loadEchartsRef.current;
          if (!loadRuntime || !chartRef.current) return;
          const runtime = await loadEchartsWithTimeout(loadRuntime);
          if (requestId !== renderRequestRef.current || !chartRef.current) {
            return;
          }
          chart = runtime.init(chartRef.current, theme);
          chartInstanceRef.current = chart;
          chartThemeRef.current = theme;
        }

        if (requestId !== renderRequestRef.current) return;
        chart.setOption(chartOption, { notMerge: true });
        if (removeResizeRef.current === noop && chartRef.current) {
          let resizeFrame: number | undefined;
          const onResize = () => {
            if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
              resizeFrame = undefined;
              chartInstanceRef.current?.resize();
            });
          };
          const observer =
            typeof ResizeObserver === 'undefined'
              ? undefined
              : new ResizeObserver(onResize);
          if (observer) {
            observer.observe(chartRef.current);
          } else {
            window.addEventListener('resize', onResize);
          }
          removeResizeRef.current = () => {
            if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
            observer?.disconnect();
            if (!observer) window.removeEventListener('resize', onResize);
          };
        }
        setChartReady(true);
      } catch (error) {
        if (requestId !== renderRequestRef.current) return;
        console.error('[web-shell] echarts-fulldata render failed:', error);
        disposeChart();
        setChartReady(false);
        setChartError(
          error instanceof Error
            ? error.message
            : tRef.current('echartsChart.renderFailed'),
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
    theme,
  ]);

  const title = getTitle(option) ?? t('echartsChart.defaultTitle');

  return (
    <section
      className={styles.card}
      aria-label={title}
      data-testid="echarts-fulldata-rendered"
    >
      <div className={styles.toolbar}>
        <div className={styles.title} title={title}>
          {title}
        </div>
        {!parseError && (
          <div
            className={styles.toggle}
            aria-label={t('echartsChart.viewMode')}
          >
            <button
              type="button"
              className={styles.toggleButton}
              aria-label={t('echartsChart.showChart')}
              aria-pressed={mode === 'chart'}
              title={t('echartsChart.chart')}
              onClick={() => setMode('chart')}
            >
              <ChartIcon />
            </button>
            <button
              type="button"
              className={styles.toggleButton}
              aria-label={t('echartsChart.showData')}
              aria-pressed={mode === 'data'}
              title={t('echartsChart.data')}
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
