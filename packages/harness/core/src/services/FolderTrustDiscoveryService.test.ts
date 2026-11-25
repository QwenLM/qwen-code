/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FolderTrustDiscoveryService } from './FolderTrustDiscoveryService.js';
import { CONFIG_DIR } from '../utils/paths.js';

describe('FolderTrustDiscoveryService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gemini-discovery-test-'),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should discover commands, skills, mcps, and hooks', async () => {
    const configDir = path.join(tempDir, CONFIG_DIR);
    await fs.mkdir(configDir, { recursive: true });

    // Mock commands
    const commandsDir = path.join(configDir, 'commands');
    await fs.mkdir(commandsDir);
    await fs.writeFile(
      path.join(commandsDir, 'test-cmd.toml'),
      'prompt = "test"',
    );

    // Mock skills
    const skillsDir = path.join(configDir, 'skills');
    await fs.mkdir(path.join(skillsDir, 'test-skill'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'test-skill', 'SKILL.md'), 'body');

    // Mock agents
    const agentsDir = path.join(configDir, 'agents');
    await fs.mkdir(agentsDir);
    await fs.writeFile(path.join(agentsDir, 'test-agent.md'), 'body');

    // Mock settings (MCPs, Hooks, and general settings)
    const settings = {
      mcpServers: {
        'test-mcp': { command: 'node', args: ['test.js'] },
      },
      hooks: {
        PreToolUse: [{ command: 'test-hook' }],
      },
      general: { vimMode: true },
      ui: { theme: 'Dark' },
    };
    await fs.writeFile(
      path.join(configDir, 'settings.json'),
      JSON.stringify(settings),
    );

    const results = await FolderTrustDiscoveryService.discover(tempDir);

    expect(results.commands).toContain('test-cmd');
    expect(results.skills).toContain('test-skill');
    expect(results.agents).toContain('test-agent');
    expect(results.mcps).toContain('test-mcp');
    expect(results.hooks).toContain('test-hook');
    expect(results.settings).toContain('general');
    expect(results.settings).toContain('ui');
    expect(results.settings).not.toContain('mcpServers');
    expect(results.settings).not.toContain('hooks');
  });

  it('should flag security warnings for sensitive settings', async () => {
    const configDir = path.join(tempDir, CONFIG_DIR);
    await fs.mkdir(configDir, { recursive: true });

    const settings = {
      tools: {
        sandbox: false,
      },
      security: {
        folderTrust: {
          enabled: false,
        },
      },
    };
    await fs.writeFile(
      path.join(configDir, 'settings.json'),
      JSON.stringify(settings),
    );

    const results = await FolderTrustDiscoveryService.discover(tempDir);

    expect(results.securityWarnings).toContain(
      'This project attempts to disable folder trust (security.folderTrust.enabled).',
    );
    expect(results.securityWarnings).not.toContain(
      'This project disables the security sandbox (tools.sandbox).',
    );
  });

  it('should handle missing ${CONFIG_DIR} directory', async () => {
    const results = await FolderTrustDiscoveryService.discover(tempDir);
    expect(results.commands).toHaveLength(0);
    expect(results.skills).toHaveLength(0);
    expect(results.mcps).toHaveLength(0);
    expect(results.hooks).toHaveLength(0);
    expect(results.settings).toHaveLength(0);
  });

  it('should handle malformed settings.json', async () => {
    const configDir = path.join(tempDir, CONFIG_DIR);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'settings.json'), 'invalid json');

    const results = await FolderTrustDiscoveryService.discover(tempDir);
    expect(results.discoveryErrors[0]).toContain(
      'Failed to discover settings: Unexpected token',
    );
  });

  it('should handle null settings.json', async () => {
    const configDir = path.join(tempDir, CONFIG_DIR);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'settings.json'), 'null');

    const results = await FolderTrustDiscoveryService.discover(tempDir);
    expect(results.discoveryErrors).toHaveLength(0);
    expect(results.settings).toHaveLength(0);
  });

  it('should handle array settings.json', async () => {
    const configDir = path.join(tempDir, CONFIG_DIR);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'settings.json'), '[]');

    const results = await FolderTrustDiscoveryService.discover(tempDir);
    expect(results.discoveryErrors).toHaveLength(0);
    expect(results.settings).toHaveLength(0);
  });

  it('should handle string settings.json', async () => {
    const configDir = path.join(tempDir, CONFIG_DIR);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'settings.json'), '"string"');

    const results = await FolderTrustDiscoveryService.discover(tempDir);
    expect(results.discoveryErrors).toHaveLength(0);
    expect(results.settings).toHaveLength(0);
  });

  it('should flag security warning for custom agents', async () => {
    const configDir = path.join(tempDir, CONFIG_DIR);
    await fs.mkdir(configDir, { recursive: true });

    const agentsDir = path.join(configDir, 'agents');
    await fs.mkdir(agentsDir);
    await fs.writeFile(path.join(agentsDir, 'test-agent.md'), 'body');

    const results = await FolderTrustDiscoveryService.discover(tempDir);

    expect(results.agents).toContain('test-agent');
    expect(results.securityWarnings).toContain(
      'This project contains custom agents.',
    );
  });
});
