import type { ScenarioConfig } from '../scenario-runner.js';

/**
 * Demonstrates streaming capture with the /insight command.
 * The insight command analyzes the codebase and streams results,
 * making it ideal for demonstrating streaming capture.
 */
export default {
  name: 'streaming-insight',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: { title: 'qwen-code', cwd: '../../..' },
  flow: [
    {
      type: '/insight',
      // /insight takes time to analyze the codebase and streams results
      // Capture frames during the analysis to show real-time progress
      streaming: {
        intervalMs: 5000, // Capture every 5 seconds
        count: 50, // Up to 250 seconds of capture
      },
    },
  ],
} satisfies ScenarioConfig;
