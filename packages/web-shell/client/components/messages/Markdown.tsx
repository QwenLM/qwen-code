import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTheme } from '../../themeContext';
import { useTranscriptRenderMode } from '../../transcriptRenderMode';
import {
  warnClipboardWriteFailure,
  writeClipboardText,
} from '../../utils/clipboard';
import { useCopiedFlash } from '../../hooks/useCopiedFlash';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import { isMarkdownFenceClosed } from '@datafe-open/markdown-chart';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import {
  getCachedHtml,
  getCodeHighlighter,
  highlightToHtmlSync,
  isTooLargeToHighlight,
} from './codeHighlighter';
import { useI18n } from '../../i18n';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import {
  useWebShellCustomization,
  type MarkdownTableMode,
  type MarkdownContentSource,
} from '../../customization';
import { ErrorBoundary } from '../ErrorBoundary';
import { EnhancedMarkdownTable } from './EnhancedMarkdownTable';
import {
  DEFAULT_WEB_SHELL_MARKDOWN_CHART,
  WebShellMarkdownChartProvider,
  createWebShellMarkdownChartPre,
} from './MarkdownChartRenderer';
import styles from './Markdown.module.css';

interface MarkdownProps {
  content: string;
  source?: MarkdownContentSource;
  /**
   * True while the message is still streaming in. Used to defer expensive,
   * per-chunk rendering (Mermaid diagrams and Shiki syntax highlighting) until
   * the content settles, avoiding flicker and wasted re-tokenization.
   */
  isStreaming?: boolean;
  tableMode?: MarkdownTableMode;
}

// Keep the cost of repeatedly parsing a growing stream bounded. Short streams
// retain live Markdown; large ones settle into full Markdown once at the end.
const STREAMING_MARKDOWN_PARSE_LIMIT = 32_000;

const SUPPORTED_LANGUAGES = new Set([
  'javascript',
  'typescript',
  'python',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
  'csharp',
  'fsharp',
  'ruby',
  'php',
  'swift',
  'kotlin',
  'scala',
  // `shell` and `zsh` are intentionally absent: LANGUAGE_ALIASES maps them to
  // `bash`, which resolveFenceLanguage applies before this membership check.
  'bash',
  'fish',
  'powershell',
  'sql',
  'html',
  'css',
  'scss',
  'json',
  'yaml',
  'toml',
  'xml',
  'markdown',
  'dockerfile',
  'graphql',
  'lua',
  'r',
  'matlab',
  'perl',
  'haskell',
  'elixir',
  'erlang',
  'clojure',
  'dart',
  'vue',
  'svelte',
  'astro',
  'tsx',
  'jsx',
  'diff',
]);

// Common fence aliases → Shiki's canonical language id. This keeps shorthand
// tags like ```ts and punctuation tags like ```c++ highlighted under the
// language ids Shiki actually supports.
const LANGUAGE_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  'f#': 'fsharp',
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  cs: 'csharp',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  md: 'markdown',
  golang: 'go',
  ps1: 'powershell',
  docker: 'dockerfile',
};

export interface ResolvedFenceLanguage {
  /** What the user typed, in its original case, shown in the code-block header. */
  label: string;
  /** Canonical language id (aliases resolved); also used to detect mermaid. */
  lang: string;
  /** A supported Shiki language id, or 'text' when unsupported (no highlight). */
  resolvedLang: string;
}

export function resolveFenceLanguage(
  rawLang: string | undefined,
): ResolvedFenceLanguage {
  const normalized = (rawLang || '').toLowerCase();
  // `Object.hasOwn` guard: a bracket read like `LANGUAGE_ALIASES['__proto__']`
  // would otherwise return an inherited prototype value (an object/function),
  // violating the `lang: string` contract.
  const lang = Object.hasOwn(LANGUAGE_ALIASES, normalized)
    ? LANGUAGE_ALIASES[normalized]
    : normalized;
  const resolvedLang = SUPPORTED_LANGUAGES.has(lang) ? lang : 'text';
  // Header label preserves the original case (` ```TypeScript ` shows
  // "TypeScript", not "typescript"); alias resolution uses the lowercased form.
  return { label: (rawLang || '').trim() || 'text', lang, resolvedLang };
}

