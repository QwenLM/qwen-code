import type { ScenarioConfig } from '../scenario-runner.js';

export default {
  name: '/hooks command',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: { title: 'qwen-code', cwd: '../../..' },
  flow: [{ type: 'hi' }, { type: '/hooks' }],
} satisfies ScenarioConfig;
