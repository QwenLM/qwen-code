import type { ScenarioConfig } from '../scenario-runner.js';

/**
 * Demonstrates the /loop skill and cron scheduling tools.
 * Creates a recurring job, lists it, then clears all jobs.
 */
export default {
  name: 'cron-loop',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: { title: 'qwen-code', cwd: '../../..' },
  flow: [
    { type: 'hi' },
    { type: '/loop 1m say hi to me' },
    { type: '/loop list' },
    { type: '/loop clear' },
  ],
} satisfies ScenarioConfig;
