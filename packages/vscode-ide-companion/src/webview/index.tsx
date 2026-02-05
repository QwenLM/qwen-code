/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { VSCodePlatformProvider } from './context/VSCodePlatformProvider.js';

// Import webui shared styles (CSS variables, component styles)
import '@qwen-code/webui/styles.css';

// VSCode-specific: Tailwind utilities + theme variables
import './styles/tailwind.css';
import './styles/App.css';

const container = document.getElementById('root');
if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(
    <VSCodePlatformProvider>
      <App />
    </VSCodePlatformProvider>,
  );
}
