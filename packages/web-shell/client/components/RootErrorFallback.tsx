import type { CSSProperties } from 'react';
import type { WebShellLanguage } from '../i18n';

interface RootErrorFallbackProps {
  error: Error;
  onRetry: () => void;
  /** Selects the fallback copy. Defaults to English when omitted. */
  language?: WebShellLanguage;
}

interface FallbackCopy {
  title: string;
  body: string;
  retry: string;
}

// This surface renders OUTSIDE the in-app I18nProvider (the boundary wraps the
// whole App, which owns that provider), so it cannot call useI18n. It carries
// its own minimal copy instead of pulling the full translation table.
const COPY: Record<WebShellLanguage, FallbackCopy> = {
  en: {
    title: 'Something went wrong',
    body: 'An unexpected error occurred and this content could not be displayed.',
    retry: 'Try again',
  },
  'zh-CN': {
    title: '出了点问题',
    body: '发生意外错误，无法显示此内容。',
    retry: '重试',
  },
};

// The boundary wraps the whole App, so this surface renders when the themed
// App container (which defines --text-primary etc.) never mounted. It therefore
// cannot use app theme tokens. Inheriting the host's text color keeps it
// readable on both light and dark hosts; opacity carries the hierarchy and a
// neutral gray border reads acceptably on either background.
const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.75rem',
  padding: '2rem',
  minHeight: '8rem',
  height: '100%',
  textAlign: 'center',
  color: 'inherit',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: '1rem',
  fontWeight: 600,
};

const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.85rem',
  opacity: 0.7,
  maxWidth: '32rem',
};

const buttonStyle: CSSProperties = {
  appearance: 'none',
  cursor: 'pointer',
  padding: '0.4rem 1rem',
  fontSize: '0.85rem',
  borderRadius: '6px',
  border: '1px solid rgba(128, 128, 128, 0.4)',
  background: 'transparent',
  color: 'inherit',
};

/**
 * Last-resort surface for the top-level boundary. Self-contained (no provider,
 * theme-token, or i18n dependency) so it survives even when the whole App tree
 * fails to mount. Offers a retry instead of forcing a host-page reload, which
 * would be hostile in embedded integrations.
 */
export function RootErrorFallback({
  error,
  onRetry,
  language = 'en',
}: RootErrorFallbackProps) {
  const copy = COPY[language] ?? COPY.en;
  return (
    <div role="alert" style={containerStyle} data-web-shell-error>
      <p style={titleStyle}>{copy.title}</p>
      <p style={bodyStyle}>{copy.body}</p>
      {/* Dev-only: end users (and embedded hosts) shouldn't see raw internal
          error text — it stays in console.error for everyone. In the published
          lib build DEV is statically false, so this never ships to consumers. */}
      {import.meta.env.DEV && error.message && (
        <p style={{ ...bodyStyle, fontFamily: 'monospace', opacity: 0.55 }}>
          {error.message}
        </p>
      )}
      <button type="button" style={buttonStyle} onClick={onRetry}>
        {copy.retry}
      </button>
    </div>
  );
}
