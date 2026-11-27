/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { renderWithI18n, renderWithProviders } from '../test-utils/render.js';
import { createMockSettings } from '../test-utils/settings.js';
import { ReleaseNotesDialog } from './releaseNotesDialog.js';

describe('ReleaseNotesDialog', () => {
  it('keeps leading versions and pins the last version when space is limited', async () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      version: `1.0.${index}`,
      content: `Notes ${index}`,
    }));
    const rendered = await renderWithProviders(
      <ReleaseNotesDialog entries={entries} />,
      { width: 40 },
    );
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain('1.0.0');
    expect(rendered.lastFrame()).toContain('1.0.1');
    expect(rendered.lastFrame()).toContain('1.0.9');
    for (const entry of entries.slice(2, -1))
      expect(rendered.lastFrame()).not.toContain(entry.version);
    rendered.unmount();
  });
  it('preserves an existing active version and repairs a missing one', async () => {
    const first = { version: '1.0.0', content: 'First notes' };
    const second = { version: '0.9.0', content: 'Second notes' };
    const rendered = await renderWithProviders(
      <ReleaseNotesDialog entries={[first, second]} />,
    );
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain('First notes');

    act(() => rendered.stdin.write('\t'));
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain('Second notes');

    rendered.rerender(
      <ReleaseNotesDialog
        entries={[first, { ...second, content: 'TRANSLATED SECOND' }]}
      />,
    );
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain('TRANSLATED SECOND');

    rendered.rerender(<ReleaseNotesDialog entries={[first]} />);
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain('First notes');
    rendered.unmount();
  });

  it('localizes the empty state', async () => {
    const settings = createMockSettings({
      ui: { language: 'zh-CN' },
    });
    const rendered = await renderWithI18n(
      <ReleaseNotesDialog entries={[]} />,
      80,
      1000,
      settings,
    );
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain('暂无版本更新');
    expect(rendered.lastFrame()).not.toContain('No release notes');
    rendered.unmount();
  });

  it.each([
    { locale: 'en' as const, width: 60 },
    { locale: 'en' as const, width: 80 },
    { locale: 'en' as const, width: 120 },
    { locale: 'zh-CN' as const, width: 60 },
    { locale: 'zh-CN' as const, width: 80 },
    { locale: 'zh-CN' as const, width: 120 },
  ])(
    'renders $locale release notes and navigation hints at $width columns',
    async ({ locale, width }) => {
      const settings = createMockSettings({
        user: {
          path: '/read-only/settings.json',
          settings: { ui: { language: locale } },
          originalSettings: { ui: { language: locale } },
          readOnly: true,
        },
      });
      const rendered = await renderWithProviders(
        <ReleaseNotesDialog
          entries={[
            {
              version: '1.2.3',
              content: 'Stable layout note for `/release-notes`',
            },
            { version: '1.2.2', content: 'Previous release' },
          ]}
        />,
        { width, settings },
      );
      await rendered.waitUntilReady();

      expect(rendered.lastFrame()).toContain('1.2.3');
      expect(rendered.lastFrame()).toContain('/release-notes');
      expect(rendered.lastFrame()).toContain(
        locale === 'zh-CN' ? 'Tab/←→ 切换' : 'Tab/←→ switch',
      );
      rendered.unmount();
    },
  );
});
