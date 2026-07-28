import {
  Fragment,
  createElement,
  isValidElement,
  useMemo,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  ChartRendererRegistry,
  type JsonPrimitive,
  type JsonValue,
} from '@datafe-open/markdown-chart';
import {
  createEChartsRenderer,
  type CreateEChartsRendererOptions,
  type LoadedEChartsRuntime,
  type ResolveDataRef,
} from '@datafe-open/markdown-chart-echarts';
import {
  MarkdownChartBlock,
  MarkdownChartProvider,
  createMarkdownChartComponents,
  isRegisteredChartLanguage,
} from '@datafe-open/markdown-chart-react';
import type { Components } from 'react-markdown';
import type {
  CodeBlockRenderer,
  WebShellCodeBlockRenderInfo,
  WebShellMarkdownChartCustomization,
} from '../../customization';
import { useI18n } from '../../i18n';
import type { WebShellTheme } from '../../themeContext';

export const ECHARTS_FULLDATA_LANGUAGE = 'echarts-fulldata';

const DATA_REF_TIMEOUT_MS = 30_000;
const SUPPORTED_DATA_REF_PREFIXES = ['artifact://', 'session-file://'];
const WINDOWS_DRIVE_SEGMENT_PATTERN = /^[a-z]:/i;

export type DatasetCell = JsonPrimitive;

export interface EchartsFullDataOption {
  readonly [key: string]: JsonValue | undefined;
}

export interface EchartsInstance {
  setOption(
    option: EchartsFullDataOption,
    opts?: { readonly notMerge?: boolean },
  ): void;
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
  readonly dimensions: string[];
  readonly source: DatasetCell[][];
}

export interface EchartsFullDataRefMeta {
  readonly dimensions: string[];
  readonly format: 'csv' | 'json';
}

export type EchartsFullDataRefResolver = (
  ref: string,
  meta: EchartsFullDataRefMeta,
) => EchartsFullDataResolvedDataset | Promise<EchartsFullDataResolvedDataset>;

export interface EchartsFullDataBlockProps {
  readonly option?: EchartsFullDataOption;
  readonly parseError?: string;
  readonly isStreaming?: boolean;
  readonly theme: WebShellTheme;
  readonly loadEcharts?: EchartsRuntimeLoader;
}

export interface EchartsFullDataRendererOptions {
  readonly loadEcharts?: EchartsRuntimeLoader;
  readonly resolveDataRef?: EchartsFullDataRefResolver;
}

export function createMarkdownChartRegistry(
  options: CreateEChartsRendererOptions = {},
): ChartRendererRegistry {
  const { validateDataRef = isSupportedLegacyDataRef, ...rendererOptions } =
    options;
  return new ChartRendererRegistry().register(
    createEChartsRenderer({
      ...rendererOptions,
      validateDataRef,
    }),
  );
}

export const DEFAULT_WEB_SHELL_MARKDOWN_CHART: WebShellMarkdownChartCustomization =
  {
    registry: createMarkdownChartRegistry(),
  };

interface ChartPreChildProps {
  readonly className?: string;
  readonly children?: ReactNode;
}

export function createWebShellMarkdownChartPre(
  registry: ChartRendererRegistry,
  options: {
    readonly chartClassName?: string;
    readonly chartStyle?: CSSProperties;
  } = {},
): NonNullable<Components['pre']> {
  const sharedPre = createMarkdownChartComponents(options).pre;
  if (!sharedPre) {
    throw new Error(
      'markdown-chart React adapter did not provide a pre renderer',
    );
  }
  return function WebShellMarkdownChartPre({ children, ...props }) {
    if (isValidElement<ChartPreChildProps>(children)) {
      const code = children;
      const match = /(?:^|\s)language-([^\s]+)/.exec(
        code.props.className ?? '',
      );
      const language = match?.[1]?.toLowerCase();
      if (language && isRegisteredChartLanguage(language, registry)) {
        return createElement(sharedPre, props, children);
      }
    }
    return createElement(Fragment, null, children);
  };
}

export function WebShellMarkdownChartProvider({
  customization,
  source,
  streaming,
  theme,
  children,
}: {
  readonly customization: WebShellMarkdownChartCustomization;
  readonly source: string;
  readonly streaming: boolean;
  readonly theme: WebShellTheme;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useI18n();
  return (
    <MarkdownChartProvider
      registry={customization.registry}
      source={source}
      streaming={streaming}
      theme={theme}
      loadingLabel={customization.loadingLabel ?? t('echartsChart.rendering')}
      onError={customization.onError}
    >
      {children}
    </MarkdownChartProvider>
  );
}

function hasWhitespaceOrControl(value: string): boolean {
  return (
    /\s/.test(value) ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}

function isSupportedLegacyDataRef(ref: string): boolean {
  if (ref.trim() !== ref || !ref || hasWhitespaceOrControl(ref)) {
    return false;
  }
  const lower = ref.toLowerCase();
  const prefix = SUPPORTED_DATA_REF_PREFIXES.find((candidate) =>
    lower.startsWith(candidate),
  );
  if (!prefix) {
    return false;
  }
  const rawPath = ref.slice(prefix.length);
  if (!rawPath || /[?#\\]/.test(rawPath)) {
    return false;
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (/[%?#\\]/.test(decodedPath) || hasWhitespaceOrControl(decodedPath)) {
    return false;
  }
  return decodedPath
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !WINDOWS_DRIVE_SEGMENT_PATTERN.test(segment),
    );
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new Error(`${label} timed out.`)),
      DATA_REF_TIMEOUT_MS,
    );
    promise
      .then(resolve, reject)
      .finally(() => globalThis.clearTimeout(timeout));
  });
}

