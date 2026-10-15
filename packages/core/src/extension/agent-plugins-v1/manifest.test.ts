/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_PLUGIN_SCHEMA,
  getAgentPluginSchemaStatus,
  loadAgentPluginManifest,
} from './manifest.js';

describe('Agent Plugins v1 manifest', () => {
  let pluginRoot: string;

  beforeEach(() => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-'));
  });

  afterEach(() => {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  });

  it('maps portable metadata without requiring a version', () => {
    writeManifest({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: 'portable.tools',
      version: '  ',
      description: '  Portable tools  ',
      unknown: true,
      extensions: { 'com.example': 'ignored' },
    });

    expect(getAgentPluginSchemaStatus(pluginRoot)).toBe('supported');
    expect(loadAgentPluginManifest(pluginRoot)).toEqual({
      name: 'portable.tools',
      version: '1.0.0',
      displayName: 'portable.tools',
      description: 'Portable tools',
    });
  });

  it('distinguishes unsupported and unrelated schemas', () => {
    writeManifest({
      $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
      name: 'future-plugin',
    });
    expect(getAgentPluginSchemaStatus(pluginRoot)).toBe('unsupported');
    expect(() => loadAgentPluginManifest(pluginRoot)).toThrow(
      'Unsupported Agent Plugins schema',
    );

    writeManifest({ $schema: 'https://example.com/plugin.schema.json' });
    expect(getAgentPluginSchemaStatus(pluginRoot)).toBe('unrelated');
  });

  it('does not read a non-regular root manifest', () => {
    fs.mkdirSync(path.join(pluginRoot, 'plugin.json'));

    expect(getAgentPluginSchemaStatus(pluginRoot)).toBe('unrelated');
  });

  it('rejects invalid portable fields', () => {
    writeManifest({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: 'UPPERCASE',
    });
    expect(() => loadAgentPluginManifest(pluginRoot)).toThrow(
      'Agent Plugins name',
    );

    writeManifest({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: 'portable',
      keywords: ['valid', 1],
    });
    expect(() => loadAgentPluginManifest(pluginRoot)).toThrow('keywords');
  });

  it.runIf(process.platform !== 'win32')(
    'loads a root manifest symlink contained in the plugin',
    () => {
      const inside = path.join(pluginRoot, 'inside-plugin.json');
      fs.writeFileSync(
        inside,
        JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: 'portable' }),
      );
      fs.symlinkSync(inside, path.join(pluginRoot, 'plugin.json'));

      expect(loadAgentPluginManifest(pluginRoot)).toMatchObject({
        name: 'portable',
        version: '1.0.0',
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a root manifest symlink that escapes the plugin',
    () => {
      const outside = `${pluginRoot}-outside.json`;
      fs.writeFileSync(
        outside,
        JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: 'portable' }),
      );
      fs.symlinkSync(outside, path.join(pluginRoot, 'plugin.json'));
      expect(getAgentPluginSchemaStatus(pluginRoot)).toBe('supported');
      expect(() => loadAgentPluginManifest(pluginRoot)).toThrow(
        'outside plugin root',
      );
      fs.rmSync(outside, { force: true });
    },
  );

  function writeManifest(value: unknown): void {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify(value),
    );
  }
});
