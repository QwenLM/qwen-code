/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPluginMarketplaceMetadata } from './pluginMarketplaceMetadata.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(
      root,
      { recursive: true, force: true }
    )),
  );
});

describe(
  'plugin marketplace file',
  () => {
    it(
      'reads the exact plugin-root path and rereads changed files',
      async () => {
        const root = await mkdtemp(join(
          tmpdir(),
          'marketplace-'
        ));
        roots.push(root);
        await mkdir(join(
          root,
          '.qoder'
        ));
        const file = join(
          root,
          '.qoder',
          'marketplace.json'
        );
        await writeFile(
          file,
          JSON.stringify({
            schemaVersion: 1,
            marketSourceId: 'sash-enterprise',
            orgId: 'org_2291',
            itemKind: 'plugin',
            marketItemId: 'plg_3c0d1e',
            displayName: '研发效能工具集',
            version: '0.3.1',
          }),
        );
        expect(await readPluginMarketplaceMetadata(root)).toEqual({
          marketSourceId: 'sash-enterprise',
          orgId: 'org_2291',
          itemKind: 'plugin',
          marketItemId: 'plg_3c0d1e',
          displayName: '研发效能工具集',
          version: '0.3.1',
        });
        await writeFile(
          file,
          '{'
        );
        expect(await readPluginMarketplaceMetadata(root)).toEqual({
          marketSourceId: '',
          orgId: '',
          itemKind: '',
          marketItemId: '',
          displayName: '',
          version: '',
        });
      }
    );

    it(
      'does not fall back to marketplace catalogue files',
      async () => {
        const root = await mkdtemp(join(
          tmpdir(),
          'marketplace-'
        ));
        roots.push(root);
        await mkdir(join(
          root,
          '.qoder-plugin'
        ));
        await writeFile(
          join(
            root,
            '.qoder-plugin',
            'marketplace.json'
          ),
          JSON.stringify({ marketItemId: 'wrong' }),
        );
        expect(await readPluginMarketplaceMetadata(root)).toEqual({
          marketSourceId: '',
          orgId: '',
          itemKind: '',
          marketItemId: '',
          displayName: '',
          version: '',
        });
      }
    );
  }
);