function adaptLegacyRuntimeLoader(
  loadEcharts: EchartsRuntimeLoader | undefined,
): CreateEChartsRendererOptions['loadECharts'] {
  if (!loadEcharts) {
    return undefined;
  }
  return async () => {
    const runtime = await withTimeout(
      Promise.resolve().then(loadEcharts),
      'Chart runtime load',
    );
    return {
      init(container: HTMLElement, theme?: string | object | null) {
        return runtime.init(
          container,
          typeof theme === 'string' ? theme : undefined,
        );
      },
    } as LoadedEChartsRuntime;
  };
}

function adaptLegacyDataResolver(
  resolveDataRef: EchartsFullDataRefResolver | undefined,
): ResolveDataRef | undefined {
  if (!resolveDataRef) {
    return undefined;
  }
  return async (ref, context) => {
    if (!context.dimensions || !context.format) {
      throw new Error('Chart data reference metadata is incomplete.');
    }
    const resolved = await withTimeout(
      Promise.resolve(
        resolveDataRef(ref, {
          dimensions: [...context.dimensions],
          format: context.format,
        }),
      ),
      'Chart data reference resolution',
    );
    return {
      dimensions: resolved.dimensions,
      source: resolved.source,
    };
  };
}

function createLegacyRegistry(
  options: EchartsFullDataRendererOptions,
): ChartRendererRegistry {
  return createMarkdownChartRegistry({
    loadECharts: adaptLegacyRuntimeLoader(options.loadEcharts),
    resolveDataRef: adaptLegacyDataResolver(options.resolveDataRef),
    validateDataRef: isSupportedLegacyDataRef,
  });
}

function normalizeLegacyEchartsSource(source: string): {
  readonly language: string;
  readonly source: string;
} {
  try {
    const parsed = JSON.parse(source) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      !('version' in parsed && 'data' in parsed && 'option' in parsed)
    ) {
      return {
        language: 'markdown-chart',
        source: JSON.stringify({
          version: 1,
          renderer: 'echarts',
          spec: parsed,
        }),
      };
    }
  } catch {
    // Let the shared strict parser produce the user-facing error.
  }
  return { language: ECHARTS_FULLDATA_LANGUAGE, source };
}

function MarkdownChartCodeBlock({
  registry,
  language,
  source,
  streaming,
  theme,
}: {
  readonly registry: ChartRendererRegistry;
  readonly language: string;
  readonly source: string;
  readonly streaming: boolean;
  readonly theme: WebShellTheme;
}): ReactElement {
  const { t } = useI18n();
  return (
    <MarkdownChartProvider
      registry={registry}
      theme={theme}
      streaming={streaming}
      loadingLabel={t('echartsChart.rendering')}
      onError={(error) => {
        console.error('[web-shell] markdown-chart render failed:', error);
      }}
    >
      <MarkdownChartBlock
        language={language}
        source={source}
        streaming={streaming}
        style={{ minHeight: 360 }}
      />
    </MarkdownChartProvider>
  );
}

/**
 * @deprecated Configure `markdown.chart.registry` with
 * `createMarkdownChartRegistry` instead.
 */
export function createEchartsFullDataRenderer(
  options: EchartsFullDataRendererOptions = {},
): CodeBlockRenderer {
  const registry = createLegacyRegistry(options);
  return function renderEchartsFullDataBlock(
    info: WebShellCodeBlockRenderInfo,
  ) {
    if (
      info.source !== 'assistant' ||
      info.language.toLowerCase() !== ECHARTS_FULLDATA_LANGUAGE
    ) {
      return undefined;
    }
    const normalized = info.isIncomplete
      ? { language: ECHARTS_FULLDATA_LANGUAGE, source: info.code }
      : normalizeLegacyEchartsSource(info.code);
    return (
      <MarkdownChartCodeBlock
        registry={registry}
        language={normalized.language}
        source={normalized.source}
        streaming={info.isIncomplete}
        theme={info.theme}
      />
    );
  };
}

/**
 * @deprecated Configure `markdown.chart.registry` and emit a Markdown chart
 * fence instead.
 */
export function EchartsFullDataBlock({
  option,
  parseError,
  isStreaming = false,
  theme,
  loadEcharts,
}: EchartsFullDataBlockProps): ReactElement {
  const registry = useMemo(
    () => createLegacyRegistry({ loadEcharts }),
    [loadEcharts],
  );
  if (parseError && !isStreaming) {
    return <div role="alert">{parseError}</div>;
  }
  return (
    <MarkdownChartCodeBlock
      registry={registry}
      language="markdown-chart"
      source={JSON.stringify({
        version: 1,
        renderer: 'echarts',
        spec: option ?? {},
      })}
      streaming={isStreaming}
      theme={theme}
    />
  );
}
