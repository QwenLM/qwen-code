import type { ScenarioConfig } from '../scenario-runner.js';

const base = {
  terminal: {
    cols: 112,
    rows: 40,
    theme: 'github-dark',
    title: 'qwen-code skill review',
    cwd: '../../..',
  },
  gif: false,
} satisfies Pick<ScenarioConfig, 'terminal' | 'gif'>;

const harness = [
  'npx',
  'tsx',
  'integration-tests/terminal-capture/skill-review-harness/text-capture.tsx',
];

export default [
  {
    ...base,
    name: 'skill-review-before-global-qwen',
    spawn: [...harness, 'before'],
    flow: [
      {
        sleep: 7000,
        capture: 'before-global-qwen.png',
        captureFull: 'before-global-qwen-full.png',
      },
    ],
  },
  {
    ...base,
    name: 'skill-review-after-preview',
    spawn: [...harness, 'after-preview'],
    flow: [
      {
        sleep: 7000,
        capture: 'after-preview.png',
        captureFull: 'after-preview-full.png',
      },
    ],
  },
  {
    ...base,
    name: 'skill-review-after-second',
    spawn: [...harness, 'after-second'],
    flow: [
      {
        sleep: 7000,
        capture: 'after-second.png',
        captureFull: 'after-second-full.png',
      },
    ],
  },
  {
    ...base,
    name: 'skill-review-after-turn-off',
    spawn: [...harness, 'after-turn-off'],
    flow: [
      {
        sleep: 7000,
        capture: 'after-turn-off.png',
        captureFull: 'after-turn-off-full.png',
      },
    ],
  },
] satisfies ScenarioConfig[];
