/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

    expect(command?.title).toBe('Qwen Code: Focus Chat View');
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
  function readSettingsSchema(): {
    properties?: {
      general?: { properties?: Record<string, unknown> };
      ui?: {
        properties?: Record<string, { description?: string }>;
      };
    };
  } {
    return JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../schemas/settings.schema.json'),
        'utf8',
      ),
    );
  }

  it('does not advertise the removed dynamic command translation setting', () => {
    const schema = readSettingsSchema();

    expect(schema.properties?.general?.properties).not.toHaveProperty(
      'dynamicCommandTranslation',
    );
  });

  it('describes the two-way tool-details click gesture', () => {
    const schema = readSettingsSchema();

    expect(
      schema.properties?.ui?.properties?.showToolCallDetails?.description,
    ).toContain(
      'click the summary to expand it and the first row of the expanded group to collapse it again',
    );
  });
});
