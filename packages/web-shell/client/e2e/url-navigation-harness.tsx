import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/standalone.css';
import { WebShellWithProviders } from '../index';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WebShellWithProviders
      urlNavigation={{ basePath: '/agentic-code' }}
      sidebar={{ enabled: true, footer: { items: ['settings'] } }}
      language="en-US"
    />
  </React.StrictMode>,
);
