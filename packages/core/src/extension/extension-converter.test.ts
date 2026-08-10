/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertCompatibleExtension } from './extension-converter.js';
import {
  AGENT_PLUGIN_SCHEMA,
  AGENT_PLUGIN_SCHEMA_PREFIX,
} from './agent-plugins-v1/index.js';

describe('Agent Plugins extension conversion', () => {
  let pluginRoot: string;

  beforeEach(() => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-'));
  });

  afterEach(() => {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  });

  it('selects a supported Agent Plugin without converting it', async () => {
    const manifest = JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: 'portable-plugin',
    });
    fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), manifest);

    await expect(convertCompatibleExtension(pluginRoot)).resolves.toEqual({
      extensionDir: pluginRoot,
      originSource: 'AgentPlugins',
      externalContent: false,
    });
    expect(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')).toBe(
      manifest,
    );
    expect(fs.existsSync(path.join(pluginRoot, 'qwen-extension.json'))).toBe(
      false,
    );
  });

  it('gives an unsupported Agent Plugins schema priority over Qwen format', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: `${AGENT_PLUGIN_SCHEMA_PREFIX}2.0.0/plugin.schema.json`,
        name: 'future-plugin',
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'qwen-extension.json'),
      JSON.stringify({ name: 'qwen-fallback', version: '1.0.0' }),
    );

    await expect(convertCompatibleExtension(pluginRoot)).rejects.toThrow(
      'Unsupported Agent Plugins schema',
    );
  });

  it('leaves an unrelated plugin.json out of format detection', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({ $schema: 'https://example.com/plugin.schema.json' }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'qwen-extension.json'),
      JSON.stringify({ name: 'qwen-extension', version: '1.0.0' }),
    );

    await expect(convertCompatibleExtension(pluginRoot)).resolves.toEqual({
      extensionDir: pluginRoot,
      originSource: 'QwenCode',
      externalContent: false,
    });
  });
});
