// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import katex from 'katex';
import {
  getReplySelectionRange,
  getSelectedReplyContent,
} from './selectionClipboard';

const bodies: HTMLElement[] = [];
afterEach(() => {
  for (const body of bodies.splice(0)) body.remove();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});
function fixture(html: string) {
  const body = document.createElement('div');
  body.innerHTML = html;
  document.body.append(body);
  bodies.push(body);
  return body;
}
function select(
  body: HTMLElement,
  start: Node,
  startOffset: number,
  end = start,
  endOffset = start.textContent!.length,
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  return getSelectedReplyContent(body, range)!;
}

describe('selected reply clipboard content', () => {
  it('keeps images in selected Markdown and their descriptions in plain text', () => {
    const body = fixture(
      '<p>Before <img src="https://example.com/diagram.png" alt="diagram"> after.</p><ul><li><img src="https://example.com/item.png" alt="item"></li></ul>',
    );
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)).toEqual({
      text: 'Before diagram after.\nitem',
      markdown:
        'Before ![diagram](https://example.com/diagram.png) after.\n\n-   ![item](https://example.com/item.png)',
    });
  });
  it.each([false, true])(
    'copies one formula source for displayMode=%s',
    (displayMode) => {
      const formula = katex.renderToString('x^2 + 1', { displayMode });
      const body = fixture(
        displayMode
          ? `<p>Before</p>${formula}<p>After</p>`
          : `<p>Before ${formula} After</p>`,
      );
      const range = document.createRange();
      range.selectNodeContents(body);
      const result = getSelectedReplyContent(body, range)!;
      expect(result.text).toBe(
        displayMode ? 'Before\nx^2 + 1\nAfter' : 'Before x^2 + 1 After',
      );
      expect(result.markdown).toBe(
        displayMode
          ? 'Before\n\n$$\nx^2 + 1\n$$\n\nAfter'
          : 'Before $x^2 + 1$ After',
      );
    },
  );
  it('copies only the selected visible part of a formula', () => {
    const body = fixture(katex.renderToString('x^2 + 1'));
    const text = body.querySelector('.katex-html .mathnormal')!.firstChild!;
    expect(select(body, text, 0, text, 1)).toEqual({
      text: 'x',
      markdown: 'x',
    });
  });
  it('keeps partial bold ancestors and excludes adjacent repeated text', () => {
    const body = fixture('<p>Same <strong>Same bold text</strong> Same</p>');
    expect(
      select(body, body.querySelector('strong')!.firstChild!, 5, undefined, 9),
    ).toEqual({ text: 'bold', markdown: '**bold**' });
  });
  it('keeps partial heading, link and strikethrough formatting', () => {
    const body = fixture(
      '<h2>Heading</h2><p><a href="https://example.com">linked text</a> <del>removed</del></p>',
    );
    expect(
      select(body, body.querySelector('h2')!.firstChild!, 0, undefined, 4),
    ).toEqual({ text: 'Head', markdown: '## Head' });
    expect(
      select(body, body.querySelector('a')!.firstChild!, 2, undefined, 6)
        .markdown,
    ).toBe('[nked](https://example.com)');
    expect(
      select(body, body.querySelector('del')!.firstChild!, 0).markdown,
    ).toBe('~~removed~~');
  });
  it('does not escape numbered heading punctuation, including partial text', () => {
    const body = fixture('<h2>2. Skills <code>/feat-dev</code></h2>');
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)!.markdown).toBe(
      '## 2. Skills `/feat-dev`',
    );
    expect(
      select(body, body.querySelector('h2')!.firstChild!, 0, undefined, 5)
        .markdown,
    ).toBe('## 2. Sk');
  });
  it('keeps necessary paragraph and literal backslash escapes', () => {
    const body = fixture('<h3>2\\. Literal slash</h3><p>2. Ordinary text</p>');
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)!.markdown).toBe(
      '### 2\\\\. Literal slash\n\n2\\. Ordinary text',
    );
  });
  it('retains paragraph boundaries and list/quote structure', () => {
    const body = fixture(
      '<p>First paragraph</p><p>Second paragraph</p><blockquote><ol start="3"><li>Third</li><li>Fourth</li></ol></blockquote>',
    );
    const result = select(
      body,
      body.querySelector('p')!.firstChild!,
      6,
      body.querySelectorAll('li')[1].firstChild!,
      3,
    );
    expect(result.text).toBe('paragraph\nSecond paragraph\nThird\nFou');
    expect(result.markdown).toContain('paragraph\n\nSecond paragraph');
    expect(result.markdown).toMatch(/> 3\.\s+Third/);
    expect(result.markdown).toMatch(/> 4\.\s+Fou/);
    expect(result.markdown).not.toContain('Fourth');
  });
  it('keeps the original number when selecting a later ordered-list item', () => {
    const body = fixture(
      '<ol start="3"><li>Third</li><li>Fourth</li><li>Fifth</li></ol>',
    );
    const text = body.querySelectorAll('li')[1].firstChild!;
    expect(select(body, text, 0, text, 4).markdown).toMatch(/^4\.\s+Four$/);
  });
  it('ignores an empty boundary at the end of the preceding list item', () => {
    const body = fixture('<ol start="3"><li>Third</li><li>Fourth</li></ol>');
    const items = body.querySelectorAll('li');
    const result = select(
      body,
      items[0].firstChild!,
      5,
      items[1].firstChild!,
      6,
    );
    expect(result.markdown).toMatch(/^4\.\s+Fourth$/);
  });
  it('closes fences around a subset of code without copying surrounding lines', () => {
    const body = fixture(
      '<div data-selection-code-language="python"><pre><code>first\n  selected\nlast</code></pre></div>',
    );
    const text = body.querySelector('code')!.firstChild!;
    expect(select(body, text, 6, text, 16)).toEqual({
      text: '  selected',
      markdown: '```python\n  selected\n```',
    });
  });
  it('preserves code indentation/language and uses a safe fence for highlighted code', () => {
    const body = fixture(
      '<div data-selection-code-language="typescript"><div data-selection-copy-ignore>typescript<button>Copy</button></div><pre><code><span>  one</span>\n```\n  two\n</code></pre></div>',
    );
    const range = document.createRange();
    range.selectNodeContents(body);
    const result = getSelectedReplyContent(body, range)!;
    expect(result.text).toBe('  one\n```\n  two');
    expect(result.markdown).toBe('````typescript\n  one\n```\n  two\n````');
    expect(result.markdown).not.toContain('Copy');
  });
  it('copies selected table columns with empty unselected headers and escaped pipes', () => {
    const body = fixture(
      '<div data-selection-copy-ignore>2 rows Copy table</div><table><thead><tr><th data-selection-copy-ignore>Actions</th><th>Name</th><th>Value</th></tr></thead><tbody><tr><td data-selection-copy-ignore>+</td><td>Alpha</td><td>A|B</td></tr><tr><td data-selection-copy-ignore>+</td><td>Beta</td><td>C</td></tr></tbody></table>',
    );
    const cells = body.querySelectorAll(
      'tbody td:not([data-selection-copy-ignore])',
    );
    const result = select(
      body,
      cells[1].firstChild!,
      0,
      cells[2].firstChild!,
      4,
    );
    expect(result.markdown).toBe(
      '|  |  |\n| --- | --- |\n|  | A\\|B |\n| Beta |  |',
    );
    expect(result.text).toBe('A|B\nBeta');
    expect(result.markdown).not.toMatch(/Name|Value|Alpha|Copy|Actions/);
  });
  it('copies only visible table rows and omits controls', () => {
    const body = fixture(
      '<div data-selection-copy-ignore>2 rows</div><table><tr><th data-selection-copy-ignore>Actions</th><th>Name<button>Filter</button></th><th>Value</th><th aria-hidden="true"></th></tr><tr><td data-selection-copy-ignore>+</td><td>Alpha</td><td>42</td><td aria-hidden="true"></td></tr><tr><td data-selection-copy-ignore colspan="3">Hidden details</td></tr></table>',
    );
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)).toEqual({
      text: 'Name\tValue\nAlpha\t42',
      markdown: '| Name | Value |\n| --- | --- |\n| Alpha | 42 |',
    });
  });
  it('does not turn renderer wrappers and inter-block whitespace into data', () => {
    const body = fixture(
      '<ol>\n<li>First</li>\n<li>Second</li>\n</ol>\n<table><tr><td><div><div>Alpha</div></div></td><td><div>42</div></td></tr></table>',
    );
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)!.text).toBe(
      'First\nSecond\nAlpha\t42',
    );
  });
  it('preserves completed and incomplete tasks when selecting their visible text', () => {
    const body = fixture(
      '<ul><li><input type="checkbox" checked disabled> Done</li><li><input type="checkbox" disabled> Pending</li></ul>',
    );
    const items = body.querySelectorAll('li');
    const result = select(body, items[0].lastChild!, 1, items[1].lastChild!, 8);
    expect(result.text).toBe('Done\n Pending');
    expect(result.markdown).toMatch(/-\s+\[x\]\s+Done/);
    expect(result.markdown).toMatch(/-\s+\[ \]\s+Pending/);
    expect(select(body, items[1].lastChild!, 1, undefined, 5).markdown).toMatch(
      /-\s+\[ \]\s+Pend/,
    );
  });
  it('does not add task markers for empty selection boundaries', () => {
    const body = fixture(
      '<ul><li><input type="checkbox" checked disabled> Done</li><li><input type="checkbox" disabled> Pending</li><li><input type="checkbox" disabled> Later</li></ul>',
    );
    const items = body.querySelectorAll('li');
    for (const item of items) (item.lastChild as Text).splitText(1);
    const result = select(body, items[0].lastChild!, 4, items[2].lastChild!, 0);
    expect(result.text).toBe(' Pending');
    expect(result.markdown).toMatch(/^-\s+\[ \]\s+Pending$/);
  });
  it('rejects outside and empty ranges', () => {
    const body = fixture('<p>Inside</p>');
    const outside = fixture('Outside');
    const range = document.createRange();
    range.selectNodeContents(outside);
    expect(getSelectedReplyContent(body, range)).toBeNull();
    window.getSelection()!.addRange(range);
    expect(getReplySelectionRange(body)).toBeNull();
    window.getSelection()!.removeAllRanges();
    expect(getReplySelectionRange(body)).toBeNull();
  });
});

