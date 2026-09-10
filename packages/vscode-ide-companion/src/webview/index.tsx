/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import ReactDOM from 'react-dom/client';
import { EmbeddedApp } from './EmbeddedApp.js';
import { initializeWebviewLogger } from './hooks/useVSCode.js';

initializeWebviewLogger();

const container = document.getElementById('root');
if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(<EmbeddedApp />);
}
