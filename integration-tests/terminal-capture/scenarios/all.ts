import type { ScenarioConfig } from '../scenario-runner.js';

export default [
  {
    name: '/about',
    spawn: ['node', 'dist/cli.js', '--yolo'],
    terminal: { title: 'qwen-code', cwd: '../../..' },
    flow: [
      { type: 'Hi, can you help me understand this codebase?' },
      { type: '/about' },
    ],
  },
  {
    name: '/context',
    spawn: ['node', 'dist/cli.js', '--yolo'],
    terminal: { title: 'qwen-code', cwd: '../../..' },
    flow: [
      { type: 'How do you understand this project?' },
      { type: '/context' },
    ],
  },

  {
    name: '/export (tab select)',
    spawn: ['node', 'dist/cli.js', '--yolo'],
    terminal: { title: 'qwen-code', cwd: '../../..' },
    flow: [
      { type: 'Please give me a brief introduction about yourself.' },
      { type: '/export' },
      { key: 'Tab' }, // Tab to open format selection
      { key: 'ArrowDown' }, // Down arrow to switch options
      { key: 'Enter' }, // Confirm selection
    ],
  },
  {
    name: '/auth',
    spawn: ['node', 'dist/cli.js', '--yolo'],
    terminal: { title: 'qwen-code', cwd: '../../..' },
    flow: [
      { type: '/auth' },
      { key: 'ArrowDown' }, // Select API Key
      { key: 'Enter' }, // Confirm
      { type: 'sk-test-key-123' },
    ],
  },
] satisfies ScenarioConfig[];
