/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyGeneratedUiAssets } from '../copy_bundle_assets.js';

const assets = [
  ['bundled-main.js', 'main.js'],
  ['app.html', 'app.html'],
  ['skills/generated-ui/SKILL.md', 'skills/generated-ui/SKILL.md'],
  ['THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'],
];

describe('bundled Generated UI assets', () => {
  let root;

  function write(relative, contents) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'qwen-generated-ui-assets-'));
    write('integrations/generated-ui/package.json', '{"private":true}');
    for (const [source] of assets) {
      write(`integrations/generated-ui/dist/${source}`, source);
    }
    write('integrations/generated-ui/dist/main.js', 'legacy entry');
    write('integrations/generated-ui/dist/development-only.js', 'skip me');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('ships only the built-in entry, fixed bootstrap, canonical writer and licenses', () => {
    write('dist/generated-ui/stale.js', 'old asset');
    write('dist/unrelated.js', 'keep me');

    copyGeneratedUiAssets({ root });

    for (const [source, target] of assets) {
      expect(
        fs.readFileSync(path.join(root, 'dist/generated-ui', target), 'utf8'),
      ).toBe(source);
    }
    expect(fs.readdirSync(path.join(root, 'dist/generated-ui')).sort()).toEqual(
      ['THIRD_PARTY_NOTICES.txt', 'app.html', 'main.js', 'skills'],
    );
    expect(fs.readFileSync(path.join(root, 'dist/unrelated.js'), 'utf8')).toBe(
      'keep me',
    );
    expect(
      fs.readFileSync(
        path.join(root, 'integrations/generated-ui/dist/main.js'),
        'utf8',
      ),
    ).toBe('legacy entry');
  });

  it.each(assets.map(([source]) => source))(
    'fails before replacing output when %s is missing',
    (source) => {
      fs.rmSync(path.join(root, 'integrations/generated-ui/dist', source));
      write('dist/generated-ui/main.js', 'previous build');

      expect(() => copyGeneratedUiAssets({ root })).toThrow(
        'npm run build --workspace=@qwen-code/generated-ui',
      );
      expect(
        fs.readFileSync(path.join(root, 'dist/generated-ui/main.js'), 'utf8'),
      ).toBe('previous build');
    },
  );
});