describe('nested selection boundaries', () => {
  it.each([
    [
      '<ol start="4"><li>Parent<ol><li>Sub one</li><li>Sub two</li></ol></li></ol>',
      'ol ol',
      '1.  Sub one\n2.  Sub two',
    ],
    [
      '<ul><li>Parent<ul><li>Child one</li></ul></li></ul>',
      'ul ul',
      '-   Child one',
    ],
    [
      '<ul><li><input type="checkbox" disabled checked>Parent<ul><li>Child one</li></ul></li></ul>',
      'ul ul',
      '-   Child one',
    ],
  ])('omits unselected ancestor markers in %s', (html, selector, expected) => {
    const body = fixture(html);
    const range = document.createRange();
    range.selectNodeContents(body.querySelector(selector)!);
    expect(getSelectedReplyContent(body, range)!.markdown).toBe(expected);
  });

  it('retains selected parent text and nested list structure', () => {
    const body = fixture(
      '<ul><li>Parent item<ul><li>Child one</li><li>Child two</li></ul></li></ul>',
    );
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)).toEqual({
      text: 'Parent item\nChild one\nChild two',
      markdown: '-   Parent item\n    -   Child one\n    -   Child two',
    });
  });

  it('separates inline content from following cell blocks', () => {
    const body = fixture(
      '<table><tbody><tr><td>42<div>sub</div></td></tr></tbody></table>',
    );
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)!.text).toBe('42 sub');
  });
});

