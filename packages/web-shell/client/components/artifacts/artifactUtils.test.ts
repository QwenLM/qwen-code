// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePath, withArtifactPreviewCsp } from './artifactUtils';

describe('artifactUtils', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves parent path segments', () => {
    expect(normalizePath('src/foo/../bar.ts')).toBe('src/bar.ts');
    expect(normalizePath('/workspace/app/../app/src/./main.ts')).toBe(
      '/workspace/app/src/main.ts',
    );
    expect(normalizePath('../outside/file.ts')).toBe('../outside/file.ts');
  });

  it('injects preview CSP and strips unsafe metadata', () => {
    const output = withArtifactPreviewCsp(`
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; report-uri https://example.com/report">
          <meta http-equiv="refresh" content="0; url=https://example.com">
        </head>
        <body>
          <noscript><meta http-equiv="refresh" content="0; url=https://example.com"></noscript>
          <p>Hello</p>
        </body>
      </html>
    `);

    expect(output).toContain('Content-Security-Policy');
    expect(output).toContain("default-src 'none'");
    expect(output).not.toContain('report-uri');
    expect(output).not.toMatch(/http-equiv=["']?refresh/i);
    expect(output).not.toMatch(/<noscript\b/i);
    expect(output).toContain('<p>Hello</p>');
  });

  it('uses the same sanitization when DOMParser is unavailable', () => {
    vi.stubGlobal('DOMParser', undefined);

    const output = withArtifactPreviewCsp(`
      <meta http-equiv="Content-Security-Policy" content="report-uri https://example.com/report">
      <noscript><meta http-equiv="refresh" content="0; url=https://example.com"></noscript>
      <meta http-equiv="refresh" content="0; url=https://example.com">
      <p>Hello</p>
    `);

    expect(output).toContain('Content-Security-Policy');
    expect(output).toContain("default-src 'none'");
    expect(output).not.toContain('report-uri');
    expect(output).not.toMatch(/http-equiv=["']?refresh/i);
    expect(output).not.toMatch(/<noscript\b/i);
    expect(output).toContain('<p>Hello</p>');
  });
});
