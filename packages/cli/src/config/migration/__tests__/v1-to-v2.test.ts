/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { migrateV1ToV2 } from '../versions/v1-to-v2.js';
import type { SettingsV1 } from '../types.js';

describe('migrateV1ToV2', () => {
  it('should migrate simple flat fields to nested structure', () => {
    const v1: SettingsV1 = {
      theme: 'dark',
      preferredEditor: 'vscode',
      vimMode: true,
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(2);
    expect(result.data.ui?.theme).toBe('dark');
    expect(result.data.general?.preferredEditor).toBe('vscode');
    expect(result.data.general?.vimMode).toBe(true);
  });

  it('should migrate disable* booleans to nested disable* structure', () => {
    const v1: SettingsV1 = {
      disableAutoUpdate: true,
      disableUpdateNag: false,
      disableLoadingPhrases: true,
      disableFuzzySearch: false,
      disableCacheControl: true,
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data.general?.disableAutoUpdate).toBe(true);
    expect(result.data.general?.disableUpdateNag).toBe(false);
    expect(result.data.ui?.accessibility?.disableLoadingPhrases).toBe(true);
    expect(result.data.context?.fileFiltering?.disableFuzzySearch).toBe(false);
    expect(result.data.model?.generationConfig?.disableCacheControl).toBe(true);
  });

  it('should migrate model field to model.name', () => {
    const v1: SettingsV1 = {
      model: 'gemini-1.5-pro',
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data.model?.name).toBe('gemini-1.5-pro');
  });

  it('should migrate tool-related fields', () => {
    const v1: SettingsV1 = {
      allowedTools: ['tool1', 'tool2'],
      excludeTools: ['tool3'],
      useRipgrep: true,
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data.tools?.allowed).toEqual(['tool1', 'tool2']);
    expect(result.data.tools?.exclude).toEqual(['tool3']);
    expect(result.data.tools?.useRipgrep).toBe(true);
  });

  it('should migrate security-related fields', () => {
    const v1: SettingsV1 = {
      useExternalAuth: true,
      folderTrust: true,
      folderTrustFeature: true,
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data.security?.auth?.useExternal).toBe(true);
    expect(result.data.security?.folderTrust?.enabled).toBe(true);
    expect(result.data.security?.folderTrust?.featureEnabled).toBe(true);
  });

  it('should preserve mcpServers at top level', () => {
    const v1: SettingsV1 = {
      mcpServers: { server1: { command: 'cmd' } },
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data.mcpServers).toEqual({ server1: { command: 'cmd' } });
  });

  it('should preserve unknown fields with warnings', () => {
    const v1: SettingsV1 = {
      theme: 'dark',
      unknownField1: 'value1',
      unknownField2: 123,
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data['unknownField1']).toBe('value1');
    expect(result.data['unknownField2']).toBe(123);
    expect(result.warnings.some((w) => w.includes('unknownField1'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('unknownField2'))).toBe(true);
  });

  it('should migrate screenReader field', () => {
    const v1: SettingsV1 = {
      screenReader: true,
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data.ui?.accessibility?.screenReader).toBe(true);
  });

  it('should migrate nested accessibility object', () => {
    const v1: SettingsV1 = {
      accessibility: { screenReader: true },
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data.ui?.accessibility?.screenReader).toBe(true);
  });

  it('should handle empty V1 object', () => {
    const v1: SettingsV1 = {};

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(2);
    expect(Object.keys(result.data).sort()).toEqual(['$version']);
  });

  it('should record changes for field moves', () => {
    const v1: SettingsV1 = {
      theme: 'dark',
      model: 'gemini',
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        type: 'move',
        path: 'ui.theme',
        oldValue: 'dark',
        newValue: 'dark',
        reason: 'Moved from theme to ui.theme',
      }),
    );
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        type: 'move',
        path: 'model.name',
        oldValue: 'gemini',
        newValue: 'gemini',
        reason: 'Moved from model to model.name',
      }),
    );
  });

  it('should handle complex nested structure migration', () => {
    const v1: SettingsV1 = {
      theme: 'dark',
      disableAutoUpdate: true,
      model: 'gemini-1.5-pro',
      maxSessionTurns: 100,
      mcpServers: { test: { command: 'test-cmd' } },
    };

    const result = migrateV1ToV2(v1);

    expect(result.success).toBe(true);
    expect(result.data.$version).toBe(2);
    expect(result.data.ui?.theme).toBe('dark');
    expect(result.data.general?.disableAutoUpdate).toBe(true);
    expect(result.data.model?.name).toBe('gemini-1.5-pro');
    expect(result.data.model?.maxSessionTurns).toBe(100);
    expect(result.data.mcpServers).toEqual({ test: { command: 'test-cmd' } });
  });

  it('should not mutate original input', () => {
    const v1: SettingsV1 = {
      theme: 'dark',
      model: 'gemini',
    };
    const original = JSON.stringify(v1);

    migrateV1ToV2(v1);

    expect(JSON.stringify(v1)).toBe(original);
  });
});
