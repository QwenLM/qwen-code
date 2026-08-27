/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
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
 * Pass { withUpdater: false } to model a fork or hand-edited shell-root
 * whose tauri.conf.json has no plugins.updater section.
 */
function makeShellRoot({ withUpdater = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brand-test-shell-'));
  mkdirSync(join(root, 'src-tauri', 'icons'), { recursive: true });
  mkdirSync(join(root, 'bootstrap'), { recursive: true });
  const tauriConfig = {
    productName: 'Qwen Code Desktop',
    identifier: 'com.qwen.code.desktop',
    bundle: { createUpdaterArtifacts: true, shortDescription: '' },
  };
  if (withUpdater) {
    tauriConfig.plugins = {
      updater: {
        endpoints: ['https://updater.qwen-code.org'],
        pubkey: 'dGVzdA==',
      },
    };
  }
  writeFileSync(
    join(root, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify(tauriConfig),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'desktop-shell', type: 'module' }),
  );
  return root;
}

/**
 * Seed a minimal @tauri-apps/cli stub so generateIcons resolves and runs it
 * locally instead of falling back to a slow, network-dependent `npx --yes`.
 */
function seedTauriCliStub(root) {
  const cliDir = join(root, 'node_modules', '@tauri-apps', 'cli');
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    join(cliDir, 'package.json'),
    JSON.stringify({ name: '@tauri-apps/cli', version: '0.0.0' }),
  );
  writeFileSync(join(cliDir, 'tauri.js'), 'process.exit(0);\n');
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
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  try {
    rmSync(shellRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
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

  // R6-1: a scalar (non-array) updaterEndpoints must fail loudly instead
  // of being silently coerced to [], which would ship the brand with
  // in-app updates permanently disabled while brand-create exits 0.
  it('rejects non-array updaterEndpoints instead of coercing to []', () => {
    const confPath = join(shellRoot, 'src-tauri', 'tauri.conf.json');
    const scalars = [
      'https://updates.acme.ai/feed.json', // typo of the array shape
      { url: 'https://updates.acme.ai/feed.json' },
      42,
      true,
    ];
    for (const updaterEndpoints of scalars) {
      const before = readFileSync(confPath, 'utf8');
      const result = runBrand(shellRoot, {
        brandId: 'acme-ai',
        logo: logoPath,
        updaterEndpoints,
      });
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain('JSON array');
      expect(
        readFileSync(confPath, 'utf8'),
        `value=${JSON.stringify(updaterEndpoints)}`,
      ).toBe(before);
    }
  });

  it('still accepts omitted or empty-array updaterEndpoints', () => {
    for (const extra of [{}, { updaterEndpoints: [] }]) {
      const root = makeShellRoot();
      tmpDirs.push(root);
      seedTauriCliStub(root);
      const logo = makeLogo(root);
      const result = runBrand(root, {
        brandId: 'acme-ai',
        logo,
        ...extra,
      });
      expect(result.status, result.stderr).toBe(0);
    }
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

  // R3-4: Single-use guard bypass when appName === productName
  it('rejects appName equal to the pristine default "Qwen Code Desktop"', () => {
    const result = runBrand(shellRoot, {
      brandId: 'acme-ai',
      logo: logoPath,
      appName: 'Qwen Code Desktop',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Qwen Code Desktop');
    expect(result.stderr).toContain('re-run guard');
  });

  it('rejects brandId that derives appName "Qwen Code Desktop"', () => {
    // brandId "qwen-code-desktop" → titleWords → "Qwen Code Desktop"
    const result = runBrand(shellRoot, {
      brandId: 'qwen-code-desktop',
      logo: logoPath,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Qwen Code Desktop');
  });

  // Hostile appName escaping: appName is a free-form override, and the
  // bootstrap.js patcher must not emit invalid JS for it. Previously only
  // single quotes were escaped, so a trailing backslash escaped the
  // literal's closing quote while brand-create still exited 0.
  it('keeps generated bootstrap.js valid JS for hostile appName values', () => {
    const hostileNames = [
      "Bob's App\\", // trailing backslash (the reported trigger)
      'Line1\nLine2', // raw newline is invalid in a single-quoted literal
      'Say "hi"', // double quotes
      'It\'s "quoted" \\ done', // quotes and backslashes combined
    ];
    for (const appName of hostileNames) {
      const root = makeShellRoot();
      tmpDirs.push(root);
      seedTauriCliStub(root);
      const logo = makeLogo(root);
      const bootstrapPath = join(root, 'bootstrap', 'bootstrap.js');
      writeFileSync(
        bootstrapPath,
        "const a = 'Starting Qwen Code';\nconst b = 'Restarting Qwen Code';\n",
      );
      const result = runBrand(root, {
        brandId: 'acme-ai',
        logo,
        appName,
      });
      expect(result.status, result.stderr).toBe(0);
      const check = spawnSync(process.execPath, ['--check', bootstrapPath], {
        encoding: 'utf8',
      });
      expect(check.status, check.stderr).toBe(0);
    }
  }, 60_000);

  // R5-1: appName is also spliced into bootstrap/index.html (<title>,
  // alt attribute, <h1>, <h2>), where it must be HTML-escaped so the
  // branded startup screen stays well-formed for free-form brand names.
  it('HTML-escapes hostile appName values in bootstrap/index.html', () => {
    const cases = [
      {
        appName: 'Acme <Corp>',
        expected: [
          '<title>Acme &lt;Corp&gt;</title>',
          'alt="Acme &lt;Corp&gt;"',
          '<h1>Acme &lt;Corp&gt;</h1>',
          '<h2 id="title">Starting Acme &lt;Corp&gt;</h2>',
        ],
        hostileFragment: '<Corp>',
      },
      {
        appName: 'Acme "Beta" <Desktop>',
        expected: [
          '<title>Acme &quot;Beta&quot; &lt;Desktop&gt;</title>',
          'alt="Acme &quot;Beta&quot; &lt;Desktop&gt;"',
          '<h1>Acme &quot;Beta&quot; &lt;Desktop&gt;</h1>',
          '<h2 id="title">Starting Acme &quot;Beta&quot; &lt;Desktop&gt;</h2>',
        ],
        hostileFragment: 'alt="Acme "Beta"',
      },
    ];
    for (const { appName, expected, hostileFragment } of cases) {
      const root = makeShellRoot();
      tmpDirs.push(root);
      seedTauriCliStub(root);
      const logo = makeLogo(root);
      const indexPath = join(root, 'bootstrap', 'index.html');
      writeFileSync(
        indexPath,
        '<!doctype html>\n<html>\n<head>\n<title>Qwen Code</title>\n' +
          '</head>\n<body>\n<img src="qwen-code-logo.svg" alt="Qwen Code">\n' +
          '<h1>Qwen Code</h1>\n<h2 id="title">Starting Qwen Code</h2>\n' +
          '</body>\n</html>\n',
      );
      const result = runBrand(root, {
        brandId: 'acme-ai',
        logo,
        appName,
      });
      expect(result.status, result.stderr).toBe(0);
      const html = readFileSync(indexPath, 'utf8');
      for (const snippet of expected) {
        expect(html, `appName=${appName}`).toContain(snippet);
      }
      expect(html, `appName=${appName}`).not.toContain(hostileFragment);
    }
  }, 60_000);

  // R5-8: the brand's validated updater config must not be silently
  // discarded when the target tauri.conf.json has no plugins.updater
  // section; fail closed with the config file left unmutated.
  it('fails closed when the shell-root has no plugins.updater section', () => {
    const root = makeShellRoot({ withUpdater: false });
    tmpDirs.push(root);
    const logo = makeLogo(root);
    const confPath = join(root, 'src-tauri', 'tauri.conf.json');
    const before = readFileSync(confPath, 'utf8');
    const result = runBrand(root, {
      brandId: 'acme-ai',
      logo,
      updaterEndpoints: ['https://updates.acme.ai'],
      updaterPubkey: 'dGVzdHB1YmtleQ==',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('plugins.updater');
    expect(readFileSync(confPath, 'utf8')).toBe(before);
  }, 60_000);
});
