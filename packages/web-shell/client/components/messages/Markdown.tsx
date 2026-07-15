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
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {
  getCachedHtml,
  getCodeHighlighter,
  highlightToHtmlSync,
  isTooLargeToHighlight,
} from './codeHighlighter';
import { useI18n } from '../../i18n';
import {
  useWebShellCustomization,
  type MarkdownTableMode,
  type MarkdownContentSource,
} from '../../customization';
import { ErrorBoundary } from '../ErrorBoundary';
import { EnhancedMarkdownTable } from './EnhancedMarkdownTable';
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
const SAFE_IMAGE_DATA_URI = /^data:image\/(png|jpeg|gif|webp);base64,/i;

export function isSafeHref(url: string | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  return SAFE_HREF_SCHEMES.test(trimmed);
}

export function isSafeImageSrc(url: string | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  if (SAFE_IMAGE_DATA_URI.test(trimmed)) return true;
  return SAFE_HREF_SCHEMES.test(trimmed);
}

// Track last initialized theme to avoid redundant mermaid.initialize() calls.
// mermaid.initialize() is idempotent but runs per-block; with N diagrams in a
// transcript this saves N-1 redundant calls per render cycle.
let lastMermaidTheme: string | undefined;
let mermaidRenderId = 0;

function MermaidBlock({ code }: { code: string }) {
  const { t } = useI18n();
  const appTheme = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'diagram' | 'code'>('diagram');
  const [copied, setCopied] = useState(false);
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
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    const timer = setTimeout(() => {
      import('mermaid').then(async (mod) => {
        if (cancelled) return;
        const mermaid = mod.default;
        if (lastMermaidTheme !== mermaidTheme) {
          mermaid.initialize({
            startOnLoad: false,
            theme: mermaidTheme,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            flowchart: {
              wrappingWidth: 300,
            },
          });
          lastMermaidTheme = mermaidTheme;
        }
        try {
          const id = `mermaid-${++mermaidRenderId}`;
          const { svg } = await mermaid.render(id, code.trim());
          // No additional sanitization needed: securityLevel:'strict' uses
          // DOMPurify internally to sanitize SVG output.
          if (!cancelled) {
            setSvg(svg);
          }
        } catch (error: unknown) {
          if (!cancelled) {
            setError(
              error instanceof Error ? error.message : 'Mermaid render failed',
            );
          }
        }
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, mermaidTheme]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
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
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { label, lang, resolvedLang } = resolveFenceLanguage(
    extractRawFenceLanguage(className),
  );
  const code = String(children).replace(/\n$/, '');
  const shikiTheme =
    appTheme === 'light' ? 'github-light-default' : 'github-dark-default';

  useEffect(() => {
    // Don't highlight unsupported languages or blocks too large to tokenize
    // without freezing the main thread — render them as plain text.
    if (
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

    // Re-highlight synchronously on every code change. With the Oniguruma
    // engine a normal-sized block tokenizes in ~1–7ms, so there's no need to
    // throttle or keep a stale snapshot around: `html` always matches the
    // current `code`, so no streamed text is ever hidden and there's no flicker.
    // `isTooLargeToHighlight` above bounds the worst-case per-chunk cost.
    //
    // Don't persist streaming intermediates: the growing block produces a new
    // cache key every chunk and would otherwise evict other blocks from the LRU.
    const persist = !isStreaming;
    const warmHtml = highlightToHtmlSync(
      code,
      resolvedLang,
      shikiTheme,
      persist,
    );
    if (warmHtml !== null) {
      setHtml(warmHtml);
      return;
    }

    // Cold path: the grammar isn't loaded yet. Drop any HTML still held from a
    // previous `code` (e.g. this reused CodeBlock instance just switched to a
    // not-yet-loaded language on regeneration) so we render the current code as
    // plain text — not the prior block's stale highlight — until the load
    // resolves. Then re-check cancellation *before* the synchronous tokenization
    // so superseded streaming snapshots that queued behind the same load don't
    // each run codeToHtml.
    setHtml(null);
    let cancelled = false;
    getCodeHighlighter(resolvedLang)
      .then(() => {
        if (cancelled) return;
        const cold = highlightToHtmlSync(
          code,
          resolvedLang,
          shikiTheme,
          persist,
        );
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
  }, [code, lang, resolvedLang, shikiTheme, isStreaming]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };

  if (lang === 'mermaid' && !isStreaming) {
    return <MermaidBlock code={code} />;
  }

  // `html` is always the highlight of the *current* `code` (re-highlighted
  // synchronously per chunk), so it can be rendered directly — no prefix gate
  // is needed to guard against showing a stale/previous block's HTML.
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeBlockLang}>{label}</span>
        <button className={styles.codeBlockCopy} onClick={handleCopy}>
          {copied ? t('code.copied') : t('code.copy')}
        </button>
      </div>
      {html !== null ? (
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

function MarkdownCode({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const isStreaming = useContext(IsStreamingContext);
  const isBlock =
    className?.startsWith('language-') ||
    (typeof children === 'string' && children.includes('\n'));

  if (isBlock) {
    return (
      <MarkdownFencedCode className={className} isStreaming={isStreaming}>
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
}: {
  className?: string;
  children?: ReactNode;
  isStreaming?: boolean;
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
export function markdownUrlTransform(url: string): string {
  return QWEN_SESSION_SCHEME.test(url.trim()) ? url : defaultUrlTransform(url);
}

function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  if (href && QWEN_SESSION_SCHEME.test(href.trim())) {
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
    >
      {children}
    </a>
  );
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const safeSrc = isSafeImageSrc(src) ? src : undefined;
  return <img src={safeSrc} alt={alt || ''} className={styles.image} />;
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

export const Markdown = memo(function Markdown({
  content,
  source,
  isStreaming,
  tableMode,
}: MarkdownProps) {
  const { markdown, markdownTableMode } = useWebShellCustomization();
  const sourceMarkdown = source ? markdown : undefined;
  const renderedContent =
    content && source && sourceMarkdown?.transformMarkdown
      ? sourceMarkdown.transformMarkdown(content, { source })
      : content;
  const effectiveTableMode = isStreaming
    ? 'basic'
    : (tableMode ?? markdownTableMode ?? 'basic');
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

  if (!content) return null;
  const remarkPlugins = sourceMarkdown?.remarkPlugins
    ? [remarkGfm, remarkMath, ...sourceMarkdown.remarkPlugins]
    : [remarkGfm, remarkMath];
  const rehypePlugins = sourceMarkdown?.rehypePlugins
    ? [rehypeKatex, ...sourceMarkdown.rehypePlugins]
    : [rehypeKatex];

  return (
    <div
      className={source !== 'thinking' ? styles.content : undefined}
      data-markdown-source={source}
    >
      <IsStreamingContext.Provider value={!!isStreaming}>
        <MarkdownSourceContext.Provider value={source}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={renderedComponents}
            urlTransform={markdownUrlTransform}
          >
            {renderedContent}
          </ReactMarkdown>
        </MarkdownSourceContext.Provider>
      </IsStreamingContext.Provider>
    </div>
  );
});
