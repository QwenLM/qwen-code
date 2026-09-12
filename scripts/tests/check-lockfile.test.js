/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'check-lockfile.js');

// The script derives the tree it inspects from its own location, with no
// injectable override, so the fixtures run a copy of it inside a throwaway
// tree. That tree sits under the repository's node_modules for two reasons: it
// is gitignored, so a crashed run cannot leave tracked residue, and Node
// resolves the script's `yaml` import by walking up into the real
// node_modules. Copying the real manifests and lockfiles in — rather than
// writing minimal ones — keeps the script's two integrity sections green, so
// the parity section is the only thing under test.
let fixtureRoot;

const FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/web-shell/package.json',
];

function pristine() {
  return Object.fromEntries(
    FILES.map((rel) => [rel, readFileSync(join(fixtureRoot, rel), 'utf8')]),
  );
}

let saved;

function runCheck() {
  const result = spawnSync(
    process.execPath,
    [join(fixtureRoot, 'scripts', 'check-lockfile.js')],
    { cwd: fixtureRoot, encoding: 'utf8' },
  );
  return { status: result.status, out: result.stdout + result.stderr };
}

// The parity banner is what separates this section's verdict from the two
// integrity sections', so every arm asserts on it rather than on the exit code
// alone.
function parityLines(out) {
  return out.slice(out.indexOf('Checking Playwright parity...'));
}

function writeFixture(rel, contents) {
  writeFileSync(join(fixtureRoot, rel), contents);
}

function perturbNpmLockfile(mutate) {
  const lockfile = JSON.parse(
    readFileSync(join(fixtureRoot, 'package-lock.json'), 'utf8'),
  );
  mutate(lockfile.packages);
  writeFixture('package-lock.json', JSON.stringify(lockfile, null, 2));
}

// Scoped to the web-shell importer block: the same specifier string appears
// under other importers, and a global replace would perturb the wrong one.
function perturbPnpmWebShell(field, value) {
  const text = readFileSync(join(fixtureRoot, 'pnpm-lock.yaml'), 'utf8');
  const start = text.indexOf('  packages/web-shell:');
  expect(start).toBeGreaterThan(-1);
  const block = text.slice(start);
  const target = `      '@playwright/test':\n        specifier: 1.61.1\n        version: 1.61.1\n`;
  expect(block).toContain(target);
  const patched = block.replace(
    target,
    target.replace(`${field}: 1.61.1`, `${field}: ${value}`),
  );
  writeFixture('pnpm-lock.yaml', text.slice(0, start) + patched);
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(root, 'node_modules', '.tmp-check-lockfile-'));
  mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true });
  cpSync(script, join(fixtureRoot, 'scripts', 'check-lockfile.js'));
  for (const rel of FILES) {
    const from = join(root, rel);
    const to = join(fixtureRoot, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  saved = pristine();
});

