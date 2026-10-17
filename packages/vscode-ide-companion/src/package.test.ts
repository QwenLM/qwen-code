/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listFiles, PackageManager } from '@vscode/vsce';
import { describe, expect, it } from 'vitest';

describe('package.json command metadata', () => {
  function readManifest(): {
    contributes: {
      commands: Array<{ command: string; title: string }>;
      views: Record<string, Array<{ id: string; when?: string }>>;
      viewsContainers: {
        activitybar: Array<{ id: string; when?: string }>;
      };
    };
  } {
    return JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    );
  }

  it('describes focusChat as focusing the chat view', () => {
    const manifest = readManifest();

    const command = manifest.contributes.commands.find(
      (item) => item.command === 'qwen-code.focusChat',
    );

    expect(command?.title).toBe('%qwen-code.focusChat.title%');
    const english = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.nls.json'), 'utf8'),
    ) as Record<string, string>;
    expect(english['qwen-code.focusChat.title']).toBe(
      'Qwen Code: Focus Chat View',
    );
  });

  it('resolves every command title in English and Simplified Chinese', () => {
    const manifest = readManifest();
    const english = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.nls.json'), 'utf8'),
    ) as Record<string, string>;
    const chinese = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../package.nls.zh-cn.json'),
        'utf8',
      ),
    ) as Record<string, string>;

    expect(english).toEqual({
      'qwen-code.copyMessage.title': 'Copy Message',
      'qwen-code.copyAllMessages.title': 'Copy All Messages',
      'qwen-code.copyLastReply.title': 'Copy Last Reply',
      'qwen.diff.accept.title': 'Qwen Code: Accept Current Diff',
      'qwen.diff.cancel.title': 'Qwen Code: Close Diff Editor',
      'qwen-code.runQwenCode.title': 'Qwen Code: Run',
      'qwen-code.showNotices.title': 'Qwen Code: View Third-Party Notices',
      'qwen-code.openChat.title': 'Qwen Code: Open',
      'qwen-code.auth.title': 'Qwen Code: Auth',
      'qwen-code.focusChat.title': 'Qwen Code: Focus Chat View',
      'qwen-code.newConversation.title': 'Qwen Code: New Conversation',
      'qwen-code.showLogs.title': 'Qwen Code: Show Logs',
    });

    for (const command of manifest.contributes.commands) {
      const key = `${command.command}.title`;
      expect(command.title).toBe(`%${key}%`);
      expect(english[key]).toEqual(expect.stringMatching(/\S/));
      expect(chinese[key]).toEqual(expect.stringMatching(/[\u3400-\u9fff]/));
    }
  });

  it('includes both NLS catalogs in the extension package', async () => {
    const files = await listFiles({
      cwd: resolve(import.meta.dirname, '..'),
      packageManager: PackageManager.None,
    });

    expect(files).toContain('package.nls.json');
    expect(files).toContain('package.nls.zh-cn.json');
  });

  it('keeps the Activity Bar chat entry visible without runtime context', () => {
    const manifest = readManifest();

    const sidebarContainer =
      manifest.contributes.viewsContainers.activitybar.find(
        (item) => item.id === 'qwen-code-sidebar',
      );
    const sidebarView = manifest.contributes.views['qwen-code-sidebar']?.find(
      (item) => item.id === 'qwen-code.chatView.sidebar',
    );

    expect(sidebarContainer?.when).toBeUndefined();
    expect(sidebarView?.when).toBeUndefined();
  });
});

describe('generated settings schema', () => {
  it('does not advertise the removed dynamic command translation setting', () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../schemas/settings.schema.json'),
        'utf8',
      ),
    ) as {
      properties?: {
        general?: { properties?: Record<string, unknown> };
      };
    };

    expect(schema.properties?.general?.properties).not.toHaveProperty(
      'dynamicCommandTranslation',
    );
  });
});
