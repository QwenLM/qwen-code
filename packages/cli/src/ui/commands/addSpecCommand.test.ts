/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addSpecCommand } from './addSpecCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext, MessageActionReturn } from './types.js';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPEC_TEMPLATE_DIR = path.resolve(__dirname, 'spec');

async function listTemplateFiles(): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(SPEC_TEMPLATE_DIR, fullPath));
      }
    }
  };
  await walk(SPEC_TEMPLATE_DIR);
  return files.sort();
}

describe('addSpecCommand', () => {
  let scratchDir: string;
  let mockContext: CommandContext;

  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'add-spec-command-'));
    mockContext = createMockCommandContext({
      services: {
        config: {
          getTargetDir: () => scratchDir,
        },
      },
    });
  });

  afterEach(async () => {
    await fs.rm(scratchDir, { recursive: true, force: true });
  });

  it('returns error when configuration is missing', async () => {
    const context = createMockCommandContext();
    if (context.services) {
      context.services.config = null;
    }

    const result = await addSpecCommand.action?.(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    });
  });

  it('copies all spec templates into the target directory', async () => {
    const result = (await addSpecCommand.action?.(
      mockContext,
      '',
    )) as MessageActionReturn;

    expect(result).toBeDefined();
    expect(result.type).toBe('message');
    expect(result.messageType).toBe('info');

    const expectedFiles = await listTemplateFiles();
    for (const relativePath of expectedFiles) {
      const targetPath = path.join(scratchDir, relativePath);
      await expect(fs.readFile(targetPath, 'utf8')).resolves.toBeDefined();
    }

    const readme = await fs.readFile(path.join(scratchDir, 'QWEN.md'), 'utf8');
    expect(readme).toContain('Spec-Driven Development');
  });

  it('skips existing files and preserves their content', async () => {
    const targetQwen = path.join(scratchDir, 'QWEN.md');
    await fs.mkdir(path.dirname(targetQwen), { recursive: true });
    await fs.writeFile(targetQwen, 'custom content', 'utf8');

    const result = (await addSpecCommand.action?.(
      mockContext,
      '',
    )) as MessageActionReturn;

    expect(result).toBeDefined();
    expect(result.type).toBe('message');
    expect(result.messageType).toBe('info');
    expect(result.content).toContain('Skipped existing files');

    const finalContent = await fs.readFile(targetQwen, 'utf8');
    expect(finalContent).toBe('custom content');

    const commandFile = path.join(
      scratchDir,
      '.qwen',
      'commands',
      'spec-init.toml',
    );
    await expect(fs.readFile(commandFile, 'utf8')).resolves.toContain(
      'Initialize a new specification',
    );
  });
});
