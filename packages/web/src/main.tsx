import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getWebDaemonConfig } from './config/daemon';
import { DaemonProviders } from './providers/DaemonProviders';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

createRoot(root).render(
  <React.StrictMode>
    <DaemonProviders config={getWebDaemonConfig()}>
      <App />
    </DaemonProviders>
  </React.StrictMode>,
);
