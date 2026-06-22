import type { ScenarioConfig } from '../scenario-runner.js';

/**
 * Tests the message component refactoring for PR #2120.
 * Captures info, warning, and error messages to verify proper icon/prefix display.
 *
 * This scenario tests:
 * - Info message prefix (● filled circle)
 * - Error message prefix (✕)
 * - User message prefix (>)
 * - Assistant message prefix (✦)
 */
export default {
  name: 'message-components',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: { title: 'qwen-code', cwd: '../../..' },
  flow: [
    // Test info message via /skills command (instant, no streaming)
    { type: '/skills' },
    // Test error message via unknown skill (instant, no streaming)
    { type: '/skills nonexistent-skill-xyz' },
    // Test user and assistant messages (streams from LLM)
    {
      type: 'Say "Hello, this is a test of message prefixes!" and nothing else.',
      streaming: {
        delayMs: 3000,
        intervalMs: 1000,
        count: 10,
      },
    },
  ],
} satisfies ScenarioConfig;
