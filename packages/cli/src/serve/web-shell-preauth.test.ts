import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { isPreAuthWebShellRequest } from './web-shell-preauth.js';

describe('PWA pre-auth classification', () => {
  it.each([
    '/manifest.webmanifest',
    '/manifest.webmanifest/',
    '/MANIFEST.WEBMANIFEST',
    '/sw.js',
    '/SW.JS/',
    '/assets/icon-192.png',
  ])('allows GET and HEAD for %s', (path) => {
    for (const method of ['GET', 'HEAD']) {
      expect(
        isPreAuthWebShellRequest({ method, path, headers: {} } as Request),
      ).toBe(true);
    }
  });

  it.each([
    '/sw.js',
    '/manifest.webmanifest',
    '/sw.js/extra',
    '/sw.js%2fextra',
    '/capabilities',
    '/session/abc/events',
  ])('does not exempt writes to %s', (path) => {
    expect(
      isPreAuthWebShellRequest({
        method: 'POST',
        path,
        headers: {},
      } as Request),
    ).toBe(false);
  });

  it.each([
    '/sw.js/extra',
    '/sw.js%2fextra',
    '/manifest.webmanifest/extra',
    '/capabilities',
    '/session/abc/events',
  ])('does not broaden public paths to %s', (path) => {
    expect(
      isPreAuthWebShellRequest({ method: 'GET', path, headers: {} } as Request),
    ).toBe(false);
  });
});