const SAFE_HREF_SCHEMES = /^(https?:|mailto:)/i;
const SAFE_IMAGE_DATA_URI = /^data:image\/(png|jpeg|gif|webp|bmp);base64,/i;
const SAFE_DOCUMENT_IMAGE_DATA_URI =
  /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/i;

export function isSafeHref(url: string | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  return SAFE_HREF_SCHEMES.test(trimmed);
}

export function isSafeImageSrc(
  url: string | undefined,
  documentMode = false,
): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (documentMode) return SAFE_DOCUMENT_IMAGE_DATA_URI.test(trimmed);
  if (trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  if (SAFE_IMAGE_DATA_URI.test(trimmed)) return true;
  return SAFE_HREF_SCHEMES.test(trimmed);
}

// Track last initialized theme to avoid redundant mermaid.initialize() calls.
// mermaid.initialize() is idempotent but runs per-block; with N diagrams in a
// transcript this saves N-1 redundant calls per render cycle.
let lastMermaidConfigKey: string | undefined;
let mermaidRenderQueue: Promise<void> = Promise.resolve();
let mermaidRenderId = 0;
const MAX_MERMAID_TEXT_CHARS = 50_000;
const MAX_MERMAID_EDGES = 500;
const MERMAID_RENDER_TIMEOUT_MS = 10_000;

