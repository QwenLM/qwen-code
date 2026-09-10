// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { splitTextByUrls } from './linkify';

describe('splitTextByUrls', () => {
  it('returns a single text segment when there is no URL', () => {
    expect(splitTextByUrls('hello world')).toEqual([
      { type: 'text', value: 'hello world' },
    ]);
  });

  it('returns an empty array for empty text', () => {
    expect(splitTextByUrls('')).toEqual([]);
  });

  it('splits an https URL from surrounding text', () => {
    expect(splitTextByUrls('see https://example.com/docs please')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'url', value: 'https://example.com/docs' },
      { type: 'text', value: ' please' },
    ]);
  });

  it('matches http URLs', () => {
    expect(splitTextByUrls('http://example.com')).toEqual([
      { type: 'url', value: 'http://example.com' },
    ]);
  });

  it('does not match other schemes, bare domains, or emails', () => {
    for (const text of [
      'ftp://example.com/file',
      'www.example.com',
      'mail me at a@b.test',
    ]) {
      expect(splitTextByUrls(text)).toEqual([{ type: 'text', value: text }]);
    }
  });

  it.each([',', '.', '!', '?', ';', ':', "'"])(
    'trims trailing ASCII punctuation %s',
    (punct) => {
      const text = `go https://example.com/foo${punct} end`;
      expect(splitTextByUrls(text)).toEqual([
        { type: 'text', value: 'go ' },
        { type: 'url', value: 'https://example.com/foo' },
        { type: 'text', value: `${punct} end` },
      ]);
    },
  );

  // The allowlist excludes seven printable ASCII characters outright; these
  // cases pin the termination (not the trimmer) for every one of them.
  it.each(['"', '<', '>', '\\', '^', '`', '|'])(
    'terminates the match at markup delimiter %s',
    (d) => {
      const text = `go https://example.com/foo${d} end`;
      expect(splitTextByUrls(text)).toEqual([
        { type: 'text', value: 'go ' },
        { type: 'url', value: 'https://example.com/foo' },
        { type: 'text', value: `${d} end` },
      ]);
    },
  );

  it('keeps the angle-bracket autolink form out of the href', () => {
    expect(splitTextByUrls('<https://example.com/a>')).toEqual([
      { type: 'text', value: '<' },
      { type: 'url', value: 'https://example.com/a' },
      { type: 'text', value: '>' },
    ]);
  });

  it('needs no left boundary before the scheme', () => {
    expect(splitTextByUrls('xhttps://a.com')).toEqual([
      { type: 'text', value: 'x' },
      { type: 'url', value: 'https://a.com' },
    ]);
  });

  // Interior placement matters for the six that TRAILING_PUNCT also trims
  // (`: , ; ! * ~`): a trailing fixture for those would not discriminate the
  // character class. The other five are kept interior for a uniform fixture.
  it.each([':', ',', ';', '!', '*', '$', '+', '-', '%', '~', '@'])(
    'keeps %s inside the URL',
    (c) => {
      const url = `https://example.com/a${c}b`;
      expect(splitTextByUrls(url)).toEqual([{ type: 'url', value: url }]);
    },
  );

  it('keeps the port in a host:port authority', () => {
    expect(splitTextByUrls('https://ci.example.com:8443/job/1')).toEqual([
      { type: 'url', value: 'https://ci.example.com:8443/job/1' },
    ]);
  });

  it('trims a trailing tilde (GFM strikethrough delimiter)', () => {
    expect(splitTextByUrls('~~https://example.com~~')).toEqual([
      { type: 'text', value: '~~' },
      { type: 'url', value: 'https://example.com' },
      { type: 'text', value: '~~' },
    ]);
  });

  it('keeps an interior tilde', () => {
    expect(splitTextByUrls('https://example.com/~user')).toEqual([
      { type: 'url', value: 'https://example.com/~user' },
    ]);
  });

  it.each([']', '}'])('trims an unmatched trailing bracket %s', (closer) => {
    const text = `(see https://example.com/foo${closer}`;
    expect(splitTextByUrls(text)).toEqual([
      { type: 'text', value: '(see ' },
      { type: 'url', value: 'https://example.com/foo' },
      { type: 'text', value: closer },
    ]);
  });

  it.each([']', '}'])('keeps a balanced bracket pair %s in the URL', (c) => {
    const o = c === ']' ? '[' : '{';
    const url = `https://example.com/a${o}0${c}`;
    expect(splitTextByUrls(`${url} end`)).toEqual([
      { type: 'url', value: url },
      { type: 'text', value: ' end' },
    ]);
  });

  it('does not absorb CJK text written directly after the URL', () => {
    expect(splitTextByUrls('详情见https://example.com即可使用')).toEqual([
      { type: 'text', value: '详情见' },
      { type: 'url', value: 'https://example.com' },
      { type: 'text', value: '即可使用' },
    ]);
  });

  it('does not linkify a bare scheme', () => {
    for (const text of ['(https://)', 'https://.', 'https://，见下文']) {
      expect(splitTextByUrls(text)).toEqual([{ type: 'text', value: text }]);
    }
  });

  it('does not absorb an emoji written directly after the URL', () => {
    expect(splitTextByUrls('check https://example.com👍')).toEqual([
      { type: 'text', value: 'check ' },
      { type: 'url', value: 'https://example.com' },
      { type: 'text', value: '👍' },
    ]);
  });

  it('does not absorb Thai text written directly after the URL', () => {
    expect(splitTextByUrls('ดูhttps://example.comได้เลย')).toEqual([
      { type: 'text', value: 'ดู' },
      { type: 'url', value: 'https://example.com' },
      { type: 'text', value: 'ได้เลย' },
    ]);
  });

  it("keeps an apostrophe inside the URL (L'Aquila)", () => {
    const url = "https://en.wikipedia.org/wiki/L'Aquila";
    expect(splitTextByUrls(url)).toEqual([{ type: 'url', value: url }]);
  });

  it('trims markdown emphasis delimiters around the URL', () => {
    expect(splitTextByUrls('see **https://example.com/docs** then')).toEqual([
      { type: 'text', value: 'see **' },
      { type: 'url', value: 'https://example.com/docs' },
      { type: 'text', value: '** then' },
    ]);
    expect(splitTextByUrls('_https://example.com/a_ and more')).toEqual([
      { type: 'text', value: '_' },
      { type: 'url', value: 'https://example.com/a' },
      { type: 'text', value: '_ and more' },
    ]);
  });

  it.each(['。', '，', '；', '：', '！', '？', '、'])(
    'trims trailing CJK punctuation %s',
    (punct) => {
      const text = `看 https://example.com/foo${punct}下一句`;
      expect(splitTextByUrls(text)).toEqual([
        { type: 'text', value: '看 ' },
        { type: 'url', value: 'https://example.com/foo' },
        { type: 'text', value: `${punct}下一句` },
      ]);
    },
  );

  it('trims only the unmatched closer from a balanced-then-unmatched run', () => {
    expect(splitTextByUrls('(see https://x.com/a())')).toEqual([
      { type: 'text', value: '(see ' },
      { type: 'url', value: 'https://x.com/a()' },
      { type: 'text', value: ')' },
    ]);
  });

  it('keeps a balanced closing paren inside the URL', () => {
    expect(
      splitTextByUrls('https://en.wikipedia.org/wiki/Foo_(bar) done'),
    ).toEqual([
      { type: 'url', value: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { type: 'text', value: ' done' },
    ]);
  });

  it('trims an unmatched closing paren after the URL', () => {
    expect(splitTextByUrls('(see https://example.com/foo)')).toEqual([
      { type: 'text', value: '(see ' },
      { type: 'url', value: 'https://example.com/foo' },
      { type: 'text', value: ')' },
    ]);
  });

  it('handles a URL ending in punctuation at end of text', () => {
    expect(splitTextByUrls('链接是 https://example.com/foo。')).toEqual([
      { type: 'text', value: '链接是 ' },
      { type: 'url', value: 'https://example.com/foo' },
      { type: 'text', value: '。' },
    ]);
  });

  it('splits multiple URLs in one message', () => {
    expect(
      splitTextByUrls('a https://one.example b https://two.example/x c'),
    ).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'url', value: 'https://one.example' },
      { type: 'text', value: ' b ' },
      { type: 'url', value: 'https://two.example/x' },
      { type: 'text', value: ' c' },
    ]);
  });

  it('handles URLs at the start and end of text', () => {
    expect(splitTextByUrls('https://a.example mid https://b.example')).toEqual([
      { type: 'url', value: 'https://a.example' },
      { type: 'text', value: ' mid ' },
      { type: 'url', value: 'https://b.example' },
    ]);
  });

  it('preserves query strings and fragments', () => {
    const url = 'https://example.com/search?q=link&lang=zh#top';
    expect(splitTextByUrls(url)).toEqual([{ type: 'url', value: url }]);
  });
});
