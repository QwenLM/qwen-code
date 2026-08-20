/**
 * Tests for the voice-token frame-trust gate. This is the SOLE guard deciding
 * whether a frame receives the voice stream URL (which embeds the RPC server
 * token), so a regression here leaks ASR credentials to a malicious iframe.
 */
import { describe, it, expect } from 'bun:test';
import {
  getRendererDevOrigin,
  isTrustedRendererFrameUrl,
} from '../frame-trust';

const DEV_URL = 'http://localhost:5173';

describe('getRendererDevOrigin', () => {
  it('returns undefined in production (no dev server url)', () => {
    expect(getRendererDevOrigin(undefined)).toBeUndefined();
    expect(getRendererDevOrigin('')).toBeUndefined();
  });

  it('derives the origin from a valid dev server url', () => {
    expect(getRendererDevOrigin('http://localhost:5173/')).toBe(DEV_URL);
    expect(getRendererDevOrigin('http://localhost:5173/index.html?x=1')).toBe(
      DEV_URL,
    );
  });

  it('returns undefined for a malformed dev server url (no throw)', () => {
    expect(getRendererDevOrigin('not-a-url')).toBeUndefined();
  });
});

describe('isTrustedRendererFrameUrl', () => {
  it('(a) trusts a file:// frame in production', () => {
    expect(isTrustedRendererFrameUrl('file:///app/index.html', undefined)).toBe(
      true,
    );
  });

  it('(b) trusts a frame whose origin matches the dev server', () => {
    expect(
      isTrustedRendererFrameUrl('http://localhost:5173/index.html', DEV_URL),
    ).toBe(true);
    // Origin match only — a different path on the same origin is still trusted.
    expect(
      isTrustedRendererFrameUrl(
        'http://localhost:5173/deep/path?q=1#h',
        DEV_URL,
      ),
    ).toBe(true);
  });

  it('(c) does NOT trust a cross-origin frame', () => {
    expect(
      isTrustedRendererFrameUrl('https://evil.example.com/x', DEV_URL),
    ).toBe(false);
    // Same host, different port/scheme is still a different origin.
    expect(
      isTrustedRendererFrameUrl('http://localhost:6006/index.html', DEV_URL),
    ).toBe(false);
    expect(
      isTrustedRendererFrameUrl('https://localhost:5173/index.html', DEV_URL),
    ).toBe(false);
  });

  it('(d) does NOT trust an undefined frame url', () => {
    expect(isTrustedRendererFrameUrl(undefined, DEV_URL)).toBe(false);
    expect(isTrustedRendererFrameUrl('', DEV_URL)).toBe(false);
  });

  it('(e) does NOT trust a malformed frame url (no throw)', () => {
    expect(isTrustedRendererFrameUrl('http://[bad', DEV_URL)).toBe(false);
    expect(isTrustedRendererFrameUrl('::::', DEV_URL)).toBe(false);
  });

  it('(f) flows VITE_DEV_SERVER_URL through: a dev-origin frame is trusted only when the dev url is set', () => {
    // With the dev url set, the dev-origin frame is trusted.
    expect(
      isTrustedRendererFrameUrl('http://localhost:5173/index.html', DEV_URL),
    ).toBe(true);
    // In production (dev url undefined) the same frame is NOT trusted.
    expect(
      isTrustedRendererFrameUrl('http://localhost:5173/index.html', undefined),
    ).toBe(false);
    // A malformed dev url falls back to no trusted dev origin.
    expect(
      isTrustedRendererFrameUrl('http://localhost:5173/index.html', 'not-a-url'),
    ).toBe(false);
  });
});
