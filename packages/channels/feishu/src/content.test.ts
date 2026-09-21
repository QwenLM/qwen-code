import { describe, expect, it, vi } from 'vitest';
import MarkdownIt from 'markdown-it';
import { fenceFor, parseFeishuContent } from './content.js';

// Parser-level witnesses for the #11554 review findings. Adapter-level
// delivery coverage lives in adapter.test.ts.
describe('parseFeishuContent (#11554)', () => {
  it('reads a backtick pair around an image reference as a code span', () => {
    // CommonMark pairs the two single-backtick runs into one code span, so
    // the reference between them renders as code, not as an image. An image
    // the platform attached regardless still arrives through the legacy
    // `content` mirror (see the rescue case below).
    const md = 'I typed `foo and got this ![err](img_e), fixed by `npm ci`';
    const result = parseFeishuContent(
      'post',
      JSON.stringify({ content_v2: [[{ tag: 'md', text: md }]] }),
    );
    expect(result.resources).toEqual([]);
    expect(result.text).toContain('![err](img_e)');
    expect(result.userAuthoredText).toBe(true);
    const rescued = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [[{ tag: 'img', image_key: 'img_e' }]],
        content_v2: [[{ tag: 'md', text: md }]],
      }),
    );
    expect(rescued.resources).toEqual([{ type: 'image', key: 'img_e' }]);
  });

  it('reads a mid-line backtick run as a code span, not a block fence', () => {
    // Neither run starts a line, so neither opens a fence — but the two
    // three-backtick runs still pair into a code span across the lines
    // between them, and the reference inside it is code.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: 'start ``` mid-line\n![diagram](img_code)\nend ```\n\n![real](img_real)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_real' }]);
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

  it('harvests from a paragraph that only looks like a fence opener', () => {
    // '```use `kubectl get pods`' is a paragraph per CommonMark — a backtick
    // fence's info string cannot contain a backtick — so no fence opens and
    // both references below it render as images.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '```use `kubectl get pods`\n![a](img_111)\n![b](img_222)',
            },
          ],
        ],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual(['img_111', 'img_222']);
    expect(result.droppedResourceCount).toBe(0);
    expect(result.text).toContain('kubectl get pods');
  });

  it('harvests nothing from a node whose list marker is followed by a tab', () => {
    // '-\t```js' is a list item holding indented code per CommonMark (the
    // tab advances to a 4-column stop), so the image is code, not a
    // reference.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [{ tag: 'md', text: '-\t```js\n\t![alt](img_bbb)\n\t```\n' }],
        ],
      }),
    );
    expect(result.resources).toEqual([]);
  });

  it.each(['<pre>\n![a](img_pre)\n</pre>', '<div>\n![a](img_div)\n</div>'])(
    'harvests nothing from a node with an HTML block start: %s',
    (text) => {
      const result = parseFeishuContent(
        'post',
        JSON.stringify({ content_v2: [[{ tag: 'md', text }]] }),
      );
      expect(result.resources).toEqual([]);
    },
  );

  it('still harvests when a line starts with the platform at-tag', () => {
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [
          [
            {
              tag: 'md',
              text: '<at user_id="ou_a">Alice</at> look ![x](img_at)',
            },
          ],
        ],
      }),
    );
    expect(result.resources).toEqual([{ type: 'image', key: 'img_at' }]);
  });

  it('sizes a fence past the longest backtick run it has to outlast', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('a ``` b')).toBe('````');
    expect(fenceFor('~~~~~~ only tildes')).toBe('```');
    // Runs a bracket peel would join count as one: '[`]``' is three.
    expect(fenceFor('[`]``')).toBe('````');
    expect(fenceFor('`[[]]`[x]`')).toBe('```');
    expect(fenceFor('``[`][`]')).toBe('`````');
    // Input-sized census: spreading the runs into Math.max overflows the
    // call stack at this size.
    expect(fenceFor('`x'.repeat(130_000))).toBe('```');
  });

  it('counts distinct keys, not citations, against the cap', () => {
    const refs = Array.from({ length: 9 }, (_, i) => `![a](img_${i})`);
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        // Twelve citations of nine distinct keys: one key is over the cap.
        content_v2: [
          [{ tag: 'md', text: [...refs, ...refs.slice(0, 3)].join(' ') }],
        ],
      }),
    );
    expect(result.resources).toHaveLength(8);
    expect(result.droppedResourceCount).toBe(1);
  });

  it.each([
    ['a tab after the list marker', '-\tpoint\n\n![early](img_early)'],
    ['a space after the list marker', '- point\n\n![early](img_early)'],
    ['an HTML block before it', '<div>pasted</div>\n\n![early](img_early)'],
  ])('keeps the first-cited key under the cap beside %s', (_label, md) => {
    // One formatting character must not decide which image survives: the
    // text cites img_early first in every arm, so it is the legacy tail
    // (img_l7) that drops.
    const natives = Array.from({ length: 8 }, (_, i) => [
      { tag: 'img', image_key: `img_l${i}` },
    ]);
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [[{ tag: 'img', image_key: 'img_early' }], ...natives],
        content_v2: [[{ tag: 'md', text: md }], ...natives],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual([
      'img_early',
      ...Array.from({ length: 7 }, (_, i) => `img_l${i}`),
    ]);
    expect(result.droppedResourceCount).toBe(1);
  });

  it('sorts a key only the legacy mirror names after every key content_v2 yields', () => {
    // Inside an HTML block the reference is raw HTML, not an image, so
    // content_v2 gives img_raw no position; the legacy mirror still says the
    // post carries it, and it joins after the keys that have one.
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content: [
          [{ tag: 'img', image_key: 'img_raw' }],
          [{ tag: 'img', image_key: 'img_b' }],
        ],
        content_v2: [
          [
            {
              tag: 'md',
              text: '<div>\n![raw](img_raw)\n</div>\n\n![b](img_b)',
            },
          ],
        ],
      }),
    );
    expect(result.resources.map((r) => r.key)).toEqual(['img_b', 'img_raw']);
  });

  it('judges a media-only md node the way it judges the legacy img node', () => {
    const md = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [[{ tag: 'md', text: '![photo](img_only)' }]],
      }),
    );
    const legacy = parseFeishuContent(
      'post',
      JSON.stringify({ content: [[{ tag: 'img', image_key: 'img_only' }]] }),
    );
    for (const result of [md, legacy]) {
      expect(result.userAuthoredText).toBe(false);
      expect(result.synthesizedText).toBe(true);
      expect(result.resources).toEqual([{ type: 'image', key: 'img_only' }]);
    }
  });

  it.each([
    ['prose', 'see ![p](img_a)', true, false],
    ['a remote image', '![p](https://example.com/a.png)', true, false],
    ['a code span', '`x` ![p](img_a)', true, false],
    ['a fenced block', '```\ncode\n```\n![p](img_a)', true, false],
    ['a link with no text', '[](https://example.com) ![p](img_a)', true, false],
    ['a thematic break', '---\n\n![p](img_a)', false, false],
    [
      'a named mention',
      '<at user_id="ou_a">Alice</at> ![p](img_a)',
      false,
      false,
    ],
    ['a bare mention', '<at user_id="ou_a"></at> ![p](img_a)', false, true],
    ['image alt text alone', '![a long alt text](img_a)', false, true],
    // An opener that never closes names nobody: what follows is prose.
    [
      'an unclosed mention tag',
      '<at user_id="ou_a"> hello ![p](img_a)',
      true,
      false,
    ],
    // A second opener ends the first one unclosed: its text was prose.
    [
      'an unclosed mention ahead of a closed one',
      '<at user_id="ou_a">hello <at user_id="ou_b">B</at> ![p](img_a)',
      true,
      false,
    ],
    ['a raw HTML block', '<div>note</div>\n\n![p](img_a)', true, false],
    // The mention grammar is the platform's: lower-case tag, a user_id, a
    // name of bounded length. Anything else between angle brackets is text
    // the member typed.
    ['a tag with no user_id', '<at>typed prose</at> ![p](img_a)', true, false],
    [
      'an upper-case tag',
      '<AT user_id="ou_a">typed prose</AT> ![p](img_a)',
      true,
      false,
    ],
    [
      'a paragraph passed off as a display name',
      `<at user_id="ou_a">${'long prose '.repeat(19)}</at> ![p](img_a)`,
      true,
      false,
    ],
    [
      'a display name at the length bound',
      `<at user_id="ou_a">${'n'.repeat(200)}</at> ![p](img_a)`,
      false,
      false,
    ],
    // A display name holds no tag-opening character.
    [
      'a name holding a <',
      '<at user_id="ou_a">a < b</at> ![p](img_a)',
      true,
      false,
    ],
    [
      'a closing tag in the wrong case',
      '<at user_id="ou_a">typed prose</AT> ![p](img_a)',
      true,
      false,
    ],
    [
      'an opener whose user_id outgrows the grammar',
      `<at user_id="${'x'.repeat(201)}">N</at> ![p](img_a)`,
      true,
      false,
    ],
    // One level short of where the parser stops descending: nothing was
    // dropped, so a media-only node is still read as media-only.
    [
      'an image nested just inside the parser limit',
      `${'> '.repeat(18)}![p](img_a)`,
      false,
      true,
    ],
    ['an indented code block', '    code sample\n\n![p](img_a)', true, false],
    [
      'a fence that carries only an info string',
      '```mermaid\n```\n![p](img_a)',
      true,
      false,
    ],
    ['a closing mention tag with no opener', '</at> ![p](img_a)', true, false],
    [
      'two mentions and nothing else',
      '<at user_id="ou_a">A</at><at user_id="ou_b">B</at> ![p](img_a)',
      false,
      false,
    ],
  ])(
    'reads authorship of an md node carrying %s from the same parse',
    (_label, text, authored, synthesized) => {
      const result = parseFeishuContent(
        'post',
        JSON.stringify({ content_v2: [[{ tag: 'md', text }]] }),
      );
      expect(result.userAuthoredText).toBe(authored);
      expect(result.synthesizedText).toBe(synthesized);
    },
  );

  it('bounds the text handed to the Markdown parser', () => {
    const filler = 'word '.repeat(20_000); // exactly the 100_000-char bound
    const result = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [[{ tag: 'md', text: `${filler}![late](img_late)` }]],
      }),
    );
    // Past the bound nothing is parsed, so nothing is harvested — and the
    // unparsed remainder still counts as something the member typed.
    expect(result.resources).toEqual([]);
    expect(result.userAuthoredText).toBe(true);
    const onlyTail = parseFeishuContent(
      'post',
      JSON.stringify({
        content_v2: [[{ tag: 'md', text: `${' '.repeat(100_000)}tail` }]],
      }),
    );
    expect(onlyTail.userAuthoredText).toBe(true);
    expect(onlyTail.synthesizedText).toBe(false);
  });

  describe('commandText', () => {
    const post = (body: unknown) =>
      parseFeishuContent('post', JSON.stringify(body));

    it('renders a row without the media node between a command and its args', () => {
      const result = post({
        content: [
          [
            { tag: 'text', text: '/approve ' },
            { tag: 'img', image_key: 'img_x' },
            { tag: 'text', text: 'group_req' },
          ],
        ],
      });
      expect(result.text).toBe('/approve (image)group_req');
      expect(result.commandText).toBe('/approve group_req');
    });

    it('renders a run of media nodes in one row as nothing', () => {
      const result = post({
        content: [
          [
            { tag: 'img', image_key: 'img_a' },
            { tag: 'media', file_key: 'file_b' },
          ],
          [{ tag: 'text', text: '/approve' }],
        ],
      });
      expect(result.text).toBe('(image)(video)\n/approve');
      expect(result.commandText).toBe('/approve');
    });

    it('never rewrites text the member typed that only looks like a placeholder', () => {
      const result = post({
        content: [
          [{ tag: 'text', text: '/btw why (image) here (file: a.pdf)' }],
        ],
      });
      expect(result.commandText).toBe('/btw why (image) here (file: a.pdf)');
    });

    it('offers the legacy rendering beside it when the two read differently', () => {
      // A command after a Markdown image is a command in the legacy rendering
      // only — the rows the classifier read before content_v2 was rendered.
      const result = post({
        content: [
          [{ tag: 'img', image_key: 'img_x' }],
          [{ tag: 'text', text: '/approve req' }],
        ],
        content_v2: [[{ tag: 'md', text: '![shot](img_x)\n/approve req' }]],
      });
      expect(result.text).toBe('![shot](img_x)\n/approve req');
      expect(result.commandText).toBe('![shot](img_x)\n/approve req');
      expect(result.legacyCommandText).toBe('/approve req');
    });

    it('keeps a Markdown mention tag in the rendering that can resolve it', () => {
      // The legacy rows spell the mention as a display name no mention key
      // resolves, so the command is one in the content_v2 rendering only.
      const result = post({
        content: [
          [
            { tag: 'at', user_id: '@_user_1', user_name: 'Bot' },
            { tag: 'text', text: ' /btw why?' },
          ],
        ],
        content_v2: [
          [{ tag: 'md', text: '<at user_id="ou_bot"></at> /btw why?' }],
        ],
      });
      expect(result.commandText).toBe('<at user_id="ou_bot"></at> /btw why?');
      expect(result.legacyCommandText).toBe('@Bot /btw why?');
    });

    it('keeps the title in the legacy rendering, as the classifier always read it', () => {
      // A titled post never was a command: the title is its first line. With
      // the title dropped from the legacy rendering alone, '/clear' would be
      // offered first and dispatched.
      const titled = post({
        title: 'Release notes',
        content: [[{ tag: 'text', text: '/clear' }]],
      });
      expect(titled.commandText).toBe('Release notes\n/clear');
      expect(titled.legacyCommandText).toBeUndefined();
      const withBlock = post({
        title: 'Release notes',
        content: [
          [{ tag: 'code_block', text: 'x' }],
          [{ tag: 'text', text: '/clear' }],
        ],
      });
      expect(withBlock.legacyCommandText).toBe('Release notes\n\n/clear');
    });

    it('offers no second rendering when the two read the same', () => {
      const rows = [[{ tag: 'text', text: '/help' }]];
      expect(
        post({ content: rows, content_v2: rows }).legacyCommandText,
      ).toBeUndefined();
      expect(post({ content: rows }).legacyCommandText).toBeUndefined();
    });

    it('renders a link as its label alone', () => {
      // The platform autolinks a URL typed as a command argument; the
      // command receives what the member typed, not Markdown. A link with no
      // label renders as nothing, so an href is never read as a command.
      const result = post({
        content: [
          [
            { tag: 'text', text: '/btw check ' },
            {
              tag: 'a',
              text: 'https://example.com/a',
              href: 'https://example.com/a',
            },
          ],
        ],
      });
      expect(result.text).toContain(
        '[https://example.com/a](https://example.com/a)',
      );
      expect(result.commandText).toBe('/btw check https://example.com/a');
      const bare = post({ content: [[{ tag: 'a', href: '/clear' }]] });
      expect(bare.text).toBe('[/clear](/clear)');
      expect(bare.commandText).toBe('');
      expect(bare.legacyCommandText).toBeUndefined();
    });

    it.each([
      [
        'a code block ahead of the command',
        [
          [{ tag: 'code_block', language: 'sh', text: 'ls' }],
          [{ tag: 'text', text: '/clear' }],
        ],
        '/clear',
      ],
      [
        'a rule ahead of the command',
        [[{ tag: 'hr' }], [{ tag: 'text', text: '/clear' }]],
        '/clear',
      ],
      [
        'a code block after the command',
        [
          [{ tag: 'text', text: '/approve req1' }],
          [{ tag: 'code_block', text: 'x' }],
        ],
        '/approve req1',
      ],
    ])(
      'reads the legacy rows as the classifier always did: %s',
      (_label, content, want) => {
        // Text, link labels and mention names only: every other node rendered
        // nothing before this parser existed, so none stands in or ahead of a
        // command the legacy rows spell.
        const result = post({ content });
        expect(result.legacyCommandText).toBe(want);
        expect(result.commandText).not.toBe(want);
      },
    );

    it('falls back to the content_v2 rows when there is no legacy mirror', () => {
      const result = post({
        title: 'T',
        content_v2: [
          [{ tag: 'img', image_key: 'img_x' }],
          [{ tag: 'md', text: '/help' }],
        ],
      });
      expect(result.commandText).toBe('T\n\n/help');
    });

    it.each([
      ['text', { text: '/clear' }, '/clear'],
      ['image', { image_key: 'img_a' }, ''],
      ['file', { file_key: 'f', file_name: '/approve' }, ''],
      ['audio', { file_key: 'f' }, ''],
      ['media', { file_key: 'f' }, ''],
      ['interactive', {}, ''],
    ])(
      'gives a %s message its placeholder-free command text',
      (type, body, want) => {
        expect(parseFeishuContent(type, JSON.stringify(body)).commandText).toBe(
          want,
        );
      },
    );
  });

  describe('md harvest follows the CommonMark parser', () => {
    const FENCE = '```';
    const oracle = new MarkdownIt('commonmark');
    const rendered = (md: string) =>
      [
        ...new Set(
          [
            ...oracle.render(md).matchAll(/<img src="(img_[A-Za-z0-9_.:-]+)"/g),
          ].map((match) => match[1]!),
        ),
      ].sort();
    const harvested = (md: string) =>
      parseFeishuContent(
        'post',
        JSON.stringify({ content_v2: [[{ tag: 'md', text: md }]] }),
      )
        .resources.map((r) => r.key)
        .sort();

    it('harvests exactly the images the parser renders, across container shapes', () => {
      const leads = [
        '',
        'para\n',
        'para\n\n',
        '- item\n',
        '- item\n\n',
        '1. item\n\n',
        '> quote\n',
        '> quote\n\n',
        '# h\n',
        '---\n',
        '<div>\n',
        '<div>\n\n',
        '- a\n  - b\n\n',
      ];
      const indents = [
        '',
        ' ',
        '   ',
        '    ',
        '      ',
        '\t',
        ' \t',
        '> ',
        '>',
        ' > ',
        '- ',
        '-     ',
        '-\t',
        '- - ',
        '- > ',
        '> - ',
        '10. ',
      ];
      const wraps: Array<(image: string) => string> = [
        (image) => image,
        (image) => `${FENCE}\n${image}`,
        (image) => `${FENCE}\n${image}\n${FENCE}`,
        (image) => `~~~\n${image}\n~~~`,
        (image) => `${FENCE}js\`x\n${image}`,
        (image) => `\`${image}\``,
        (image) => `![r][ref]\n${image}\n\n[ref]: img_R`,
      ];
      const disagreements: string[] = [];
      let imagesRendered = 0;
      let shapes = 0;
      for (const lead of leads) {
        for (const indent of indents) {
          for (const wrap of wraps) {
            const block = wrap('![a](img_K)')
              .split('\n')
              .map((line) => indent + line)
              .join('\n');
            // A second image after the block, so every shape renders at
            // least one and the sweep's premise below can count both answers.
            const md = `${lead}${block}\n\ntail ![t](img_T)`;
            shapes += 1;
            const want = rendered(md);
            imagesRendered += want.length;
            if (JSON.stringify(harvested(md)) !== JSON.stringify(want)) {
              disagreements.push(JSON.stringify(md));
            }
          }
        }
      }
      expect(disagreements).toEqual([]);
      // The sweep is only a witness if it covers both answers: shapes where
      // img_K renders and shapes where it is code.
      expect(shapes).toBe(leads.length * indents.length * wraps.length);
      expect(imagesRendered).toBeGreaterThan(shapes);
      expect(imagesRendered).toBeLessThan(shapes * 2);
    });

    it.each([
      [
        'a loose list item paragraph',
        '- item\n\n    ![x](img_v2_REAL)',
        ['img_v2_REAL'],
      ],
      ['indented code inside a list item', '-     ![alt](img_v2_AAAA)', []],
      [
        'a fence opened under a nested list marker',
        `- - ${FENCE}\n    ![c](img_code)\n    ${FENCE}\n\n![r](img_real)`,
        ['img_real'],
      ],
      [
        'a blockquote right after a list item',
        `- item\n> ${FENCE}\n> ![a](img_code)\n> ${FENCE}\n\n![r](img_real)`,
        ['img_real'],
      ],
      [
        'an image inside a link',
        '[![a](img_in_link)](https://example.com)',
        ['img_in_link'],
      ],
      [
        'an image nested in alt text',
        '![outer ![inner](img_inner)](img_outer)',
        ['img_outer'],
      ],
      ['a raw HTML img tag', '<img src="img_html"> text', []],
      [
        'a destination that is not a bare key',
        '![a](img_a(b)) ![c](img_c?x=1)',
        [],
      ],
    ])('reads %s the way the parser renders it', (_label, md, want) => {
      expect(harvested(md)).toEqual([...want].sort());
      expect(
        rendered(md).filter((key) => /^img_[A-Za-z0-9_.:-]+$/.test(key)),
      ).toEqual(expect.arrayContaining([...want]));
    });

    it.each([
      ['an emphasis run', '*a'.repeat(40_000), true, false],
      ['an image-opener run', '!['.repeat(40_000), true, false],
      ['a bracket run', '['.repeat(80_000), true, false],
      // A line of nothing but backticks opens a fence with nothing in it.
      ['a backtick run', '`'.repeat(80_000), false, false],
      // Past the parser's nesting limit the inner text is dropped from the
      // token stream; it still counts as typed.
      ['a blockquote nest', `${'> '.repeat(40_000)}typed`, true, false],
      ['a list nest', `${'- '.repeat(40_000)}typed`, true, false],
      ['a nest one past the limit', `${'> '.repeat(21)}typed`, true, false],
      [
        'mention tags and nothing else',
        '<at user_id="ou_x">'.repeat(5_000),
        false,
        true,
      ],
    ])(
      'reads %s without failing the parse',
      (_label, text, authored, synthesized) => {
        // No timing here: a wall-clock bound certifies the host, not the
        // parser. What is pinned is that input-sized nesting neither throws
        // (a recursive parser overflows its stack on the nests) nor loses the
        // image that follows it within the analysis bound.
        const errors: unknown[] = [];
        const result = parseFeishuContent(
          'post',
          JSON.stringify({
            content_v2: [
              [{ tag: 'md', text: `![first](img_first)\n\n${text}` }],
            ],
          }),
          (err) => errors.push(err),
        );
        expect(errors).toEqual([]);
        expect(result.resources).toEqual([{ type: 'image', key: 'img_first' }]);
        expect(result.userAuthoredText).toBe(authored);
        expect(result.synthesizedText).toBe(synthesized);
      },
    );

    it('costs a node its harvest, not the message, when the parser throws', () => {
      const parse = vi
        .spyOn(MarkdownIt.prototype, 'parse')
        .mockImplementation(() => {
          throw new RangeError('Maximum call stack size exceeded');
        });
      const errors: unknown[] = [];
      try {
        const result = parseFeishuContent(
          'post',
          JSON.stringify({
            content: [[{ tag: 'img', image_key: 'img_mirror' }]],
            content_v2: [[{ tag: 'md', text: 'see ![a](img_md)' }]],
          }),
          (err) => errors.push(err),
        );
        // The text still arrives and counts as typed; the key the parser
        // would have read is gone, the mirror's is not.
        expect(result.text).toBe('see ![a](img_md)');
        expect(result.commandText).toBe('see ![a](img_md)');
        expect(result.userAuthoredText).toBe(true);
        expect(result.synthesizedText).toBe(false);
        expect(result.resources).toEqual([
          { type: 'image', key: 'img_mirror' },
        ]);
        expect(errors).toHaveLength(1);
      } finally {
        parse.mockRestore();
      }
    });
  });
});
