/**
 * Streaming/settled markdown parity: run the transcript's real content
 * pipeline through the real OpenTUI markdown renderable and compare the
 * visible frames. The unit suite can only compare the text handed to the
 * renderer; this pins the "same text while streaming and after settle"
 * claim that the PR is built on.
 *
 * Run: bun packages/cli/scripts/opentui-markdown-parity.ts
 */
import { MarkdownRenderable, SyntaxStyle } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { streamingMarkdownForRender } from '../src/ui/opentui/markdown-heal.js';

const CASES: Array<readonly [name: string, text: string]> = [
  ['heading', '## 同步結果\n\nbody'],
  ['bare url', 'see https://x.dev/a for docs'],
  ['partial url', 'see https://www.bb'],
  ['long url', 'see https://www.bbc.com/news/live/c6zjry11v8w1t'],
  [
    'list long url',
    '1. https://www.bbc.com/news/live/c6zjry11v8w1t (live updates — most current)',
  ],
  ['www/email', 'see www.example.com or a@b.co'],
  ['cpp template', 'std::any_cast<std::string>(&boxed)'],
  [
    'shortcut defined',
    'per [expr.add]: P is null\n\n[expr.add]: https://x.dev',
  ],
  ['task markers', '- [ ] rotate\n- [x] drain'],
  ['html tags', '<b>bold</b> <details>'],
  ['indented code', 'Example:\n\n    curl https://x.dev/a'],
  // OpenTUI 0.5.10's preview still folds a multi-line inline code span to one
  // row and mis-renders a fence nested in a list; both differ from settle for
  // reasons outside this mask, so they are not pinned as URL-parity cases.
  ['three blank lines', 'p1\n\n\np2'],
  ['table cell url', '| a | b |\n| --- | --- |\n| https://x.dev | x |'],
  ['emphasis url', '**run https://x.dev**'],
  ['ftp url', 'see ftp://ftp.gnu.org/gnu/emacs'],
  ['tilde approximations', '~3,000, ~3,300, ~3,600'],
  ['tilde near dollars', '- Fuel: Q4 ~$92 (+12%), ~20% of cost'],
  ['strikethrough', '~~strike~~'],
  ['list definition', '- [expr.add]: https://x.dev'],
  ['reference link', '[ref][1]'],
  ['non-ascii label', 'see [图1]'],
];

const syntaxStyle = SyntaxStyle.create();

async function frame(content: string, streaming: boolean): Promise<string[]> {
  const setup = await createTestRenderer({ width: 72, height: 30 });
  const markdown = new MarkdownRenderable(setup.renderer, {
    content,
    syntaxStyle,
    streaming,
  });
  setup.renderer.root.add(markdown);
  await setup.renderOnce();
  // The streaming arm must be read on the first paint: waiting lets the
  // async tree-sitter pass replace the preview and hides preview mismatches.
  if (streaming) {
    const preview = setup.captureCharFrame();
    setup.renderer.destroy();
    return preview.split('\n').map((line) => line.trimEnd());
  }
  await setup.flush();
  // The settled arm paints in stages: a blank preview frame, then the code
  // block, then the paragraph above it. Poll until the captured frame has
  // been stable for two consecutive checks instead of sleeping a fixed
  // interval; this is the renderer's settle signal and does not capture the
  // intermediate one-block frame.
  let previous = '';
  let stable = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await setup.renderOnce();
    await setup.flush();
    const current = setup.captureCharFrame();
    if (current.trim().length > 0 && current === previous) {
      stable += 1;
    } else {
      stable = 0;
    }
    previous = current;
    if (stable >= 2) break;
  }
  const text = setup.captureCharFrame();
  setup.renderer.destroy();
  return text.split('\n').map((line) => line.trimEnd());
}

async function main() {
  let failures = 0;
  for (const [name, text] of CASES) {
    const live = await frame(streamingMarkdownForRender(text, true), true);
    const settled = await frame(streamingMarkdownForRender(text, false), false);
    const mismatch: number[] = [];
    for (
      let index = 0;
      index < Math.max(live.length, settled.length);
      index++
    ) {
      if ((live[index] ?? '') !== (settled[index] ?? '')) mismatch.push(index);
    }
    if (mismatch.length === 0) {
      console.log(`PASS ${name}`);
      continue;
    }
    failures += 1;
    console.log(`FAIL ${name} rows=${mismatch.join(',')}`);
    for (const row of mismatch.slice(0, 3)) {
      console.log(`  live[${row}]=${JSON.stringify(live[row] ?? '')}`);
      console.log(`  set [${row}]=${JSON.stringify(settled[row] ?? '')}`);
    }
  }
  console.log(
    failures === 0
      ? 'MARKDOWN PARITY PASS'
      : `MARKDOWN PARITY FAIL (${failures}/${CASES.length})`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
