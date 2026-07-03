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
  theme: 'dark' | 'light';
  loadEcharts?: EchartsRuntimeLoader;
}

export interface EchartsFullDataRendererOptions {
  loadEcharts?: EchartsRuntimeLoader;
}

function cloneOptionForChart(
  option: EchartsFullDataOption,
): EchartsFullDataOption {
  const cloned = JSON.parse(JSON.stringify(option)) as EchartsFullDataOption;
  delete cloned.title;
  return cloned;
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

export function EchartsFullDataBlock({
  option,
  parseError,
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
        chart = runtime.init(chartRef.current, theme);
        chart.setOption(cloneOptionForChart(option));
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
        <h2 className={styles.title}>{title}</h2>
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
      {parseError ? (
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
