import React from 'react';
import ReactDOM from 'react-dom/client';
import appStyles from '../App.module.css';
import '../styles/standalone.css';

const indexEntry = '../index.tsx';
const { WebShellWithProviders } = await import(/* @vite-ignore */ indexEntry);

const params = new URLSearchParams(window.location.search);
const emptyMobileWelcome = params.get('emptyMobileWelcome') === 'true';
const includeWelcomeFooter = params.get('welcomeFooter') !== 'false';
const includeCustomFooter = params.get('customFooter') === 'true';
const tallWelcome = params.get('tallWelcome') === 'true';
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
        <div data-e2e-mobile-welcome-header>
          {tallWelcome
            ? Array.from({ length: 16 }, (_, index) => (
                <div key={index} style={{ lineHeight: '24px' }}>
                  Welcome header line {index + 1}
                </div>
              ))
            : 'Welcome header'}
        </div>
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

Object.assign(window, {
  __hideEmptyMobileChat: () => {
    const composer = document.querySelector(
      '[data-web-shell-composer-surface]',
    );
    const chatPane = document.querySelector(
      '[data-testid="chat-pane-container"]',
    );
    const chatView = Array.from(chatPane?.children ?? []).find((child) =>
      child.contains(composer),
    );
    if (!(chatView instanceof HTMLElement)) {
      throw new Error('Expected the empty mobile chat view.');
    }
    chatView.classList.add(appStyles.chatViewHidden);
    chatView.setAttribute('aria-hidden', 'true');
  },
});
