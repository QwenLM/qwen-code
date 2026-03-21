import type { ScenarioConfig } from '../scenario-runner.js';

export default {
  name: 'pr-2371-review',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: { title: 'qwen-code', cwd: '../../..' },
  flow: [
    {
      type: '/review https://github.com/QwenLM/qwen-code/pull/2371',
      streaming: {
        delayMs: 5000,
        intervalMs: 10000, // Every 10s
        count: 60, // 10 minutes total (60 * 10s)
        gif: true,
      },
    },
  ],
} satisfies ScenarioConfig;
