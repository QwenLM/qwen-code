import {
  Component,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { useTheme } from '../../themeContext';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { highlightToHtml, highlightToHtmlSync } from './codeHighlighter';
import { useI18n } from '../../i18n';
import {
  useWebShellCustomization,
  type MarkdownContentSource,
} from '../../customization';
import { EnhancedMarkdownTable } from './EnhancedMarkdownTable';
import styles from './Markdown.module.css';
import { StreamingCodeBlock } from './StreamingCodeBlock';

interface MarkdownProps {
  content: string;
  source?: MarkdownContentSource;
  /**
   * True while the message is still streaming in. Used to defer expensive,
   * per-chunk rendering (Mermaid diagrams and Shiki syntax highlighting) until
   * the content settles, avoiding flicker and wasted re-tokenization.
   */
  isStreaming?: boolean;
  enhanceTables?: boolean;
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
  'ruby',
  'php',
  'swift',
  'kotlin',
  'scala',
  'shell',
  'bash',
  'zsh',
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

// Common fence aliases → Shiki's canonical language id. Without this, blocks
// tagged ```ts / ```js / ```py fall through to the unhighlighted "text" path
// even though Shiki supports them under their full names.
const LANGUAGE_ALIASES: Record<string, string> = {
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
  /** What the user typed (lowercased), shown in the code-block header. */
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
  const lang = LANGUAGE_ALIASES[normalized] ?? normalized;
  const resolvedLang = SUPPORTED_LANGUAGES.has(lang) ? lang : 'text';
  return { label: normalized || 'text', lang, resolvedLang };
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

const SHIKI_CACHE_MAX = 128;
const shikiCache = new Map<string, string>();

function shikiCacheKey(code: string, lang: string, theme: string): string {
  return `${lang}\0${theme}\0${code}`;
}

function setShikiCache(key: string, html: string): void {
  if (shikiCache.size >= SHIKI_CACHE_MAX) {
    const first = shikiCache.keys().next().value;
    if (first !== undefined) shikiCache.delete(first);
  }
  shikiCache.set(key, html);
}

function cachedCodeToHtml(
  code: string,
  lang: string,
  theme: string,
): Promise<string> {
  const key = shikiCacheKey(code, lang, theme);
  const cached = shikiCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  return highlightToHtml(code, lang, theme).then((html) => {
    setShikiCache(key, html);
    return html;
  });
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
  const mermaidTheme = appTheme === 'light' ? 'default' : 'dark';

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
          <span className={styles.codeBlockLang}>mermaid (error)</span>
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
        <span className={styles.codeBlockLang}>mermaid</span>
        <span className={styles.mermaidActions}>
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
          className={`${styles.mermaidBlock} ${styles.mermaidInline}`}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
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
  // True once this block has streamed at least once, so the settle hand-off can
  // hold the colored streaming render until the static highlight is ready.
  const hasStreamedRef = useRef(false);

  const match = className?.match(/language-(\w+)/);
  const { label, lang, resolvedLang } = resolveFenceLanguage(match?.[1]);
  const code = String(children).replace(/\n$/, '');
  const shikiTheme =
    appTheme === 'light' ? 'github-light-default' : 'github-dark-default';

  useEffect(() => {
    if (lang === 'mermaid' || resolvedLang === 'text') {
      setHtml(null);
      return;
    }

    // Streaming is painted live by <StreamingCodeBlock>; the static path only
    // renders the settled content, so do nothing while the turn streams.
    if (isStreaming) {
      return;
    }

    const cacheKey = shikiCacheKey(code, resolvedLang, shikiTheme);
    if (shikiCache.has(cacheKey)) {
      setHtml(shikiCache.get(cacheKey)!);
      return;
    }

    // Fast path: if the highlighter is already warm for this language (e.g. the
    // block just finished streaming), highlight synchronously so the hand-off
    // from the streaming renderer is instant — no grey flash, no debounce delay.
    const warmHtml = highlightToHtmlSync(code, resolvedLang, shikiTheme);
    if (warmHtml !== null) {
      setShikiCache(cacheKey, warmHtml);
      setHtml(warmHtml);
      return;
    }

    // Cold path: keep any previously-rendered HTML in place (don't clear to
    // plain) and swap only once the new highlight is ready, avoiding a grey
    // flash on recompute (e.g. theme change). Debounced to coalesce changes.
    let cancelled = false;
    const timer = setTimeout(() => {
      cachedCodeToHtml(code, resolvedLang, shikiTheme)
        .then((result) => {
          if (!cancelled) setHtml(result);
        })
        .catch(() => {
          if (!cancelled) setHtml(null);
        });
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, lang, resolvedLang, shikiTheme, isStreaming]);

  // Remember once this block has streamed, so the settle hand-off can hold the
  // colored streaming render until the static highlight is ready.
  useEffect(() => {
    if (isStreaming && lang !== 'mermaid' && resolvedLang !== 'text') {
      hasStreamedRef.current = true;
    }
  }, [isStreaming, lang, resolvedLang]);

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

  // While streaming a highlightable fence, paint it live via @shikijs/stream
  // instead of waiting for the turn to settle. Plain/unknown languages and the
  // settled (post-stream) render fall through to the static Shiki path below.
  const highlightable = lang !== 'mermaid' && resolvedLang !== 'text';
  const streamingHighlight = isStreaming && highlightable;

  // After the turn settles, keep the (already-colored) streaming renderer
  // mounted until the static highlight is ready, so the hand-off never flashes
  // through a plain grey frame.
  const showStreaming =
    streamingHighlight ||
    (hasStreamedRef.current && html === null && highlightable);

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeBlockLang}>{label}</span>
        <button className={styles.codeBlockCopy} onClick={handleCopy}>
          {copied ? t('code.copied') : t('code.copy')}
        </button>
      </div>
      {showStreaming ? (
        <StreamingCodeBlock
          code={code}
          lang={resolvedLang}
          theme={shikiTheme}
        />
      ) : html ? (
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

class EnhancedMarkdownTableBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { hasError: boolean; resetKey: string }
> {
  state = { hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { resetKey: string },
  ) {
    if (props.resetKey !== state.resetKey) {
      return { hasError: false, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      '[web-shell] enhanced markdown table failed:',
      error,
      errorInfo.componentStack,
    );
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function createComponents(
  isStreaming?: boolean,
  enhanceTables?: boolean,
  tableResetKey = '',
): Components {
  return {
    code({
      className,
      children,
    }: {
      className?: string;
      children?: ReactNode;
    }) {
      const isBlock =
        className?.startsWith('language-') ||
        (typeof children === 'string' && children.includes('\n'));

      if (isBlock) {
        return (
          <CodeBlock className={className} isStreaming={isStreaming}>
            {String(children)}
          </CodeBlock>
        );
      }
      return <InlineCode>{children}</InlineCode>;
    },
    pre({ children }: { children?: ReactNode }) {
      return <>{children}</>;
    },
    a({ href, children }: { href?: string; children?: ReactNode }) {
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
    },
    table({ children }: { children?: ReactNode }) {
      const fallback = <PlainMarkdownTable>{children}</PlainMarkdownTable>;
      if (enhanceTables) {
        return (
          <EnhancedMarkdownTableBoundary
            fallback={fallback}
            resetKey={tableResetKey}
          >
            <EnhancedMarkdownTable fallback={fallback}>
              {children}
            </EnhancedMarkdownTable>
          </EnhancedMarkdownTableBoundary>
        );
      }
      return fallback;
    },
    img({ src, alt }: { src?: string; alt?: string }) {
      const safeSrc = isSafeImageSrc(src) ? src : undefined;
      return <img src={safeSrc} alt={alt || ''} className={styles.image} />;
    },
  };
}

const COMPONENTS_DEFAULT = createComponents();
const COMPONENTS_STREAMING = createComponents(true);

export const Markdown = memo(function Markdown({
  content,
  source,
  isStreaming,
  enhanceTables,
}: MarkdownProps) {
  const { markdown } = useWebShellCustomization();
  const sourceMarkdown = source ? markdown : undefined;
  const renderedContent =
    content && source && sourceMarkdown?.transformMarkdown
      ? sourceMarkdown.transformMarkdown(content, { source })
      : content;
  const components = useMemo(() => {
    if (enhanceTables) {
      return createComponents(isStreaming, true, renderedContent);
    }
    return isStreaming ? COMPONENTS_STREAMING : COMPONENTS_DEFAULT;
  }, [isStreaming, enhanceTables, renderedContent]);
  const sourceComponents = sourceMarkdown?.components;
  const renderedComponents = useMemo(() => {
    if (!sourceComponents) return components;
    return {
      ...components,
      ...sourceComponents,
      ...(enhanceTables ? { table: components.table } : {}),
    };
  }, [components, enhanceTables, sourceComponents]);

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
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={renderedComponents}
      >
        {renderedContent}
      </ReactMarkdown>
    </div>
  );
});