function MermaidBlock({ code }: { code: string }) {
  const { t } = useI18n();
  const appTheme = useTheme();
  // Document mode no longer reaches this component: since #11091 CodeBlock
  // renders a mermaid fence as a plain <pre> there, so the export bundle can
  // drop mermaid entirely. The render limits below were never about the export
  // format though — they are about rendering a transcript the viewer did not
  // author and cannot interrupt, which is equally true of readonly replay.
  const untrustedMode = useTranscriptRenderMode() !== 'interactive';
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'diagram' | 'code'>('diagram');
  const [copied, flashCopied] = useCopiedFlash();
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const mermaidTheme = appTheme === 'light' ? 'default' : 'dark';

  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;
  const ZOOM_STEP = 0.25;

  const handleZoomIn = () => {
    setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100));
  };
  const handleZoomOut = () => {
    setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100));
  };
  const resetZoomAndPan = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: offset.x,
        origY: offset.y,
      };
    },
    [offset],
  );

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      // Clamp Y to prevent dragging into overflow-y: hidden clipped area.
      // X is unclamped — overflow-x: auto provides native horizontal scroll.
      const PAN_LIMIT = 1500;
      setOffset({
        x: dragRef.current.origX + dx,
        y: Math.max(
          -PAN_LIMIT,
          Math.min(PAN_LIMIT, dragRef.current.origY + dy),
        ),
      });
    };

    const onMouseUp = () => {
      dragRef.current = null;
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [code]);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    const timer = setTimeout(() => {
      import('mermaid')
        .then(async (mod) => {
          if (cancelled) return;
          const mermaid = mod.default;
          const configKey = `${mermaidTheme}:${untrustedMode ? 'hardened' : 'runtime'}`;
          const render = mermaidRenderQueue.then(async () => {
            if (cancelled) throw new Error('Mermaid render skipped');
            if (lastMermaidConfigKey !== configKey) {
              mermaid.initialize({
                startOnLoad: false,
                theme: mermaidTheme,
                securityLevel: 'strict',
                suppressErrorRendering: true,
                ...(untrustedMode
                  ? {
                      maxTextSize: MAX_MERMAID_TEXT_CHARS,
                      maxEdges: MAX_MERMAID_EDGES,
                    }
                  : {}),
                flowchart: {
                  wrappingWidth: 300,
                  useMaxWidth: false,
                },
              });
              lastMermaidConfigKey = configKey;
            }
            const id = `mermaid-${++mermaidRenderId}`;
            if (!untrustedMode) return mermaid.render(id, code.trim());
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                mermaid.render(id, code.trim()),
                new Promise<never>((_resolve, reject) => {
                  timeoutId = setTimeout(
                    () => reject(new Error('Mermaid render timed out')),
                    MERMAID_RENDER_TIMEOUT_MS,
                  );
                }),
              ]);
            } finally {
              if (timeoutId !== undefined) clearTimeout(timeoutId);
            }
          });
          mermaidRenderQueue = render.then(
            () => undefined,
            () => undefined,
          );
          const { svg } = await render;
          // No additional sanitization needed: securityLevel:'strict' uses
          // DOMPurify internally to sanitize SVG output.
          if (!cancelled) setSvg(svg);
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setError(
              error instanceof Error ? error.message : 'Mermaid render failed',
            );
          }
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, untrustedMode, mermaidTheme]);

  const handleCopy = () => {
    void writeClipboardText(code)
      .then(() => {
        flashCopied();
      })
      .catch(warnClipboardWriteFailure);
  };

  if (error) {
    return (
      <div className={styles.codeBlock}>
        <div className={styles.codeBlockHeader}>
          <span className={styles.codeBlockLang}>
            {t('mermaid.errorLabel')}
          </span>
        </div>
        <pre className={`${styles.codeBlockContent} ${styles.codeBlockPlain}`}>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeBlockLang}>{t('mermaid.label')}</span>
        <span className={styles.mermaidActions}>
          {viewMode === 'diagram' && (
            <>
              <button
                className={styles.codeBlockCopy}
                onClick={handleZoomOut}
                title={t('mermaid.zoomOut')}
                disabled={zoom <= ZOOM_MIN}
              >
                {t('mermaid.zoomOut')}
              </button>
              <button
                className={styles.codeBlockCopy}
                onClick={resetZoomAndPan}
                title={t('mermaid.zoomReset')}
                disabled={zoom === 1 && offset.x === 0 && offset.y === 0}
              >
                {t('mermaid.zoomReset')}
              </button>
              <button
                className={styles.codeBlockCopy}
                onClick={handleZoomIn}
                title={t('mermaid.zoomIn')}
                disabled={zoom >= ZOOM_MAX}
              >
                {t('mermaid.zoomIn')}
              </button>
            </>
          )}
          <button
            className={styles.codeBlockCopy}
            onClick={() =>
              setViewMode(viewMode === 'diagram' ? 'code' : 'diagram')
            }
          >
            {viewMode === 'diagram'
              ? t('mermaid.viewCode')
              : t('mermaid.viewDiagram')}
          </button>
          <button className={styles.codeBlockCopy} onClick={handleCopy}>
            {copied ? t('code.copied') : t('code.copy')}
          </button>
        </span>
      </div>
      {viewMode === 'code' ? (
        <pre className={`${styles.codeBlockContent} ${styles.codeBlockPlain}`}>
          <code>{code}</code>
        </pre>
      ) : !svg ? (
        <div
          className={`${styles.mermaidBlock} ${styles.mermaidLoading} ${styles.mermaidInline}`}
        >
          <span>{t('mermaid.rendering')}</span>
        </div>
      ) : (
        <div
          className={`${styles.mermaidZoomWrapper} ${isDragging ? styles.mermaidDragging : ''}`}
          onMouseDown={handleMouseDown}
          onDoubleClick={resetZoomAndPan}
        >
          <div
            className={`${styles.mermaidBlock} ${styles.mermaidInline}`}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transformOrigin: 'top center',
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </div>
  );
}

function CodeBlock({
  className,
  children,
  isStreaming,
}: {
  className?: string;
  children: string;
  isStreaming?: boolean;
}) {
  const { t } = useI18n();
  const appTheme = useTheme();
  const documentMode = useTranscriptRenderMode() === 'document';
  const [html, setHtml] = useState<string | null>(null);
  const [copied, flashCopied] = useCopiedFlash();

  const { label, lang, resolvedLang } = resolveFenceLanguage(
    extractRawFenceLanguage(className),
  );
  const code = String(children).replace(/\n$/, '');
  const shikiTheme =
    appTheme === 'light' ? 'github-light-default' : 'github-dark-default';

  useEffect(() => {
    // Stream code as plain text. Highlighting a growing fence on every chunk
    // repeatedly tokenizes its entire contents and can dominate rendering for
    // long responses; the settled render below highlights the final text once.
    if (
      documentMode ||
      isStreaming ||
      lang === 'mermaid' ||
      resolvedLang === 'text' ||
      isTooLargeToHighlight(code)
    ) {
      setHtml(null);
      return;
    }

    // Already-highlighted exact code/lang/theme (settled re-render, or a block
    // that re-mounted): return it synchronously without needing the highlighter.
    const cached = getCachedHtml(code, resolvedLang, shikiTheme);
    if (cached !== null) {
      setHtml(cached);
      return;
    }

    const warmHtml = highlightToHtmlSync(code, resolvedLang, shikiTheme, true);
    if (warmHtml !== null) {
      setHtml(warmHtml);
      return;
    }

    // Cold path: the grammar isn't loaded yet. Drop any HTML still held from a
    // previous `code` (e.g. this reused CodeBlock instance just switched to a
    // not-yet-loaded language on regeneration) so we render the current code as
    // plain text — not the prior block's stale highlight — until the load
    // resolves. Then re-check cancellation *before* the synchronous tokenization
    // so a superseded settled block does not run codeToHtml.
    setHtml(null);
    let cancelled = false;
    getCodeHighlighter(resolvedLang)
      .then(() => {
        if (cancelled) return;
        const cold = highlightToHtmlSync(code, resolvedLang, shikiTheme, true);
        if (cold !== null) setHtml(cold);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(
          '[web-shell] highlight failed for lang=%s',
          resolvedLang,
          err,
        );
        setHtml(null);
      });

    return () => {
      cancelled = true;
    };
  }, [code, documentMode, lang, resolvedLang, shikiTheme, isStreaming]);

  const handleCopy = () => {
    void writeClipboardText(code)
      .then(() => {
        flashCopied();
      })
      .catch(warnClipboardWriteFailure);
  };

  // In document mode a mermaid fence falls through to the plain <pre> below,
  // holding its own source: the same degradation this component already applies
  // to syntax highlighting there, and what lets the export bundle drop mermaid
  // and its graph dependencies (#11091).
  if (lang === 'mermaid' && !isStreaming && !documentMode) {
    return <MermaidBlock code={code} />;
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeBlockLang}>{label}</span>
        <button className={styles.codeBlockCopy} onClick={handleCopy}>
          {copied ? t('code.copied') : t('code.copy')}
        </button>
      </div>
      {!documentMode && !isStreaming && html !== null ? (
        <div
          className={styles.codeBlockContent}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={`${styles.codeBlockContent} ${styles.codeBlockPlain}`}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function extractRawFenceLanguage(className: string | undefined): string {
  const token = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? '';
  const match = token.match(/^([\w+.#-]+)/);
  if (!match) return '';
  const language = match[1] ?? '';
  const nextChar = token[language.length];
  return !nextChar || nextChar === '{' || nextChar === ':' ? language : '';
}

function InlineCode({ children }: { children: ReactNode }) {
  return <code className={styles.inlineCode}>{children}</code>;
}

function PlainMarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>{children}</table>
    </div>
  );
}

// Carries the streaming flag to CodeBlock via context instead of a closure, so
// the `code` renderer below can be a single stable reference. Toggling
// isStreaming then no longer changes the `code` element type, so React reuses
// the same CodeBlock instance across the streaming→settled transition
// (preserving its highlighted `html` state) instead of remounting it.
const IsStreamingContext = createContext(false);
const MarkdownSourceContext = createContext<MarkdownContentSource | undefined>(
  undefined,
);
const MarkdownDocumentContext = createContext<string | undefined>(undefined);

interface PositionedCodeNode {
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
}

function isIncompleteTailFence(
  document: string | undefined,
  node: PositionedCodeNode | undefined,
  isStreaming: boolean,
): boolean {
  if (!isStreaming || document === undefined) return false;
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  return (
    !isMarkdownFenceClosed(document.slice(start, end)) &&
    document.slice(end).trim().length === 0
  );
}

function MarkdownCode({
  className,
  children,
  node,
}: {
  className?: string;
  children?: ReactNode;
  node?: PositionedCodeNode;
}) {
  const isStreaming = useContext(IsStreamingContext);
  const document = useContext(MarkdownDocumentContext);
  const isBlock =
    className?.startsWith('language-') ||
    (typeof children === 'string' && children.includes('\n'));

  if (isBlock) {
    return (
      <MarkdownFencedCode
        className={className}
        isStreaming={isStreaming}
        isIncomplete={isIncompleteTailFence(document, node, isStreaming)}
      >
        {children}
      </MarkdownFencedCode>
    );
  }
  return <InlineCode>{children}</InlineCode>;
}

function MarkdownFencedCode({
  className,
  children,
  isStreaming,
  isIncomplete,
}: {
  className?: string;
  children?: ReactNode;
  isStreaming?: boolean;
  isIncomplete?: boolean;
}) {
  const source = useContext(MarkdownSourceContext);
  const appTheme = useTheme();
  const { markdown } = useWebShellCustomization();
  const rawCode = String(children);
  const code = rawCode.replace(/\n$/, '');
  const fallback = (
    <CodeBlock className={className} isStreaming={isStreaming}>
      {rawCode}
    </CodeBlock>
  );
  const language = extractRawFenceLanguage(className);
  const { resolvedLang: resolvedLanguage } = resolveFenceLanguage(language);
  const canUseCustomRenderer = !!source && !!className && !!language;

  if (canUseCustomRenderer) {
    try {
      const custom = markdown?.renderCodeBlock?.({
        language,
        resolvedLanguage,
        className,
        code,
        isStreaming: !!isStreaming,
        isIncomplete: !!isIncomplete,
        source,
        theme: appTheme,
      });
      if (custom != null && typeof custom !== 'boolean') {
        return (
          <ErrorBoundary
            fallback={fallback}
            label={`custom code block component render (lang=${language})`}
            resetKeys={[
              language,
              source,
              appTheme,
              isStreaming ? 'streaming' : 'settled',
              isIncomplete ? 'incomplete' : 'complete',
              code,
            ]}
          >
            {custom}
          </ErrorBoundary>
        );
      }
    } catch (error) {
      console.error(
        '[web-shell] custom code block renderer call failed (lang=%s):',
        language,
        error,
      );
    }
  }

  return fallback;
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

/** `qwen-session://<id>` links are intercepted and dispatched as a DOM event
 * (`qwen:open-session`) so the app shell can navigate to the session without
 * the markdown renderer needing to know about session management. */
const QWEN_SESSION_SCHEME = /^qwen-session:\/\//i;

/**
 * react-markdown sanitizes every href through `defaultUrlTransform`, which
 * allows only `http(s)`, `irc(s)`, `mailto` and `xmpp` and rewrites everything
 * else to `''`. Without this, `qwen-session://<id>` never reaches
 * {@link MarkdownLink} with its scheme intact, the interception below is dead
 * code, and the link renders as an inert anchor.
 *
 * Letting the scheme through is safe: `MarkdownLink` never puts it in the DOM.
 * It renders `href="#"` and dispatches the id as an event, so nothing navigates
 * to a `qwen-session:` URL — and an unknown scheme is inert in a browser anyway.
 * Every other href keeps the default sanitizer.
 */
export function markdownUrlTransform(
  url: string,
  documentMode = false,
): string {
  if (documentMode && SAFE_DOCUMENT_IMAGE_DATA_URI.test(url.trim())) {
    return url;
  }
  return QWEN_SESSION_SCHEME.test(url.trim()) ? url : defaultUrlTransform(url);
}

function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const renderMode = useTranscriptRenderMode();
  const openExternalLink = useExternalLinkOpener();
  if (href && QWEN_SESSION_SCHEME.test(href.trim())) {
    if (renderMode !== 'interactive') {
      return <span className={styles.link}>{children}</span>;
    }
    const sessionId = href.trim().replace(QWEN_SESSION_SCHEME, '');
    return (
      <a
        href="#"
        role="button"
        className={styles.link}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent('qwen:open-session', { detail: sessionId }),
          );
        }}
      >
        {children}
      </a>
    );
  }
  const safeHref = isSafeHref(href) ? href : undefined;
  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.link}
      onClick={(event) => openExternalLink(event, safeHref)}
    >
      {children}
    </a>
  );
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const renderMode = useTranscriptRenderMode();
  const safeSrc = isSafeImageSrc(src, renderMode === 'document')
    ? src
    : undefined;
  return <img src={safeSrc} alt={alt || ''} className={styles.image} />;
}

