/**
 * Side Panel Entry Point
 */

import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import './styles/tailwind.css';
import './styles/App.css';
import './styles/styles.css';

const container = document.getElementById('root');
if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(<App />);
}
