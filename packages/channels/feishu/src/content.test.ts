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
      Array.from(
        { length: 8 },
        (_, i) => `img_${String(i).padStart(3, '0')}`,
      ),
    );
  });

  it('merges legacy-rescued resources in document order', () => {
    // The titled form `![图1](img_AAA "标题")` is outside the harvest grammar,
    // so only the legacy sweep recovers it — at its document position, not
    // appended after the v2 hits.
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
          [{ tag: 'at', user_name: 'Alice' }, { tag: 'img', image_key: 'img_x' }],
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
});
