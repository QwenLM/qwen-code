/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parse, stringify } from 'comment-json';
import {
  deleteCommentJsonProperty,
  getCommentJsonProperty,
  setCommentJsonProperty,
  toPlainJsonValue,
} from './commentJson.js';
// 仅验证显式替换一个对象路径的 JSONC 行为，不提供整文件持久化入口。
function replaceObject(content: string, value: Record<string, unknown>): string {
  const root = { value: parse(content) };
  setCommentJsonProperty(root, 'value', value);
  return stringify(root.value, null, 2);
}

describe('commentJson', () => {
  describe('explicit object replacement', () => {
    it('should preserve comments when updating settings', () => {
      const originalContent = `{
        // Model configuration
        "model": "gemini-2.5-pro",
        "ui": {
          // Theme setting
          "theme": "dark"
        }
      }`;

      const updatedContent = replaceObject(originalContent, {
        model: 'gemini-2.5-flash',
        ui: {
          theme: 'dark',
        },
      });


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

      const updatedContent = replaceObject(originalContent, {
        ui: {
          theme: 'light',
          showLineNumbers: true,
        },
      });

      expect(updatedContent).toContain('"theme": "light"');
      expect(updatedContent).toContain('"showLineNumbers": true');
    });

    it('should add new fields while preserving existing structure', () => {
      const originalContent = `{
        // Existing config
        "model": "gemini-2.5-pro"
      }`;

      const updatedContent = replaceObject(originalContent, {
        model: 'gemini-2.5-pro',
        newField: 'newValue',
      });

      expect(updatedContent).toContain('// Existing config');
      expect(updatedContent).toContain('"newField": "newValue"');
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

      const updatedContent = replaceObject(complexContent, {
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


      // Verify comments preserved
      expect(updatedContent).toContain('// Settings');
      expect(updatedContent).toContain('// Active server');
      expect(updatedContent).toContain('// API key');

      // Verify updates applied
      expect(updatedContent).toContain('"model": "gemini-2.5-flash"');
      expect(updatedContent).toContain('"newSection"');
      expect(updatedContent).toContain('"API_KEY": "new-test-key"');
    });

    it('should handle array updates while preserving comments', () => {
      const originalContent = `{
        // Server configurations
        "servers": [
          // First server
          "server1",
          "server2" // Second server
        ]
      }`;

      const updatedContent = replaceObject(originalContent, {
        servers: ['server1', 'server3'],
      });

      expect(updatedContent).toContain('// Server configurations');
      expect(updatedContent).toContain('"server1"');
      expect(updatedContent).toContain('"server3"');
      expect(updatedContent).not.toContain('"server2"');
    });

    it('should sync nested objects, removing omitted fields', () => {
      const originalContent = `{
        // Configuration
        "model": "gemini-2.5-pro",
        "ui": {
          "theme": "dark",
          "existingSetting": "value"
        },
        "preservedField": "keep me"
      }`;

      const updatedContent = replaceObject(originalContent, {
        model: 'gemini-2.5-flash',
        ui: {
          theme: 'light',
        },
        preservedField: 'keep me',
      });

      expect(updatedContent).toContain('// Configuration');
      expect(updatedContent).toContain('"model": "gemini-2.5-flash"');
      expect(updatedContent).toContain('"theme": "light"');
      expect(updatedContent).not.toContain('"existingSetting": "value"');
      expect(updatedContent).toContain('"preservedField": "keep me"');
    });

    it('should handle mcpServers field deletion properly', () => {
      const originalContent = `{
        "model": "gemini-2.5-pro",
        "mcpServers": {
          // Server to keep
          "context7": {
            "command": "node",
            "args": ["server.js"]
          },
          // Server to remove
          "oldServer": {
            "command": "old",
            "args": ["old.js"]
          }
        }
      }`;

      const updatedContent = replaceObject(originalContent, {
        model: 'gemini-2.5-pro',
        mcpServers: {
          context7: {
            command: 'node',
            args: ['server.js'],
          },
        },
      });

      expect(updatedContent).toContain('// Server to keep');
      expect(updatedContent).toContain('"context7"');
      expect(updatedContent).not.toContain('"oldServer"');
      // The comment for the removed server should still be preserved
      expect(updatedContent).toContain('// Server to remove');
    });

    it('preserves sibling-level commented-out blocks when removing another key', () => {
      const originalContent = `{
        "mcpServers": {
          // "sleep": {
          //   "command": "node",
          //   "args": [
          //     "/Users/testUser/test-mcp-server/sleep-mcp/build/index.js"
          //   ],
          //   "timeout": 300000
          // },
          "playwright": {
            "command": "npx",
            "args": [
              "@playwright/mcp@latest",
              "--headless",
              "--isolated"
            ]
          }
        }
      }`;

      const updatedContent = replaceObject(originalContent, {
        mcpServers: {},
      });

      expect(updatedContent).toContain('// "sleep": {');
      expect(updatedContent).toContain('"mcpServers"');
      expect(updatedContent).not.toContain('"playwright"');
    });

    it('should handle type conversion from object to array', () => {
      const originalContent = `{
        "data": {
          "key": "value"
        }
      }`;

      const updatedContent = replaceObject(originalContent, {
        data: ['item1', 'item2'],
      });

      expect(updatedContent).toContain('"data": [');
      expect(updatedContent).toContain('"item1"');
      expect(updatedContent).toContain('"item2"');
    });

    it('should remove both nested and non-nested objects when omitted', () => {
      const originalContent = `{
        // Top-level config
        "topLevelObject": {
          "field1": "value1",
          "field2": "value2"
        },
        // Parent object
        "parent": {
          "nestedObject": {
            "nestedField1": "value1",
            "nestedField2": "value2"
          },
          "keepThis": "value"
        },
        // This should be preserved
        "preservedObject": {
          "data": "keep"
        }
      }`;

      const updatedContent = replaceObject(originalContent, {
        parent: {
          keepThis: 'value',
        },
        preservedObject: {
          data: 'keep',
        },
      });


      expect(updatedContent).not.toContain('"topLevelObject"');

      expect(updatedContent).not.toContain('"nestedObject"');

      expect(updatedContent).toContain('"keepThis": "value"');
      expect(updatedContent).toContain('"preservedObject"');
      expect(updatedContent).toContain('"data": "keep"');

      expect(updatedContent).toContain('// This should be preserved');
    });
  });

  describe('path mutations', () => {
    it('treats explicit path segments as map keys even when they contain dots', () => {
      const parsed = parse('{ "model": { "preferences": {} } }') as Record<
        string,
        unknown
      >;

      expect(
        setCommentJsonProperty(
          parsed,
          ['model', 'preferences', 'model.v2/fast'],
          { effort: 'high' },
        ),
      ).toBe(true);
      expect(
        getCommentJsonProperty(parsed, [
          'model',
          'preferences',
          'model.v2/fast',
        ]),
      ).toMatchObject({ effort: 'high' });
    });

    it('deletes only the explicit property and preserves its adjacent comment', () => {
      const parsed = parse(`{
        "mcpServers": {
          // Keep the explanation even if the entry is removed.
          "remove": { "command": "old" },
          "keep": { "command": "new" }
        }
      }`) as Record<string, unknown>;

      expect(
        deleteCommentJsonProperty(parsed, ['mcpServers', 'remove']),
      ).toBe(true);
      const raw = stringify(parsed, null, 2);
      expect(raw).toContain('// Keep the explanation');
      expect(toPlainJsonValue(parsed)).toEqual({
        mcpServers: { keep: { command: 'new' } },
      });
    });

    it('preserves nested comments when replacing an object value', () => {
      const parsed = parse(`{
        "providers": {
          // Keep the provider explanation.
          "existing": { "apiKey": "old", "baseUrl": "https://old" }
        }
      }`) as Record<string, unknown>;

      expect(
        setCommentJsonProperty(parsed, 'providers', {
          existing: { apiKey: 'new', baseUrl: 'https://old' },
          added: { apiKey: 'added' },
        }),
      ).toBe(true);

      const raw = stringify(parsed, null, 2);
      expect(raw).toContain('// Keep the provider explanation.');
      expect(toPlainJsonValue(parsed)).toEqual({
        providers: {
          existing: { apiKey: 'new', baseUrl: 'https://old' },
          added: { apiKey: 'added' },
        },
      });
    });

    it('treats prototype-shaped path segments as ordinary own keys', () => {
      const parsed = parse('{}') as Record<string, unknown>;

      expect(
        setCommentJsonProperty(parsed, ['mcpServers', '__proto__'], {
          command: 'safe',
        }),
      ).toBe(true);

      expect(getCommentJsonProperty(parsed, ['mcpServers', '__proto__'])).toEqual(
        { command: 'safe' },
      );
      expect(Object.prototype).not.toHaveProperty('command');
      const reparsed = JSON.parse(stringify(parsed, null, 2)) as Record<
        string,
        Record<string, unknown>
      >;
      expect(Object.keys(reparsed['mcpServers'])).toContain('__proto__');
      expect(reparsed['mcpServers']['__proto__']).toEqual({ command: 'safe' });
    });
  });
});
