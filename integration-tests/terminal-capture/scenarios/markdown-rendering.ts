import type { ScenarioConfig } from '../scenario-runner.js';

const markdownPrompt = `Output a compact Markdown rendering verification sample with exactly:

1. A mermaid flowchart fenced code block with a branch and a loop.
2. A mermaid sequenceDiagram fenced code block.
3. A markdown table with two rows.
4. Inline math $x = \\\\frac{-b \\\\pm \\\\sqrt{b^2 - 4ac}}{2a}$.
5. One display math block using $$ fences.
6. One checked and one unchecked task list item.

Do not explain the sample.`;

export default {
  name: 'markdown-rendering',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: {
    title: 'qwen-code markdown rendering',
    cwd: '../../..',
    cols: 140,
    rows: 42,
  },
  flow: [
    {
      type: markdownPrompt,
      streaming: {
        delayMs: 3000,
        intervalMs: 1000,
        count: 15,
      },
      capture: 'markdown-rendered.png',
      captureFull: 'markdown-rendered-full.png',
    },
    {
      key: '\x1bm',
      capture: 'markdown-raw-toggle.png',
      captureFull: 'markdown-raw-toggle-full.png',
    },
    {
      type: '/copy mermaid 1',
      capture: 'copy-mermaid-source.png',
    },
    {
      type: '/copy latex 1',
      capture: 'copy-latex-source.png',
    },
  ],
} satisfies ScenarioConfig;
