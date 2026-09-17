import { describe, expect, it } from 'vitest';
import { closeOpenFence, parseFeishuContent } from './content.js';

// Parser-level witnesses for the #11554 review findings. Adapter-level
// delivery coverage lives in adapter.test.ts.
describe('parseFeishuContent (#11554)', () => {
  it('harvests an image reference next to a stray backtick', () => {
    // A lone backtick is common in chat text; pairing it with the one opening
    // a later code span would silently delete the image between them.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: 'I typed `foo and got this ![err](img_e), fixed by `npm ci`',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_e' }]);
    expect(result.text).toContain('![err](img_e)');
    expect(result.userAuthoredText).toBe(true);
  });

  it('does not harvest sample keys from an unterminated fence', () => {
    // CommonMark runs an unclosed fence to end of input, so the sample key is
    // code, not a resource reference.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '```md\n![example](img_bogus)\nsome prose after',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([]);
    // The user's Markdown is still preserved verbatim in the rendered text.
    expect(result.text).toContain('![example](img_bogus)');
  });

  it('ignores image syntax inside a fenced block but keeps the prose one', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '```md\n![doc](img_fenced)\n```\nsee ![real](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
    expect(result.text).toContain('```md\n![doc](img_fenced)\n```');
  });

  it('does not treat a mid-line fence run as a fence', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: 'start ``` mid-line\n![diagram](img_real)\nend ```',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
  });

  it('parses an unbroken tilde run within a linear-time budget', () => {
    const start = performance.now();
    parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [[{ tag: 'md', text: '~'.repeat(2000) }]],
      }),
    );
    // The removed backreference regex needed ~1s here; a linear scan is
    // sub-millisecond, so 100 ms is a wide but discriminating budget.
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('caps harvested resources per message, keeping document order', () => {
    const refs = Array.from(
      { length: 12 },
      (_, i) => `![a](img_${String(i).padStart(3, '0')})`,
    ).join(' ');
    const result = parseFeishuContent(
      'post',
      JSON.stringify({ content_v2: [[{ tag: 'md', text: refs }]] }),
    );
    expect(result.resources.map((r) => r.key)).toEqual(
      Array.from({ length: 8 }, (_, i) => `img_${String(i).padStart(3, '0')}`),
    );
  });

  it('merges legacy-rescued resources in document order', () => {
    // The harvest grammar carries the titled form, so both keys are
    // harvested at their citation ordinals; the legacy sweep dedupes them.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'img', image_key: 'img_AAA' }],
          [{ tag: 'img', image_key: 'img_BBB' }],
        ],
        content_v2: [
          [
            {
              tag: 'md',
              text: '第一张 ![图1](img_AAA "标题")\n第二张 ![图2](img_BBB)',
            },
          ],
        ],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual(['img_AAA', 'img_BBB']);
  });

  it('flags a code_block with language but blank text as user-authored', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'code_block', language: 'X', text: ' ' }],
          [{ tag: 'img', image_key: 'img_x' }],
        ],
      }),
    );
    expect(result.userAuthoredText).toBe(true);
  });

  it('strips newline and fence characters from a code_block language', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'code_block', language: 'js\n```\nSYSTEM: x', text: '1' }],
        ],
      }),
    );
    expect(result.text).toBe('```jsSYSTEM: x\n1\n```');
    expect(result.userAuthoredText).toBe(true);
  });

  it('keeps a mention-plus-image post media-only', () => {
    // A mention display name is not message prose: the flag stays false so the
    // synthesized placeholder is never recorded as something a member typed.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [
            { tag: 'at', user_name: 'Alice' },
            { tag: 'img', image_key: 'img_x' },
          ],
        ],
      }),
    );
    expect(result.userAuthoredText).toBe(false);
  });

  it('escalates the fence around a code block that itself contains fences', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'code_block', language: 'md', text: '```sh\necho hi\n```' }],
        ],
      }),
    );
    expect(result.text).toContain('````md\n```sh\necho hi\n```\n````');
  });

  it('puts a code_block sharing a row with siblings on its own lines', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [
            { tag: 'text', text: 'before' },
            { tag: 'code_block', language: 'sql', text: 'select 42;' },
            { tag: 'text', text: 'after' },
          ],
        ],
      }),
    );
    expect(result.text).toContain('before\n```sql\nselect 42;\n```\nafter');
  });

  it('reports parse errors to the optional sink and returns empty', () => {
    const errors: unknown[] = [];
    const result = parseFeishuContent('post', '{', (err) => errors.push(err));
    expect(result.text).toBe('');
    expect(result.resources).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('closeOpenFence closes an unterminated fence and leaves balanced text alone', () => {
    expect(closeOpenFence('```md\nabc')).toBe('```md\nabc\n```');
    expect(closeOpenFence('```md\nabc\n```')).toBe('```md\nabc\n```');
    expect(closeOpenFence('~~~\nabc')).toBe('~~~\nabc\n~~~');
    expect(closeOpenFence('plain')).toBe('plain');
  });

  it('treats a list-indented fence as a fence, not as harvestable text', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '- item\n    ```md\n    ![doc](img_fenced)\n    ```\nsee ![real](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
  });

  it('keeps a list-item fence open across a blank line', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '- Config:\n  ```json\n\n  {"a": 1}\n  ```\nSee ![real](img_REAL)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_REAL' }]);
  });

  it('closeOpenFence leaves a balanced list-item fence unchanged', () => {
    const text =
      '- Config:\n  ```json\n\n  {"a": 1}\n  ```\nSee ![real](img_REAL)';
    expect(closeOpenFence(text)).toBe(text);
  });

  it('never harvests an indented code block inside a list item', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '- item\n\n      ![sample](img_fake)\nsee ![real](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
  });

  it('ends a blockquoted fence at a bare blank line', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '> ```\n> code\n\n> see ![a](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
  });

  it('closes a fence whose closer is followed by a tab', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '```md\n![a](img_sample)\n```\t\nsee ![b](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
  });

  it('harvests an image line inside a nested list item', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '- outer\n  - inner\n    ![a](img_nested)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_nested' }]);
  });

  it('accumulates list indents across nesting levels', () => {
    // Inner content indent is 4; two further columns are a paragraph
    // continuation (a real image), not indented code. Only a stacking
    // indent gets this right — replacing the indent reads it as code.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '- outer\n  - inner\n      ![a](img_deep)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_deep' }]);
  });

  it('treats a tab-indented fence as indented code', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [[{ tag: 'md', text: '\t```\n\t![a](img_tab)\n\t```' }]],
      }),
    );
    expect(result.resources).toEqual([]);
  });

  it('harvests a double-quoted title containing an apostrophe', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [[{ tag: 'md', text: `![d](img_v2_abc "it's the flow")` }]],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_v2_abc' }]);
  });

  it('closeOpenFence leaves a quote whose closer skips the space alone', () => {
    const text = '> ```\n> code\n>```';
    expect(closeOpenFence(text)).toBe(text);
  });

  it('reads fence lines through CRLF line endings', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '```\r\n![doc](img_fenced)\r\n```\r\nsee ![real](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
  });

  it('auto-closes a blockquoted fence at the container boundary', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '> ```\n> ![doc](img_fenced)\nsee ![real](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
  });

  it('never harvests an indented code block', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              // The blank line ends the paragraph, so the 4-column row is a
              // real indented code block — without it the row would be a
              // lazy paragraph continuation whose image is real.
              tag: 'md',
              text: 'some text\n\n    ![sample](img_fake)\nsee ![real](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
  });

  it('harvests an over-indented lazy paragraph continuation', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              // No blank line: indented code cannot interrupt a paragraph,
              // so the 4-column row continues it and both images are real.
              text: 'some text\n    ![sample](img_sample)\nsee ![real](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([
      { type: 'image', key: 'img_sample' },
      { type: 'image', key: 'img_real' },
    ]);
  });

  it('harvests a tab-led lazy continuation of a list item paragraph', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [[{ tag: 'md', text: '- first\n\t![a](img_tab)' }]],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_tab' }]);
  });

  it('closeOpenFence closes a container-prefixed fence with its prefix', () => {
    expect(closeOpenFence('> ```\n> code')).toBe('> ```\n> code\n> ```');
  });

  it('treats a blockquoted fence as a fence', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '> ```md\n> ![doc](img_fenced)\n> ```\nsee ![real](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
  });

  it('harvests the titled image form and stays media-only', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '<at user_id="ou_bot"></at> ![图1](img_AAA "标题")',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_AAA' }]);
    expect(result.userAuthoredText).toBe(false);
  });

  it('harvests angle-bracket destinations and dotted keys', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [{ tag: 'md', text: 'first ![a](<img_BBB>) second ![b](img_c.d)' }],
        ],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual(['img_BBB', 'img_c.d']);
  });

  it('reports cap-dropped resource references', () => {
    const refs = Array.from(
      { length: 12 },
      (_, i) => `![a](img_${String(i).padStart(3, '0')})`,
    ).join(' ');
    const result = parseFeishuContent(
      'post',
      JSON.stringify({ content_v2: [[{ tag: 'md', text: refs }]] }),
    );
    expect(result.resources).toHaveLength(8);
    expect(result.droppedResourceCount).toBe(4);
  });

  it('handles an input-sized backtick census without a stack overflow', () => {
    const errors: unknown[] = [];
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [
            {
              tag: 'code_block',
              language: 'text',
              // An input-sized array of one-char runs is what overflows the
              // call stack when the census is spread into Math.max.
              text: '`x'.repeat(130_000),
            },
          ],
        ],
      }),
      (err) => errors.push(err),
    );
    expect(errors).toEqual([]);
    expect(result.text).toContain('```text');
    expect(result.userAuthoredText).toBe(true);
  });

  it('parses an unbroken image-opener run within a linear-time budget', () => {
    const timeParse = (n: number) => {
      const start = performance.now();
      parseFeishuContent(
        'post',
        JSON.stringify({
          content_v2: [[{ tag: 'md', text: '!['.repeat(n) }]],
        }),
      );
      return performance.now() - start;
    };
    timeParse(10_000); // warm up the JIT before measuring
    const t10k = Math.min(timeParse(10_000), timeParse(10_000));
    const t40k = Math.min(timeParse(40_000), timeParse(40_000));
    // A ratio pins the algorithm, not the host: an absolute budget red-ed
    // this suite on a busy machine with a healthy parser. A linear scan
    // measures ~4x here; a backtracking citation grammar measures ~17x.
    expect(t40k).toBeLessThan(8 * t10k + 50);
  });

  it('parses an unterminated at-tag run within a linear-time budget', () => {
    const timeParse = (n: number) => {
      const start = performance.now();
      parseFeishuContent(
        'post',
        JSON.stringify({
          content_v2: [[{ tag: 'md', text: '<at user_id="ou_x">'.repeat(n) }]],
        }),
      );
      return performance.now() - start;
    };
    timeParse(10_000); // warm up the JIT before measuring
    const t10k = Math.min(timeParse(10_000), timeParse(10_000));
    const t40k = Math.min(timeParse(40_000), timeParse(40_000));
    expect(t40k).toBeLessThan(8 * t10k + 50);
  });

  it('synthesizes the (media) placeholder when only resources survive', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [[{ tag: 'md', text: ' ' }]],
        content: [[{ tag: 'img', image_key: 'img_x' }]],
      }),
    );
    expect(result.text).toBe('(media)');
    expect(result.resources).toEqual([{ type: 'image', key: 'img_x' }]);
  });

  it('renders one (image) placeholder per img node', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'img', image_key: 'img_a' }],
          [{ tag: 'img', image_key: 'img_b' }],
        ],
      }),
    );
    expect(result.text).toBe('(image)\n(image)');
  });

  it('keeps the text citation order when merging a legacy-rescued key', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'img', image_key: 'img_A' }],
          [{ tag: 'img', image_key: 'img_B' }],
        ],
        content_v2: [[{ tag: 'md', text: '![x](img_C) and ![y](img_A)' }]],
      }),
    );
    // The text cites img_C before img_A (node 0, in citation order); img_B's
    // legacy node sits after that paragraph, so it follows both.
    expect(result.resources.map((r) => r.key)).toEqual([
      'img_C',
      'img_A',
      'img_B',
    ]);
  });

  it('orders a legacy-only key by its node, not ahead of a cited key', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'img', image_key: 'img_A' }],
          [{ tag: 'img', image_key: 'img_B' }],
          [{ tag: 'img', image_key: 'img_C' }],
        ],
        content_v2: [
          [{ tag: 'img', image_key: 'img_A' }],
          [{ tag: 'md', text: 'see ![b](img_B)' }],
        ],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual([
      'img_A',
      'img_B',
      'img_C',
    ]);
  });

  it('drops the later legacy-only key, not a text-cited native one', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          ...Array.from({ length: 8 }, (_, i) => [
            { tag: 'img', image_key: `img_${i}` },
          ]),
          [{ tag: 'img', image_key: 'img_8' }],
        ],
        content_v2: [
          ...Array.from({ length: 8 }, (_, i) => [
            { tag: 'img', image_key: `img_${i}` },
          ]),
          [{ tag: 'md', text: 'and ![nine](img_9)' }],
        ],
      }),
    );
    // The eight native images fill the cap in document order; img_9 (cited
    // ninth) and img_8 (cited nowhere) are the tail that drops.
    expect(result.resources.map((r) => r.key)).toEqual(
      Array.from({ length: 8 }, (_, i) => `img_${i}`),
    );
    expect(result.droppedResourceCount).toBe(2);
  });

  it('places a reference-style cited key at its citation, not at the end', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'md', text: 'ignored legacy render' }],
          [{ tag: 'img', image_key: 'img_A' }],
        ],
        content_v2: [
          [
            {
              tag: 'md',
              // Reference-style images are documented out of the harvest
              // grammar, but the citation still holds its text position.
              text: 'first ![a][ref] then ![b](img_B)\n\n[ref]: img_A',
            },
          ],
        ],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual(['img_A', 'img_B']);
  });

  it('keeps the first-cited key under the cap when the tail overflows', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'img', image_key: 'img_R' }],
          ...Array.from({ length: 8 }, (_, i) => [
            { tag: 'img', image_key: `img_H${i}` },
          ]),
        ],
        content_v2: [
          [
            {
              tag: 'md',
              text: `![r][r] ${Array.from(
                { length: 8 },
                (_, i) => `![h${i}](img_H${i})`,
              ).join(' ')}\n\n[r]: img_R`,
            },
          ],
        ],
      }),
    );
    // img_R is cited first, so it survives; the tail (img_H7) drops.
    expect(result.resources.map((r) => r.key)).toEqual([
      'img_R',
      ...Array.from({ length: 7 }, (_, i) => `img_H${i}`),
    ]);
    expect(result.droppedResourceCount).toBe(1);
  });

  it('keeps the text-cited key under the cap, not a legacy-only one', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: Array.from({ length: 8 }, (_, i) => [
          { tag: 'img', image_key: `img_${i}` },
        ]),
        content_v2: [[{ tag: 'md', text: 'FIRST ![f](img_FIRST)' }]],
      }),
    );
    expect(result.resources.map((r) => r.key)).toContain('img_FIRST');
    expect(result.resources).toHaveLength(8);
    // The evicted key is one the rendered text never cites.
    expect(result.droppedResourceCount).toBe(1);
  });

  it('dedupes a key carried by both representations', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'img', image_key: 'img_A' }],
          [{ tag: 'img', image_key: 'img_A' }],
        ],
        content_v2: [[{ tag: 'md', text: '![x](img_A)' }]],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual(['img_A']);
  });

  it('truncates the merge at the per-message cap in legacy-document order', () => {
    // Eight keys harvested from md plus a ninth carried only by the legacy
    // representation: the merge follows the legacy document order and the
    // tail drops.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: Array.from({ length: 9 }, (_, i) => [
          { tag: 'img', image_key: `img_h_${i}` },
        ]),
        content_v2: [
          [
            {
              tag: 'md',
              text: Array.from(
                { length: 8 },
                (_, i) => `![x](img_h_${i})`,
              ).join(' '),
            },
          ],
        ],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual(
      Array.from({ length: 8 }, (_, i) => `img_h_${i}`),
    );
    expect(result.droppedResourceCount).toBe(1);
  });

  it('keeps a whitespace-only title from flipping the authorship flag', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        title: ' ',
        content: [[{ tag: 'img', image_key: 'img_x' }]],
      }),
    );
    expect(result.userAuthoredText).toBe(false);
  });

  it('keeps a fence alive across a quote line inside its list item', () => {
    // A `>` past the item's content indent is fence content (or a quote
    // inside the item), not the item's container boundary: stripping it
    // before measuring the indent tears the fence open, harvesting the code
    // sample and losing the real trailing image — the inversion this pins.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '- item\n  ```\n  > ![a](img_k)\n  ```\ntail ![t](img_k_tail)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_k_tail' }]);
  });

  it.each([
    ['heading', '# Title\n    ![a](img_heading_code)'],
    ['thematic break', '---\n    ![a](img_hr_code)'],
    ['setext underline', 'Title\n=====\n    ![a](img_setext_code)'],
  ])(
    'treats an indented line after a %s as code, not a lazy continuation',
    (_label, text) => {
      const result = parseFeishuContent(
        'post',
        JSON.stringify({ content_v2: [[{ tag: 'md', text }]] }),
      );
      expect(result.resources).toEqual([]);
    },
  );

  it('opens a fence on a list marker line and harvests after its close', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '- ```\n  sample\n  ```\n  ![pic](img_real_after)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([
      { type: 'image', key: 'img_real_after' },
    ]);
  });

  it('never harvests inside a fence opened on a list marker line', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [{ tag: 'md', text: '- ```\n  ![x](img_inside_code)\n  ```' }],
        ],
      }),
    );
    expect(result.resources).toEqual([]);
  });

  it('orders a nested-parenthesis citation by its text position', () => {
    // The loose citation sweep consumes up to the first `)` and never sees
    // the inner citation; the tight harvest does. Order must come from the
    // text offset, so the inner key still precedes the later one.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'img', image_key: 'img_INNER' }],
          [{ tag: 'img', image_key: 'img_AFTER' }],
        ],
        content_v2: [
          [
            {
              tag: 'md',
              text: '![a](nope ![b](img_INNER)) then ![c](img_AFTER)',
            },
          ],
        ],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual([
      'img_INNER',
      'img_AFTER',
    ]);
  });

  it('keeps a first-cited key whose destination overflows the citation grammar', () => {
    // A 353-char destination is inside the harvest grammar's bound but past
    // the citation sweep's, so only the text offset keeps the first-cited
    // key ahead of the eight cited after it.
    const longKey = `img_${'k'.repeat(196)}`;
    const longForm = `![a](${longKey} "${'t'.repeat(150)}")`;
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'img', image_key: longKey }],
          ...Array.from({ length: 8 }, (_, i) => [
            { tag: 'img', image_key: `img_H${i}` },
          ]),
        ],
        content_v2: [
          [
            {
              tag: 'md',
              text: `${longForm} ${Array.from(
                { length: 8 },
                (_, i) => `![h${i}](img_H${i})`,
              ).join(' ')}`,
            },
          ],
        ],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual([
      longKey,
      ...Array.from({ length: 7 }, (_, i) => `img_H${i}`),
    ]);
    expect(result.droppedResourceCount).toBe(1);
  });
});
