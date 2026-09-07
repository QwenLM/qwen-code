import { describe, expect, it } from 'vitest';
import { parseWebPreviewUrl, webPreviewDocument } from './web-preview';

describe('web preview URLs', () => {
  const parse = (value: string) =>
    parseWebPreviewUrl(value, 'https://shell.example', 'http://localhost:4170');

  it('preserves the development route, search, and fragment', () => {
    expect(
      parse(' http://localhost:3000/settings?theme=dark#card ')?.href,
    ).toBe('http://localhost:3000/settings?theme=dark#card');
    expect(parse('https://preview.example/app')?.origin).toBe(
      'https://preview.example',
    );
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/index.html',
    '/relative',
    'localhost:3000',
    'https://user:password@preview.example',
    'https://shell.example/path',
    'http://shell.example/path',
    'http://localhost:4170/path',
    'http://[::1]:3000',
    'http://*.example',
    "http://example;script-src'unsafe-inline'",
  ])('rejects unsafe or unsupported URL %s', (value) => {
    expect(parse(value)).toBeUndefined();
  });

  it('rejects a non-default-port HTTPS upgrade into the daemon', () => {
    expect(
      parseWebPreviewUrl(
        'http://daemon.example:4170',
        'https://shell.example',
        'https://daemon.example:4170',
      ),
    ).toBeUndefined();
  });

  it('pins the child origin before loading escaped application markup', () => {
    const document = webPreviewDocument(
      new URL('https://preview.example/?a=1&b=2'),
      'Preview "app" <script>',
    );
    expect(document).toContain('frame-src https://preview.example;');
    expect(document).toContain("script-src 'none'");
    expect(document).toContain('src="https://preview.example/?a=1&amp;b=2"');
    expect(document).toContain('Preview &quot;app&quot; &lt;script&gt;');
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(
      document.indexOf('<iframe'),
    );
    expect(document).not.toContain('allow-top-navigation');
    expect(document).not.toContain('<script>');
  });
});
