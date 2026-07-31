import type { ScenarioConfig } from '../scenario-runner.js';

/**
 * Demonstrates streaming shell execution output with PTY enabled by default.
 * Tests the render throttle behavior and progress bar handling.
 * Captures multiple screenshots during execution to show real-time output.
 */
export default {
  name: 'streaming-shell',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: { title: 'qwen-code', cwd: '../../..' },
  flow: [
    {
      type: 'Run this command: bash integration-tests/terminal-capture/scenarios/progress.sh',
      // Capture 20 screenshots at 500ms intervals during execution
      // The progress.sh script takes ~10 seconds (20 iterations * 0.5s each)
      streaming: {
        delayMs: 7000,
        intervalMs: 500,
        count: 20,
      },
    },
  ],
} satisfies ScenarioConfig;
