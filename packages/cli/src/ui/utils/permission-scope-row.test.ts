/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { SettingScope } from '../../config/settings.js';
import { setLanguageAsync } from '../../i18n/index.js';
import { getCachedStringWidth } from './textUtils.js';
import {
  permissionScopeItems,
  SCOPE_LABEL_GAP,
} from './permission-scope-row.js';

describe('permissionScopeItems', () => {
  const originalQwenHome = process.env['QWEN_HOME'];
  // Anchored at the filesystem root so the fixture can never sit under the
  // home directory, where tildeifyPath would rewrite it to `~/...`.
  const qwenHome = nodePath.join(
    nodePath.parse(os.tmpdir()).root,
    'qwen-home-scope-items',
  );

  afterEach(() => {
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
  });

  it('lists project first, then user, with the save locations', () => {
    delete process.env['QWEN_HOME'];
    const items = permissionScopeItems(67);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      label: 'Project settings',
      description: 'Checked in at .qwen/settings.json',
      value: SettingScope.Workspace,
      key: 'project',
    });
    expect(items[1]).toEqual({
      label: 'User settings',
      description: `Saved in ~${nodePath.sep}.qwen${nodePath.sep}settings.json`,
      value: SettingScope.User,
      key: 'user',
    });
  });

  it('shortens the default global settings path to a tilde', () => {
    delete process.env['QWEN_HOME'];
    expect(permissionScopeItems(67)[1]?.description).toBe(
      `Saved in ~${nodePath.sep}.qwen${nodePath.sep}settings.json`,
    );
  });

  it('names the resolved global directory when QWEN_HOME is set', () => {
    process.env['QWEN_HOME'] = qwenHome;
    expect(permissionScopeItems(67)[1]?.description).toBe(
      `Saved in ${qwenHome}${nodePath.sep}settings.json`,
    );
  });

  it('keeps the settings file name when the global directory is deep', () => {
    process.env['QWEN_HOME'] = nodePath.join(
      qwenHome,
      'srv',
      'qwen-runtime',
      'shared',
      'fixtures',
    );
    const description = permissionScopeItems(67)[1]?.description ?? '';
    expect(description.endsWith(`${nodePath.sep}settings.json`)).toBe(true);
    // 50 is the description column this row gets at an 80-column terminal.
    expect(description.length).toBeLessThanOrEqual(50);
  });

  it('strips control characters from a path taken from the environment', () => {
    process.env['QWEN_HOME'] = `${qwenHome}\n\x1b[2J`;
    const description = permissionScopeItems(67)[1]?.description ?? '';

    expect(description).not.toContain('\n');
    expect(description).not.toContain('\x1b');
  });
});

describe('permissionScopeItems row width', () => {
  const originalQwenHome = process.env['QWEN_HOME'];
  const deepQwenHome = nodePath.join(
    nodePath.parse(os.tmpdir()).root,
    'qwen-home-scope-row-intl',
    'srv',
    'qwen-runtime',
    'shared',
    'fixtures',
  );
  // label + 4-space gap + description, the row budget at an 80-column terminal.
  const ROW_COLUMNS = 67;

  // Five wide segments: 34 code units but 49 display columns. A budget that
  // counts code units lets this path through unshortened, and the row's clip
  // then eats the file name.
  const wideQwenHome = nodePath.join(
    nodePath.parse(os.tmpdir()).root,
    'tmp',
    '工作区'.repeat(5),
  );

  afterEach(async () => {
    await setLanguageAsync('en');
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
  });

  it.each(['ca', 'de', 'fr', 'ja', 'pt', 'ru', 'zh', 'zh-TW'])(
    'keeps the settings file name inside the row budget in %s',
    async (language) => {
      process.env['QWEN_HOME'] = deepQwenHome;
      await setLanguageAsync(language);
      const item = permissionScopeItems(ROW_COLUMNS)[1]!;

      expect(item.description).toContain('settings.json');
      expect(
        getCachedStringWidth(item.label) +
          SCOPE_LABEL_GAP +
          getCachedStringWidth(item.description),
      ).toBeLessThanOrEqual(ROW_COLUMNS);
    },
  );

  it.each(['ca', 'de', 'en', 'fr', 'ja', 'pt', 'ru', 'zh', 'zh-TW'])(
    'charges wide characters against the row budget in %s',
    async (language) => {
      process.env['QWEN_HOME'] = wideQwenHome;
      await setLanguageAsync(language);
      const item = permissionScopeItems(ROW_COLUMNS)[1]!;

      expect(item.description).toContain('settings.json');
      expect(
        getCachedStringWidth(item.label) +
          SCOPE_LABEL_GAP +
          getCachedStringWidth(item.description),
      ).toBeLessThanOrEqual(ROW_COLUMNS);
    },
  );

  it('budgets from the row it is given, not from an 80-column terminal', () => {
    process.env['QWEN_HOME'] = '/opt/qwen-runtimes/shared/tenant-42/config';
    const item = permissionScopeItems(60)[1]!;
    const row = `${item.label}${' '.repeat(SCOPE_LABEL_GAP)}${item.description}`;

    expect(row).toContain('settings.json');
    expect(getCachedStringWidth(row)).toBeLessThanOrEqual(60);
  });

  it.each([43, 34, 31])(
    'keeps the row inside a %i-column budget',
    (rowColumns) => {
      process.env['QWEN_HOME'] = '/opt/qwen-runtimes/shared/tenant-42/config';
      const item = permissionScopeItems(rowColumns)[1]!;
      const row = `${item.label}${' '.repeat(SCOPE_LABEL_GAP)}${item.description}`;

      // The fallback used to be emitted whatever the row could hold, so the
      // renderer's clip — not this budget — decided whether the name survived.
      expect(getCachedStringWidth(row)).toBeLessThanOrEqual(rowColumns);
    },
  );

  it('keeps the file name once the bare name fits the row', () => {
    process.env['QWEN_HOME'] = '/opt/qwen-runtimes/shared/tenant-42/config';
    const item = permissionScopeItems(43)[1]!;

    expect(item.description).toContain('settings.json');
  });

  it.each([39, 40, 41, 42])(
    'falls back to the bare name rather than truncating it at %i columns',
    (rowColumns) => {
      process.env['QWEN_HOME'] = '/opt/qwen-runtimes/shared/tenant-42/config';
      const item = permissionScopeItems(rowColumns)[1]!;

      // `.../settings.json` does not fit here, but `settings.json` does; the
      // description used to jump straight to truncation and lose it.
      expect(item.description).toContain('settings.json');
      expect(getCachedStringWidth(item.description)).toBeLessThanOrEqual(
        rowColumns - getCachedStringWidth(item.label) - SCOPE_LABEL_GAP,
      );
    },
  );

  it('fits the Project row to the same budget as the User row', () => {
    // Both rows are painted at rowWidth; sizing only the User row left the
    // Project row to the renderer's truncate, which drops `settings.json`.
    for (const rowColumns of [39, 50, 53, 67]) {
      const item = permissionScopeItems(rowColumns)[0]!;
      const row = `${item.label}${' '.repeat(SCOPE_LABEL_GAP)}${item.description}`;

      expect(getCachedStringWidth(row)).toBeLessThanOrEqual(rowColumns);
      expect(row).toContain('settings.json');
    }
  });
});
