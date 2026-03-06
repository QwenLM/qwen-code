import type { ScenarioConfig } from '../scenario-runner.js';

export default {
  name: '/qc:code-review',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: { title: 'qwen-code', cwd: '../../..' },
  flow: [
    {
      type: '/qc:code-review 2117',
      streaming: {
        delayMs: 10000, // Wait for initial model thinking/approval
        intervalMs: 800, // Capture every 800ms
        count: 30, // Max 30 captures
        gif: true, // Generate animated GIF
      },
    },
  ],
} satisfies ScenarioConfig;
