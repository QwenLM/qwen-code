/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  normalizePluginMarketplaceMetadata,
  normalizeMcpMarketplaceMetadata,
  toMcpHookMarketplaceMetadata,
} from './marketplaceMetadata.js';

describe(
  'marketplace metadata',
  () => {
    it(
      'keeps plugin market fields without schema or legacy identity',
      () => {
        expect(
          normalizePluginMarketplaceMetadata({
            schemaVersion: 1,
            marketSourceId: 'sash-enterprise',
            orgId: 'org_2291',
            itemKind: 'plugin',
            marketItemId: 'plg_3c0d1e',
            displayName: '研发效能工具集',
            version: '0.3.1',
            id: 'legacy',
            name: 'legacy',
          }),
        ).toEqual({
          marketSourceId: 'sash-enterprise',
          orgId: 'org_2291',
          itemKind: 'plugin',
          marketItemId: 'plg_3c0d1e',
          displayName: '研发效能工具集',
          version: '0.3.1',
        });
      }
    );

    it.each([undefined, null, [], 'invalid', { marketItemId: 42 }])(
      'defaults invalid or missing plugin fields: %j',
      (input) => {
        expect(normalizePluginMarketplaceMetadata(input)).toEqual({
          marketSourceId: '',
          orgId: '',
          itemKind: '',
          marketItemId: '',
          displayName: '',
          version: '',
        });
      },
    );

    it(
      'stores only three MCP fields and expands a detached Hook payload',
      () => {
        const metadata = normalizeMcpMarketplaceMetadata({
          schemaVersion: 1,
          marketSourceId: 'excluded',
          orgId: 'excluded',
          itemKind: 'excluded',
          marketItemId: 'notion',
          displayName: 'Notion',
          version: '0.3.1',
        });
        expect(metadata).toEqual({
          marketItemId: 'notion',
          displayName: 'Notion',
          version: '0.3.1',
        });
        const hook = toMcpHookMarketplaceMetadata(metadata);
        expect(hook).toEqual({
          marketSourceId: '',
          orgId: '',
          itemKind: '',
          marketItemId: 'notion',
          displayName: 'Notion',
          version: '0.3.1',
        });
        hook.version = 'mutated';
        expect(metadata).toEqual({
          marketItemId: 'notion',
          displayName: 'Notion',
          version: '0.3.1',
        });
      }
    );

    it(
      'creates independent empty values',
      () => {
        const first = normalizeMcpMarketplaceMetadata(null);
        first.version = 'mutated';
        expect(normalizeMcpMarketplaceMetadata(undefined)).toEqual({
          marketItemId: '',
          displayName: '',
          version: '',
        });
      }
    );
  }
);
