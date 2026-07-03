import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CodeBlockRenderer,
  WebShellCodeBlockRenderInfo,
} from '../../customization';
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
  option?: EchartsFullDataOption;
  parseError?: string;
  isStreaming?: boolean;
  theme: ChartTheme;
  loadEcharts?: EchartsRuntimeLoader;
}

export interface EchartsFullDataRendererOptions {
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

function getSeriesList(series: unknown): EchartsObject[] {
  if (Array.isArray(series)) return series.filter(isObject);
  return isObject(series) ? [series] : [];
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
  styled.tooltip = styleComponent(option.tooltip, {
    trigger: getTooltipTrigger(option),
    confine: true,
    enterable: true,
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
    extraCssText: `border-radius:6px;box-shadow:${tokens.tooltipShadow};max-height:300px;overflow:auto;white-space:pre-wrap;`,
  });
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

function cloneOptionForChart(
  option: EchartsFullDataOption,
  theme: ChartTheme,
): EchartsFullDataOption {
  const cloned = JSON.parse(JSON.stringify(option)) as EchartsFullDataOption;
  const styled = applyDefaultChartStyle(cloned, theme);
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
    return title.find((entry) => entry.text)?.text ?? 'Dataset chart';
  }
  return title?.text ?? 'Dataset chart';
}

function getRows(option: EchartsFullDataOption | undefined): DatasetSource {
  const source = getPrimaryDataset(option)?.source;
  return Array.isArray(source) ? source : [];
}

function normalizeDimensions(
  dimensions: DatasetDimension[] | undefined,
): string[] {
  if (!Array.isArray(dimensions)) return [];
  return dimensions
    .map((dimension) =>
      typeof dimension === 'string' ? dimension : dimension.name,
    )
    .filter((dimension): dimension is string => !!dimension);
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

function getCell(row: DatasetRow, column: string): DatasetCell | undefined {
  if (Array.isArray(row)) {
    const index = Number(column) - 1;
    return Number.isInteger(index) ? row[index] : undefined;
  }
  return row[column];
}

function formatCell(value: DatasetCell | undefined): string {
  if (value == null) return '';
  return String(value);
}

function parseOption(code: string): {
  option?: EchartsFullDataOption;
  parseError?: string;
} {
  try {
    const parsed = JSON.parse(code) as EchartsFullDataOption;
    return { option: parsed };
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
    const { option, parseError } = parseOption(info.code);
    return (
      <EchartsFullDataBlock
        option={option}
        parseError={parseError}
        isStreaming={info.isStreaming}
        theme={info.theme}
        loadEcharts={loadEcharts}
      />
    );
  };
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

  return (
    <div className={styles.tableWrap} data-testid="echarts-fulldata-table">
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => (
                <td key={column}>{formatCell(getCell(row, column))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
  const [mode, setMode] = useState<'chart' | 'data'>('chart');
  const [chartError, setChartError] = useState<string | null>(null);
  const rows = useMemo(() => getRows(option), [option]);
  const columns = useMemo(() => getColumns(option), [option]);

  useEffect(() => {
    if (mode !== 'chart' || !option || parseError) return;
    if (!chartRef.current) return;
    if (!loadEcharts) {
      setChartError('Chart runtime is unavailable.');
      return;
    }

    let disposed = false;
    let chart: EchartsInstance | undefined;
    setChartError(null);

    Promise.resolve(loadEcharts())
      .then((runtime) => {
        if (disposed || !chartRef.current) return;
        chart = runtime.init(chartRef.current);
        chart.setOption(cloneOptionForChart(option, theme));
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setChartError(
          error instanceof Error ? error.message : 'Chart render failed.',
        );
      });

    const onResize = () => chart?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      chart?.dispose();
    };
  }, [loadEcharts, mode, option, parseError, theme]);

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
        chartError ? (
          <div className={styles.state}>{chartError}</div>
        ) : (
          <div
            ref={chartRef}
            className={styles.chartSurface}
            data-testid="echarts-fulldata-chart"
          />
        )
      ) : (
        <EchartsDataTable columns={columns} rows={rows} />
      )}
    </section>
  );
}
