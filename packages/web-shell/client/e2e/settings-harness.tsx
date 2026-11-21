import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/standalone.css';
import { WebShellWithProviders, WEB_SHELL_SETTING_ITEM_IDS } from '../index';
import type { WebShellSettingItemId } from '../settings';
import type { WebShellTheme } from '../themeContext';
import type {
  WebShellUnavailableModel,
  WebShellUnavailableModelTooltipMount,
} from '../unavailableModels';

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
const unavailableModels: readonly WebShellUnavailableModel[] | undefined =
  params.get('unavailableModels') === '1'
    ? [
        {
          id: 'qwen-max',
          label: 'Qwen Max',
          tooltip: 'Available on the Pro plan.',
        },
        {
          id: 'gpt-5',
          label: 'GPT-5',
          tooltip: 'Requires an enterprise account.',
        },
      ]
    : undefined;
const mountUnavailableModelTooltip:
  | WebShellUnavailableModelTooltipMount
  | undefined =
  params.get('unavailableMount') === '1'
    ? (container, info) => {
        const summary = container.ownerDocument.createElement('p');
        summary.style.margin = '0';
        const button = container.ownerDocument.createElement('button');
        button.type = 'button';
        button.textContent = 'Authorize';
        button.style.cssText =
          'appearance:none;border:1px solid var(--border);border-radius:8px;padding:6px 10px;background:transparent;color:var(--foreground);font:inherit;font-size:13px;font-weight:500;cursor:pointer';
        const update = () => {
          summary.textContent = 'Not authorized for the current account.';
        };
        update(info);
        container.replaceChildren(summary, button);
        return {
          update,
          dispose() {
            container.replaceChildren();
          },
        };
      }
    : undefined;

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
      sidebar={params.get('sidebar') === 'false' ? false : undefined}
      settings={{ includeItems, excludeItems }}
      loadingPhrases={
        params.has('loadingPhrase')
          ? () => [params.get('loadingPhrase')!]
          : undefined
      }
      modelManagement={modelManagement}
      unavailableModels={unavailableModels}
      mountUnavailableModelTooltip={mountUnavailableModelTooltip}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsHarness />
  </React.StrictMode>,
);
