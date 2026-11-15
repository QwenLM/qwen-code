import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/standalone.css';
import { WebShellWithProviders } from '../index';

const mode = new URLSearchParams(location.search).get('sidebar');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WebShellWithProviders
      urlNavigation={{ basePath: '/agentic-code' }}
      sidebar={
        mode === 'hidden'
          ? false
          : mode === 'omitted'
            ? undefined
            : mode === 'default'
              ? { enabled: true }
              : {
                  enabled: true,
                  primaryNav: {
                    items: ['plugins', 'channels', 'scheduledTasks', 'goals'],
                  },
                  footer: { items: ['settings'] },
                }
      }
      language="en-US"
    />
  </React.StrictMode>,
);
