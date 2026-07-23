import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/standalone.css';

const indexEntry = '../index.tsx';
const { WebShellWithProviders } = await import(/* @vite-ignore */ indexEntry);

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId') ?? 'composer-layout-e2e';
const tags = Array.from({ length: 18 }, (_, index) => ({
  id: `table-${index + 1}`,
  label: 'Table',
  value: `analytics_table_${index + 1}`,
}));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WebShellWithProviders
      baseUrl={window.location.origin}
      sessionId={sessionId}
      sidebar={false}
      composerInput={{ tags, tagPlacement: 'top' }}
      composerInputVersion={1}
      renderComposerTagTooltip={({ tag }) => `Details for ${tag.value}`}
    />
  </React.StrictMode>,
);
