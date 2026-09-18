import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WEB_SHELL_PWA_ASSETS } from '@qwen-code/sdk/daemon';
import { describe, expect, it } from 'vitest';

const PUBLIC_DIR = resolve(__dirname, 'public');

describe('committed PWA assets', () => {
  it('keeps the install manifest identity, scope, and icons valid', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'),
    ) as {
      name: string;
      short_name: string;
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{
        src: string;
        sizes: string;
        type: string;
        purpose: string;
      }>;
    };

    expect(manifest).toMatchObject({
      name: 'Qwen Code',
      short_name: 'Qwen Code',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    expect(manifest.scope).toBe(manifest.start_url);
    expect(manifest.icons).toEqual([
      {
        src: '/assets/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/assets/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/assets/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ]);
    for (const { src } of manifest.icons) {
      expect(existsSync(resolve(PUBLIC_DIR, src.slice(1)))).toBe(true);
    }
  });

  it('uses the same public route table as the daemon', () => {
    expect(WEB_SHELL_PWA_ASSETS.map(({ route }) => route)).toEqual([
      '/manifest.webmanifest',
      '/sw.js',
    ]);
  });
});
