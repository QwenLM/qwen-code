/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import ReactDOM from 'react-dom/client';
import { App } from './App.js';

// eslint-disable-next-line import/no-internal-modules
import './styles/tailwind.css';
// eslint-disable-next-line import/no-internal-modules
import './styles/App.css';
// eslint-disable-next-line import/no-internal-modules
import './styles/styles.css';

const container = document.getElementById('root');
if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(<App />);
}