/**
 * Throttles a rapidly changing value (like a streaming string) to prevent
 * O(n²) re-parsing of the entire Markdown AST on every token.
 */
function useThrottledValue(
  value: string,
  isStreaming: boolean | undefined,
  intervalMs: number = 80,
): string {
  const [throttled, setThrottled] = useState(value);
  const throttledRef = useRef(throttled);
  throttledRef.current = throttled;
  const lastRunRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!isStreaming) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      // Flush immediately when streaming stops
      if (throttledRef.current !== value) {
        setThrottled(value);
      }
      return;
    }

    const now = Date.now();
    const elapsed = now - lastRunRef.current;

    if (elapsed >= intervalMs) {
      lastRunRef.current = now;
      setThrottled(valueRef.current);
    } else if (!timeoutRef.current) {
      timeoutRef.current = setTimeout(() => {
        lastRunRef.current = Date.now();
        timeoutRef.current = null;
        setThrottled(valueRef.current);
      }, intervalMs - elapsed);
    }
  }, [value, isStreaming, intervalMs]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  if (!isStreaming) return value;

  // Bypass throttle for non-monotonic changes
  if (
    typeof value === 'string' &&
    typeof throttled === 'string' &&
    !value.startsWith(throttled)
  ) {
    return value;
  }

  return throttled;
}

