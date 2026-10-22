/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareBundledGeneratedUi } from './generated-ui-settings.js';

const resolveBundleDir = vi.hoisted(() => vi.fn());
vi.mock('@qwen-code/qwen-code-core/utils/bundlePaths.js', () => ({
  resolveBundleDir,
}));

describe('bundled Generated UI candidate', () => {
  let fixture: string;
  const files = [
    'main.js',
    'app.html',
    join('skills', 'generated-ui', 'SKILL.md'),
    'THIRD_PARTY_NOTICES.txt',
  ];
  const populate = (directory: string, paths = files) => {
    for (const file of paths) {
      const target = join(directory, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'fixture');
    }
  };

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'generated ui 中文-'));
    resolveBundleDir.mockReset().mockReturnValue(fixture);
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  it.each([undefined, false, 'true', 1, {}, null])(
    'requires a strict boolean opt-in: %j',
    (value) => {
      expect(prepareBundledGeneratedUi(value, true)).toEqual({
        enabled: false,
      });
      expect(resolveBundleDir).not.toHaveBeenCalled();
    },
  );

  it('does not search assets for an unsupported runtime', () => {
    expect(prepareBundledGeneratedUi(true, false)).toEqual({
      enabled: true,
      unavailableReason: 'unsupported-runtime',
    });
    expect(resolveBundleDir).not.toHaveBeenCalled();
  });

  it('uses the owning runtime and a single tool without shell interpolation', () => {
    const assets = join(fixture, 'generated-ui');
    populate(assets);
    expect(prepareBundledGeneratedUi(true, true)).toEqual({
      enabled: true,
      skillsDir: join(assets, 'skills'),
      server: {
        command: process.execPath,
        args: [join(assets, 'main.js')],
        includeTools: ['generated_ui_show'],
        trust: false,
      },
    });
  });

  it.each(files)(
    'withholds an incomplete installation missing %s',
    (missing) => {
      populate(
        join(fixture, 'generated-ui'),
        files.filter((file) => file !== missing),
      );
      expect(prepareBundledGeneratedUi(true, true)).toEqual({
        enabled: true,
        unavailableReason: 'assets-missing',
      });
    },
  );

  it('uses the built-in integration entry for a source launch without a product bundle', () => {
    populate(fixture, [
      'integrations/generated-ui/package.json',
      'scripts/copy_bundle_assets.js',
    ]);
    const assets = join(fixture, 'integrations', 'generated-ui', 'dist');
    populate(
      assets,
      files.map((file) => (file === 'main.js' ? 'bundled-main.js' : file)),
    );
    resolveBundleDir.mockReturnValue(
      join(fixture, 'packages', 'cli', 'dist', 'src', 'config'),
    );
    expect(prepareBundledGeneratedUi(true, true).server?.args).toEqual([
      join(assets, 'bundled-main.js'),
    ]);
  });

  it('locates the built repository assets from its source module ancestry', () => {
    populate(fixture, [
      'integrations/generated-ui/package.json',
      'scripts/copy_bundle_assets.js',
    ]);
    const assets = join(fixture, 'dist', 'generated-ui');
    populate(assets);
    resolveBundleDir.mockReturnValue(
      join(fixture, 'packages', 'cli', 'src', 'config'),
    );
    expect(prepareBundledGeneratedUi(true, true).server?.args).toEqual([
      join(assets, 'main.js'),
    ]);
  });
});
