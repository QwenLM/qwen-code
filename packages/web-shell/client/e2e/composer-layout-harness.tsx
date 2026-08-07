import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/standalone.css';

const indexEntry = '../index.tsx';
const { WebShellWithProviders } = await import(/* @vite-ignore */ indexEntry);

const params = new URLSearchParams(window.location.search);
const emptyMobileWelcome = params.get('emptyMobileWelcome') === 'true';
const includeWelcomeFooter = params.get('welcomeFooter') !== 'false';
const includeCustomFooter = params.get('customFooter') === 'true';
const sessionId = params.get('sessionId') ?? 'composer-layout-e2e';
const tags = Array.from({ length: 18 }, (_, index) => ({
  id: `table-${index + 1}`,
  label: 'Table',
  value: `analytics_table_${index + 1}`,
}));
const sessionProps = emptyMobileWelcome
  ? {
      mobileWelcomeFooterMiddle: true,
      renderWelcomeHeader: () => (
        <div data-e2e-mobile-welcome-header>Welcome header</div>
      ),
      ...(includeWelcomeFooter
        ? {
            renderWelcomeFooter: () => (
              <div data-e2e-mobile-welcome-footer>Welcome footer</div>
            ),
          }
        : {}),
      ...(includeCustomFooter
        ? {
            renderFooter: () => <div data-e2e-custom-footer>Custom footer</div>,
            bottomStatusItems: [
              { id: 'composer-layout-status', label: 'Bottom status item' },
            ],
          }
        : {}),
    }
  : { sessionId };

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WebShellWithProviders
      baseUrl={window.location.origin}
      sidebar={false}
      composerInput={{ tags, tagPlacement: 'top' }}
      composerInputVersion={1}
      renderComposerTagTooltip={({ tag }) => `Details for ${tag.value}`}
      {...sessionProps}
    />
  </React.StrictMode>,
);
