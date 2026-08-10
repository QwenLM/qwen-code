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

  it('honors an explicit marketplace selection over a root Agent Plugin manifest', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'root-agent-plugin',
      }),
    );
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'sample-marketplace',
        owner: { name: 'Test Owner', email: 'owner@example.com' },
        plugins: [
          {
            name: 'requested-plugin',
            version: '2.0.0',
            source: './plugin-src',
          },
        ],
      }),
    );
    const selectedRoot = path.join(pluginRoot, 'plugin-src');
    fs.mkdirSync(path.join(selectedRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(selectedRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'requested-plugin', version: '2.0.0' }),
    );
    fs.writeFileSync(
      path.join(selectedRoot, 'plugin.json'),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'carried-agent-plugin',
      }),
    );

    const selected = await convertCompatibleExtension(
      pluginRoot,
      'requested-plugin',
    );
    expect(selected.originSource).toBe('Claude');
    const selectedConfig = JSON.parse(
      fs.readFileSync(
        path.join(selected.extensionDir, 'qwen-extension.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(selectedConfig['name']).toBe('requested-plugin');
    expect(fs.existsSync(path.join(selected.extensionDir, 'plugin.json'))).toBe(
      false,
    );
    fs.rmSync(selected.extensionDir, { recursive: true, force: true });

    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: `${AGENT_PLUGIN_SCHEMA_PREFIX}2.0.0/plugin.schema.json`,
        name: 'future-root-agent-plugin',
      }),
    );
    fs.writeFileSync(
      path.join(selectedRoot, 'plugin.json'),
      JSON.stringify({
        $schema: `${AGENT_PLUGIN_SCHEMA_PREFIX}2.0.0/plugin.schema.json`,
        name: 'future-carried-agent-plugin',
      }),
    );
    const selectedWithFutureRoot = await convertCompatibleExtension(
      pluginRoot,
      'requested-plugin',
    );
    expect(selectedWithFutureRoot.originSource).toBe('Claude');
    expect(
      fs.existsSync(
        path.join(selectedWithFutureRoot.extensionDir, 'plugin.json'),
      ),
    ).toBe(false);
    fs.rmSync(selectedWithFutureRoot.extensionDir, {
      recursive: true,
      force: true,
    });
  });
});
