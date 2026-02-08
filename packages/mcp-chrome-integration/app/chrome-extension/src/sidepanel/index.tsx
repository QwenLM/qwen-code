/**
 * Side Panel Entry Point
 */

import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import '@qwen-code/webui/styles.css';
import './styles/tailwind.css';
import './styles/App.css';
import './styles/styles.css';

function injectExtensionUri(): void {
  try {
    const extensionUri = chrome.runtime.getURL('');
    document.body?.setAttribute('data-extension-uri', extensionUri);
    window.__EXTENSION_URI__ = extensionUri;
  } catch (error) {
    console.warn('[SidePanel] Failed to inject extension URI:', error);
  }
}

const container = document.getElementById('root');
if (container) {
  injectExtensionUri();
  const root = ReactDOM.createRoot(container);
  root.render(<App />);
}
