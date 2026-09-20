import React, { useEffect, useState } from 'react';
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
const excludeItems = (params.get('exclude') ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter((item): item is WebShellSettingItemId => validIds.has(item));

function SettingsHarness() {
  const [modelManagement, setModelManagement] = useState(() => ({
    allowAdd: params.has('allowAdd')
      ? params.get('allowAdd') !== 'false'
      : undefined,
    allowDelete: params.has('allowDelete')
      ? params.get('allowDelete') !== 'false'
      : undefined,
  }));
  useEffect(() => {
    const update = (event: Event) => {
      setModelManagement((event as CustomEvent<typeof modelManagement>).detail);
    };
    window.addEventListener('model-management-change', update);
    return () => window.removeEventListener('model-management-change', update);
  }, []);
  return (
    <WebShellWithProviders
      baseUrl={window.location.origin}
      sessionId={sessionId}
      theme={theme}
      settings={{ excludeItems }}
      modelManagement={modelManagement}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsHarness />
  </React.StrictMode>,
);
