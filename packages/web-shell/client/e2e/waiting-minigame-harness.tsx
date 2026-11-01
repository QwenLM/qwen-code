import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/globals.css';
import '../styles/standalone.css';
import { I18nProvider, type WebShellLanguage } from '../i18n';
import {
  WaitingMinigame,
  WaitingMinigameButton,
} from '../components/WaitingMinigame';
import type { WaitingActivityBucket } from '../utils/waitingActivity';

function makeActivity(seed: number): WaitingActivityBucket[] {
  const now = Date.now();
  return Array.from({ length: 44 }, (_, index) => {
    const startAt = now - 44 * 60_000 + index * 60_000;
    const count = (index + seed) % 5 === 0 ? 1 + ((index + seed) % 3) : 0;
    return { count, startAt, endAt: startAt + 60_000 };
  });
}

const TOKENS = {
  input: 48_200,
  output: 12_600,
  cached: 31_400,
  context: 61_000,
  contextLimit: 131_072,
};

function Harness() {
  const [open, setOpen] = useState(true);
  const [dark, setDark] = useState(true);
  const [language, setLanguage] = useState<WebShellLanguage>('en');
  const [seed, setSeed] = useState(1);
  const [withTokens, setWithTokens] = useState(true);
  const activity = useMemo(() => makeActivity(seed), [seed]);
  const tokenUsage = withTokens ? TOKENS : { input: 0, output: 0, cached: 0 };
  const toggleTheme = () => setDark((value) => !value);

  return (
    <I18nProvider language={language}>
      <div
        style={{
          minHeight: '100dvh',
          background: dark ? '#0d0d0d' : '#ffffff',
          color: dark ? '#fafafa' : '#0a0a0b',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        <header
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            padding: '10px 16px',
            borderBottom: `1px solid ${dark ? '#2a2a2a' : '#e5e7eb'}`,
            fontSize: 12,
          }}
        >
          <strong>Waiting minigame harness</strong>
          <button type="button" onClick={toggleTheme}>
            {dark ? 'Light theme' : 'Dark theme'}
          </button>
          <button
            type="button"
            onClick={() =>
              setLanguage((value) => (value === 'en' ? 'zh-CN' : 'en'))
            }
          >
            {language === 'en' ? '中文' : 'English'}
          </button>
          <button type="button" onClick={() => setSeed((value) => value + 3)}>
            Random activity
          </button>
          <button
            type="button"
            onClick={() => setWithTokens((value) => !value)}
          >
            {withTokens ? 'Hide token data' : 'Show token data'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              window.setTimeout(() => setOpen(true), 30);
            }}
          >
            Reopen at activity
          </button>
          <span style={{ marginLeft: 'auto', opacity: 0.6 }}>
            Fake task · local preview
          </span>
        </header>
        <main
          data-web-shell-root
          data-web-shell-shadcn
          className={dark ? 'dark' : undefined}
          style={{
            minHeight: 'calc(100dvh - 43px)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            gap: 10,
            width: 'min(860px, calc(100% - 48px))',
            margin: '0 auto',
            padding: '24px 0 28px',
            background: 'var(--background)',
            color: 'var(--foreground)',
          }}
        >
          <div style={{ flex: 1 }} />
          {open && (
            <WaitingMinigame
              open={open}
              onClose={() => setOpen(false)}
              activity={activity}
              tokenUsage={tokenUsage}
            />
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minHeight: 24,
              color: 'var(--muted-foreground)',
              fontSize: 14,
            }}
          >
            <span aria-hidden="true">⠋</span>
            <span>Waiting for a reply</span>
            <span style={{ fontSize: 13 }}>
              (12s · ↓ 3 tokens · esc to cancel)
            </span>
            <span style={{ marginLeft: 'auto' }}>
              <WaitingMinigameButton
                open={open}
                onToggle={() => setOpen((value) => !value)}
              />
            </span>
          </div>
          <div
            style={{
              height: 132,
              padding: '14px 16px',
              border: '1px solid var(--border)',
              borderRadius: 12,
              background: 'var(--card)',
              color: 'var(--muted-foreground)',
              fontSize: 14,
            }}
          >
            Processing. New messages will be queued.
          </div>
        </main>
      </div>
    </I18nProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
