/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MarketplaceNameSchema,
  PluginInstallationEntrySchema,
} from './schemas.js';

describe('MarketplaceNameSchema — qoder-enterprise-* prefix protection', () => {
  it('rejects exact prefix with org id', () => {
    const result = MarketplaceNameSchema.safeParse('qoder-enterprise-acme');
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues
        .map((i) => i.message)
        .join(' | ');
      expect(msg).toMatch(/qoder-enterprise/);
    }
  });

  it('rejects mixed-case variant (case-insensitive)', () => {
    const result = MarketplaceNameSchema.safeParse('Qoder-Enterprise-Acme');
    expect(result.success).toBe(false);
  });

  it('rejects bare prefix without trailing org id', () => {
    // "qoder-enterprise-" is invalid because of the dangling dash but the
    // refine still adds protection in case the user supplies it
    const result = MarketplaceNameSchema.safeParse('qoder-enterprise-');
    expect(result.success).toBe(false);
  });

  it('accepts a similar-but-different name', () => {
    const result = MarketplaceNameSchema.safeParse('qoder-enterpris-acme');
    expect(result.success).toBe(true);
  });

  it('accepts a normal marketplace name', () => {
    const result = MarketplaceNameSchema.safeParse('my-team-marketplace');
    expect(result.success).toBe(true);
  });

  it('rejects qoderwork-enterprise-* prefix too', () => {
    const result = MarketplaceNameSchema.safeParse('qoderwork-enterprise-acme');
    expect(result.success).toBe(false);
  });

  it('rejects mixed-case qoderwork variant', () => {
    const result = MarketplaceNameSchema.safeParse('Qoderwork-Enterprise-X');
    expect(result.success).toBe(false);
  });

  it('accepts a name only starting with "qoderwork" but no enterprise', () => {
    const result = MarketplaceNameSchema.safeParse('qoderwork-tools');
    expect(result.success).toBe(true);
  });
});

describe('PluginInstallationEntrySchema — enterprise fields', () => {
  it('accepts a managed entry with all enterprise fields populated', () => {
    const entry = {
      scope: 'managed' as const,
      installPath: '/tmp/foo',
      version: '1.0.0',
      orgId: 'org-1',
      displayName: 'My Enterprise Plugin',
      userVisible: false,
      userCanDisable: false,
      fileHash: 'sha256:abc',
      fileSize: 1234,
    };
    const result = PluginInstallationEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orgId).toBe('org-1');
      expect(result.data.userVisible).toBe(false);
      expect(result.data.userCanDisable).toBe(false);
      expect(result.data.fileHash).toBe('sha256:abc');
    }
  });

  it('accepts a normal user entry without enterprise fields', () => {
    const entry = {
      scope: 'user' as const,
      installPath: '/tmp/foo',
      version: '1.0.0',
    };
    const result = PluginInstallationEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('accepts a managed entry without enterprise metadata (lenient)', () => {
    // Schema does not REQUIRE enterprise fields on managed scope — they are
    // populated by the sync layer and may legitimately be missing on read of
    // a corrupted/older entry.
    const entry = {
      scope: 'managed' as const,
      installPath: '/tmp/foo',
    };
    const result = PluginInstallationEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });
});