describe('review regressions', () => {
  it.each(['checked', ''])('omits an unselected task state (%s)', (checked) => {
    const body = fixture(
      `<ul><li><p><input type="checkbox" ${checked} disabled> Task</p><p>Note</p></li></ul>`,
    );
    const note = body.querySelectorAll('p')[1].firstChild!;
    const result = select(body, note, 0);
    expect(result.text).toBe('Note');
    expect(result.markdown).not.toMatch(/\[[x ]\]/);
  });
  it('omits task state when a drag starts at the end of its task line', () => {
    const body = fixture(
      '<ul><li><p><input type="checkbox" checked disabled> Task</p><p>Note</p></li></ul>',
    );
    const paragraphs = body.querySelectorAll('p');
    const result = select(
      body,
      paragraphs[0].lastChild!,
      5,
      paragraphs[1].firstChild!,
      4,
    );
    expect(result.text).toBe('Note');
    expect(result.markdown).not.toMatch(/\[[x ]\]/);
  });
  it.each(['2', '0', '-2'])(
    'honors explicit list value %s and subsequent ordinals',
    (value) => {
      const body = fixture(
        `<ol><li value="${value}">First</li><li>Next</li></ol>`,
      );
      const range = document.createRange();
      range.selectNodeContents(body);
      expect(getSelectedReplyContent(body, range)!.markdown).toBe(
        `${value}.  First\n${Number(value) + 1}.  Next`,
      );
    },
  );
  it.each([
    [
      '<ul><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ul>',
      '-   Child\n-   Next',
    ],
    [
      '<ol><li>Parent<ol><li>Child</li></ol></li><li>Next</li></ol>',
      '1.  Child\n2.  Next',
    ],
    [
      '<ul><li>A<ul><li>B<ul><li>Child</li></ul></li></ul></li><li>Next</li></ul>',
      '-   Child\n-   Next',
    ],
  ])(
    'separates nested subsets from following siblings: %s',
    (html, markdown) => {
      const body = fixture(html);
      const items = body.querySelectorAll('li');
      const child = [...items].find((item) => item.textContent === 'Child')!;
      const next = items[items.length - 1];
      expect(select(body, child.firstChild!, 0, next.firstChild!, 4)).toEqual({
        text: 'Child\nNext',
        markdown,
      });
    },
  );
  it('retains ordered-list continuation indentation', () => {
    const body = fixture(
      '<ol start="3"><li>Parent<ol><li>Sub one</li><li>Sub two</li></ol></li></ol>',
    );
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)!.markdown).toBe(
      '3.  Parent\n    1.  Sub one\n    2.  Sub two',
    );
  });
  it('rejects a content-free selection touching a table boundary', () => {
    const body = fixture('<p>Before</p><table><tr><td>Cell</td></tr></table>');
    expect(
      select(
        body,
        body.querySelector('p')!.firstChild!,
        6,
        body.querySelector('td')!.firstChild!,
        0,
      ),
    ).toBeNull();
  });
  it('omits a body row touched only at its start boundary', () => {
    const body = fixture(
      '<p>Para</p><table><tr><th>A</th><th>B</th></tr><tr><td>Cell</td><td>Data</td></tr></table>',
    );
    expect(
      select(
        body,
        body.querySelector('p')!.firstChild!,
        0,
        body.querySelector('td')!.firstChild!,
        0,
      ),
    ).toEqual({
      text: 'Para\nA\tB',
      markdown: 'Para\n\n| A | B |\n| --- | --- |',
    });
  });
  it('omits a preceding row touched only at its end boundary', () => {
    const body = fixture(
      '<table><tr><td>First</td></tr><tr><td>Next</td></tr></table><p>After</p>',
    );
    expect(
      select(
        body,
        body.querySelector('td')!.firstChild!,
        5,
        body.querySelector('p')!.firstChild!,
        5,
      ),
    ).toEqual({
      text: 'Next\nAfter',
      markdown: '|  |\n| --- |\n| Next |\n\nAfter',
    });
  });
  it('rejects whitespace-only projections', () => {
    const body = fixture('<p>Hello world</p>');
    expect(
      select(body, body.querySelector('p')!.firstChild!, 5, undefined, 6),
    ).toBeNull();
  });
  it('keeps loose task state on the same line as its selected text', () => {
    const body = fixture(
      '<ul><li><p><input type="checkbox" checked disabled> Done</p></li><li><p><input type="checkbox" disabled> Pending</p></li></ul>',
    );
    const paragraphs = body.querySelectorAll('p');
    const result = select(
      body,
      paragraphs[0].lastChild!,
      1,
      paragraphs[1].lastChild!,
      8,
    );
    expect(result.markdown).toMatch(/-\s+\[x\][^\S\n]+Done/);
    expect(result.markdown).toMatch(/-\s+\[ \][^\S\n]+Pending/);
  });
  it.each([
    ['<td>Alpha</td><td></td><td>42</td>', 'Alpha\t\t42'],
    ['<td></td><td>42</td><td></td>', '\t42\t'],
  ])('retains selected empty table fields in %s', (cells, expected) => {
    const body = fixture(
      `<table><tr><th>Name</th><th>Value</th><th>Extra</th></tr><tr>${cells}</tr></table>`,
    );
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)!.text).toBe(
      `Name\tValue\tExtra\n${expected}`,
    );
  });
  it('keeps original ordinals across blank ordered-list items', () => {
    const body = fixture(
      '<ol start="3"><li>Third</li><li></li><li>Fifth</li></ol>',
    );
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)!.markdown).toMatch(
      /^5\.\s+Fifth$/m,
    );
  });
  it.each([
    [
      '<img src="https://example.com/diagram.png" alt="">',
      '![](https://example.com/diagram.png)',
    ],
    ['<hr>', '* * *'],
  ])('keeps Markdown-only selections: %s', (html, expected) => {
    const body = fixture(html);
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)).toEqual({
      text: '',
      markdown: expected,
    });
  });
  it.each([
    '<svg><text>Node A</text></svg>',
    '<span data-markdown-chart-loading="true">Rendering chart</span>',
    '<div class="markdown-chart-error">Chart render failed.</div>',
    '<a data-footnote-backref href="#internal">↩</a>',
    '<div class="markdown-chart-data-view" hidden><div class="markdown-chart-data-notice">Showing 2 of 900 rows.</div><table><tr><th>region</th></tr><tr><td>EMEA</td></tr></table></div>',
    '<div hidden>No data</div>',
  ])('excludes renderer chrome: %s', (html) => {
    const body = fixture(`<p>Before</p>${html}<p>After</p>`);
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)).toEqual({
      text: 'Before\nAfter',
      markdown: 'Before\n\nAfter',
    });
  });
  it('retains hard line breaks', () => {
    const body = fixture('<p>one<br>two</p>');
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)!.text).toBe('one\ntwo');
  });
  it('keeps visible chart data without the truncation notice', () => {
    const body = fixture(
      '<div class="markdown-chart-data-view"><div class="markdown-chart-data-notice">Showing 2 of 900 rows.</div><table><tr><th>region</th></tr><tr><td>EMEA</td></tr></table></div>',
    );
    const range = document.createRange();
    range.selectNodeContents(body);
    expect(getSelectedReplyContent(body, range)).toEqual({
      text: 'region\nEMEA',
      markdown: '| region |\n| --- |\n| EMEA |',
    });
  });
  it('rejects multiple disjoint ranges without affecting native selection', () => {
    const body = fixture('<p>First</p><p>Second</p>');
    const ranges = [...body.querySelectorAll('p')].map((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      return range;
    });
    vi.spyOn(document, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 2,
      getRangeAt: (index: number) => ranges[index],
    } as Selection);
    expect(getReplySelectionRange(body)).toBeNull();
  });
  it('uses composed ranges for a reply inside a ShadowRoot', () => {
    const host = fixture('');
    const shadow = host.attachShadow({ mode: 'open' });
    const body = document.createElement('div');
    body.textContent = 'Shadow reply';
    shadow.append(body);
    const outer = document.createRange();
    outer.selectNode(host);
    const composed = {
      startContainer: body.firstChild!,
      startOffset: 0,
      endContainer: body.firstChild!,
      endOffset: 6,
    };
    const composedRanges = vi.fn(() => [composed]);
    vi.spyOn(document, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => outer,
      getComposedRanges: composedRanges,
    } as unknown as Selection);
    expect(getReplySelectionRange(body)?.toString()).toBe('Shadow');
    expect(composedRanges).toHaveBeenCalledWith({ shadowRoots: [shadow] });
  });
});
