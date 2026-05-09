/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  updateSettingsFilePreservingFormat,
  applyUpdates,
} from './commentJson.js';

describe('commentJson', () => {
  let tempDir: string;
  let testFilePath: string;

  beforeEach(() => {
    // Create a temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-format-test-'));
    testFilePath = path.join(tempDir, 'settings.json');
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('updateSettingsFilePreservingFormat', () => {
    it('should preserve comments when updating settings', () => {
      const originalContent = `{
        // Model configuration
        "model": "gemini-2.5-pro",
        "ui": {
          // Theme setting
          "theme": "dark"
        }
      }`;

      fs.writeFileSync(testFilePath, originalContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        model: 'gemini-2.5-flash',
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');

      expect(updatedContent).toContain('// Model configuration');
      expect(updatedContent).toContain('// Theme setting');
      expect(updatedContent).toContain('"model": "gemini-2.5-flash"');
      expect(updatedContent).toContain('"theme": "dark"');
    });

    it('should handle nested object updates', () => {
      const originalContent = `{
        "ui": {
          "theme": "dark",
          "showLineNumbers": true
        }
      }`;

      fs.writeFileSync(testFilePath, originalContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        ui: {
          theme: 'light',
          showLineNumbers: true,
        },
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(updatedContent).toContain('"theme": "light"');
      expect(updatedContent).toContain('"showLineNumbers": true');
    });

    it('should add new fields while preserving existing structure', () => {
      const originalContent = `{
        // Existing config
        "model": "gemini-2.5-pro"
      }`;

      fs.writeFileSync(testFilePath, originalContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        model: 'gemini-2.5-pro',
        newField: 'newValue',
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(updatedContent).toContain('// Existing config');
      expect(updatedContent).toContain('"newField": "newValue"');
    });

    it('should create file if it does not exist', () => {
      updateSettingsFilePreservingFormat(testFilePath, {
        model: 'gemini-2.5-pro',
      });

      expect(fs.existsSync(testFilePath)).toBe(true);
      const content = fs.readFileSync(testFilePath, 'utf-8');
      expect(content).toContain('"model": "gemini-2.5-pro"');
    });

    it('should handle complex real-world scenario', () => {
      const complexContent = `{
        // Settings
        "model": "gemini-2.5-pro",
        "mcpServers": {
          // Active server
          "context7": {
            "headers": {
              "API_KEY": "test-key" // API key
            }
          }
        }
      }`;

      fs.writeFileSync(testFilePath, complexContent, 'utf-8');

      updateSettingsFilePreservingFormat(testFilePath, {
        model: 'gemini-2.5-flash',
        mcpServers: {
          context7: {
            headers: {
              API_KEY: 'new-test-key',
            },
          },
        },
        newSection: {
          setting: 'value',
        },
      });

      const updatedContent = fs.readFileSync(testFilePath, 'utf-8');

      // Verify comments preserved
      expect(updatedContent).toContain('// Settings');
      expect(updatedContent).toContain('// Active server');
      expect(updatedContent).toContain('// API key');

      // Verify updates applied
      expect(updatedContent).toContain('"model": "gemini-2.5-flash"');
      expect(updatedContent).toContain('"newSection"');
      expect(updatedContent).toContain('"API_KEY": "new-test-key"');
    });

    it('should handle corrupted JSON files gracefully', () => {
      const corruptedContent = `{
        "model": "gemini-2.5-pro",
        "ui": {
          "theme": "dark"
        // Missing closing brace
      `;

      fs.writeFileSync(testFilePath, corruptedContent, 'utf-8');

      expect(() => {
        updateSettingsFilePreservingFormat(testFilePath, {
          model: 'gemini-2.5-flash',
        });
      }).not.toThrow();

      const unchangedContent = fs.readFileSync(testFilePath, 'utf-8');
      expect(unchangedContent).toBe(corruptedContent);
    });
  });
});

describe('applyUpdates', () => {
  it('should apply updates correctly', () => {
    const original = { a: 1, b: { c: 2 } };
    const updates = { b: { c: 3 } };
    const result = applyUpdates(original, updates);
    expect(result).toEqual({ a: 1, b: { c: 3 } });
  });
  it('should apply updates correctly when empty', () => {
    const original = { a: 1, b: { c: 2 } };
    const updates = { b: {} };
    const result = applyUpdates(original, updates);
    expect(result).toEqual({ a: 1, b: {} });
  });
});

describe('migration write-back via updateSettingsFilePreservingFormat', () => {
  let tempDir: string;
  let testFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'migration-writeback-test-'),
    );
    testFilePath = path.join(tempDir, 'settings.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should preserve comments on keys that exist in both original and updates', () => {
    const original = `{
  // My model choice
  "model": "gemini-2.5-pro",
  "ui": {
    // Theme preference
    "theme": "dark"
  }
}`;

    fs.writeFileSync(testFilePath, original, 'utf-8');

    // Runtime update: only changes model, keeps ui
    const updates = {
      model: 'gemini-2.5-flash',
      ui: {
        theme: 'dark',
      },
    };

    updateSettingsFilePreservingFormat(testFilePath, updates);

    const result = fs.readFileSync(testFilePath, 'utf-8');

    // Comments on preserved keys survive
    expect(result).toContain('// My model choice');
    expect(result).toContain('// Theme preference');
    // Updated value applied
    expect(result).toContain('"model": "gemini-2.5-flash"');
  });

  it('should add new keys while preserving existing comments', () => {
    const original = `{
  // API configuration
  "model": "gemini-2.5-flash"
}`;

    fs.writeFileSync(testFilePath, original, 'utf-8');

    const updates = {
      model: 'gemini-2.5-flash',
      $version: 3,
    };

    updateSettingsFilePreservingFormat(testFilePath, updates);

    const result = fs.readFileSync(testFilePath, 'utf-8');

    // Original comment preserved
    expect(result).toContain('// API configuration');
    // New key added
    expect(result).toContain('$version');
  });

  it('should preserve inline comments and trailing commas', () => {
    const original = `{
  "model": "gemini-2.5-pro", // inline comment
  "ui": {
    "theme": "dark",
  },
}`;

    fs.writeFileSync(testFilePath, original, 'utf-8');

    const updates = {
      model: 'gemini-2.5-flash',
      ui: {
        theme: 'light',
      },
    };

    updateSettingsFilePreservingFormat(testFilePath, updates);

    const result = fs.readFileSync(testFilePath, 'utf-8');

    // Inline comment preserved
    expect(result).toContain('// inline comment');
    // Values updated
    expect(result).toContain('"model": "gemini-2.5-flash"');
    expect(result).toContain('"theme": "light"');
  });

  it('should remove nested zombie keys in sync mode', () => {
    // Simulate a V2 settings file with deprecated disable* keys inside nested objects
    const v2Settings = `{
  "general": {
    // Auto-update setting
    "disableAutoUpdate": true,
    "disableUpdateNag": true
  },
  "ui": {
    "theme": "dark"
  },
  "$version": 2
}`;

    fs.writeFileSync(testFilePath, v2Settings, 'utf-8');

    // Migrated V3 settings: disable* keys removed, enable* keys added
    const migratedSettings = {
      general: {
        enableAutoUpdate: false,
      },
      ui: {
        theme: 'dark',
      },
      $version: 3,
    };

    const result = updateSettingsFilePreservingFormat(
      testFilePath,
      migratedSettings,
      true,
    );

    expect(result).toBe(true);
    const content = fs.readFileSync(testFilePath, 'utf-8');

    // Deprecated nested keys must be removed
    expect(content).not.toContain('disableAutoUpdate');
    expect(content).not.toContain('disableUpdateNag');
    // New keys must be present
    expect(content).toContain('enableAutoUpdate');
    expect(content).toContain('$version');
    // Unrelated keys preserved
    expect(content).toContain('"theme": "dark"');
  });

  it('should remove top-level zombie keys in sync mode', () => {
    const original = `{
  "theme": "dark",
  "model": "gemini-2.5-pro",
  "deprecatedKey": "zombie"
}`;

    fs.writeFileSync(testFilePath, original, 'utf-8');

    const migratedSettings = {
      model: 'gemini-2.5-flash',
      $version: 3,
    };

    const result = updateSettingsFilePreservingFormat(
      testFilePath,
      migratedSettings,
      true,
    );

    expect(result).toBe(true);
    const content = fs.readFileSync(testFilePath, 'utf-8');

    // Top-level zombie removed
    expect(content).not.toContain('theme');
    expect(content).not.toContain('deprecatedKey');
    // Migrated keys present
    expect(content).toContain('"model": "gemini-2.5-flash"');
    expect(content).toContain('$version');
  });

  it('should preserve unrelated keys in nested objects during sync', () => {
    // The migrated object represents the full desired state — migrations
    // preserve unrelated keys, so they appear in the migrated output.
    const original = `{
  "general": {
    "disableAutoUpdate": true,
    "someOtherSetting": "keep-me"
  }
}`;

    fs.writeFileSync(testFilePath, original, 'utf-8');

    // After migration: disableAutoUpdate removed, enableAutoUpdate added,
    // someOtherSetting preserved (migrations carry forward unrelated keys)
    const migratedSettings = {
      general: {
        enableAutoUpdate: false,
        someOtherSetting: 'keep-me',
      },
    };

    const result = updateSettingsFilePreservingFormat(
      testFilePath,
      migratedSettings,
      true,
    );

    expect(result).toBe(true);
    const content = fs.readFileSync(testFilePath, 'utf-8');

    // Deprecated key removed
    expect(content).not.toContain('disableAutoUpdate');
    // New key added
    expect(content).toContain('enableAutoUpdate');
    // Unrelated key in same nested object preserved
    expect(content).toContain('someOtherSetting');
    expect(content).toContain('keep-me');
  });

  it('should remove all keys when sync=true with empty updates object', () => {
    // Documents the behavior: sync mode with empty updates wipes all keys.
    // This is intentional for migrations that restructure the entire file.
    const original = `{
  "a": 1,
  "b": { "c": 2 }
}`;
    fs.writeFileSync(testFilePath, original, 'utf-8');

    const result = updateSettingsFilePreservingFormat(testFilePath, {}, true);

    expect(result).toBe(true);
    const content = fs.readFileSync(testFilePath, 'utf-8');
    expect(content).not.toContain('"a"');
    expect(content).not.toContain('"b"');
    expect(content).not.toContain('"c"');
  });
});
