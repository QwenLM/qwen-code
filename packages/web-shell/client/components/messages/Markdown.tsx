import { memo, useEffect, useState, type ReactNode } from 'react';
import { useTheme } from '../../themeContext';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { codeToHtml, type BundledLanguage } from 'shiki';
import { useI18n } from '../../i18n';
import {
  useWebShellCustomization,
  type MarkdownContentSource,
} from '../../customization';
import styles from './Markdown.module.css';

interface MarkdownProps {
  content: string;
  source?: MarkdownContentSource;
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

// Sanitize mermaid SVG output to prevent XSS while preserving rendering.
//
// Why <style> is kept (not removed):
//   Mermaid embeds <style> in SVG for theming (colors, fonts, backgrounds).
//   Removing it causes diagrams to render as unstyled black shapes.
//   Instead we strip dangerous CSS constructs (@import, external url()).
//
// Why <foreignObject> is kept (not removed):
//   Mermaid uses <foreignObject> for text labels in flowcharts, sequence
//   diagrams, etc. Removing it makes all text disappear.
//   With securityLevel:'strict', mermaid already escapes user input inside
//   foreignObject. Our attribute sanitizer below still strips on* handlers
//   and dangerous href/src values from all child elements.
export function sanitizeSvg(svg: string): string {
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return '';

  doc
    .querySelectorAll(
      'script, iframe, object, embed, link, ' +
        'animate, set, animateTransform, animateMotion, ' +
        'image, feImage, mpath',
    )
    .forEach((node) => node.remove());

  // Keep <style> but strip dangerous CSS: @import (external resource loading)
  // and external url() references (data exfiltration). Local url(#id) is safe.
  doc.querySelectorAll('style').forEach((node) => {
    const css = node.textContent || '';
    node.textContent = css
      .replace(/@import\b[^;]*/gi, '')
      .replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, 'url()');
  });

  doc.querySelectorAll('use').forEach((node) => {
    const hrefs = [
      node.getAttribute('href'),
      node.getAttribute('xlink:href'),
      node.getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
    ].filter((h): h is string => h !== null);
    if (hrefs.length === 0 || hrefs.some((h) => !h.startsWith('#'))) {
      node.remove();
    }
  });

  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' || name.endsWith(':href') || name === 'src') {
        if (
          value.startsWith('javascript:') ||
          value.startsWith('data:') ||
          value.startsWith('http:') ||
          value.startsWith('https:') ||
          value.startsWith('//')
        ) {
          element.removeAttribute(attr.name);
        }
      }
      if (/url\(/i.test(attr.value)) {
        const hasExternalUrl = /url\(\s*(?!['"]?#)/i.test(attr.value);
        if (hasExternalUrl) {
          element.removeAttribute(attr.name);
        }
      }
    }
  }

  return doc.documentElement.outerHTML;
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

function cachedCodeToHtml(
  code: string,
  lang: string,
  theme: string,
): Promise<string> {
  const key = `${lang}\0${theme}\0${code}`;
  const cached = shikiCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  return codeToHtml(code, {
    lang: lang as BundledLanguage,
    theme,
  }).then((html) => {
    if (shikiCache.size >= SHIKI_CACHE_MAX) {
      const first = shikiCache.keys().next().value;
      if (first !== undefined) shikiCache.delete(first);
    }
    shikiCache.set(key, html);
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
          const { svg: rendered } = await mermaid.render(id, code.trim());
          const safeSvg = sanitizeSvg(rendered);
          if (!cancelled) {
            if (safeSvg) {
              setSvg(safeSvg);
            } else {
              setError('Mermaid render failed');
            }
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
}: {
  className?: string;
  children: string;
}) {
  const { t } = useI18n();
  const appTheme = useTheme();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const match = className?.match(/language-(\w+)/);
  const lang = match?.[1] || '';
  const code = String(children).replace(/\n$/, '');
  const resolvedLang = SUPPORTED_LANGUAGES.has(lang) ? lang : 'text';
  const shikiTheme =
    appTheme === 'light' ? 'github-light-default' : 'github-dark-default';

  useEffect(() => {
    if (lang === 'mermaid' || resolvedLang === 'text') {
      setHtml(null);
      return;
    }

    const cacheKey = `${resolvedLang}\0${shikiTheme}\0${code}`;
    if (shikiCache.has(cacheKey)) {
      setHtml(shikiCache.get(cacheKey)!);
      return;
    }

    let cancelled = false;
    setHtml(null);
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
  }, [code, lang, resolvedLang, shikiTheme]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };

  if (lang === 'mermaid') {
    return <MermaidBlock code={code} />;
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeBlockLang}>{lang || 'text'}</span>
        <button className={styles.codeBlockCopy} onClick={handleCopy}>
          {copied ? t('code.copied') : t('code.copy')}
        </button>
      </div>
      {html ? (
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

const components: Components = {
  code({ className, children }: { className?: string; children?: ReactNode }) {
    const isBlock =
      className?.startsWith('language-') ||
      (typeof children === 'string' && children.includes('\n'));

    if (isBlock) {
      return <CodeBlock className={className}>{String(children)}</CodeBlock>;
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
    return (
      <div className={styles.tableWrapper}>
        <table className={styles.table}>{children}</table>
      </div>
    );
  },
  img({ src, alt }: { src?: string; alt?: string }) {
    const safeSrc = isSafeImageSrc(src) ? src : undefined;
    return <img src={safeSrc} alt={alt || ''} className={styles.image} />;
  },
};

export const Markdown = memo(function Markdown({
  content,
  source,
}: MarkdownProps) {
  const { markdown } = useWebShellCustomization();

  if (!content) return null;

  const sourceMarkdown = source ? markdown : undefined;
  const renderedContent =
    source && sourceMarkdown?.transformMarkdown
      ? sourceMarkdown.transformMarkdown(content, { source })
      : content;
  const renderedComponents = sourceMarkdown?.components
    ? { ...components, ...sourceMarkdown.components }
    : components;
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
