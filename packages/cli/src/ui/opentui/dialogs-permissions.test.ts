/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI permissions dialog reproduces the original ink
 * PermissionsDialog content: the four tabs, rule descriptions, scope
 * labels, the rule-save scope items, and the workspace directory input
 * validation (same fs checks, same error strings).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  describePermissionRule,
  formatScopeRow,
  getPermissionsTabs,
  permissionScopeLabel,
  validateWorkspaceDirectory,
} from './dialogs-permissions.js';
import { permissionScopeItems } from '../utils/permission-scope-row.js';
import { SettingScope } from '../../config/settings.js';
import { setLanguageAsync } from '../../i18n/index.js';
import { getCachedStringWidth } from '../utils/textUtils.js';

describe('getPermissionsTabs', () => {
  it('keeps the original four tabs, order, and copy', () => {
    const tabs = getPermissionsTabs();
    expect(tabs.map((tab) => tab.id)).toEqual([
      'allow',
      'ask',
      'deny',
      'workspace',
    ]);
    expect(tabs[0]).toEqual({
      id: 'allow',
      label: 'Allow',
      description: "Qwen Code won't ask before using allowed tools.",
    });
    expect(tabs[3]).toEqual({
      id: 'workspace',
      label: 'Workspace',
      description: 'Manage trusted directories for this workspace.',
    });
  });
});

describe('describePermissionRule', () => {
  it('describes a bare tool as any use', () => {
    expect(describePermissionRule('Bash')).toBe('Any use of the Bash tool');
  });

  it('describes a specifier rule as a pattern match', () => {
    expect(describePermissionRule('Bash(ls:*)')).toBe(
      "Bash commands matching 'ls:*'",
    );
  });

  it('returns the raw text when it cannot be parsed', () => {
    expect(describePermissionRule('(weird)')).toBe('(weird)');
  });
});

describe('permissionScopeLabel', () => {
  it('maps rule sources to the original labels', () => {
    expect(permissionScopeLabel('user')).toBe('From user settings');
    expect(permissionScopeLabel('workspace')).toBe('From project settings');
    expect(permissionScopeLabel('session')).toBe('From session');
    expect(permissionScopeLabel('elsewhere')).toBe('elsewhere');
  });
});

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
});

describe('permissionScopeItems row width', () => {
  const originalQwenHome = process.env['QWEN_HOME'];
  const deepQwenHome = nodePath.join(
    nodePath.parse(os.tmpdir()).root,
    'qwen-home-scope-intl',
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
          4 +
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
          4 +
          getCachedStringWidth(item.description),
      ).toBeLessThanOrEqual(ROW_COLUMNS);
    },
  );

  it('budgets from the row it is given, not from an 80-column terminal', () => {
    process.env['QWEN_HOME'] = '/opt/qwen-runtimes/shared/tenant-42/config';
    const row = formatScopeRow(permissionScopeItems(57)[1]!, 57);

    expect(row).toContain('settings.json');
    expect(getCachedStringWidth(row)).toBeLessThanOrEqual(57);
  });

  it.each([43, 34, 31])(
    'keeps a %i-column row inside its budget',
    (rowColumns) => {
      process.env['QWEN_HOME'] = '/opt/qwen-runtimes/shared/tenant-42/config';
      const row = formatScopeRow(
        permissionScopeItems(rowColumns)[1]!,
        rowColumns,
      );

      expect(getCachedStringWidth(row)).toBeLessThanOrEqual(rowColumns);
    },
  );
});

describe('formatScopeRow', () => {
  it('keeps a row that fits untouched', () => {
    expect(
      formatScopeRow(
        {
          label: 'User settings',
          description: 'Saved in ~/.qwen/settings.json',
        },
        67,
      ),
    ).toBe('User settings    Saved in ~/.qwen/settings.json');
  });

  it('clips an overlong row with an ellipsis, not a silent cut', () => {
    const row = formatScopeRow(
      { label: 'User settings', description: 'x'.repeat(120) },
      40,
    );

    expect(getCachedStringWidth(row)).toBeLessThanOrEqual(40);
    expect(row.endsWith('…')).toBe(true);
  });
});

describe('validateWorkspaceDirectory', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'perm-dialog-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the falsy empty-input sentinel (handler must short-circuit)', () => {
    // ink short-circuits empty input in the submit handler before calling
    // the validator — the sentinel keeps that contract visible here.
    expect(validateWorkspaceDirectory('   ', [])).toEqual({ error: '' });
  });

  it('rejects paths that do not exist', () => {
    const result = validateWorkspaceDirectory(
      nodePath.join(tmpRoot, 'missing'),
      [],
    );
    expect(result.error).toBe('Directory does not exist.');
  });

  it('rejects file paths', () => {
    const file = nodePath.join(tmpRoot, 'file.txt');
    fs.writeFileSync(file, 'x');
    const result = validateWorkspaceDirectory(file, []);
    expect(result.error).toBe('Path is not a directory.');
  });

  it('resolves an existing directory', () => {
    const dir = nodePath.join(tmpRoot, 'dir');
    fs.mkdirSync(dir);
    const result = validateWorkspaceDirectory(dir, []);
    expect(result.error).toBeUndefined();
    expect(result.resolved).toBe(fs.realpathSync(dir));
  });

  it('rejects duplicates of an existing workspace directory', () => {
    const result = validateWorkspaceDirectory(tmpRoot, [
      fs.realpathSync(tmpRoot),
    ]);
    expect(result.error).toBe('This directory is already in the workspace.');
  });

  it('rejects subdirectories of an existing workspace directory', () => {
    const child = nodePath.join(tmpRoot, 'child');
    fs.mkdirSync(child);
    const result = validateWorkspaceDirectory(child, [
      fs.realpathSync(tmpRoot),
    ]);
    expect(result.error).toContain('Already covered by existing directory');
  });
});
