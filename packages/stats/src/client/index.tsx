import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