afterAll(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function restore() {
  for (const [rel, contents] of Object.entries(saved)) {
    writeFixture(rel, contents);
  }
}

describe('check-lockfile Playwright parity', () => {
  it('passes on the committed tree', () => {
    const { status, out } = runCheck();

    expect(parityLines(out)).toContain('Playwright parity check passed.');
    expect(status).toBe(0);
  });

  it('rejects two manifests pinned to different exact versions', () => {
    try {
      writeFixture(
        'packages/web-shell/package.json',
        saved['packages/web-shell/package.json'].replace(
          '"@playwright/test": "1.61.1"',
          '"@playwright/test": "1.62.0"',
        ),
      );

      const { status, out } = runCheck();

      expect(parityLines(out)).toContain('must declare the same version');
      expect(status).toBe(1);
    } finally {
      restore();
    }
  });

  it('rejects a range on either manifest', () => {
    try {
      // The state main was in before the pin: both sides equal as strings, but
      // a caret on both, which is exactly how the two trees came to resolve
      // apart in the first place.
      writeFixture(
        'packages/web-shell/package.json',
        saved['packages/web-shell/package.json'].replace(
          '"@playwright/test": "1.61.1"',
          '"@playwright/test": "^1.57.0"',
        ),
      );

      const { status, out } = runCheck();

      expect(parityLines(out)).toContain('expected an exact version');
      expect(status).toBe(1);
    } finally {
      restore();
    }
  });

  it('rejects a lockfile that resolves the hoisted package off the pin', () => {
    try {
      perturbNpmLockfile((packages) => {
        packages['node_modules/playwright'].version = '1.58.2';
      });

      const { status, out } = runCheck();

      expect(parityLines(out)).toContain(
        'resolves node_modules/playwright to 1.58.2 instead of 1.61.1',
      );
      expect(status).toBe(1);
    } finally {
      restore();
    }
  });

  it('rejects a lockfile that lost the hoisted package entirely', () => {
    try {
      perturbNpmLockfile((packages) => {
        delete packages['node_modules/@playwright/test'];
      });

      const { status, out } = runCheck();

      expect(parityLines(out)).toContain(
        'has no node_modules/@playwright/test entry',
      );
      expect(status).toBe(1);
    } finally {
      restore();
    }
  });

  it('rejects a nested copy at a different revision', () => {
    try {
      perturbNpmLockfile((packages) => {
        packages['node_modules/@playwright/test/node_modules/playwright'] = {
          version: '1.62.0',
          dev: true,
          resolved:
            'https://registry.npmjs.org/playwright/-/playwright-1.62.0.tgz',
          integrity: 'sha512-fixture=',
        };
      });

      const { status, out } = runCheck();

      expect(parityLines(out)).toContain('splitting the chromium revision');
      expect(status).toBe(1);
    } finally {
      restore();
    }
  });

  it('tolerates a nested copy at the pinned revision', () => {
    try {
      // A same-version duplicate is a redundant install, not a split revision,
      // so it must not be reported as one.
      perturbNpmLockfile((packages) => {
        packages['node_modules/@playwright/test/node_modules/playwright'] = {
          version: '1.61.1',
          dev: true,
          resolved:
            'https://registry.npmjs.org/playwright/-/playwright-1.61.1.tgz',
          integrity: 'sha512-fixture=',
        };
      });

      const { status, out } = runCheck();

      expect(parityLines(out)).toContain('Playwright parity check passed.');
      expect(status).toBe(0);
    } finally {
      restore();
    }
  });

  it('rejects a pnpm specifier that lags the manifest', () => {
    try {
      perturbPnpmWebShell('specifier', '^1.57.0');

      const { status, out } = runCheck();

      expect(parityLines(out)).toContain(
        'records @playwright/test in "packages/web-shell" as "^1.57.0"',
      );
      expect(status).toBe(1);
    } finally {
      restore();
    }
  });

  it('rejects a pnpm resolved version that lags the specifier', () => {
    try {
      // pnpm's --frozen-lockfile validates specifiers only, so this is the arm
      // that would otherwise install a different browser silently.
      perturbPnpmWebShell('version', '1.62.0');

      const { status, out } = runCheck();

      expect(parityLines(out)).toContain(
        'resolves @playwright/test in "packages/web-shell" to 1.62.0 instead of 1.61.1',
      );
      expect(status).toBe(1);
    } finally {
      restore();
    }
  });

  it('names the layer that decides the value when an importer entry is missing', () => {
    try {
      const text = readFileSync(join(fixtureRoot, 'pnpm-lock.yaml'), 'utf8');
      const start = text.indexOf('  packages/web-shell:');
      expect(start).toBeGreaterThan(-1);
      const block = text.slice(start);
      const target = `      '@playwright/test':\n        specifier: 1.61.1\n        version: 1.61.1\n`;
      expect(block).toContain(target);
      writeFixture(
        'pnpm-lock.yaml',
        text.slice(0, start) + block.replace(target, ''),
      );

      const { status, out } = runCheck();

      // "regenerate it" is a no-op for this arm — the importer list comes from
      // pnpm-workspace.yaml, so the message has to say so.
      expect(parityLines(out)).toContain(
        'pnpm-lock.yaml has no @playwright/test entry for importer "packages/web-shell"',
      );
      expect(parityLines(out)).toContain(
        "importers come from pnpm-workspace.yaml's packages:",
      );
      expect(status).toBe(1);
    } finally {
      restore();
    }
  });

  it('applies the agreement check to a third manifest, not just the second', () => {
    try {
      // The list is documented as extensible, so extending it must buy the
      // coverage the first two rows get. A positional destructure of [0] and
      // [1] hands a third entry the exactness check while silently skipping
      // the agreement check — which is the divergence that matters here,
      // because the triage workflow resolves playwright from
      // terminal-capture's own directory.
      const thirdManifest = 'integration-tests/terminal-capture/package.json';
      mkdirSync(dirname(join(fixtureRoot, thirdManifest)), { recursive: true });
      writeFixture(
        thirdManifest,
        JSON.stringify(
          {
            name: '@qwen-code/terminal-capture',
            dependencies: { playwright: '1.62.0' },
          },
          null,
          2,
        ),
      );
      writeFixture(
        'scripts/check-lockfile.js',
        readFileSync(
          join(fixtureRoot, 'scripts', 'check-lockfile.js'),
          'utf8',
        ).replace(
          "  { manifest: 'packages/web-shell/package.json', name: '@playwright/test' },",
          "  { manifest: 'packages/web-shell/package.json', name: '@playwright/test' },\n" +
            `  { manifest: '${thirdManifest}', name: 'playwright' },`,
        ),
      );

      const { out } = runCheck();

      expect(parityLines(out)).toContain(
        'playwright 1.61.1 (package.json) and playwright 1.62.0 (integration-tests/terminal-capture/package.json) must declare the same version',
      );
    } finally {
      cpSync(script, join(fixtureRoot, 'scripts', 'check-lockfile.js'));
      rmSync(join(fixtureRoot, 'integration-tests'), {
        recursive: true,
        force: true,
      });
      restore();
    }
  });
});