// `code`/`pre`/`a`/`img` are stable references; only `table` is created per
// call (it closes over tableMode/tableResetKey). Recreating the components
// object for a table reset therefore never changes the `code` element type, so
// code blocks are not remounted.
function createComponents(
  tableMode: MarkdownTableMode = 'basic',
  tableResetKey = '',
): Components {
  return {
    code: MarkdownCode,
    pre: MarkdownPre,
    a: MarkdownLink,
    img: MarkdownImage,
    table({ children }: { children?: ReactNode }) {
      if (tableMode === 'advanced') {
        const fallback = <PlainMarkdownTable>{children}</PlainMarkdownTable>;
        return (
          <ErrorBoundary
            fallback={fallback}
            label="enhanced markdown table"
            resetKeys={[tableResetKey]}
          >
            <EnhancedMarkdownTable fallback={fallback}>
              {children}
            </EnhancedMarkdownTable>
          </ErrorBoundary>
        );
      }
      return <PlainMarkdownTable>{children}</PlainMarkdownTable>;
    },
  };
}

const COMPONENTS_DEFAULT = createComponents();

/**
 * Isolated memoized renderer. This ensures react-markdown ONLY re-parses
 * when the throttled content or plugin references actually change.
 */
const MemoizedMarkdownRenderer = memo(function MemoizedMarkdownRenderer({
  content,
  components,
  remarkPlugins,
  rehypePlugins,
  urlTransform,
}: {
  content: string;
  components: Options['components'];
  remarkPlugins: Options['remarkPlugins'];
  rehypePlugins: Options['rehypePlugins'];
  urlTransform: Options['urlTransform'];
}) {
  return (
    <ReactMarkdown
      components={components}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
    >
      {content}
    </ReactMarkdown>
  );
});

