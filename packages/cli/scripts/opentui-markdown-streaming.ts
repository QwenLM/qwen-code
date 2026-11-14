/**
 * Streaming markdown stability: feed a reply into one OpenTUI markdown
 * renderable a few characters at a time and fail if a delta repaints rows
 * that were already on screen with different text. This is the incremental
 * path where 0.5.10's inline preview flipped each updated block before the
 * tree-sitter pass (see src/ui/opentui/stable-markdown.ts).
 *
 * Run: bun packages/cli/scripts/opentui-markdown-streaming.ts
 */
import { SyntaxStyle } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { getComponentCatalogue } from '@opentui/react';
import remend from 'remend';
import { StableMarkdownRenderable } from '../src/ui/opentui/stable-markdown.js';

const TEXT = [
  '## 分析步驟',
  '',
  '先看 **std::any_cast<std::string>** 的行為，參考 [expr.add] 與 `[temp.deduct.call/1]`。',
  '大約 ~3,000 次呼叫，*某些* 會失敗，見 https://en.cppreference.com/w/cpp/utility/any 與 www.example.com。',
  '',
  'Let me fetch:',
  '- https://x.dev/a',
  '- https://x.dev/b **重要**',
  '',
  '> 引用 `std::vector<int>` 與 [temp.deduct.call/1]',
  '',
  '接著寫一段 `code` 與 __底線__ 說明，然後 ~~刪除~~ 一些內容。',
  '',
].join('\n');
const STEP = 4;

// The app renders `<markdown>`, so fail when the `extend` registration
// stops pointing at the subclass even though the class itself still works.
if (getComponentCatalogue()['markdown'] !== StableMarkdownRenderable) {
  console.error(
    'MARKDOWN STREAMING FAIL: <markdown> is not StableMarkdownRenderable',
  );
  process.exit(1);
}
const setup = await createTestRenderer({ width: 70, height: 40 });
const markdown = new StableMarkdownRenderable(setup.renderer, {
  content: '',
  syntaxStyle: SyntaxStyle.create(),
  streaming: true,
});
setup.renderer.root.add(markdown);

async function settle(): Promise<string> {
  let previous = '';
  let stable = 0;
  for (let attempt = 0; attempt < 60 && stable < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    await setup.renderOnce();
    await setup.flush();
    const current = setup.captureCharFrame();
    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }
  return previous;
}

const rows = (frame: string) => frame.split('\n').map((row) => row.trimEnd());
const failures: string[] = [];
let settled: string[] = [];
for (let end = STEP; end < TEXT.length + STEP; end += STEP) {
  markdown.content = remend(TEXT.slice(0, end), { linkMode: 'text-only' });
  await setup.renderOnce();
  const immediate = rows(setup.captureCharFrame());
  const lastRow = immediate.findLastIndex((row) => row.length > 0);
  // Rows above the growing tail must not change; the tail row may extend.
  for (let row = 0; row < lastRow; row++) {
    if (settled[row] && settled[row] !== immediate[row]) {
      failures.push(
        `at ${end} chars, row ${row}\n  was: ${settled[row]}\n  now: ${immediate[row]}`,
      );
      break;
    }
  }
  settled = rows(await settle());
}
setup.renderer.destroy();

if (failures.length > 0) {
  console.error(`MARKDOWN STREAMING FAIL: ${failures.length} repaint(s)`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('MARKDOWN STREAMING PASS: no settled row repainted mid-stream');
process.exit(0);
