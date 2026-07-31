import { afterEach, describe, expect, it, mock } from 'bun:test';
import { getHighQualityLogoUrl } from '../logo.ts';

describe('getHighQualityLogoUrl', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('keeps uppercase absolute favicon hrefs from HTML', async () => {
    const iconUrl = 'HTTPS://cdn.example.com/icon.svg';
    const fetchMock = mock(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);

        if (init?.method === 'GET' && url === 'https://example.com') {
          return Promise.resolve(
            new Response(
              `<html><head><link rel="icon" href="${iconUrl}" sizes="any"></head></html>`,
              { status: 200 },
            ),
          );
        }

        if (init?.method === 'HEAD' && url === iconUrl) {
          return Promise.resolve(
            new Response(null, {
              status: 200,
              headers: { 'content-type': 'image/svg+xml' },
            }),
          );
        }

        return Promise.resolve(new Response(null, { status: 404 }));
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getHighQualityLogoUrl('https://example.com')).resolves.toBe(
      iconUrl,
    );
  });
});
