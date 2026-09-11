/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Extension } from '../extension/extensionManager.js';
import {
  buildExtensionContextText,
  buildExtensionMentionContext,
  EXTENSION_CONTEXT_BUDGET,
  EXTENSION_CONTEXT_FILE_CAP,
} from './extension-mention.js';

describe('extension mention context', () => {
  let root: string;
  let extension: Extension;
  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-extension-context-'),
    );
    extension = {
      id: 'expert',
      name: 'expert',
      version: '1',
      isActive: true,
      path: root,
      config: { name: 'expert', version: '1', description: 'Inspect tables' },
      contextFiles: [path.join(root, 'QWEN.md')],
    };
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('loads selected context files and accounts for the complete prompt in strict mode', async () => {
    await fs.writeFile(
      extension.contextFiles[0],
      'Read table schemas before running SQL.',
    );
    const result = await buildExtensionMentionContext(extension, {
      remainingBudget: EXTENSION_CONTEXT_BUDGET,
      strict: true,
    });
    expect(result.text).toContain('untrusted third-party content');
    expect(result.text).toContain('Read table schemas before running SQL.');
    expect(
      result.text.indexOf('Read table schemas before running SQL.'),
    ).toBeLessThan(result.text.indexOf('--- End Extension:'));
    expect(result.remainingBudget).toBe(
      EXTENSION_CONTEXT_BUDGET - result.text.length,
    );
  });

  it('retains lenient mention behavior but refuses an unreadable listed context file', async () => {
    await expect(
      buildExtensionMentionContext(extension, {
        remainingBudget: EXTENSION_CONTEXT_BUDGET,
      }),
    ).resolves.toMatchObject({ remainingBudget: EXTENSION_CONTEXT_BUDGET });
    await expect(
      buildExtensionMentionContext(extension, {
        remainingBudget: EXTENSION_CONTEXT_BUDGET,
        strict: true,
      }),
    ).rejects.toThrow(/Unreadable extension context/);
  });

  it('refuses context symlinks outside the selected extension', async () => {
    const outside = path.join(root, 'outside.md');
    await fs.writeFile(outside, 'outside rules');
    const extensionDir = path.join(root, 'extension');
    await fs.mkdir(extensionDir);
    extension.path = extensionDir;
    extension.contextFiles = [path.join(extensionDir, 'QWEN.md')];
    await fs.symlink(outside, extension.contextFiles[0]);
    await expect(
      buildExtensionMentionContext(extension, {
        remainingBudget: EXTENSION_CONTEXT_BUDGET,
        strict: true,
      }),
    ).rejects.toThrow(/outside its directory/);
  });

  it('refuses truncation of required workflow rules while ordinary mentions remain bounded', async () => {
    await fs.writeFile(
      extension.contextFiles[0],
      'x'.repeat(EXTENSION_CONTEXT_FILE_CAP + 1),
    );
    await expect(
      buildExtensionMentionContext(extension, {
        remainingBudget: EXTENSION_CONTEXT_BUDGET,
        strict: true,
      }),
    ).rejects.toThrow(/file cap/);
    const result = await buildExtensionMentionContext(extension, {
      remainingBudget: EXTENSION_CONTEXT_BUDGET,
    });
    expect(result.text).toContain('... (truncated)');
    await expect(
      buildExtensionMentionContext(
        { ...extension, contextFiles: [] },
        { remainingBudget: 1, strict: true },
      ),
    ).rejects.toThrow(/budget/);
  });

  it('honors cancellation before reading required context', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      buildExtensionMentionContext(extension, {
        remainingBudget: EXTENSION_CONTEXT_BUDGET,
        strict: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });

  it('preserves cancellation that arrives while required context is read', async () => {
    await fs.writeFile(extension.contextFiles[0], 'rules');
    const controller = new AbortController();
    let checks = 0;
    const throwIfAborted = vi
      .spyOn(controller.signal, 'throwIfAborted')
      .mockImplementation(() => {
        checks += 1;
        if (checks === 2) throw new Error('cancelled during read');
      });
    try {
      await expect(
        buildExtensionMentionContext(extension, {
          remainingBudget: EXTENSION_CONTEXT_BUDGET,
          strict: true,
          signal: controller.signal,
        }),
      ).rejects.toThrow('cancelled during read');
      expect(throwIfAborted).toHaveBeenCalledTimes(2);
    } finally {
      throwIfAborted.mockRestore();
    }
  });

  it('never falls back to terminal-control-only capability names', () => {
    extension.displayName = '\u001b[31m\u001b[0m';
    extension.name = '\u001b[31m\u001b[0m';
    extension.skills = [{ name: '\u001b[31m\u001b[0m' } as never];
    expect(buildExtensionContextText(extension)).toContain(
      'Extension: unnamed extension',
    );
    expect(buildExtensionContextText(extension)).toContain('Skills: unnamed');
    expect(buildExtensionContextText(extension)).not.toContain('\u001b');
  });
});
