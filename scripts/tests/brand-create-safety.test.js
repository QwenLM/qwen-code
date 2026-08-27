/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const SCRIPT = join(
  __dirname,
  '..',
  '..',
  'packages',
  'desktop-shell',
  '.agents',
  'skills',
  'desktop-brand-builder',
  'scripts',
  'brand-create.mjs',
);

/**
 * Create a minimal fake shell-root with the files brand-create.mjs expects.
 */
function makeShellRoot() {
  const root = mkdtempSync(join(tmpdir(), 'brand-test-shell-'));
  mkdirSync(join(root, 'src-tauri', 'icons'), { recursive: true });
  mkdirSync(join(root, 'bootstrap'), { recursive: true });
  writeFileSync(
    join(root, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({
      productName: 'Qwen Code Desktop',
      identifier: 'com.qwen.code.desktop',
      bundle: { createUpdaterArtifacts: true, shortDescription: '' },
      plugins: {
        updater: {
          endpoints: ['https://updater.qwen-code.org'],
          pubkey: 'dGVzdA==',
        },
      },
    }),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'desktop-shell', type: 'module' }),
  );
  return root;
}

function makeLogo(dir) {
  const logoPath = join(dir, 'logo.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  writeFileSync(logoPath, png);
  return logoPath;
}

function runBrand(shellRoot, brandConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'brand-test-cfg-'));
  const configPath = join(dir, 'brand.json');
  writeFileSync(configPath, JSON.stringify(brandConfig));
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--shell-root', shellRoot, '--config', configPath],
    { encoding: 'utf8', timeout: 10_000 },
  );
  return { ...result, configDir: dir };
}

let shellRoot;
let logoPath;
const tmpDirs = [];

beforeEach(() => {
  shellRoot = makeShellRoot();
  logoPath = makeLogo(shellRoot);
});

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  try { rmSync(shellRoot, { recursive: true, force: true }); } catch {}
});

describe('brand-create.mjs safety checks', () => {
  // R1-4: Shell injection via logo path
  it('does not use shell:true when invoking the icon generator', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const fnMatch = source.match(/function generateIcons[\s\S]*?\n\}/);
    expect(fnMatch).toBeTruthy();
    expect(fnMatch[0]).not.toContain('shell: true');
    expect(fnMatch[0]).not.toContain('shell:true');
    expect(fnMatch[0]).not.toContain('safeLogo');
  });

  // R1-1: Missing updaterPubkey for bring-your-own-feed
  it('rejects updaterEndpoints without updaterPubkey', () => {
    const result = runBrand(shellRoot, {
      brandId: 'acme-ai',
      logo: logoPath,
      updaterEndpoints: ['https://updates.acme.ai'],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('updaterPubkey');
  });

  it('accepts updaterEndpoints when updaterPubkey is provided', () => {
    const result = runBrand(shellRoot, {
      brandId: 'acme-ai',
      logo: logoPath,
      updaterEndpoints: ['https://updates.acme.ai'],
      updaterPubkey: 'dGVzdHB1YmtleQ==',
    });
    // May fail later (e.g., tauri icon not installed) but must NOT fail
    // on the updaterPubkey validation.
    expect(result.stderr).not.toContain('updaterPubkey is missing');
  });
});