export const Markdown = memo(function Markdown({
  content,
  source,
  isStreaming,
  tableMode,
}: MarkdownProps) {
  const { markdown, markdownTableMode } = useWebShellCustomization();
  const theme = useTheme();
  const documentMode = useTranscriptRenderMode() === 'document';
  const sourceMarkdown = source ? markdown : undefined;

  const throttledContent = useThrottledValue(content ?? '', isStreaming);
  const renderStreamingPlainText =
    isStreaming === true &&
    throttledContent.length > STREAMING_MARKDOWN_PARSE_LIMIT;
  const renderedContent = useMemo(
    () =>
      throttledContent && source && sourceMarkdown?.transformMarkdown
        ? sourceMarkdown.transformMarkdown(throttledContent, { source })
        : throttledContent,
    [source, sourceMarkdown, throttledContent],
  );

  const effectiveTableMode = isStreaming
    ? 'basic'
    : (tableMode ?? markdownTableMode ?? 'basic');

  // Memoize components so references stay stable during throttle window
  const components = useMemo(() => {
    if (effectiveTableMode === 'advanced') {
      return createComponents('advanced', renderedContent);
    }
    return COMPONENTS_DEFAULT;
  }, [effectiveTableMode, renderedContent]);

  const sourceComponents = sourceMarkdown?.components;
  const renderedComponents = useMemo(() => {
    if (!sourceComponents) return components;
    return {
      ...components,
      ...sourceComponents,
      ...(effectiveTableMode === 'advanced' ? { table: components.table } : {}),
    };
  }, [components, effectiveTableMode, sourceComponents]);
  const chart =
    !documentMode &&
    source === 'assistant' &&
    !sourceComponents?.code &&
    !sourceComponents?.pre
      ? (sourceMarkdown?.chart ??
        (sourceMarkdown?.renderCodeBlock
          ? undefined
          : DEFAULT_WEB_SHELL_MARKDOWN_CHART))
      : undefined;
  const chartPre = useMemo(
    () =>
      chart
        ? createWebShellMarkdownChartPre(chart.registry, {
            chartClassName: chart.chartClassName,
            chartStyle: { minHeight: 360, ...chart.chartStyle },
          })
        : undefined,
    [chart],
  );
  const componentsWithCharts = useMemo(
    () =>
      chartPre
        ? {
            ...renderedComponents,
            pre: chartPre,
          }
        : renderedComponents,
    [chartPre, renderedComponents],
  );

  // Memoize plugins so their array references remain stable.
  const remarkPlugins = useMemo(() => {
    return sourceMarkdown?.remarkPlugins
      ? [
          remarkGfm,
          remarkMath,
          remarkCjkFriendly,
          ...sourceMarkdown.remarkPlugins,
        ]
      : [remarkGfm, remarkMath, remarkCjkFriendly];
  }, [sourceMarkdown?.remarkPlugins]);

  const rehypePlugins = useMemo(() => {
    return sourceMarkdown?.rehypePlugins
      ? [rehypeKatex, ...sourceMarkdown.rehypePlugins]
      : [rehypeKatex];
  }, [sourceMarkdown?.rehypePlugins]);
  const urlTransform = useMemo(
    () => (url: string) => markdownUrlTransform(url, documentMode),
    [documentMode],
  );

  if (!content) return null;

  if (renderStreamingPlainText) {
    return (
      <div
        className={source !== 'thinking' ? styles.content : undefined}
        data-markdown-source={source}
        data-markdown-streaming-plain-text="true"
      >
        <pre className={styles.streamingPlainText}>{renderedContent}</pre>
      </div>
    );
  }

  const renderedMarkdown = (
    <MemoizedMarkdownRenderer
      content={renderedContent}
      components={componentsWithCharts}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
    />
  );
  const chartAwareMarkdown = chart ? (
    <WebShellMarkdownChartProvider
      customization={chart}
      source={renderedContent}
      streaming={!!isStreaming}
      theme={theme}
    >
      {renderedMarkdown}
    </WebShellMarkdownChartProvider>
  ) : (
    renderedMarkdown
  );

  return (
    <div
      className={source !== 'thinking' ? styles.content : undefined}
      data-markdown-source={source}
    >
      <IsStreamingContext.Provider value={!!isStreaming}>
        <MarkdownSourceContext.Provider value={source}>
          <MarkdownDocumentContext.Provider value={renderedContent}>
            {chartAwareMarkdown}
          </MarkdownDocumentContext.Provider>
        </MarkdownSourceContext.Provider>
      </IsStreamingContext.Provider>
    </div>
  );
});
