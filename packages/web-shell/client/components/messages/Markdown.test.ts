/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { isSafeHref, isSafeImageSrc, sanitizeSvg } from './Markdown';

describe('isSafeHref', () => {
  it('allows https URLs', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
  });

  it('allows http URLs', () => {
    expect(isSafeHref('http://example.com')).toBe(true);
  });

  it('allows mailto URLs', () => {
    expect(isSafeHref('mailto:test@example.com')).toBe(true);
  });

  it('allows anchor links', () => {
    expect(isSafeHref('#section')).toBe(true);
  });

  it('allows relative paths', () => {
    expect(isSafeHref('/path/to/page')).toBe(true);
  });

  it('blocks protocol-relative URLs', () => {
    expect(isSafeHref('//evil.com')).toBe(false);
  });

  it('blocks javascript: scheme', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
  });

  it('blocks data: URIs', () => {
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('blocks vbscript: scheme', () => {
    expect(isSafeHref('vbscript:MsgBox("XSS")')).toBe(false);
  });

  it('returns false for empty/undefined', () => {
    expect(isSafeHref(undefined)).toBe(false);
    expect(isSafeHref('')).toBe(false);
    expect(isSafeHref('   ')).toBe(false);
  });

  it('handles whitespace-padded schemes', () => {
    expect(isSafeHref('  https://example.com')).toBe(true);
    expect(isSafeHref('  javascript:alert(1)')).toBe(false);
  });
});

describe('isSafeImageSrc', () => {
  it('allows https URLs', () => {
    expect(isSafeImageSrc('https://example.com/img.png')).toBe(true);
  });

  it('allows data:image/png base64', () => {
    expect(isSafeImageSrc('data:image/png;base64,iVBOR')).toBe(true);
  });

  it('allows data:image/jpeg base64', () => {
    expect(isSafeImageSrc('data:image/jpeg;base64,/9j')).toBe(true);
  });

  it('allows data:image/gif base64', () => {
    expect(isSafeImageSrc('data:image/gif;base64,R0lG')).toBe(true);
  });

  it('allows data:image/webp base64', () => {
    expect(isSafeImageSrc('data:image/webp;base64,UklG')).toBe(true);
  });

  it('blocks data:image/svg+xml (can load external resources)', () => {
    expect(isSafeImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
  });

  it('blocks data:text/html', () => {
    expect(isSafeImageSrc('data:text/html,<script>')).toBe(false);
  });

  it('blocks protocol-relative URLs', () => {
    expect(isSafeImageSrc('//evil.com/img.png')).toBe(false);
  });

  it('blocks javascript: scheme', () => {
    expect(isSafeImageSrc('javascript:alert(1)')).toBe(false);
  });

  it('allows relative paths', () => {
    expect(isSafeImageSrc('/images/logo.png')).toBe(true);
  });
});

describe('sanitizeSvg', () => {
  it('strips script elements', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('<script');
    expect(result).toContain('<rect');
  });

  it('strips foreignObject elements', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>XSS</div></foreignObject></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('foreignObject');
  });

  it('strips style elements', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>body{}</style><rect/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('<style');
  });

  it('strips image elements (external resource loading)', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.com/track"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('<image');
  });

  it('strips feImage elements', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><filter><feImage href="https://evil.com"/></filter></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('feImage');
  });

  it('keeps use elements with fragment-only href', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="m"/></defs><use href="#m"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).toContain('<use');
  });

  it('keeps use elements with xlink:href fragment reference', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><marker id="arrow"/></defs><use xlink:href="#arrow"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).toContain('<use');
  });

  it('strips use elements with external href', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.com/sprite.svg#icon"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('<use');
  });

  it('strips use elements with no href', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><use/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('<use');
  });

  it('removes on* event handler attributes', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" onload="alert(2)"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('onload');
  });

  it('removes href attributes with javascript: scheme', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>click</text></a></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('javascript:');
  });

  it('removes href attributes with external URLs', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.com"><text>link</text></a></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('https://evil.com');
  });

  it('removes style attributes with external url()', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.com/track)"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('url(https://');
  });

  it('keeps style attributes with fragment-only url()', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(#gradient0)"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).toContain('url(#gradient0)');
  });

  it('strips animate elements', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect><animate attributeName="x" values="0;100"/></rect></svg>';
    const result = sanitizeSvg(svg);
    expect(result).not.toContain('<animate');
  });

  it('returns empty string for invalid SVG', () => {
    expect(sanitizeSvg('<not-valid-svg>')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeSvg('')).toBe('');
  });

  it('passes through safe SVG content', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="red"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).toContain('<rect');
    expect(result).toContain('fill="red"');
  });
});
