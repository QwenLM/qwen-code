import type { ScenarioConfig } from '../scenario-runner.js';

/**
 * Streaming capture for /qc:bugfix command on GitHub issue #2833.
 * This scenario runs a long-running bugfix workflow with screenshots every 30 seconds
 * to capture the full evolution of the debugging process.
 */
export default {
  name: 'streaming-bugfix-2833',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: { title: 'qwen-code', cwd: '../../..' },
  flow: [
    {
      type: '/qc:bugfix https://github.com/QwenLM/qwen-code/issues/2833',
      // Bugfix workflow is long-running (20+ minutes), capture throughout
      streaming: {
        delayMs: 10000, // Wait 10s for initial prompt processing
        intervalMs: 30000, // Capture every 30 seconds
        count: 50, // Up to 25 minutes of capture (50 * 30s)
        gif: true, // Generate animated GIF
      },
    },
  ],
} satisfies ScenarioConfig;
