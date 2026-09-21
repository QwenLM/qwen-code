import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/standalone.css';
import type { WebShellSettingItemId } from '../settings';
import type { WebShellTheme } from '../themeContext';

const indexEntry = '../index.tsx';
const { WebShellWithProviders, WEB_SHELL_SETTING_ITEM_IDS } = await import(
  /* @vite-ignore */ indexEntry
);

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId') ?? 'settings-harness-e2e';
const theme: WebShellTheme = params.get('theme') === 'light' ? 'light' : 'dark';

// main.tsx owns the <html> theme class on the standalone entry; a harness
// page mounts the shell directly and must apply it itself.
document.documentElement.classList.add(`theme-${theme}`);
document.documentElement.classList.toggle('dark', theme === 'dark');

const validIds: ReadonlySet<string> = new Set(WEB_SHELL_SETTING_ITEM_IDS);
const parseItems = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is WebShellSettingItemId => validIds.has(item));
const excludeItems = parseItems(params.get('exclude') ?? '');
const includeItems = params.has('include')
  ? parseItems(params.get('include') ?? '')
  : undefined;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WebShellWithProviders
      baseUrl={window.location.origin}
      sessionId={sessionId}
      theme={theme}
      settings={{ includeItems, excludeItems }}
    />
  </React.StrictMode>,
);
