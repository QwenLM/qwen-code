import type { ScenarioConfig } from '../scenario-runner.js';

const prompt = String.raw`请只输出以下 7 行测试文本，不要解释，不要编号，不要使用代码块，也不要改变任何字符。尤其要原样保留所有美元符号和反斜杠：
$x^2$ is valid math
it costs $5 and $10
$5-$10
literal \$x$
formula $x + \$5$
literal then math: \$$x^2$
math then literal: $x^2\$$`;

export default {
  name: 'inline-math-escaped-dollar',
  spawn: ['node', 'dist/cli.js', '--yolo', '--model', 'qwen3.7-max-2026-06-08'],
  terminal: {
    title: 'qwen-code inline math',
    cwd: '../../..',
    cols: 120,
    rows: 32,
  },
  flow: [
    {
      type: prompt,
      capture: 'inline-math-escaped-dollar.png',
    },
    {
      sleep: 20000,
      capture: 'inline-math-escaped-dollar-settled.png',
    },
  ],
  gif: false,
} satisfies ScenarioConfig;
